import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/config';

/**
 * HTTP 安全基线：安全响应头 + 进程内限流（B4）。
 * 直连部署无 Nginx 时，这两项必须在应用内补齐。
 */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** 安全响应头；HSTS 仅在对外地址为 https 时下发，http 直连下发会被浏览器忽略并报错 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (getConfig().publicBaseUrl.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // API 与注册表响应含权限态与包列表，禁止中间层缓存
  if (req.path.startsWith('/api/') || req.path.startsWith('/npm') || req.path.startsWith('/pypi') || req.path.startsWith('/simple')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

type Scope = 'auth' | 'write' | 'read';

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
/** 键上限：防止伪造来源 IP 打爆内存 */
const MAX_TRACKED_KEYS = 20_000;

export function resetRateLimitState(): void {
  windows.clear();
}

/**
 * 只有真正校验凭据的入口才计入「鉴权类」配额（默认 10 次/分钟）。
 * 早期按路径前缀 /api/v1/auth/ 一刀切，导致 /auth/me 轮询、令牌列表/创建/吊销
 * 都挤在这个极小配额里：管理员集中清理令牌时很快就 429。
 * 这些接口本身要求已登录会话，防爆破意义不大，改按读/写配额计数。
 */
const AUTH_SCOPED_PATHS = new Set(['/api/v1/auth/login', '/api/v1/auth/change-password', '/auth/login']);

function scopeOf(req: Request): Scope {
  const path = (req.path || '').toLowerCase();
  if (AUTH_SCOPED_PATHS.has(path)) return 'auth';
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  return 'write';
}

/** 固定窗口计数；返回是否放行与建议重试秒数 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: boolean; retryAfter: number; remaining: number } {
  if (limit <= 0 || windowMs <= 0) return { allowed: true, retryAfter: 0, remaining: limit };

  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) prune(now);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1 };
  }

  current.count += 1;
  if (current.count > limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { allowed: true, retryAfter: 0, remaining: limit - current.count };
}

/** 仅清理已过期窗口；仍有大量未过期键时保持现状，避免误清除正在计数的来源 */
function prune(now: number): void {
  for (const [key, item] of windows) {
    if (item.resetAt <= now) windows.delete(key);
  }
  if (windows.size >= MAX_TRACKED_KEYS) {
    // 极端情况下直接清空：宁可短暂放宽，也不让进程内存无限增长
    windows.clear();
  }
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const cfg = getConfig().rateLimit;
  if (!cfg.enabled) {
    next();
    return;
  }

  const scope = scopeOf(req);
  const limit = scope === 'auth' ? cfg.authMax : scope === 'write' ? cfg.writeMax : cfg.readMax;
  const key = `${scope}:${req.ip || 'unknown'}`;
  const result = checkRateLimit(key, limit, cfg.windowMs);

  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfter));
    res.status(429).json({
      code: 'SYS_RATE_LIMITED',
      message: `请求过于频繁，请 ${result.retryAfter} 秒后重试`,
      data: null,
      traceId: (req as Request & { traceId?: string }).traceId || null,
    });
    return;
  }

  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  next();
}

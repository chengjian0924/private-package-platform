import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/config';
import { clientIp } from './http.util';

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

type Scope = 'auth' | 'write' | 'read' | 'npm' | 'pypi';

interface Window {
  count: number;
  resetAt: number;
  /** 建窗时的窗口长度：运行时改 RATE_LIMIT_WINDOW_MS 后，旧窗口要按新长度重建 */
  size: number;
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

/**
 * 路径归一化，与 Express 的路由匹配口径对齐：
 * - 末尾斜杠：Express 默认非严格路由，`/api/v1/auth/login/` 与无斜杠命中同一处理函数；
 * - 大小写：路由本身大小写不敏感（本中间件此前已对 path 做 toLowerCase）。
 * 不归一化的话，攻击者加个 `/` 就能把登录从 auth 桶（10 次/分钟）漏到 write 桶（60 次/分钟）。
 */
export function normalizeRequestPath(raw: string): string {
  const lower = (raw || '').toLowerCase();
  if (lower.length <= 1) return lower;
  const trimmed = lower.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * registry 协议入口（/npm/*、/pypi/*）由包管理器批量拉取：
 * dshmarket 打开一次市场页会发约 400 个 search/catalog GET，
 * pip/npm 批量安装也会为每个依赖拉 simple 页面/packument 与 tarball。
 * 这些请求若和控制台 API 共用 readMax=600 桶，正常使用就会被 429 打断，
 * 因此 GET/HEAD 按协议拆成 npm/pypi 独立桶，写请求仍走 writeMax。
 */
export function rateLimitScopeOf(req: Request): Scope {
  const path = normalizeRequestPath(req.path);
  if (AUTH_SCOPED_PATHS.has(path)) return 'auth';

  // method 统一大写：Node 保证标准 method 是大写，但代理/自研客户端可能下发小写，
  // 而 Express 路由对 method 大小写不敏感——小写 post 打登录同样能成功，限流层必须同口径。
  const method = (req.method || '').toUpperCase();
  const registry: Exclude<Scope, 'auth' | 'write' | 'read'> | null =
    path === '/npm' || path.startsWith('/npm/')
      ? 'npm'
      : path === '/pypi' || path.startsWith('/pypi/')
        ? 'pypi'
        : null;
  if (registry && (method === 'GET' || method === 'HEAD')) return registry;

  if (method === 'GET' || method === 'HEAD') return 'read';
  return 'write';
}

/** 固定窗口计数；返回是否放行、建议重试秒数与窗口剩余秒数 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: boolean; retryAfter: number; remaining: number; resetIn: number } {
  if (limit <= 0 || windowMs <= 0) return { allowed: true, retryAfter: 0, remaining: limit, resetIn: 0 };

  const current = windows.get(key);
  // size 不一致说明窗口长度被运行时改过（字典热更新）：旧计数按旧窗口算，
  // 继续沿用会让新配置要等一整个旧窗口才生效，这里直接按新长度重建。
  if (!current || current.resetAt <= now || current.size !== windowMs) {
    if (windows.size >= MAX_TRACKED_KEYS) prune(now);
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt, size: windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1, resetIn: Math.ceil(windowMs / 1000) };
  }

  current.count += 1;
  const resetIn = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  if (current.count > limit) {
    return { allowed: false, retryAfter: resetIn, remaining: 0, resetIn };
  }
  return { allowed: true, retryAfter: 0, remaining: limit - current.count, resetIn };
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

  const scope = rateLimitScopeOf(req);
  const limit =
    scope === 'auth'
      ? cfg.authMax
      : scope === 'write'
        ? cfg.writeMax
        : scope === 'read'
          ? cfg.readMax
          : cfg.registryMax;
  // npm/pypi 各自独立计数，避免一侧的批量拉取把另一侧的客户端饿死。
  // 来源 IP 与审计/访问日志共用 clientIp()，确保网关形态按真实客户端分桶、直连形态忽略伪造 XFF。
  const key = `${scope}:${clientIp(req) || 'unknown'}`;
  const result = checkRateLimit(key, limit, cfg.windowMs);

  // RateLimit-* 采用 IETF 草案口径；成功与 429 都下发，客户端才能按剩余额度主动退避，
  // 而不是等到被拒后才凭感觉重试。resetIn 是距窗口重置的秒数。
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Policy', `${scope};q=${limit};w=${Math.max(1, Math.ceil(cfg.windowMs / 1000))}`);
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(result.resetIn));

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

  next();
}

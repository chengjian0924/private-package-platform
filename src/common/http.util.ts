import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import { getConfig } from '../config/config';

export type TracedRequest = Request & { traceId?: string };

/** 每个请求生成/透传 trace_id，用于错误定位与审计回放 */
export function traceMiddleware(req: TracedRequest, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.traceId = incoming && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('X-Trace-Id', req.traceId);
  next();
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function parseBasicAuth(header?: string): { username: string; password: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function bearerToken(header?: string): string | null {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function digestOf(buf: Buffer): { sha256: string; shasum: string; integrity: string } {
  return {
    sha256: sha256Hex(buf),
    shasum: crypto.createHash('sha1').update(buf).digest('hex'),
    integrity: `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`,
  };
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/**
 * 统一的可信来源 IP：审计、限流、访问日志三处共用，口径一致。
 *
 * - direct（默认，无网关）：客户端可直连，X-Forwarded-For 完全由客户端自报、不可信，
 *   一律忽略，取 TCP 对端地址 req.socket.remoteAddress。
 * - gateway（前置 Nginx）：只信任由网关追加的最后一段。Nginx 用 $proxy_add_x_forwarded_for，
 *   会把真实对端追加到 XFF 末尾；前面的段落可由客户端伪造，故取最后一段而非第一段。
 *
 * 不用 Express 的 trust proxy：它会让 req.ip 取 XFF 第一段，正好是客户端可伪造的那段。
 */
export function clientIp(req: Request): string {
  if (getConfig().deployMode === 'gateway') {
    const forwarded = req.header('x-forwarded-for');
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      // $proxy_add_x_forwarded_for 的最后一跳由网关追加，可信
      if (hops.length) return hops[hops.length - 1];
    }
  }
  // direct 形态或网关未注入 XFF：取 TCP 对端；req.ip 在未设 trust proxy 时即等于此值，
  // 但显式读 socket 可避免将来误开 trust proxy 后悄悄改变口径。
  return req.socket?.remoteAddress || req.ip || '';
}

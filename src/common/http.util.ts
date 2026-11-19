import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';

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

export function clientIp(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || '';
}

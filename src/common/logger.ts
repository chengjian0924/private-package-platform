import type { LoggerService } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/config';

/**
 * 结构化日志（B2）：单行 JSON 写 stdout，由 filebeat/fluent-bit 等采集。
 * traceId 通过 AsyncLocalStorage 透传，业务代码无需逐层传参。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface TraceStore {
  traceId?: string;
}

const als = new AsyncLocalStorage<TraceStore>();

export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return als.run({ traceId }, fn);
}

export function currentTraceId(): string | undefined {
  return als.getStore()?.traceId;
}

/** 敏感键一律整体替换，避免凭据、Cookie、签名进入日志 */
const SECRET_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|token|access_token|refresh_token|secret|signature|api[-_]?key)$/i;

/**
 * 递归脱敏 + 截断：超长字符串按 512 字符截断，数组最多保留 50 项、嵌套最多 4 层，
 * 防止把整个包内容或大对象写进日志。
 */
export function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '***' : maskDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

function normalizeMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(maskDeep(message));
  } catch {
    return String(message);
  }
}

/**
 * 生成一行日志；返回空串表示低于当前级别被过滤。
 * 便于单测直接断言字段，不依赖 stdout。
 */
export function formatLog(
  level: Level,
  logger: string,
  message: unknown,
  meta: Record<string, unknown> = {},
  traceId: string | undefined = currentTraceId(),
): string {
  const cfg = getConfig().log;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[cfg.level]) return '';

  const time = new Date().toISOString();
  const msg = normalizeMessage(message);
  const maskedMeta = maskDeep(meta) as Record<string, unknown>;
  const base = {
    time,
    level,
    logger,
    msg,
    traceId: traceId ?? null,
    ...maskedMeta,
  };

  if (cfg.format === 'text') {
    const extras = Object.entries(maskedMeta)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    const trace = traceId ? ` trace=${traceId}` : '';
    return `${time} ${level.toUpperCase()} [${logger}]${trace} ${msg}${extras ? ` ${extras}` : ''}\n`;
  }
  return `${JSON.stringify(base)}\n`;
}

function emit(
  level: Level,
  logger: string,
  message: unknown,
  meta?: Record<string, unknown>,
  traceId?: string,
): void {
  const line = formatLog(level, logger, message, meta, traceId);
  if (!line) return;
  process.stdout.write(line);
  writeToFile(line);
}

/**
 * 落盘：按天切分的 app-YYYY-MM-DD.log，与控制台「日志文件保留天数」配套。
 * journald 采集的部署可用 LOG_FILE_ENABLED=false 关掉；写盘失败只在首次告警并退回 stdout。
 */
let fileSink: fs.WriteStream | null = null;
let fileSinkDate = '';
let fileSinkWarned = false;

function writeToFile(line: string): void {
  try {
    if (!getConfig().log.fileEnabled) return;
    const stream = ensureFileSink();
    stream?.write(line);
  } catch {
    // 日志系统自身不能抛异常，否则会把业务请求带崩
  }
}

function ensureFileSink(): fs.WriteStream | null {
  const dir = getConfig().log.dir;
  const date = new Date().toISOString().slice(0, 10);
  if (fileSink && fileSinkDate === date) return fileSink;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const next = fs.createWriteStream(path.join(dir, `app-${date}.log`), { flags: 'a' });
    next.on('error', (err) => {
      if (!fileSinkWarned) {
        fileSinkWarned = true;
        process.stderr.write(`[log] 日志落盘失败，已退回 stdout: ${err.message}\n`);
      }
      if (fileSink === next) {
        fileSink = null;
        fileSinkDate = '';
      }
    });
    // 跨天换文件：旧流优雅关闭，避免文件句柄泄漏
    if (fileSink) fileSink.end();
    fileSink = next;
    fileSinkDate = date;
    return next;
  } catch (err) {
    if (!fileSinkWarned) {
      fileSinkWarned = true;
      process.stderr.write(`[log] 日志目录不可写，已退回 stdout: ${(err as Error).message}\n`);
    }
    return null;
  }
}

/** 接管 Nest 内置 Logger，使所有服务日志统一为结构化格式 */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    emit('info', context || 'App', message);
  }

  error(message: unknown, stack?: string, context?: string): void {
    emit('error', context || 'App', message, stack ? { stack } : undefined);
  }

  warn(message: unknown, context?: string): void {
    emit('warn', context || 'App', message);
  }

  debug(message: unknown, context?: string): void {
    emit('debug', context || 'App', message);
  }

  verbose(message: unknown, context?: string): void {
    emit('debug', context || 'App', message);
  }
}

type TracedRequest = Request & { traceId?: string };

/**
 * 请求访问日志：只记录方法、路径、状态码、耗时、来源 IP，
 * 不记录 query / body / header，避免令牌与包内容落盘。
 */
export function requestLog(req: TracedRequest, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const traceId = req.traceId;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const status = res.statusCode;
    const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    emit(level, 'HTTP', `${req.method} ${req.path} ${status}`, {
      method: req.method,
      path: req.path,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      bytes: Number(res.getHeader('content-length') || 0),
    }, traceId);
  });

  if (traceId) {
    runWithTrace(traceId, next);
    return;
  }
  next();
}

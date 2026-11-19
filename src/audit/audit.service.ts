import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { nowIso, sha256Hex } from '../common/http.util';

export interface AuditInput {
  traceId?: string | null;
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: 'success' | 'failure';
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
  /** 认证所用 API Token 的哈希（Token 归属法：审计按 Token 追踪下游项目），会话认证为空 */
  actorTokenHash?: string | null;
}

/**
 * 凭据类键名：按常见命名风格扩展，避免「键名换个写法就绕过脱敏」。
 * - 词片段匹配：password/pass/passwd、token、secret、credential、authorization、
 *   api-key/api_key/apikey、private-key/private_key、session-id/session_id
 * - 整键匹配：session / auth / cookie 这类短键单独判定，避免命中 revokedSessions 等统计字段
 */
const SENSITIVE_KEYS =
  /pass(word|wd)?|token|secret|credential|authorization|api[_-]?key|x-apikey|private[_-]?key|session[_-]?id/i;
const SENSITIVE_EXACT_KEYS = new Set(['session', 'auth', 'cookie', 'set-cookie', 'apikey', 'sessionid']);
const isSensitiveKey = (k: string): boolean =>
  SENSITIVE_KEYS.test(k) || SENSITIVE_EXACT_KEYS.has(k.toLowerCase());

/**
 * 审计详情脱敏（导出供单元测试直接覆盖）：
 * 敏感键打码、嵌套深度上限 4、数组截断 50、长字符串截断 500。
 * 审计日志只追加，并用 prev_hash 组成哈希链，便于事后校验未被篡改。
 */
export function sanitizeAuditDetail(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeAuditDetail(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = '***';
      } else {
        out[k] = sanitizeAuditDetail(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...`;
  return value;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  log(input: AuditInput): string {
    const createdAt = nowIso();
    const traceId = input.traceId || randomUUID();
    const detail = input.detail ? JSON.stringify(sanitizeAuditDetail(input.detail)) : null;
    // 哈希链依赖「上一条记录」：读+写必须在同一写事务内，多进程并发写才不会读到同一个 prev 导致链分叉
    this.db.tx(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
      const prevHash = prev?.hash ?? 'genesis';
      const hash = sha256Hex(
        [prevHash, traceId, input.actorId ?? '', input.actorTokenHash ?? '', input.action, input.result, input.resourceId ?? '', detail ?? '', createdAt].join('|'),
      );

      this.db.run(
        `INSERT INTO audit_logs (trace_id, actor_id, actor_token_hash, action, resource_type, resource_id, result, ip, user_agent, detail, prev_hash, hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        traceId,
        input.actorId ?? null,
        input.actorTokenHash ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.result,
        input.ip ?? null,
        (input.userAgent ?? '').slice(0, 300) || null,
        detail,
        prevHash,
        hash,
        createdAt,
      );
    });
    return traceId;
  }

  query(params: {
    action?: string;
    actorId?: string;
    resourceType?: string;
    result?: string;
    /** Token 名（Token 归属法）：按下游项目的 Token 名过滤，同名 Token 全部命中 */
    tokenName?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }): { items: Record<string, unknown>[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 20));
    const where: string[] = [];
    const args: unknown[] = [];

    if (params.action) {
      where.push('action = ?');
      args.push(params.action);
    }
    if (params.actorId) {
      where.push('actor_id = ?');
      args.push(params.actorId);
    }
    if (params.tokenName) {
      // Token 归属法：一个下游项目可能换发过多个 Token，按名字全部命中
      where.push('actor_token_hash IN (SELECT token_hash FROM api_tokens WHERE name = ?)');
      args.push(params.tokenName);
    }
    if (params.resourceType) {
      where.push('resource_type = ?');
      args.push(params.resourceType);
    }
    if (params.result) {
      where.push('result = ?');
      args.push(params.result);
    }
    if (params.from) {
      where.push('created_at >= ?');
      args.push(params.from);
    }
    if (params.to) {
      where.push('created_at <= ?');
      args.push(params.to);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`, ...args)?.c ?? 0;
    // LEFT JOIN 出 Token 名：下游项目归属在控制台/CSV 中直接可读（快照语义：Token 改名后按当前名聚合）
    const rows = this.db.all(
      `SELECT a.*, t.name AS actor_token_name FROM audit_logs a LEFT JOIN api_tokens t ON t.token_hash = a.actor_token_hash ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );

    return {
      items: rows.map((row) => ({
        ...row,
        detail: row.detail ? safeParse(row.detail as string) : null,
      })),
      total: Number(total),
      page,
      pageSize,
    };
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

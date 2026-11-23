import type { AppConfig } from './config';

/**
 * 字典覆盖层：控制台「字典管理」保存的运行时配置。
 * env 仍是基线（未覆盖时 getConfig() 行为完全不变），DB 字典只保存显式覆盖项。
 *
 * 跨进程一致性：console / npm / pypi 是三个独立进程，各自持有一份进程内覆盖层，
 * 单靠保存方的 setDictionaryOverrides() 只能让本进程生效。字典存放在共享 SQLite
 * 库（WAL），因此由 DictionaryService 在启动时注入一个纯读 loader；业务模块每次
 * 经 getConfig() 读取配置时，覆盖层按同步间隔惰性回读 DB，其他进程的保存会在
 * 间隔内自动同步过来，无需重启容器、无需广播或消息队列。
 * 保存方进程仍由 setDictionaryOverrides() 立即套用，保证本机零延迟。
 */
export interface DictionaryOverrides {
  'rateLimit.enabled'?: boolean;
  'rateLimit.windowMs'?: number;
  'rateLimit.authMax'?: number;
  'rateLimit.writeMax'?: number;
  'rateLimit.readMax'?: number;
  'rateLimit.registryMax'?: number;
  'security.scanEnabled'?: boolean;
  'security.requireSignature'?: boolean;
  'security.requireAdvisoryDb'?: boolean;
  'retention.deletedPackageDays'?: number;
  'retention.logDays'?: number;
  'backup.enabled'?: boolean;
  'backup.intervalMinutes'?: number;
  'missing.autoReport'?: boolean;
  'limits.maxNpmUploadBytes'?: number;
  'limits.maxPypiUploadBytes'?: number;
}

const RATE_LIMIT_KEYS = ['enabled', 'windowMs', 'authMax', 'writeMax', 'readMax', 'registryMax'] as const;
const SECURITY_KEYS = ['scanEnabled', 'requireSignature', 'requireAdvisoryDb'] as const;
const RETENTION_KEYS = ['deletedPackageDays', 'logDays'] as const;
/** 备份目录（backup.dir）刻意不在字典里：它决定数据落哪块盘，属于部署参数而非运行时开关 */
const BACKUP_KEYS = ['enabled', 'intervalMinutes'] as const;
const MISSING_KEYS = ['autoReport'] as const;
/**
 * 上传大小只登记业务上限，不登记 HTTP 硬天花板（maxNpmPublishBytes / maxPypiPublishBytes）。
 * 后者在 express.json / multer 初始化时固定，运行时改字典也无法突破，暴露出来只会误导运维。
 */
const LIMITS_KEYS = ['maxNpmUploadBytes', 'maxPypiUploadBytes'] as const;

/** 由 DictionaryService 注入：从共享 DB 全量读取并校验后的覆盖项（纯读，无副作用） */
export type DictionaryLoader = () => DictionaryOverrides;

export interface DictionarySyncOptions {
  /** 回读间隔（毫秒），0 表示每次读取都回读；仅测试或要求强实时时调小 */
  syncIntervalMs?: number;
  /** 回读失败回调；失败时沿用上一次已生效值，不影响请求 */
  onError?: (err: unknown) => void;
}

/** 默认 1s：三角色共享同一 WAL 库，秒级收敛即可满足运维操作，且每进程每秒最多一次查询 */
const DEFAULT_SYNC_INTERVAL_MS = 1000;
const MAX_SYNC_INTERVAL_MS = 60_000;

let current: Readonly<DictionaryOverrides> = {};
let loader: DictionaryLoader | null = null;
let onError: ((err: unknown) => void) | null = null;
let syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS;
/** -Infinity 保证注册 loader 后首次读取必定回读一次 */
let lastSyncAt = -Infinity;
let syncing = false;

function envSyncInterval(): number {
  const raw = (process.env.DICTIONARY_SYNC_INTERVAL_MS || '').trim();
  if (!raw) return DEFAULT_SYNC_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SYNC_INTERVAL_MS) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }
  return parsed;
}

/**
 * 注册 DB 读取器（传 null 注销，供测试清理）。
 * 由 CoreModule 中的 DictionaryService 在 onModuleInit 调用，三个角色进程都会注册。
 */
export function registerDictionaryLoader(fn: DictionaryLoader | null, options: DictionarySyncOptions = {}): void {
  loader = fn;
  onError = options.onError ?? null;
  syncIntervalMs = options.syncIntervalMs ?? envSyncInterval();
  lastSyncAt = -Infinity;
}

/** 立即回读一次，忽略间隔；供运维/测试显式触发，以及需要强实时的调用方使用 */
export function refreshDictionaryOverrides(): DictionaryOverrides {
  if (loader && !syncing) {
    syncing = true;
    try {
      syncNow();
    } finally {
      syncing = false;
    }
  }
  return { ...current };
}

function syncNow(): void {
  if (!loader) return;
  try {
    current = { ...loader() };
  } catch (err) {
    // DB 暂不可用（写锁、迁移中）：保留上一次已生效值，绝不能因读配置让请求失败。
    // 仍推进时间戳，避免每个请求都重试打满 DB。
    onError?.(err);
  } finally {
    lastSyncAt = Date.now();
  }
}

/**
 * 惰性同步：间隔内直接复用内存值；到期后从共享 DB 回读。
 * syncing 同时防重入——loader 内部的 DB 访问链可能再次调用 getConfig()。
 */
function maybeSync(): void {
  if (!loader || syncing) return;
  if (Date.now() - lastSyncAt < syncIntervalMs) return;
  syncing = true;
  try {
    syncNow();
  } finally {
    syncing = false;
  }
}

export function setDictionaryOverrides(next: DictionaryOverrides): void {
  current = { ...next };
  // 本进程刚把值写入共享 DB，短期内无需回读
  lastSyncAt = Date.now();
}

export function getDictionaryOverrides(): DictionaryOverrides {
  maybeSync();
  return { ...current };
}

export function clearDictionaryOverrides(): void {
  current = {};
  // 测试重置后若已注册 loader，下次读取会立即从 DB 拉回真实值
  lastSyncAt = -Infinity;
}

function overlayGroup<T extends object>(
  base: T,
  fields: readonly string[],
  overrides: Record<string, unknown>,
  prefix: string,
): T {
  const merged = { ...base } as Record<string, unknown>;
  let touched = false;
  for (const field of fields) {
    const value = overrides[`${prefix}.${field}`];
    if (value !== undefined) {
      merged[field] = value;
      touched = true;
    }
  }
  return touched ? (merged as T) : base;
}

/**
 * 在 env 基线上套用字典覆盖。无覆盖时直接返回原对象（保持既有引用语义与零开销）；
 * 有覆盖时返回浅拷贝合并结果，基线对象不被污染，清空字典后 env 默认值仍然可控。
 */
export function applyDictionaryOverrides(base: AppConfig): AppConfig {
  // getConfig() 的唯一入口：在这里做跨进程惰性回读，业务模块无需感知
  maybeSync();
  const overrides = current as unknown as Record<string, unknown>;
  if (Object.keys(overrides).length === 0) return base;

  const rateLimit = overlayGroup(base.rateLimit, RATE_LIMIT_KEYS, overrides, 'rateLimit');
  const security = overlayGroup(base.security, SECURITY_KEYS, overrides, 'security');
  const retention = overlayGroup(base.retention, RETENTION_KEYS, overrides, 'retention');
  const backup = overlayGroup(base.backup, BACKUP_KEYS, overrides, 'backup');
  const missing = overlayGroup(base.missing, MISSING_KEYS, overrides, 'missing');
  const limits = overlayGroup(base.limits, LIMITS_KEYS, overrides, 'limits');
  if (
    rateLimit === base.rateLimit &&
    security === base.security &&
    retention === base.retention &&
    backup === base.backup &&
    missing === base.missing &&
    limits === base.limits
  ) {
    return base;
  }
  return { ...base, rateLimit, security, retention, backup, missing, limits };
}

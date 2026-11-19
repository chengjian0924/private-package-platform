import type { AppConfig } from './config';

/**
 * 字典覆盖层：控制台「字典管理」保存的运行时配置。
 * env 仍是基线（未覆盖时 getConfig() 行为完全不变），DB 字典只保存显式覆盖项；
 * 保存后由 DictionaryService 调用 setDictionaryOverrides() 即时生效，
 * 限流中间件、安全扫描等业务模块继续从 getConfig() 读取，无需感知来源。
 */
export interface DictionaryOverrides {
  'rateLimit.enabled'?: boolean;
  'rateLimit.windowMs'?: number;
  'rateLimit.authMax'?: number;
  'rateLimit.writeMax'?: number;
  'rateLimit.readMax'?: number;
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

const RATE_LIMIT_KEYS = ['enabled', 'windowMs', 'authMax', 'writeMax', 'readMax'] as const;
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

let current: Readonly<DictionaryOverrides> = {};

export function setDictionaryOverrides(next: DictionaryOverrides): void {
  current = { ...next };
}

export function getDictionaryOverrides(): DictionaryOverrides {
  return { ...current };
}

export function clearDictionaryOverrides(): void {
  current = {};
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

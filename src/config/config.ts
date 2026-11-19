import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyDictionaryOverrides,
  clearDictionaryOverrides,
} from './overrides';

export interface TrustedKey {
  keyId: string;
  pem: string;
}

/**
 * 进程角色：all 为单进程三合一；console/npm/pypi 为拆分部署，
 * 分别只暴露控制台 API、npm registry、PyPI 协议入口。
 */
export type ProcessRole = 'all' | 'console' | 'npm' | 'pypi';

const PROCESS_ROLES: ProcessRole[] = ['all', 'console', 'npm', 'pypi'];

/** SNTP 时钟源：审计时间与 Token 过期判断的可信基准 */
export interface ClockConfig {
  /** SNTP 服务器；空表示不采样 */
  ntpServer: string;
  ntpIntervalMs: number;
  ntpMaxOffsetMs: number;
}

export interface SecurityConfig {
  /** 漏洞扫描与校验总开关：关闭后上传/导入跳过安全扫描直接入库（字典管理可运行时切换） */
  scanEnabled: boolean;
  /** 达到该等级直接拦截，不入库 */
  blockSeverity: 'critical' | 'high';
  /** 达到该等级进入隔离区，等待人工复核 */
  quarantineSeverity: 'high' | 'medium';
  /** 定期复检间隔（秒），<=0 表示关闭定时任务 */
  rescanIntervalSec: number;
  /** 低峰窗口起止小时（0-23），两者均为 -1 表示不限制；支持跨零点，如 23 → 5 */
  rescanWindowStartHour: number;
  rescanWindowEndHour: number;
  /** 复检逐包间隔（毫秒），降低 CPU 占空比，给在线请求让出扫描槽 */
  rescanPauseMs: number;
  requireSignature: boolean;
  /** 漏洞库未初始化时是否禁止发布（默认只告警） */
  requireAdvisoryDb: boolean;
  /** 同时执行的扫描数量上限，避免大包解析长期占用事件循环 */
  scanConcurrency: number;
  /** 等待队列上限，超过后直接拒绝，防止无界堆积 */
  maxScanQueue: number;
  /** 单次扫描超时，超时按扫描失败处理（fail-closed） */
  scanTimeoutMs: number;
  /** 孤儿对象/隔离目录的清理宽限期（小时），避免误删正在写入的文件 */
  orphanGraceHours: number;
  /** 已完成导入批次的文件保留天数，过期后由维护任务回收 */
  batchRetentionDays: number;
  trustedKeys: TrustedKey[];
  /** 单文件扫描大小上限，超出则只做摘要与结构校验 */
  maxScanFileBytes: number;
  /** 归档内最多解析的条目数，防止 zip bomb */
  maxScanEntries: number;
  /** 归档解压后累计可读字节上限 */
  maxScanTotalBytes: number;
  /** 声明解压总量与压缩包体积之比上限，超过按压缩炸弹拒绝 */
  maxCompressionRatio: number;
  /** 单个嵌套归档允许保留并递归扫描的字节数 */
  maxNestedArchiveBytes: number;
  /** 嵌套归档递归层数，0 表示只标记不展开 */
  maxNestedDepth: number;
  /** 隔离区目录，可通过 QUARANTINE_DIR 指向独立挂载卷 */
  quarantineDir: string;
  /** 隔离样本保留天数，超期且未复核的由维护任务销毁 */
  quarantineRetentionDays: number;
  /** 超期销毁检查间隔（毫秒），<=0 表示关闭自动销毁 */
  quarantinePurgeIntervalMs: number;
  /** 扫描记录与报告保留天数（RV-26），超期清理但每个版本至少保留最近一次；0 表示关闭 */
  scanRetentionDays: number;
}

export interface AppConfig {
  envName: string;
  /** 进程角色：决定了加载哪些路由模块，以及默认监听端口 */
  role: ProcessRole;
  port: number;
  /** 监听地址：默认 0.0.0.0；生产走 Nginx 网关时应设 127.0.0.1，杜绝绕过网关直连（A4） */
  bindHost: string;
  dataDir: string;
  dbPath: string;
  objectDir: string;
  metaDir: string;
  batchDir: string;
  tmpDir: string;
  publicDir: string;
  publicBaseUrl: string;
  /** registry 专属对外基址：多进程分端口部署时客户端直连各自入口，未设置时回落 publicBaseUrl */
  npmBaseUrl: string;
  pypiBaseUrl: string;
  /** 生产环境允许 http 基址（无 TLS 网关/应用内 HTTPS 时的显式豁免） */
  allowInsecureBaseUrl: boolean;
  sessionTtlSec: number;
  sessionIdleTtlSec: number;
  authCacheTtlMs: number;
  /** 本地账号认证：口令强度、失败锁定与首启管理员引导 */
  auth: {
    passwordMinLength: number;
    loginMaxFailures: number;
    loginLockMinutes: number;
    bootstrapUsername: string;
    /** 内置管理员与新建管理员的固定初始密码（首登强制改密） */
    initialPasswordAdmin: string;
    /** 新建 developer / reader 账号的固定初始密码（首登强制改密） */
    initialPasswordUser: string;
  };
  limits: {
    maxItems: number;
    /** 批量导入单文件上限（env 基线，不进字典） */
    maxUploadBytes: number;
    /**
     * npm publish 的 HTTP body 硬天花板（含 base64，约为 tarball 的 1.33 倍）。
     * 在 express.json 启动时固定读取，字典无法突破；仅防止超大请求打爆内存，
     * 真正的业务上限由 limits.maxNpmUploadBytes（字典可控）决定。
     */
    maxNpmPublishBytes: number;
    /** twine 上传的 multer 单文件硬天花板，语义同上，字典无法突破 */
    maxPypiPublishBytes: number;
    /** npm 解码后包文件大小上限（业务层，字典可控） */
    maxNpmUploadBytes: number;
    /** PyPI 上传文件大小上限（业务层，字典可控） */
    maxPypiUploadBytes: number;
  };
  /** /metrics 采集令牌；为空表示不校验（生产建议设置，并用网络 ACL 限制来源） */
  metrics: {
    token: string;
  };
  /** 结构化日志：level 过滤 + 输出格式 */
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
    /** 是否额外按天落盘（journald 采集的部署可关闭，关闭后日志保留策略自然空转） */
    fileEnabled: boolean;
    /** 日志目录，默认 <dataDir>/logs */
    dir: string;
  };
  /** 保留与清理：超期未恢复的软删除包、日志文件的存活天数（0 表示不自动清理） */
  retention: {
    deletedPackageDays: number;
    logDays: number;
  };
  /**
   * 包文件备份：开启后按间隔把对象存储里的包增量复制到备份目录。
   * 关闭只停止后续备份，已生成的备份文件不会被删除（备份目录也不参与保留期清理）。
   */
  backup: {
    enabled: boolean;
    /** 增量同步间隔（分钟），每轮只补齐备份目录里缺失的对象 */
    intervalMinutes: number;
    /** 备份目录，默认 <dataDir>/backups */
    dir: string;
  };
  /**
   * 缺包自动上报：配置本平台为 npm/pypi 源的下游项目拉取失败（404）时，
   * registry 静默记一条缺失依赖，供管理端查看并补包。显式上报接口不受此开关影响。
   */
  missing: {
    autoReport: boolean;
  };
  /** 进程内限流：按 来源 IP + 请求类别 计数 */
  rateLimit: {
    enabled: boolean;
    windowMs: number;
    authMax: number;
    writeMax: number;
    readMax: number;
  };
  /** 磁盘水位保护：百分比与最小剩余空间双阈值，任一触发即降级 */
  storage: {
    diskAlertPercent: number;
    diskReadonlyPercent: number;
    minFreeBytes: number;
    checkIntervalMs: number;
  };
  /** 优雅停机：先排空在途请求，超过硬超时强制退出 */
  shutdown: {
    graceMs: number;
    hardTimeoutMs: number;
  };
  clock: ClockConfig;
  defaults: { node: string; python: string };
  defaultBatchMode: 'partial' | 'strict';
  security: SecurityConfig;
}

let cached: AppConfig | undefined;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`缺少必填环境变量 ${key}，请检查 .env.development / .env.test`);
  }
  return value;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`环境变量 ${key} 必须为数字，当前值: ${raw}`);
  return Math.trunc(parsed);
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

/** 拆分部署的默认端口：控制台 3000、npm 3001、pypi 3002（测试环境整体 +100，避免与本机开发端口冲突） */
function defaultPort(envName: string, role: ProcessRole): number {
  const base = envName === 'test' ? 3100 : 3000;
  if (role === 'npm') return base + 1;
  if (role === 'pypi') return base + 2;
  return base;
}

function severityEnv(key: string, fallback: string, allowed: string[]): string {
  const raw = (process.env[key] || fallback).toLowerCase();
  if (!allowed.includes(raw)) throw new Error(`环境变量 ${key} 取值非法: ${raw}，可选 ${allowed.join('/')}`);
  return raw;
}

/** 可信公钥通过 JSON 数组配置：[{"keyId":"corp-2026","pem":"-----BEGIN PUBLIC KEY-----..."}] */
function trustedKeysEnv(key: string): TrustedKey[] {
  const raw = process.env[key];
  if (!raw || raw.trim() === '' || raw.trim() === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`环境变量 ${key} 必须是合法 JSON 数组`);
  }
  if (!Array.isArray(parsed)) throw new Error(`环境变量 ${key} 必须是数组`);
  return parsed.map((item, index) => {
    if (typeof item === 'string') return { keyId: `key-${index}`, pem: item };
    const obj = item as Partial<TrustedKey>;
    if (!obj || typeof obj.pem !== 'string' || obj.pem.trim() === '') {
      throw new Error(`环境变量 ${key} 第 ${index} 项缺少 pem`);
    }
    return { keyId: obj.keyId || `key-${index}`, pem: obj.pem };
  });
}

/**
 * 进程内单例配置；服务与测试均通过此函数读取，保证两套环境参数唯一来源。
 * 返回值 = env 基线 + 字典覆盖（字典管理保存的运行时配置），
 * 无覆盖时返回基线对象本身，与历史行为完全一致。
 */
export function getConfig(): AppConfig {
  if (!cached) buildConfig();
  return applyDictionaryOverrides(cached!);
}

/** env 基线配置：不含字典覆盖，字典管理用于展示「环境默认值」与回退依据 */
export function getEnvConfig(): AppConfig {
  if (!cached) buildConfig();
  return cached!;
}

function buildConfig(): void {
  const envName = process.env.NODE_ENV || 'development';
  // 角色取值非法直接拒绝启动，避免拼错后静默退化成单进程（会重复跑后台任务）
  const roleRaw = (process.env.PROCESS_ROLE || 'all').trim().toLowerCase();
  const role = PROCESS_ROLES.includes(roleRaw as ProcessRole) ? (roleRaw as ProcessRole) : null;
  if (!role) {
    throw new Error(`环境变量 PROCESS_ROLE 取值非法: ${roleRaw}，可选 ${PROCESS_ROLES.join('/')}`);
  }
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data/dev');
  const mode = (process.env.BATCH_DEFAULT_MODE || 'partial').toLowerCase();
  // 配置层先收敛为字面量联合类型，避免下游再做类型断言
  const blockSeverity = severityEnv('SECURITY_BLOCK_SEVERITY', 'critical', ['critical', 'high']);
  const quarantineSeverity = severityEnv('SECURITY_QUARANTINE_SEVERITY', 'high', ['high', 'medium']);

  // A-05：85% 告警、95% 只读；同时叠加最小剩余空间，避免大共享盘上百分比失真
  const diskAlertPercent = intEnv('DISK_ALERT_PERCENT', 85);
  const diskReadonlyPercent = intEnv('DISK_READONLY_PERCENT', 95);
  if (diskAlertPercent <= 0 || diskReadonlyPercent > 100 || diskAlertPercent >= diskReadonlyPercent) {
    throw new Error(
      `磁盘水位阈值不合法：DISK_ALERT_PERCENT=${diskAlertPercent}、DISK_READONLY_PERCENT=${diskReadonlyPercent}，需满足 0 < 告警 < 只读 ≤ 100`,
    );
  }

  // A-06：低峰窗口默认关闭（-1），由运维按机房负载显式开启；逐包间隔默认 200ms
  const rescanWindowStartHour = intEnv('SECURITY_RESCAN_WINDOW_START', -1);
  const rescanWindowEndHour = intEnv('SECURITY_RESCAN_WINDOW_END', -1);
  const windowDisabled = rescanWindowStartHour === -1 && rescanWindowEndHour === -1;
  const windowValid =
    rescanWindowStartHour >= 0 &&
    rescanWindowStartHour <= 23 &&
    rescanWindowEndHour >= 0 &&
    rescanWindowEndHour <= 23 &&
    rescanWindowStartHour !== rescanWindowEndHour;
  if (!windowDisabled && !windowValid) {
    throw new Error(
      `复检低峰窗口不合法：SECURITY_RESCAN_WINDOW_START=${rescanWindowStartHour}、SECURITY_RESCAN_WINDOW_END=${rescanWindowEndHour}，需同时为 -1 或 0-23 内不相等的小时`,
    );
  }
  const rescanPauseMs = intEnv('SECURITY_RESCAN_PAUSE_MS', 200);
  if (rescanPauseMs < 0) {
    throw new Error(`复检逐包间隔不合法：SECURITY_RESCAN_PAUSE_MS=${rescanPauseMs}，需 ≥ 0`);
  }
  const shutdownGraceMs = intEnv('SHUTDOWN_GRACE_MS', 25_000);
  const shutdownHardTimeoutMs = intEnv('SHUTDOWN_HARD_TIMEOUT_MS', 35_000);
  if (shutdownGraceMs <= 0 || shutdownHardTimeoutMs <= shutdownGraceMs) {
    throw new Error(
      `停机超时配置不合法：SHUTDOWN_GRACE_MS=${shutdownGraceMs}、SHUTDOWN_HARD_TIMEOUT_MS=${shutdownHardTimeoutMs}，需满足 0 < 宽限 < 硬超时`,
    );
  }

  // 本地认证：阈值一次校验完，避免出现“0 次失败即锁定”这类上线后才炸的配置
  const passwordMinLength = intEnv('PASSWORD_MIN_LENGTH', 8);
  const loginMaxFailures = intEnv('LOGIN_MAX_FAILURES', 5);
  const loginLockMinutes = intEnv('LOGIN_LOCK_MINUTES', 15);  if (passwordMinLength < 8 || passwordMinLength > 64) {
    throw new Error(`密码最小长度不合法：PASSWORD_MIN_LENGTH=${passwordMinLength}，需在 8-64 之间`);
  }
  if (loginMaxFailures < 1 || loginMaxFailures > 100) {
    throw new Error(`登录失败次数上限不合法：LOGIN_MAX_FAILURES=${loginMaxFailures}，需在 1-100 之间`);
  }
  if (loginLockMinutes < 1 || loginLockMinutes > 1440) {
    throw new Error(`登录锁定时长不合法：LOGIN_LOCK_MINUTES=${loginLockMinutes}，需在 1-1440 之间`);
  }

  // 保留与清理：包与日志的存活天数，0 表示不自动清理；上限 10 年挡掉手滑填的 9999
  const deletedPackageRetentionDays = intEnv('DELETED_PACKAGE_RETENTION_DAYS', 30);
  const logRetentionDays = intEnv('LOG_RETENTION_DAYS', 180);
  for (const [envName, value] of [
    ['DELETED_PACKAGE_RETENTION_DAYS', deletedPackageRetentionDays],
    ['LOG_RETENTION_DAYS', logRetentionDays],
  ] as const) {
    if (value < 0 || value > 3650) {
      throw new Error(`保留天数不合法：${envName}=${value}，需在 0-3650 之间（0 表示不自动清理）`);
    }
  }

  // 包文件备份：默认开启、每小时增量一次；间隔上限一周，0 视为配置错误（关闭备份请用开关，不要填 0）
  const backupIntervalMinutes = intEnv('BACKUP_INTERVAL_MINUTES', 60);
  if (backupIntervalMinutes < 1 || backupIntervalMinutes > 10_080) {
    throw new Error(
      `备份间隔不合法：BACKUP_INTERVAL_MINUTES=${backupIntervalMinutes}，需在 1-10080 之间（要停用备份请设 BACKUP_ENABLED=false）`,
    );
  }
  const backupDir = path.resolve(
    process.cwd(),
    (process.env.BACKUP_DIR || '').trim() || path.join(dataDir, 'backups'),
  );
  // 备份目录与对象目录重合会把「备份」做成自我复制，直接拒绝而不是留到运行期才发现
  if (backupDir === path.join(dataDir, 'objects')) {
    throw new Error(`备份目录不能与对象目录相同：BACKUP_DIR=${backupDir}`);
  }

  // SNTP 时钟源：用于观测主机时钟偏移，审计时间与 Token 过期判断依赖它
  const ntpServer = (process.env.NTP_SERVER || '').trim();
  const ntpIntervalMs = intEnv('NTP_CHECK_INTERVAL_MS', 300_000);
  const ntpMaxOffsetMs = intEnv('NTP_MAX_OFFSET_MS', 1000);
  if (ntpIntervalMs < 1000) {
    throw new Error(`NTP 采样间隔不合法：NTP_CHECK_INTERVAL_MS=${ntpIntervalMs}，需 ≥ 1000`);
  }
  if (ntpMaxOffsetMs <= 0) {
    throw new Error(`NTP 偏移阈值不合法：NTP_MAX_OFFSET_MS=${ntpMaxOffsetMs}，需 > 0`);
  }

  // B6：隔离区可挂到独立卷；超期销毁默认 30 天、每天检查一次
  const quarantineDir = path.resolve(
    process.cwd(),
    (process.env.QUARANTINE_DIR || '').trim() || path.join(dataDir, 'quarantine'),
  );
  const quarantineRetentionDays = intEnv('QUARANTINE_RETENTION_DAYS', 30);
  const quarantinePurgeIntervalMs = intEnv('QUARANTINE_PURGE_INTERVAL_MS', 24 * 60 * 60 * 1000);
  if (quarantineRetentionDays < 1) {
    throw new Error(`隔离样本保留期不合法：QUARANTINE_RETENTION_DAYS=${quarantineRetentionDays}，需 ≥ 1`);
  }
  if (quarantinePurgeIntervalMs < 0) {
    throw new Error(`隔离区销毁间隔不合法：QUARANTINE_PURGE_INTERVAL_MS=${quarantinePurgeIntervalMs}，需 ≥ 0`);
  }

  cached = {
    envName,
    role,
    port: intEnv('PORT', defaultPort(envName, role)),
    // A4：默认保持全网卡监听兼容直连部署；配 Nginx 时由 .env 设 BIND_HOST=127.0.0.1
    bindHost: (process.env.BIND_HOST || '').trim() || '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'platform.db'),
    objectDir: path.join(dataDir, 'objects'),
    metaDir: path.join(dataDir, 'meta'),
    batchDir: path.join(dataDir, 'batches'),
    tmpDir: path.join(dataDir, 'tmp'),
    publicDir: path.resolve(__dirname, '..', '..', 'public'),
    publicBaseUrl: requireEnv('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    // 单进程部署不设 NPM/PYPI_BASE_URL 即与控制台同址；拆进程后各自指向独立入口
    npmBaseUrl: (process.env.NPM_BASE_URL || requireEnv('PUBLIC_BASE_URL')).replace(/\/+$/, ''),
    pypiBaseUrl: (process.env.PYPI_BASE_URL || requireEnv('PUBLIC_BASE_URL')).replace(/\/+$/, ''),
    allowInsecureBaseUrl: boolEnv('ALLOW_INSECURE_BASE_URL', false),
    sessionTtlSec: intEnv('SESSION_TTL_SEC', 28800),
    sessionIdleTtlSec: intEnv('SESSION_IDLE_TTL_SEC', 1800),
    authCacheTtlMs: intEnv('AUTH_CACHE_TTL_MS', 5000),
    auth: {
      passwordMinLength,
      loginMaxFailures,
      loginLockMinutes,
      bootstrapUsername: (process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim() || 'admin',
      // 固定初始密码：仅用于建号，首次登录必须改密；不参与强度校验（本身就是一次性弱口令）
      initialPasswordAdmin: process.env.INITIAL_PASSWORD_ADMIN || 'admin123',
      initialPasswordUser: process.env.INITIAL_PASSWORD_USER || '123123123',
    },
    limits: {
      maxItems: intEnv('MAX_ITEMS', 5000),
      maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 200 * 1024 * 1024),
      // HTTP body 硬天花板：200MB 包体经 base64 膨胀约 1.33 倍，留到 288MB 容纳元数据。
      // 该值在 express.json 初始化时固定，字典只控制下面的业务上限，不能突破此天花板。
      // 实测峰值内存约为请求体的 3 倍（JSON 解析 + 分块解码 + 扫描），上调需评估内存。
      maxNpmPublishBytes: intEnv('MAX_NPM_PUBLISH_BYTES', 288 * 1024 * 1024),
      // twine 走磁盘落盘（multer diskStorage），硬天花板按等容量设置；字典不能突破。
      maxPypiPublishBytes: intEnv('MAX_PYPI_PUBLISH_BYTES', 288 * 1024 * 1024),
      // 业务上限：默认 200MB，可由控制台「字典管理」运行时调整（min 1MB / max 256MB）。
      maxNpmUploadBytes: intEnv('MAX_NPM_UPLOAD_BYTES', 200 * 1024 * 1024),
      maxPypiUploadBytes: intEnv('MAX_PYPI_UPLOAD_BYTES', 200 * 1024 * 1024),
    },
    metrics: {
      token: process.env.METRICS_TOKEN || '',
    },
    // 测试环境默认只输出 warn 以上，避免用例刷屏；生产默认 json 便于日志采集
    log: {
      level: (process.env.LOG_LEVEL || (envName === 'test' ? 'warn' : envName === 'production' ? 'info' : 'debug')) as
        | 'debug'
        | 'info'
        | 'warn'
        | 'error',
      format: (process.env.LOG_FORMAT || (envName === 'development' ? 'text' : 'json')) as 'json' | 'text',
      // 落盘开关与目录：journald 采集的部署可关闭；测试环境默认关闭，避免每个用例往临时目录写日志
      fileEnabled: boolEnv('LOG_FILE_ENABLED', envName !== 'test'),
      dir: path.resolve(process.cwd(), (process.env.LOG_DIR || '').trim() || path.join(dataDir, 'logs')),
    },
    // 软删除包与日志文件的存活期：超期未恢复的软删除包硬删除，超期日志文件删除
    retention: {
      deletedPackageDays: deletedPackageRetentionDays,
      logDays: logRetentionDays,
    },
    // 包文件备份：默认开启；字典里可关闭或改间隔，关闭后已有备份保留
    backup: {
      enabled: boolEnv('BACKUP_ENABLED', true),
      intervalMinutes: backupIntervalMinutes,
      dir: backupDir,
    },
    // 缺包自动上报：默认开启；关闭后 404 不再静默登记，显式上报接口仍可用
    missing: {
      autoReport: boolEnv('MISSING_AUTO_REPORT', true),
    },
    // 测试环境默认关闭，避免用例之间共享计数导致误报；需要时显式打开
    rateLimit: {
      enabled: boolEnv('RATE_LIMIT_ENABLED', envName !== 'test'),
      windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60_000),
      authMax: intEnv('RATE_LIMIT_AUTH_MAX', 10),
      writeMax: intEnv('RATE_LIMIT_WRITE_MAX', 60),
      readMax: intEnv('RATE_LIMIT_READ_MAX', 600),
    },
    storage: {
      diskAlertPercent,
      diskReadonlyPercent,
      minFreeBytes: intEnv('DISK_MIN_FREE_BYTES', 1024 * 1024 * 1024),
      checkIntervalMs: intEnv('DISK_CHECK_INTERVAL_MS', 60_000),
    },
    shutdown: {
      graceMs: shutdownGraceMs,
      hardTimeoutMs: shutdownHardTimeoutMs,
    },
    clock: {
      ntpServer,
      ntpIntervalMs,
      ntpMaxOffsetMs,
    },
    defaults: {
      node: process.env.DEFAULT_NODE_TARGET || '',
      python: process.env.DEFAULT_PYTHON_TARGET || '',
    },
    defaultBatchMode: mode === 'strict' ? 'strict' : 'partial',
    security: {
      scanEnabled: boolEnv('SECURITY_SCAN_ENABLED', true),
      blockSeverity: blockSeverity === 'high' ? 'high' : 'critical',
      quarantineSeverity: quarantineSeverity === 'medium' ? 'medium' : 'high',
      rescanIntervalSec: intEnv('SECURITY_RESCAN_INTERVAL_SEC', 86400),
      rescanWindowStartHour,
      rescanWindowEndHour,
      rescanPauseMs,
      requireSignature: boolEnv('SECURITY_REQUIRE_SIGNATURE', false),
      requireAdvisoryDb: boolEnv('SECURITY_REQUIRE_ADVISORY_DB', false),
      scanConcurrency: intEnv('SECURITY_SCAN_CONCURRENCY', 2),
      maxScanQueue: intEnv('SECURITY_MAX_SCAN_QUEUE', 50),
      scanTimeoutMs: intEnv('SECURITY_SCAN_TIMEOUT_MS', 60_000),
      orphanGraceHours: intEnv('SECURITY_ORPHAN_GRACE_HOURS', 24),
      batchRetentionDays: intEnv('SECURITY_BATCH_RETENTION_DAYS', 7),
      trustedKeys: trustedKeysEnv('SECURITY_TRUSTED_KEYS'),
      // 与上传硬天花板对齐：否则 200MB 包会先被 INT-010 拦截，导致「允许上传」形同虚设
      maxScanFileBytes: intEnv('SECURITY_MAX_SCAN_FILE_BYTES', 288 * 1024 * 1024),
      maxScanEntries: intEnv('SECURITY_MAX_SCAN_ENTRIES', 5000),
      maxScanTotalBytes: intEnv('SECURITY_MAX_SCAN_TOTAL_BYTES', 32 * 1024 * 1024),
      maxCompressionRatio: intEnv('SECURITY_MAX_COMPRESSION_RATIO', 100),
      maxNestedArchiveBytes: intEnv('SECURITY_MAX_NESTED_ARCHIVE_BYTES', 8 * 1024 * 1024),
      maxNestedDepth: intEnv('SECURITY_MAX_NESTED_DEPTH', 2),
      quarantineDir,
      quarantineRetentionDays,
      quarantinePurgeIntervalMs,
      scanRetentionDays: intEnv('SECURITY_SCAN_RETENTION_DAYS', 180),
    },
  };
}

/** 仅供测试在同一进程内切换环境变量后复用的场景；同时清掉字典覆盖，保证用例间互不串扰 */
export function resetConfigCache(): void {
  cached = undefined;
  clearDictionaryOverrides();
}

/** 配置校验失败：携带完整问题清单，便于一次改完而不是逐条试错 */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`生产配置校验未通过（${problems.length} 项）`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const MIN_NODE = { major: 22, minor: 5 };

function nodeVersion(): { major: number; minor: number } {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number(part));
  return { major, minor };
}

/**
 * 生产环境硬性检查：这些项一旦放行就等于放弃身份鉴别或传输安全，
 * 因此统一 fail-fast，不提供“只告警”的降级开关。
 */
export function productionConfigProblems(cfg: AppConfig): string[] {
  if (cfg.envName !== 'production') return [];
  const problems: string[] = [];

  // 内置管理员初始密码是固定弱口令，靠 must_change_password 强制首登改密兜底，
  // 因此这里不再对它做强度校验（校验会导致默认 admin123 直接拒绝建号）

  // 显式豁免 ALLOW_INSECURE_BASE_URL 用于直连部署；默认仍要求 HTTPS（三个入口一并校验）
  for (const [label, base] of [
    ['PUBLIC_BASE_URL', cfg.publicBaseUrl],
    ['NPM_BASE_URL', cfg.npmBaseUrl],
    ['PYPI_BASE_URL', cfg.pypiBaseUrl],
  ] as const) {
    if (!base.startsWith('https://') && !cfg.allowInsecureBaseUrl) {
      problems.push(
        `${label} 必须为 https://（当前 ${base}）；确需直连 HTTP 请显式设置 ALLOW_INSECURE_BASE_URL=true`,
      );
    }
  }

  const version = nodeVersion();
  if (version.major < MIN_NODE.major || (version.major === MIN_NODE.major && version.minor < MIN_NODE.minor)) {
    problems.push(`Node.js 版本过低（当前 ${process.versions.node}），要求 ≥ ${MIN_NODE.major}.${MIN_NODE.minor}`);
  }

  // 数据目录先建后测写权限，避免运行期才发现无法落盘
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
  } catch (err) {
    problems.push(`DATA_DIR 不可写（${cfg.dataDir}）：${(err as Error).message}`);
  }

  return problems;
}

/** 启动前调用：非生产环境直接放行，生产环境发现问题即抛错 */
export function assertProductionReady(): void {
  const problems = productionConfigProblems(getConfig());
  if (problems.length) throw new ConfigError(problems);
}

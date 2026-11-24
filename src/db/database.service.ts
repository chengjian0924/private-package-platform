import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { getConfig } from '../config/config';
import { fallbackPypiVersionKey, pep440VersionKey } from '../packages/pep440';

export type DbRow = Record<string, unknown>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
-- busy_timeout 统一在 onModuleInit 里于 SCHEMA 之前设置（10s）。
-- 这里不能再写一次，否则会把它覆盖成更小的值：三进程共享一个库时，
-- 长事务并发下 5s 更容易提前 SQLITE_BUSY。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'reader',
  -- human: 人员账号，可口令登录；service: 机器账号（CI/流水线），口令随机不可知，仅能用 API 令牌
  account_type TEXT NOT NULL DEFAULT 'human',
  status TEXT NOT NULL DEFAULT 'active',
  idp_updated_at TEXT,
  -- 本地账号认证：口令只存 scrypt 哈希，绝不落明文
  password_hash TEXT,
  password_updated_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idp_sid TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  client_ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  -- 令牌到期时间；NULL 表示不过期（加列前的存量令牌都按此处理）
  expires_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  ecosystem TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  scope TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  -- npm 自定义 dist-tags（JSON，如 {"beta":"2.0.0"}）；latest 始终按 semver 动态计算，不落库
  dist_tags TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(ecosystem, normalized_name)
);

CREATE TABLE IF NOT EXISTS package_versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  normalized_version TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  metadata TEXT,
  compatibility TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  uploader_id TEXT,
  source TEXT NOT NULL,
  signature TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(package_id, normalized_version)
);
CREATE INDEX IF NOT EXISTS idx_versions_pkg ON package_versions(package_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'partial',
  status TEXT NOT NULL,
  operator_id TEXT,
  targets TEXT,
  stats TEXT,
  report_key TEXT,
  manifest_key TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS import_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  item_no INTEGER NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  file_path TEXT,
  sha256 TEXT,
  status TEXT NOT NULL,
  reason_codes TEXT,
  detail TEXT,
  package_version_id TEXT,
  UNIQUE(batch_id, item_no)
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON import_batch_items(batch_id);

CREATE TABLE IF NOT EXISTS missing_dependencies (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  ecosystem TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  version_spec TEXT NOT NULL,
  project_id TEXT,
  hits INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_version_id TEXT,
  -- 来源：ci=下游显式上报，registry=拉取失败自动探针，import=批量导入静默登记
  source TEXT NOT NULL DEFAULT 'ci',
  -- 自动探针记录最后一次请求方元数据（按去重键覆盖，不随 hits 增长）
  requester_ip TEXT,
  user_agent TEXT,
  auth_present INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_missing_status ON missing_dependencies(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  result TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  prev_hash TEXT,
  hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload TEXT,
  trace_id TEXT,
  occurred_at TEXT NOT NULL
);

-- 安全校验：扫描主记录（上传触发 / 定期复检）
CREATE TABLE IF NOT EXISTS security_scans (
  id TEXT PRIMARY KEY,
  package_version_id TEXT,
  ecosystem TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  verdict TEXT NOT NULL,
  disposition TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  signature_status TEXT NOT NULL DEFAULT 'unsigned',
  signature TEXT,
  rule_version TEXT,
  advisory_snapshot_id TEXT,
  dimensions TEXT,
  report_key TEXT,
  quarantine_kind TEXT,
  quarantine_path TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT,
  actor_id TEXT,
  source TEXT,
  released_at TEXT,
  released_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_created ON security_scans(created_at);
CREATE INDEX IF NOT EXISTS idx_scans_sha ON security_scans(sha256);
CREATE INDEX IF NOT EXISTS idx_scans_disposition ON security_scans(disposition);

-- 扫描任务队列：仅记录「待执行/执行中」的上传扫描，进程重启后可恢复。
-- 不复用 security_scans 的原因是该表 verdict/disposition 非空，排队态会污染统计与 CSV。
CREATE TABLE IF NOT EXISTS security_scan_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  scan_id TEXT,
  ecosystem TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL,
  trace_id TEXT,
  actor_id TEXT,
  signature TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
-- 部分唯一索引：同一幂等键只允许一个在途任务，完成后可再次提交
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_jobs_active ON security_scan_jobs(idempotency_key)
  WHERE status IN ('PENDING', 'RUNNING');
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON security_scan_jobs(status);

-- 安全校验：逐条风险明细，dimension 覆盖六维
CREATE TABLE IF NOT EXISTS security_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  location TEXT,
  evidence TEXT,
  remediation TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON security_findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);

-- 漏洞库本地快照（CVE / CNVD / OSV 导入后落库，供离线匹配）
CREATE TABLE IF NOT EXISTS vulnerability_advisories (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  package_name TEXT NOT NULL,
  affected_range TEXT NOT NULL,
  severity TEXT NOT NULL,
  cvss REAL,
  title TEXT,
  description TEXT,
  fixed_version TEXT,
  refs TEXT,
  published_at TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE(source, advisory_id, ecosystem, package_name, affected_range)
);
CREATE INDEX IF NOT EXISTS idx_advisory_pkg ON vulnerability_advisories(ecosystem, package_name);
CREATE INDEX IF NOT EXISTS idx_advisory_external ON vulnerability_advisories(advisory_id);

-- 规则包版本快照：报告需要能复现「当时用的是哪套规则」
CREATE TABLE IF NOT EXISTS security_rule_packs (
  version TEXT PRIMARY KEY,
  rule_count INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

-- 漏洞库导入快照：每次导入生成一条，扫描记录引用其 id
CREATE TABLE IF NOT EXISTS advisory_snapshots (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  advisory_count INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  imported_by TEXT,
  created_at TEXT NOT NULL
);

-- 定期复检运行记录
CREATE TABLE IF NOT EXISTS security_rescan_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  new_findings INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- A4：证书相关数据表保留（只读），业务入口已裁剪，后续迭代直接复用
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  subject TEXT,
  serial TEXT,
  status TEXT,
  issued_at TEXT,
  created_at TEXT
);

-- 字典管理：运行时配置覆盖项，value 为 JSON 编码后的标量；
-- 读取时与 env 基线合并（getConfig()），保存后即时生效并落审计
CREATE TABLE IF NOT EXISTS sys_dictionary (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 用户手册：管理员编辑的章节 HTML 覆盖项；未登记的章节继续用内置静态内容
CREATE TABLE IF NOT EXISTS user_manual (
  section_id TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * node:sqlite 同步封装：单连接 + WAL。
 * 所有写操作在同一连接上串行，天然避免并发写冲突。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Database');
  private db!: DatabaseSync;

  onModuleInit(): void {
    const cfg = getConfig();
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    this.db = new DatabaseSync(cfg.dbPath);
    // 必须在执行 SCHEMA 前设置：SCHEMA 首句是 journal_mode=WAL，切换日志模式需要独占锁，
    // 拆分部署时多个角色进程同时启动会争抢该锁。若在 SCHEMA 内才设置 busy_timeout，
    // WAL 切换发生在超时生效之前，后启动的进程会直接抛 SQLITE_BUSY 而启动失败。
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.logger.log(`数据库已就绪: ${cfg.dbPath}`);
  }

  /** 轻量列迁移：CREATE TABLE IF NOT EXISTS 不会补列，存量库在此补齐 */
  private migrate(): void {
    this.ensureColumn('package_versions', 'signature', 'TEXT');
    this.ensureColumn('security_scans', 'signature', 'TEXT');
    this.ensureColumn('security_scans', 'rule_version', 'TEXT');
    this.ensureColumn('security_scans', 'advisory_snapshot_id', 'TEXT');
    // 本地认证：存量库补列后为 NULL，这些账号需由管理员重置口令才能登录
    this.ensureColumn('users', 'password_hash', 'TEXT');
    this.ensureColumn('users', 'password_updated_at', 'TEXT');
    this.ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('users', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('users', 'locked_until', 'TEXT');
    // 机器账号：存量库补列后按 human 处理，保持原有口令登录行为不变
    this.ensureColumn('users', 'account_type', "TEXT NOT NULL DEFAULT 'human'");
    // Token 归属法（下游项目追踪）：审计行记录认证所用 Token 的哈希，可空（会话/密码认证为 NULL）
    this.ensureColumn('audit_logs', 'actor_token_hash', 'TEXT');
    // npm 自定义 dist-tags 持久化（RV 系列完善项）：存量库补列后为 NULL，packument 输出时按空对象处理
    this.ensureColumn('packages', 'dist_tags', 'TEXT');
    // 缺包自动上报：存量记录按“CI 显式上报”归类，探针字段留空
    this.ensureColumn('missing_dependencies', 'source', "TEXT NOT NULL DEFAULT 'ci'");
    this.ensureColumn('missing_dependencies', 'requester_ip', 'TEXT');
    this.ensureColumn('missing_dependencies', 'user_agent', 'TEXT');
    this.ensureColumn('missing_dependencies', 'auth_present', 'INTEGER NOT NULL DEFAULT 0');
    // 令牌吊销原因：区分手动吊销/批量清理/账号删除，便于审计回溯（存量记录为 NULL，视为手动）
    this.ensureColumn('api_tokens', 'revoke_reason', 'TEXT');
    // 令牌有效期：老库补列后存量令牌 expires_at 为 NULL，语义是永不过期，不会被误判失效
    this.ensureColumn('api_tokens', 'expires_at', 'TEXT');

    // PyPI 版本键改为 PEP 440 相等语义：存量 1.0 / 1.0.0 需在启动时收敛，
    // 否则 findVersion('1.0') 查不到旧库的 1.0.0，出现「同一个包装两次」。
    this.migratePep440VersionKeys();

    // 依赖后补列的索引必须建在 migrate 之后：
    // SCHEMA 先于 migrate 执行，存量库此时还没有 source 列，建索引会直接抛「no such column」导致启动失败
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_missing_source ON missing_dependencies(source, last_seen_at)',
    );
  }

  /**
   * PyPI 版本键迁移：把存量 normalized_version 按 PEP 440 相等语义重算。
   * - 幂等：迁移后各键已是规范形式，再次执行不产生变更。
   * - 冲突（旧库同时存在 1.0 与 1.0.0）：保留创建最早的一条，其余软删除；
   *   不物理删除对象与记录，管理员仍可在管理端恢复/清理，避免不可逆数据丢失。
   * - 三角色进程可能并发启动，整体放在 BEGIN IMMEDIATE 事务内串行执行。
   */
  private migratePep440VersionKeys(): void {
    const rows = this.all<{
      id: string;
      package_id: string;
      version: string;
      normalized_version: string;
      created_at: string;
    }>(
      `SELECT v.id, v.package_id, v.version, v.normalized_version, v.created_at
       FROM package_versions v
       JOIN packages p ON p.id = v.package_id
       WHERE p.ecosystem = 'pypi' AND v.deleted_at IS NULL
       ORDER BY v.package_id ASC, v.created_at ASC, v.id ASC`,
    );
    if (rows.length === 0) return;

    const changed: { id: string; key: string }[] = [];
    const conflicts: string[] = [];
    const occupied = new Map<string, string>();

    for (const row of rows) {
      const key = pep440VersionKey(row.version) ?? fallbackPypiVersionKey(row.version);
      const mark = `${row.package_id}\u0000${key}`;
      const holder = occupied.get(mark);
      if (holder && holder !== row.id) {
        // 同一包下多个版本归一到同一键：按创建顺序保留最早，其余软删除
        conflicts.push(row.id);
        continue;
      }
      occupied.set(mark, row.id);
      if (key !== row.normalized_version) changed.push({ id: row.id, key });
    }

    if (changed.length === 0 && conflicts.length === 0) return;

    this.tx(() => {
      const deletedAt = new Date().toISOString();
      for (const item of changed) {
        this.run('UPDATE package_versions SET normalized_version = ? WHERE id = ?', item.key, item.id);
      }
      for (const id of conflicts) {
        this.run(
          "UPDATE package_versions SET status = 'deleted', deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
          deletedAt,
          id,
        );
      }
    });

    if (conflicts.length > 0) {
      this.logger.warn(
        `PyPI 版本键迁移：${changed.length} 条已归一，${conflicts.length} 条等价重复版本已软删除（均早于本次修复入库，可在管理端查看/恢复）`,
      );
    } else {
      this.logger.log(`PyPI 版本键迁移：${changed.length} 条已按 PEP 440 归一`);
    }
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (err) {
      // 多进程同时启动时另一进程可能刚补完同一列，忽略重复列错误
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private prepared(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  /** node:sqlite 不支持 boolean 绑定，这里统一转换 */
  private bind(params: unknown[]): unknown[] {
    return params.map((value) => {
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value === undefined) return null;
      return value;
    });
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const result = this.prepared(sql).run(...(this.bind(params) as never[]));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  all<T = DbRow>(sql: string, ...params: unknown[]): T[] {
    return this.prepared(sql).all(...(this.bind(params) as never[])) as T[];
  }

  get<T = DbRow>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepared(sql).get(...(this.bind(params) as never[])) as T | undefined;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function isUniqueViolation(err: unknown): boolean {
  // node:sqlite 抛出的错误对象在部分 Node 版本下不满足 instanceof Error，按 message 判断更稳妥
  const message =
    typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

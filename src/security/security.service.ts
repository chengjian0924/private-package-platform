import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors';
import { nowIso } from '../common/http.util';
import { getConfig } from '../config/config';
import { DatabaseService, isUniqueViolation } from '../db/database.service';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { StorageService } from '../storage/storage.service';
import { maskEvidence, rulePackInfo } from './rules';
import { runScan } from './scan-runner';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  SEVERITY_RANK,
  type Dimension,
  type DimensionOutcome,
  type Disposition,
  type FindingRow,
  type ScanInput,
  type ScanOutcome,
  type ScanRow,
  type SecurityFinding,
  type Severity,
} from './types';
import { VulnerabilityService } from './vuln.service';
import type { Ecosystem } from '../packages/packages.service';

export interface GateResult {
  scanId: string;
  outcome: ScanOutcome;
}

const SCORE_WEIGHT: Record<Exclude<Severity, 'none'>, number> = { critical: 40, high: 20, medium: 8, low: 2 };

/** 可 unref 的等待：复检节流不应阻止进程退出 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 幂等键：同一包同一内容重复提交时复用同一个在途任务 */
function scanJobKey(input: Pick<ScanInput, 'ecosystem' | 'name' | 'version' | 'sha256' | 'trigger'>): string {
  return `${input.trigger}:${input.ecosystem}:${input.name.toLowerCase()}@${input.version}:${input.sha256}`;
}

interface ScanJobRow {
  id: string;
  idempotency_key: string;
  status: string;
  scan_id: string | null;
  ecosystem: Ecosystem;
  package_name: string;
  package_version: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  source: string;
  trigger: string;
  trace_id: string | null;
  actor_id: string | null;
  signature: string | null;
}

function maxSeverity(findings: SecurityFinding[]): Severity {
  return findings.reduce<Severity>(
    (acc, item) => (SEVERITY_RANK[item.severity] > SEVERITY_RANK[acc] ? item.severity : acc),
    'none',
  );
}

function buildDimensions(
  findings: SecurityFinding[],
  signatureStatus: string,
  advisoryCount: number,
  vulnMatched: number,
): Record<Dimension, DimensionOutcome> {
  const out = {} as Record<Dimension, DimensionOutcome>;
  for (const dimension of DIMENSIONS) {
    const items = findings.filter((item) => item.dimension === dimension);
    const worst = maxSeverity(items);
    // 漏洞库为空时该维度没有判定依据，必须显式标 unknown，不能伪装成 pass
    const status: DimensionOutcome['status'] =
      dimension === 'vulnerability' && advisoryCount === 0
        ? 'unknown'
        : SEVERITY_RANK[worst] >= SEVERITY_RANK.high
          ? 'fail'
          : items.length > 0
            ? 'warn'
            : 'pass';
    let summary: string;
    if (dimension === 'vulnerability') {
      summary =
        advisoryCount === 0
          ? '本地漏洞库为空，请先导入 CVE/CNVD 快照'
          : `漏洞库 ${advisoryCount} 条，命中 ${vulnMatched} 条${items.length > 0 ? `（最高 ${worst}）` : ''}`;
    } else if (items.length === 0) {
      summary = '未发现风险';
    } else {
      summary = `${items.length} 项风险（最高 ${worst}）`;
    }
    if (dimension === 'integrity' && signatureStatus === 'unsigned') {
      summary += '；签名校验 SKIPPED（未提供签名）';
    }
    if (dimension === 'integrity' && signatureStatus === 'verified') {
      summary += '；签名校验通过';
    }
    out[dimension] = { status, findingCount: items.length, summary };
  }
  return out;
}

function resolveDisposition(verdict: Severity): Disposition {
  const cfg = getConfig().security;
  if (verdict === 'none') return 'ALLOW';
  const rank = SEVERITY_RANK[verdict];
  if (rank >= SEVERITY_RANK[cfg.blockSeverity]) return 'BLOCK';
  if (rank >= SEVERITY_RANK[cfg.quarantineSeverity]) return 'QUARANTINE';
  if (rank >= SEVERITY_RANK.medium) return 'WARN';
  return 'ALLOW';
}

export function csvCell(value: unknown): string {
  let raw = value === null || value === undefined ? '' : String(value);
  // 包内代码/文件名可被构造成公式，Excel 打开会执行；前置单引号强制按文本处理
  if (/^[=+\-@\t\r]/.test(raw)) raw = `'${raw}`;
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class SecurityService implements OnModuleInit {
  private readonly logger = new Logger('Security');
  /** 最近一次真正执行超期销毁的时间，供指标与健康检查读取 */
  private lastPurgeAt: string | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly telemetry: TelemetryService,
    private readonly vuln: VulnerabilityService,
  ) {}

  async onModuleInit(): Promise<void> {
    // B6：隔离区含恶意样本，目录 0700、文件 0600；启动时顺带修正存量权限
    await this.ensureQuarantineDir(getConfig().security.quarantineDir, true);
    // 拆分部署时恢复只能单实例执行，否则 npm/pypi/console 会重复重扫同一批中断任务
    const role = getConfig().role;
    if (role !== 'all' && role !== 'console') {
      this.logger.log(`角色 ${role} 不执行扫描队列恢复（由控制台进程负责）`);
      return;
    }
    // 恢复在后台串行执行，避免历史积压拖慢服务启动；任务登记是同步的，重启后的重试仍可复用
    void this.recoverPendingJobs().catch((err) => {
      this.logger.error(`扫描队列恢复失败: ${(err as Error).message}`);
    });
  }

  /**
   * 隔离区可能通过 QUARANTINE_DIR 挂到独立卷，不能再假设它在 DATA_DIR 下；
   * 同时拦截历史脏数据里的 ../ 逃逸。
   */
  quarantineAbsolutePath(relativeKey: string): string {
    const key = relativeKey.replace(/\\/g, '/');
    const rel = key.startsWith('quarantine/') ? key.slice('quarantine/'.length) : key;
    const root = path.resolve(getConfig().security.quarantineDir);
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new ApiError('SEC_QUARANTINE_NOT_FOUND', { id: relativeKey });
    }
    return resolved;
  }

  /** 创建隔离目录并收紧权限；hardenExisting 用于启动时修正运维放开的存量权限 */
  private async ensureQuarantineDir(dir: string, hardenExisting = false): Promise<void> {
    // mkdir 的 mode 会被 umask 削减，创建后仍需显式 chmod 才能保证 0700
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!hardenExisting) {
      await fsp.chmod(dir, 0o700).catch(() => undefined);
      return;
    }
    try {
      await fsp.chmod(dir, 0o700);
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await fsp.chmod(abs, 0o700);
          for (const child of await fsp.readdir(abs, { withFileTypes: true })) {
            if (child.isFile()) await fsp.chmod(path.join(abs, child.name), 0o600);
          }
        } else if (entry.isFile()) {
          await fsp.chmod(abs, 0o600);
        }
      }
    } catch (err) {
      this.logger.warn(`隔离区权限修正失败 ${dir}: ${(err as Error).message}`);
    }
  }

  // ---------- 扫描并发闸门 ----------

  private activeScans = 0;
  private readonly scanWaiters: Array<() => void> = [];
  /** 在途扫描任务：键为幂等键，重复提交直接复用同一结果，不重复占用扫描槽 */
  private readonly inflightJobs = new Map<string, Promise<GateResult>>();

  /**
   * 限制同时进行的扫描数量：解析 tar/zip 是 CPU 密集型同步操作，
   * 并发过高会卡住整个事件循环，表现为所有接口一起变慢。
   */
  private async acquireScanSlot(): Promise<void> {
    const { scanConcurrency, maxScanQueue } = getConfig().security;
    if (this.activeScans < scanConcurrency) {
      this.activeScans++;
      return;
    }
    if (this.scanWaiters.length >= maxScanQueue) {
      throw new ApiError('SEC_SCAN_BUSY', {
        active: this.activeScans,
        queued: this.scanWaiters.length,
      });
    }
    this.telemetry.record('security.scan.queued', {
      active: this.activeScans,
      queued: this.scanWaiters.length + 1,
    });
    await new Promise<void>((resolve) => this.scanWaiters.push(resolve));
  }

  private releaseScanSlot(): void {
    const next = this.scanWaiters.shift();
    if (next) {
      // 槽位直接转交给排队者，activeScans 保持不变
      next();
      return;
    }
    this.activeScans = Math.max(0, this.activeScans - 1);
  }

  /** 扫描超时：超时按失败处理，调用方 fail-closed 阻断入库 */
  private withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ApiError('SEC_SCAN_TIMEOUT', { timeoutMs }));
      }, timeoutMs);
      timer.unref?.();
      task.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // ---------- 上传闸门 ----------

  /**
   * 全量扫描并落库。调用方必须在写入 package_versions 前执行：
   * BLOCK / QUARANTINE 由调用方阻断，保证未通过校验的包不进入可用集合。
   *
   * A-04：任务先落库再执行，进程重启后可由 recoverPendingJobs() 恢复；
   * 同一幂等键的并发提交复用同一个在途结果，避免重复扫描。
   */
  async scanAndGate(input: ScanInput): Promise<GateResult> {
    const key = scanJobKey(input);
    const inflight = this.inflightJobs.get(key);
    if (inflight) return inflight;

    const jobId = this.createScanJob(key, input);
    const task = this.runScanJob(jobId, input).finally(() => {
      this.inflightJobs.delete(key);
    });
    this.inflightJobs.set(key, task);
    return task;
  }

  private createScanJob(key: string, input: ScanInput): string {
    const jobId = randomUUID();
    try {
      this.db.run(
        `INSERT INTO security_scan_jobs
         (id, idempotency_key, status, ecosystem, package_name, package_version, filename, sha256, size_bytes,
          source, trigger, trace_id, actor_id, signature, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        jobId,
        key,
        'PENDING',
        input.ecosystem,
        input.name,
        input.version,
        input.filename,
        input.sha256,
        input.sizeBytes,
        input.source,
        input.trigger,
        input.traceId ?? null,
        input.uploaderId ?? null,
        input.signature ?? null,
        nowIso(),
      );
    } catch (err) {
      // 部分唯一索引兜底：跨进程或异常残留的在途任务不能再开一份
      if (isUniqueViolation(err)) {
        throw new ApiError('SEC_SCAN_BUSY', { reason: '相同包正在扫描中，请稍后重试' });
      }
      throw err;
    }
    return jobId;
  }

  private finishScanJob(
    jobId: string,
    status: 'COMPLETED' | 'FAILED',
    scanId: string | null,
    error: string | null,
  ): void {
    this.db.run(
      `UPDATE security_scan_jobs SET status = ?, scan_id = COALESCE(?, scan_id), error = ?, finished_at = ? WHERE id = ?`,
      status,
      scanId,
      error,
      nowIso(),
      jobId,
    );
  }

  private async runScanJob(jobId: string, input: ScanInput): Promise<GateResult> {
    const cfg = getConfig().security;
    let outcome: ScanOutcome;
    try {
      await this.acquireScanSlot();
    } catch (err) {
      this.finishScanJob(jobId, 'FAILED', null, (err as Error).message);
      throw err;
    }
    this.db.run(
      `UPDATE security_scan_jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = ? WHERE id = ?`,
      nowIso(),
      jobId,
    );
    const scanId = randomUUID();
    try {
      outcome = await this.withTimeout(this.evaluate(input), cfg.scanTimeoutMs);
    } catch (err) {
      this.finishScanJob(jobId, 'FAILED', null, (err as Error).message);
      throw err;
    } finally {
      this.releaseScanSlot();
    }

    try {
      let quarantinePath: string | null = null;
      let quarantineKind: string | null = null;
      if (outcome.disposition === 'QUARANTINE') {
        quarantinePath = await this.writeQuarantine(input, scanId);
        quarantineKind = 'upload';
      }
      if (outcome.disposition === 'BLOCK') {
        // 拦截包不保留二进制，但仅删除无版本引用的对象，避免误删共享内容
        await this.discardObjectIfUnreferenced(input.sha256);
      }

      await this.persistScan(scanId, input, outcome, {
        versionId: null,
        quarantineKind,
        quarantinePath,
      });

      this.audit.log({
        traceId: input.traceId ?? null,
        actorId: input.uploaderId ?? null,
        action: outcome.disposition === 'BLOCK' ? 'security.scan.blocked' : 'security.scan.completed',
        resourceType: 'package',
        resourceId: `${input.ecosystem}:${input.name}@${input.version}`,
        result: outcome.disposition === 'BLOCK' ? 'failure' : 'success',
        detail: {
          scanId,
          verdict: outcome.verdict,
          disposition: outcome.disposition,
          score: outcome.score,
          findingCount: outcome.findings.length,
          signature: outcome.signature,
          dimensions: outcome.dimensions,
        },
      });
      this.telemetry.record(
        'security.scan.completed',
        {
          scanId,
          verdict: outcome.verdict,
          disposition: outcome.disposition,
          score: outcome.score,
          durationMs: outcome.durationMs,
          findingCount: outcome.findings.length,
          // 性能基线维度：包体积、条目数、签名状态，便于定位耗时退化
          bytes: input.sizeBytes,
          fileCount: Number((outcome.metadata as Record<string, unknown>).fileCount ?? 0),
          signatureStatus: outcome.signature,
        },
        input.traceId ?? null,
      );

      this.finishScanJob(jobId, 'COMPLETED', scanId, null);
      return { scanId, outcome };
    } catch (err) {
      this.finishScanJob(jobId, 'FAILED', null, (err as Error).message);
      throw err;
    }
  }

  /**
   * 启动恢复：把中断的 PENDING/RUNNING 任务从对象存储重扫并留档。
   * 只补审计与隔离动作，不补写 package_versions（原上传请求已随进程终止失败）。
   */
  async recoverPendingJobs(): Promise<void> {
    const rows = this.db.all<ScanJobRow>(
      `SELECT * FROM security_scan_jobs WHERE status IN ('PENDING', 'RUNNING') ORDER BY created_at ASC`,
    );
    if (rows.length === 0) return;
    this.logger.warn(`发现 ${rows.length} 个中断的扫描任务，开始后台恢复`);
    // 先统一回落到 PENDING，避免恢复期间仍占用部分唯一索引
    this.db.run(`UPDATE security_scan_jobs SET status = 'PENDING', started_at = NULL WHERE status = 'RUNNING'`);

    const tasks: Array<Promise<GateResult>> = [];
    for (const row of rows) {
      if (this.inflightJobs.has(row.idempotency_key)) continue;
      const task = this.resumeScanJob(row)
        .catch((err: unknown) => {
          this.logger.warn(`扫描任务恢复失败 ${row.id}: ${(err as Error).message}`);
          throw err;
        })
        .finally(() => {
          this.inflightJobs.delete(row.idempotency_key);
        });
      this.inflightJobs.set(row.idempotency_key, task);
      tasks.push(task);
    }
    await Promise.allSettled(tasks);
  }

  private async resumeScanJob(row: ScanJobRow): Promise<GateResult> {
    const objectKey = `objects/${row.sha256.slice(0, 2)}/${row.sha256}`;
    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(this.storage.absolutePath(objectKey));
    } catch (err) {
      this.finishScanJob(row.id, 'FAILED', null, `恢复失败：对象文件不可读（${(err as Error).message}）`);
      throw err;
    }
    return this.runScanJob(row.id, {
      ecosystem: row.ecosystem,
      name: row.package_name,
      version: row.package_version,
      filename: row.filename,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      source: row.source,
      uploaderId: row.actor_id,
      traceId: row.trace_id,
      signature: row.signature ?? undefined,
      trigger: row.trigger === 'rescan' ? 'rescan' : 'upload',
      buffer,
    });
  }

  /**
   * 预扫描：只计算不落库，供批量导入在校验阶段提前拿到安全结论。
   * 正式入库仍走 scanAndGate，避免预扫描结论被当作放行依据。
   */
  async preview(input: Omit<ScanInput, 'trigger'>): Promise<ScanOutcome> {
    const cfg = getConfig().security;
    await this.acquireScanSlot();
    try {
      return await this.withTimeout(this.evaluate({ ...input, trigger: 'upload' }), cfg.scanTimeoutMs);
    } finally {
      this.releaseScanSlot();
    }
  }

  /** 只做扫描计算，不落库，供复检复用 */
  private async evaluate(input: ScanInput): Promise<ScanOutcome> {
    const cfg = getConfig().security;
    // 复检不强制签名：历史版本可能早于签名持久化上线，缺签名按 unsigned 处理，
    // 否则一次复检会把全部存量版本判为高危并自动隔离。
    const effectiveCfg = input.trigger === 'rescan' && !input.signature ? { ...cfg, requireSignature: false } : cfg;
    const started = Date.now();
    // 扫描在独立线程执行（A-03），主线程只做漏洞比对与落库
    const staticResult = await runScan(
      { ecosystem: input.ecosystem, filename: input.filename, sha256: input.sha256, buffer: input.buffer },
      effectiveCfg,
      input.signature,
    );
    const vulnResult = this.vuln.match(input.ecosystem, input.name, input.version, staticResult.dependencies);
    const advisoryCount = this.vuln.list({ pageSize: 1 }).total;
    const findings = [...staticResult.findings, ...vulnResult.findings];
    if (advisoryCount === 0) {
      // 空库不代表安全：至少 WARN，开启强制初始化后按高危处理，避免拿到虚假的 ALLOW
      findings.push({
        dimension: 'vulnerability',
        ruleId: 'VULN-DB-EMPTY',
        severity: cfg.requireAdvisoryDb ? 'high' : 'medium',
        title: '本地漏洞库未初始化',
        detail: '尚未导入任何 CVE/CNVD 数据，已知漏洞维度无法生效，当前结论不代表不存在漏洞',
        remediation: '由管理员导入漏洞库快照后重新扫描（POST /api/v1/security/advisories/import）',
      });
    }
    const verdict = maxSeverity(findings);
    const disposition = resolveDisposition(verdict);
    const score = Math.min(
      100,
      findings.reduce((sum, item) => sum + SCORE_WEIGHT[item.severity], 0),
    );
    const dimensions = buildDimensions(findings, staticResult.signature, advisoryCount, vulnResult.matched);

    return {
      verdict,
      disposition,
      score,
      signature: staticResult.signature,
      findings,
      dimensions,
      metadata: {
        ...staticResult.metadata,
        vulnerabilityAdvisories: advisoryCount,
        vulnerabilityMatched: vulnResult.matched,
        scanMode: staticResult.offThread ? 'worker' : 'inline',
      },
      dependencies: staticResult.dependencies,
      durationMs: Date.now() - started,
    };
  }

  private async persistScan(
    scanId: string,
    input: ScanInput,
    outcome: ScanOutcome,
    extra: { versionId: string | null; quarantineKind: string | null; quarantinePath: string | null },
  ): Promise<{ scanId: string; reportKey: string }> {
    const createdAt = nowIso();
    const pack = rulePackInfo();
    const advisorySnapshotId = this.latestAdvisorySnapshotId();
    // 规则包快照按版本幂等登记，报告可直接引用版本号复现判定依据
    this.db.run(
      `INSERT OR IGNORE INTO security_rule_packs (version, rule_count, description, created_at) VALUES (?,?,?,?)`,
      pack.version,
      pack.ruleCount,
      '内置静态规则包（恶意代码/敏感信息模式）',
      createdAt,
    );
    const report = {
      schemaVersion: '1.0',
      ruleVersion: pack.version,
      advisorySnapshotId,
      generatedAt: createdAt,
      // SBOM 随报告存档：依赖清单含 lockfile 传递依赖，便于后续离线复核
      sbom: {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: {
          timestamp: createdAt,
          component: { type: 'application', name: `${input.name}@${input.version}` },
        },
        components: outcome.dependencies.slice(0, 300).map((dep) => ({
          type: 'library',
          name: dep.name,
          version: dep.resolvedVersion || dep.range,
          scope: dep.transitive ? 'transitive' : 'direct',
        })),
      },
      scan: {
        id: scanId,
        ecosystem: input.ecosystem,
        name: input.name,
        version: input.version,
        filename: input.filename,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        source: input.source,
        trigger: input.trigger,
        verdict: outcome.verdict,
        disposition: outcome.disposition,
        riskScore: outcome.score,
        signatureStatus: outcome.signature,
        durationMs: outcome.durationMs,
        traceId: input.traceId ?? null,
        uploaderId: input.uploaderId ?? null,
      },
      dimensions: outcome.dimensions,
      findings: outcome.findings,
      metadata: outcome.metadata,
    };
    const reportKey = await this.storage.putMeta(`security-report-${scanId}`, JSON.stringify(report, null, 2));

    this.db.run(
      `INSERT INTO security_scans
       (id, package_version_id, ecosystem, package_name, package_version, filename, sha256, size_bytes, trigger,
        verdict, disposition, risk_score, signature_status, signature, rule_version, advisory_snapshot_id, dimensions, report_key, quarantine_kind, quarantine_path,
        duration_ms, trace_id, actor_id, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      scanId,
      extra.versionId,
      input.ecosystem,
      input.name,
      input.version,
      input.filename,
      input.sha256,
      input.sizeBytes,
      input.trigger,
      outcome.verdict,
      outcome.disposition,
      outcome.score,
      outcome.signature,
      input.signature ?? null,
      pack.version,
      advisorySnapshotId,
      JSON.stringify(outcome.dimensions),
      reportKey,
      extra.quarantineKind,
      extra.quarantinePath,
      outcome.durationMs,
      input.traceId ?? null,
      input.uploaderId ?? null,
      input.source,
      createdAt,
    );

    for (const item of outcome.findings) {
      this.db.run(
        `INSERT INTO security_findings (scan_id, dimension, rule_id, severity, title, detail, location, evidence, remediation, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        scanId,
        item.dimension,
        item.ruleId,
        item.severity,
        item.title,
        item.detail,
        item.location ?? null,
        item.evidence ?? null,
        item.remediation,
        createdAt,
      );
    }

    return { scanId, reportKey };
  }

  private async writeQuarantine(input: ScanInput, scanId: string): Promise<string> {
    const dir = path.join(getConfig().security.quarantineDir, scanId);
    await this.ensureQuarantineDir(dir);
    const safeName = input.filename.replace(/[^\w.@+-]/g, '_') || 'package.bin';
    const dest = path.join(dir, safeName);
    // 扫描在 worker 中执行时主线程 buffer 已被转移（detached），
    // 此时从已入库对象复制，避免为了隔离再申请一整份包体内存
    const objectPath = this.storage.absolutePath(`objects/${input.sha256.slice(0, 2)}/${input.sha256}`);
    try {
      if (!input.buffer || input.buffer.byteLength === 0) {
        await fsp.copyFile(objectPath, dest);
      } else {
        await fsp.writeFile(dest, input.buffer);
      }
      // 样本文件默认 0644，同机其他账号可读，必须显式收紧
      await fsp.chmod(dest, 0o600);
    } catch (err) {
      this.logger.warn(`隔离副本写入失败 ${scanId}: ${(err as Error).message}`);
      throw err;
    }
    return path.join('quarantine', scanId, safeName);
  }

  private async discardObjectIfUnreferenced(sha256: string): Promise<void> {
    const storageKey = `objects/${sha256.slice(0, 2)}/${sha256}`;
    const ref = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM package_versions WHERE storage_key = ?', storageKey);
    if (Number(ref?.c ?? 0) > 0) return;
    try {
      await fsp.rm(this.storage.absolutePath(storageKey), { force: true });
    } catch (err) {
      this.logger.warn(`拦截包对象清理失败 ${storageKey}: ${(err as Error).message}`);
    }
  }

  attachVersion(scanId: string, versionId: string): void {
    this.db.run('UPDATE security_scans SET package_version_id = ? WHERE id = ?', versionId, scanId);
  }

  // ---------- 查询 ----------

  listScans(params: {
    verdict?: string;
    disposition?: string;
    ecosystem?: string;
    versionId?: string;
    name?: string;
    /** 仅看该用户上传的包：开发者只能查询自己的安全结论 */
    actorId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.verdict) {
      where.push('verdict = ?');
      args.push(params.verdict);
    }
    if (params.disposition) {
      where.push('disposition = ?');
      args.push(params.disposition);
    }
    if (params.ecosystem) {
      where.push('ecosystem = ?');
      args.push(params.ecosystem);
    }
    if (params.versionId) {
      where.push('package_version_id = ?');
      args.push(params.versionId);
    }
    if (params.name) {
      where.push('package_name = ?');
      args.push(params.name);
    }
    if (params.actorId) {
      // 复检记录的 actor_id 为空，按版本上传者兜底，避免开发者看不到自己包的复检结果
      where.push(
        '(actor_id = ? OR package_version_id IN (SELECT id FROM package_versions WHERE uploader_id = ?))',
      );
      args.push(params.actorId, params.actorId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM security_scans ${clause}`, ...args)?.c ?? 0;
    const rows = this.db.all<ScanRow>(
      `SELECT * FROM security_scans ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      items: rows.map((row) => this.toScanView(row)),
      total: Number(total),
      page,
      pageSize,
    };
  }

  /** 运行指标：耗时分布、处置分布、队列深度，用于容量评估与性能回归 */
  metrics(days = 7) {
    const since = new Date(Date.now() - Math.max(1, Math.min(days, 90)) * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.all<{ disposition: string; duration_ms: number }>(
      'SELECT disposition, duration_ms FROM security_scans WHERE created_at >= ? ORDER BY created_at DESC LIMIT 2000',
      since,
    );
    const durations = rows
      .map((row) => Number(row.duration_ms))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const pick = (ratio: number) =>
      durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(durations.length * ratio))];
    const byDisposition: Record<string, number> = {};
    for (const row of rows) byDisposition[row.disposition] = (byDisposition[row.disposition] || 0) + 1;
    const advisoryStats = this.advisoryStats();
    return {
      windowDays: days,
      scans: rows.length,
      byDisposition,
      durationMs: {
        avg: durations.length === 0 ? 0 : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
        p50: pick(0.5),
        p95: pick(0.95),
        max: durations.length === 0 ? 0 : durations[durations.length - 1],
      },
      queue: { active: this.activeScans, queued: this.scanWaiters.length },
      advisories: advisoryStats.total,
      advisoriesByEcosystem: {
        npm: advisoryStats.npm,
        pypi: advisoryStats.pypi,
        wildcard: advisoryStats.wildcard,
      },
    };
  }

  /**
   * 孤儿资源清扫：对象库按 storage_key 引用判断，隔离区按扫描记录判断，
   * 批次文件按 finished_at 过期判断。默认只统计不删除，apply=true 才真正回收。
   */
  async sweepOrphans(apply = false) {
    const cfg = getConfig();
    const cutoff = Date.now() - Math.max(0, cfg.security.orphanGraceHours) * 3600_000;

    const referenced = new Set(
      this.db
        .all<{ storage_key: string }>('SELECT DISTINCT storage_key FROM package_versions')
        .map((row) => row.storage_key),
    );
    const orphanObjects: string[] = [];
    for (const abs of await this.walkFiles(cfg.objectDir)) {
      const relative = this.relativeKey(abs);
      if (referenced.has(relative)) continue;
      if (!(await this.isOlderThan(abs, cutoff))) continue;
      orphanObjects.push(relative);
    }
    const quarantineRefs = this.db
      .all<{ quarantine_path: string }>('SELECT quarantine_path FROM security_scans WHERE quarantine_path IS NOT NULL')
      .map((row) => row.quarantine_path.replace(/\\/g, '/'));
    const orphanQuarantine: string[] = [];
    for (const entry of await fsp.readdir(cfg.security.quarantineDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const relative = `quarantine/${entry.name}`;
      if (quarantineRefs.some((item) => item === relative || item.startsWith(`${relative}/`))) continue;
      // 隔离区可能挂在独立卷，不能拼 DATA_DIR
      if (!(await this.isOlderThan(this.quarantineAbsolutePath(relative), cutoff))) continue;
      orphanQuarantine.push(relative);
    }

    const batchCutoff = new Date(
      Date.now() - Math.max(1, cfg.security.batchRetentionDays) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const expiredBatches = new Set(
      this.db
        .all<{ id: string }>(
          "SELECT id FROM import_batches WHERE status IN ('COMPLETED','PARTIAL_COMPLETED','FAILED') AND COALESCE(finished_at, created_at) < ?",
          batchCutoff,
        )
        .map((row) => `batches/${row.id}/`),
    );
    const expiredBatchFiles = (await this.walkFiles(cfg.batchDir))
      .map((abs) => this.relativeKey(abs))
      .filter((key) => Array.from(expiredBatches).some((prefix) => key.startsWith(prefix)));

    // 删前二次确认：扫描文件树与真正删除之间可能刚好有新上传复用同一个内容寻址对象
    // （putObject 命中已存在文件会直接复用），只删此刻仍然无引用的，避免删掉刚入库的包。
    // 放在 apply 分支内，预览接口保持「按扫描时刻的判定」语义不变。
    let removableObjects = orphanObjects;
    if (apply) {
      const referencedNow = new Set(
        this.db
          .all<{ storage_key: string }>("SELECT DISTINCT storage_key FROM package_versions WHERE storage_key IS NOT NULL")
          .map((row) => row.storage_key),
      );
      removableObjects = orphanObjects.filter((key) => !referencedNow.has(key));
      for (const key of [...removableObjects, ...expiredBatchFiles]) {
        await fsp.rm(path.join(cfg.dataDir, key), { force: true }).catch(() => undefined);
      }
      for (const key of orphanQuarantine) {
        await fsp.rm(this.quarantineAbsolutePath(key), { recursive: true, force: true }).catch(() => undefined);
      }
      this.telemetry.record('security.orphans.swept', {
        objects: removableObjects.length,
        quarantine: orphanQuarantine.length,
        batchFiles: expiredBatchFiles.length,
      });
    }

    return {
      applied: apply,
      // applied=true 时返回实际删除的集合（已剔除期间新被引用的），预览保持扫描结果
      orphanObjects: { count: removableObjects.length, sample: removableObjects.slice(0, 20) },
      orphanQuarantine: { count: orphanQuarantine.length, sample: orphanQuarantine.slice(0, 20) },
      expiredBatchFiles: { count: expiredBatchFiles.length, sample: expiredBatchFiles.slice(0, 20) },
    };
  }

  private relativeKey(absPath: string): string {
    return path.relative(getConfig().dataDir, absPath).split(path.sep).join('/');
  }

  /**
   * 超期销毁：只删样本文件，保留 security_scans 记录并写审计，
   * 保证「删了什么、什么时候删、依据哪条保留期」都可追溯。
   */
  async purgeExpiredQuarantine(apply = false) {
    const cfg = getConfig().security;
    const cutoff = new Date(Date.now() - cfg.quarantineRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.all<{ id: string; ecosystem: string; package_name: string; package_version: string }>(
      `SELECT id, ecosystem, package_name, package_version FROM security_scans
       WHERE disposition = 'QUARANTINE' AND released_at IS NULL AND quarantine_path IS NOT NULL AND created_at < ?
       ORDER BY created_at ASC`,
      cutoff,
    );

    let bytes = 0;
    const ids: string[] = [];
    for (const row of rows) {
      const dir = path.join(cfg.quarantineDir, row.id);
      bytes += await this.pathSize(dir);
      if (!apply) continue;
      await fsp.rm(dir, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(`过期隔离样本清理失败 ${row.id}: ${(err as Error).message}`);
      });
      this.db.run(
        'UPDATE security_scans SET released_at = ?, released_by = ? WHERE id = ?',
        nowIso(),
        `retention:${cfg.quarantineRetentionDays}d`,
        row.id,
      );
      this.audit.log({
        actorId: 'system',
        action: 'security.quarantine.expire',
        resourceType: 'security_scan',
        resourceId: row.id,
        result: 'success',
        detail: {
          package: `${row.ecosystem}:${row.package_name}@${row.package_version}`,
          retentionDays: cfg.quarantineRetentionDays,
        },
      });
      ids.push(row.id);
    }

    if (apply) {
      this.lastPurgeAt = nowIso();
      this.telemetry.record('security.quarantine.purged', {
        count: rows.length,
        retentionDays: cfg.quarantineRetentionDays,
      });
    }
    return { applied: apply, retentionDays: cfg.quarantineRetentionDays, cutoff, count: rows.length, bytes, ids };
  }

  /**
   * 扫描记录与报告保留期清理（RV-26）：
   * - 超过 scanRetentionDays 的扫描记录连同 findings 与报告文件删除；
   * - 每个版本至少保留最近一次扫描（版本安全徽标依赖 latest 查询）；
   * - 未处置的隔离样本不在此清理（走隔离区独立的销毁流程）；
   * - 已完成的扫描任务记录与埋点事件同步按保留期回收。0 表示关闭。
   */
  async purgeExpiredScans(apply = false) {
    const cfg = getConfig().security;
    if (cfg.scanRetentionDays <= 0) {
      return { applied: apply, retentionDays: 0, cutoff: null, scanCount: 0, jobCount: 0, telemetryCount: 0, ids: [] };
    }
    const cutoff = new Date(Date.now() - cfg.scanRetentionDays * 24 * 60 * 60 * 1000).toISOString();

    // 可删集合：超期 + 非未处置隔离 + 不属于任何版本的最新扫描（按 created_at 保留每版本最新一条，徽标依赖）
    const rows = this.db.all<{ id: string; report_key: string | null }>(
      `SELECT s.id, s.report_key FROM security_scans s
       WHERE s.created_at < ?
         AND NOT (s.disposition = 'QUARANTINE' AND s.released_at IS NULL)
         AND s.id NOT IN (
           SELECT v.id FROM security_scans v
           JOIN (
             SELECT package_version_id, MAX(created_at) AS latest_at FROM security_scans
             WHERE package_version_id IS NOT NULL GROUP BY package_version_id
           ) m ON v.package_version_id = m.package_version_id AND v.created_at = m.latest_at
         )
       ORDER BY s.created_at ASC`,
      cutoff,
    );

    const ids: string[] = [];
    for (const row of rows) {
      if (!apply) {
        ids.push(row.id);
        continue;
      }
      // 报告 meta 文件先删；删除失败不阻塞 DB 清理（孤儿 meta 可被离线巡检发现）
      if (row.report_key) {
        await fsp.rm(path.join(getConfig().dataDir, row.report_key), { force: true }).catch((err) => {
          this.logger.warn(`扫描报告文件清理失败 ${row.report_key}: ${(err as Error).message}`);
        });
      }
      this.db.run('DELETE FROM security_findings WHERE scan_id = ?', row.id);
      this.db.run('DELETE FROM security_scans WHERE id = ?', row.id);
      ids.push(row.id);
    }

    // 已完成扫描任务与埋点事件：队列/观测数据，超期直接回收
    let jobCount = 0;
    let telemetryCount = 0;
    if (apply) {
      const jobs = this.db.run(
        "DELETE FROM security_scan_jobs WHERE status IN ('COMPLETED', 'FAILED') AND created_at < ?",
        cutoff,
      );
      jobCount = jobs.changes;
      const telemetry = this.db.run('DELETE FROM telemetry_events WHERE occurred_at < ?', cutoff);
      telemetryCount = telemetry.changes;
    } else {
      jobCount =
        this.db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM security_scan_jobs WHERE status IN ('COMPLETED', 'FAILED') AND created_at < ?",
          cutoff,
        )?.c ?? 0;
      telemetryCount = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM telemetry_events WHERE occurred_at < ?', cutoff)?.c ?? 0;
    }

    if (apply && ids.length > 0) {
      this.audit.log({
        actorId: 'system',
        action: 'security.scan.purge',
        resourceType: 'security_scan',
        resourceId: ids[0],
        result: 'success',
        detail: { retentionDays: cfg.scanRetentionDays, purged: ids.length, jobs: jobCount, telemetry: telemetryCount },
      });
    }

    return { applied: apply, retentionDays: cfg.scanRetentionDays, cutoff, scanCount: ids.length, jobCount, telemetryCount, ids };
  }

  /** 隔离区概况：待复核数、超期数、占用字节与目录权限，供健康检查与指标使用 */
  async quarantineStats(includeBytes = true) {
    const cfg = getConfig().security;
    const rows = this.db.all<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM security_scans
       WHERE disposition = 'QUARANTINE' AND released_at IS NULL AND quarantine_path IS NOT NULL`,
    );
    const cutoff = Date.now() - cfg.quarantineRetentionDays * 24 * 60 * 60 * 1000;
    let bytes = 0;
    let expired = 0;
    for (const row of rows) {
      if (includeBytes) bytes += await this.pathSize(path.join(cfg.quarantineDir, row.id));
      if (Date.parse(row.created_at) < cutoff) expired++;
    }
    const mode = await fsp.stat(cfg.quarantineDir).then((stat) => stat.mode & 0o777).catch(() => 0);
    return {
      pending: rows.length,
      expired,
      bytes,
      retentionDays: cfg.quarantineRetentionDays,
      dirMode: mode ? `0${mode.toString(8)}` : 'unknown',
      lastPurgeAt: this.lastPurgeAt,
    };
  }

  /** 目录占用按一层子目录内的普通文件累加；隔离区结构固定为 quarantine/<scanId>/<file> */
  private async pathSize(dir: string): Promise<number> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await this.pathSize(abs);
      else if (entry.isFile()) total += await fsp.stat(abs).then((stat) => stat.size).catch(() => 0);
    }
    return total;
  }

  private async isOlderThan(absPath: string, cutoff: number): Promise<boolean> {
    const stat = await fsp.stat(absPath).catch(() => null);
    return Boolean(stat && stat.mtimeMs <= cutoff);
  }

  private async walkFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(abs);
        else if (entry.isFile()) out.push(abs);
      }
    }
    return out;
  }

  /** 只读校验结论：供发布流水线按 name@version 判断是否通过安全校验 */
  attestation(ecosystem: Ecosystem, name: string, version: string) {
    const row = this.db.get<{
      id: string;
      disposition: string;
      verdict: string;
      risk_score: number;
      signature_status: string;
      rule_version: string | null;
      created_at: string;
    }>(
      `SELECT s.id, s.disposition, s.verdict, s.risk_score, s.signature_status, s.rule_version, s.created_at
       FROM security_scans s
       JOIN package_versions v ON v.id = s.package_version_id
       JOIN packages p ON p.id = v.package_id
       WHERE p.ecosystem = ? AND p.normalized_name = ? AND v.version = ?
       ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
      ecosystem,
      // 与 packages.normalizeName 保持一致：PyPI 名称需统一分隔符后再查
      ecosystem === 'npm' ? name.trim().toLowerCase() : name.trim().toLowerCase().replace(/[-_.]+/g, '-'),
      version,
    );
    if (!row) throw new ApiError('SEC_NOT_FOUND', { ecosystem, name, version });
    return {
      ecosystem,
      name,
      version,
      status: row.disposition,
      passed: row.disposition === 'ALLOW',
      verdict: row.verdict,
      score: row.risk_score,
      signatureStatus: row.signature_status,
      ruleVersion: row.rule_version,
      scannedAt: row.created_at,
      scanId: row.id,
    };
  }

  /** 校验扫描记录是否属于该上传者，供 security:read:own 使用 */
  isScanOwnedBy(scanId: string, userId: string): boolean {
    const row = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM security_scans s
       WHERE s.id = ? AND (s.actor_id = ? OR EXISTS (
         SELECT 1 FROM package_versions v WHERE v.id = s.package_version_id AND v.uploader_id = ?))`,
      scanId,
      userId,
      userId,
    );
    return Number(row?.c ?? 0) > 0;
  }

  getScan(id: string) {
    const row = this.requireScan(id);
    const findings = this.db.all<FindingRow>(
      'SELECT * FROM security_findings WHERE scan_id = ? ORDER BY id ASC',
      id,
    );
    return {
      ...this.toScanView(row),
      findings: findings.map((item) => ({
        dimension: item.dimension,
        dimensionLabel: DIMENSION_LABELS[item.dimension] || item.dimension,
        ruleId: item.rule_id,
        severity: item.severity,
        title: item.title,
        detail: item.detail,
        location: item.location,
        evidence: item.evidence ? maskEvidence(item.evidence) : null,
        remediation: item.remediation,
      })),
      reportUrl: `/api/v1/security/scans/${id}/report?format=json`,
    };
  }

  /** 包详情页展示最近一次校验结论 */
  latestForVersion(versionId: string): ScanRow | undefined {
    return this.db.get<ScanRow>(
      'SELECT * FROM security_scans WHERE package_version_id = ? ORDER BY created_at DESC LIMIT 1',
      versionId,
    );
  }

  private toScanView(row: ScanRow) {
    return {
      id: row.id,
      versionId: row.package_version_id,
      ecosystem: row.ecosystem,
      name: row.package_name,
      version: row.package_version,
      filename: row.filename,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      trigger: row.trigger,
      verdict: row.verdict,
      disposition: row.disposition,
      riskScore: Number(row.risk_score),
      signatureStatus: row.signature_status,
      ruleVersion: row.rule_version,
      advisorySnapshotId: row.advisory_snapshot_id,
      dimensions: safeJson<Record<string, DimensionOutcome>>(row.dimensions, {}),
      quarantineKind: row.quarantine_kind,
      quarantinePath: row.quarantine_path,
      durationMs: Number(row.duration_ms),
      traceId: row.trace_id,
      actorId: row.actor_id,
      source: row.source,
      releasedAt: row.released_at,
      releasedBy: row.released_by,
      createdAt: row.created_at,
    };
  }

  async getReport(id: string, format: 'json' | 'csv') {
    const row = this.requireScan(id);
    if (format === 'json') {
      if (!row.report_key) throw new ApiError('SEC_REPORT_NOT_FOUND', { id });
      const raw = await this.storage.readMeta(row.report_key);
      // 导出前二次脱敏：历史报告可能存有未脱敏片段
      const parsed = safeJson<Record<string, unknown>>(raw.toString('utf8'), {});
      const findings = Array.isArray(parsed.findings) ? (parsed.findings as Record<string, unknown>[]) : [];
      for (const item of findings) {
        if (item && typeof item.evidence === 'string' && item.evidence) item.evidence = maskEvidence(item.evidence);
      }
      return { contentType: 'application/json; charset=utf-8', body: JSON.stringify(parsed, null, 2) };
    }

    const findings = this.db.all<FindingRow>('SELECT * FROM security_findings WHERE scan_id = ? ORDER BY id ASC', id);
    const header =
      'scanId,ecosystem,name,version,verdict,disposition,riskScore,trigger,dimension,ruleId,severity,title,location,evidence,remediation,detail';
    const lines = findings.map((item) =>
      [
        row.id,
        row.ecosystem,
        row.package_name,
        row.package_version,
        row.verdict,
        row.disposition,
        row.risk_score,
        row.trigger,
        item.dimension,
        item.rule_id,
        item.severity,
        item.title,
        item.location,
        item.evidence ? maskEvidence(item.evidence) : null,
        item.remediation,
        item.detail,
      ]
        .map(csvCell)
        .join(','),
    );
    // 前置 BOM，Excel 才能按 UTF-8 正确识别中文
    return { contentType: 'text/csv; charset=utf-8', body: `\ufeff${[header, ...lines].join('\n')}` };
  }

  /**
   * 漏洞库按生态拆分计数。总数看不出"某一侧根本没导数据"，
   * 排查"pypi 包为什么从不命中漏洞"时这组数字是第一个要看的东西。
   */
  private advisoryStats(): { total: number; npm: number; pypi: number; wildcard: number } {
    const rows = this.db.all<{ ecosystem: string; c: number }>(
      'SELECT ecosystem, COUNT(*) AS c FROM vulnerability_advisories GROUP BY ecosystem',
    );
    const stats = { total: 0, npm: 0, pypi: 0, wildcard: 0 };
    for (const row of rows) {
      const count = Number(row.c) || 0;
      stats.total += count;
      if (row.ecosystem === 'npm') stats.npm += count;
      else if (row.ecosystem === 'pypi') stats.pypi += count;
      else stats.wildcard += count;
    }
    return stats;
  }

  /**
   * 漏洞库按严重级别拆分。控制台据此显示"库里到底有多少高危"，
   * 避免管理员只知道总数，却不知道这份快照能不能拦住 critical。
   */
  private advisorySeverityStats(): Record<string, number> {
    const rows = this.db.all<{ severity: string; c: number }>(
      'SELECT severity, COUNT(*) AS c FROM vulnerability_advisories GROUP BY severity',
    );
    const stats: Record<string, number> = {};
    for (const row of rows) {
      const key = String(row.severity || 'unknown').toLowerCase();
      stats[key] = (stats[key] || 0) + (Number(row.c) || 0);
    }
    return stats;
  }

  getOverview() {
    const byDisposition = this.db.all<{ disposition: string; c: number }>(
      'SELECT disposition, COUNT(*) AS c FROM security_scans GROUP BY disposition',
    );
    const counts: Record<string, number> = { ALLOW: 0, WARN: 0, QUARANTINE: 0, BLOCK: 0 };
    for (const item of byDisposition) counts[item.disposition] = Number(item.c);
    const quarantined = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM security_scans WHERE disposition = 'QUARANTINE' AND released_at IS NULL",
    );
    const advisoryStats = this.advisoryStats();
    const lastRun = this.db.get<Record<string, unknown>>(
      'SELECT * FROM security_rescan_runs ORDER BY started_at DESC LIMIT 1',
    );
    const lastImport = this.db.get<{ source: string; advisory_count: number; created_at: string; imported_by: string | null }>(
      'SELECT source, advisory_count, created_at, imported_by FROM advisory_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    return {
      counts,
      pendingQuarantine: Number(quarantined?.c ?? 0),
      advisories: advisoryStats.total,
      advisoriesByEcosystem: {
        npm: advisoryStats.npm,
        pypi: advisoryStats.pypi,
        wildcard: advisoryStats.wildcard,
      },
      // 最近一次漏洞库导入：控制台据此说明「库里现在是什么、什么时候进来的」
      lastAdvisoryImport: lastImport
        ? {
            source: lastImport.source,
            advisoryCount: Number(lastImport.advisory_count),
            createdAt: lastImport.created_at,
            importedBy: lastImport.imported_by || null,
          }
        : null,
      advisoriesBySeverity: this.advisorySeverityStats(),
      lastRescan: lastRun ?? null,
      scanEnabled: getConfig().security.scanEnabled,
      blockSeverity: getConfig().security.blockSeverity,
      quarantineSeverity: getConfig().security.quarantineSeverity,
      signatureRequired: getConfig().security.requireSignature,
    };
  }

  // ---------- 隔离区 ----------

  listQuarantine() {
    const rows = this.db.all<ScanRow>(
      `SELECT * FROM security_scans WHERE disposition = 'QUARANTINE' AND released_at IS NULL AND quarantine_path IS NOT NULL
       ORDER BY created_at DESC`,
    );
    // RV-17：按 sha256 分组并返回 versions[]，同一文件被多个包版本引用时不再互相遮蔽；
    // 组内最新一条作为展示主体（复核结论以最近一次扫描为准），处置任一条即视为处置该样本
    const groups = new Map<string, { latest: ScanRow; versions: Record<string, unknown>[] }>();
    for (const row of rows) {
      const group = groups.get(row.sha256) ?? { latest: row, versions: [] };
      group.versions.push({
        scanId: row.id,
        ecosystem: row.ecosystem,
        package: `${row.ecosystem}:${row.package_name}@${row.package_version}`,
        versionId: row.package_version_id,
        verdict: row.verdict,
        quarantinedAt: row.created_at,
      });
      groups.set(row.sha256, group);
    }
    const items = [...groups.values()].map((group) => ({
      ...this.toScanView(group.latest),
      versions: group.versions,
    }));
    return { items, total: items.length };
  }

  requireScan(id: string): ScanRow {
    const row = this.db.get<ScanRow>('SELECT * FROM security_scans WHERE id = ?', id);
    if (!row) throw new ApiError('SEC_NOT_FOUND', { id });
    return row;
  }

  /** 最近一次漏洞库导入快照，写入扫描记录与报告以便复现 */
  private latestAdvisorySnapshotId(): string | null {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM advisory_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    return row?.id ?? null;
  }

  /** 供隔离放行等场景复用原始签名，避免放行后丢失验签上下文 */
  signatureOfScan(id: string | null | undefined): string | null {
    if (!id) return null;
    const row = this.db.get<{ signature: string | null }>('SELECT signature FROM security_scans WHERE id = ?', id);
    return row?.signature ?? null;
  }

  async readQuarantineFile(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const row = this.requireScan(id);
    if (!row.quarantine_path) throw new ApiError('SEC_QUARANTINE_NOT_FOUND', { id });
    const buffer = await fsp.readFile(this.quarantineAbsolutePath(row.quarantine_path));
    return { buffer, filename: row.filename };
  }

  /**
   * 隔离处置三段式（RV-18 幂等）：
   * 1) claimQuarantineDisposition：原子占位（released_at = 'pending:<runId>'），抢占失败区分「已处置」与「处置中」
   * 2) 调用方编排入库等副作用（见 security.controller 的 release）
   * 3) completeQuarantineDisposition：落真实处置时间与副作用；失败则 abandonQuarantineClaim 释放占位
   */
  claimQuarantineDisposition(id: string, actorId: string, mode: 'release' | 'delete'): { row: ScanRow; already: boolean } {
    const row = this.requireScan(id);
    const claimToken = `pending:${randomUUID()}`;
    const claimed = this.db.run(
      'UPDATE security_scans SET released_at = ?, released_by = ? WHERE id = ? AND released_at IS NULL',
      claimToken,
      mode === 'delete' ? `deleted:${actorId}` : actorId,
      id,
    );
    if (claimed.changes === 0) {
      // 已有处置痕迹：真实时间戳 = 已完成（幂等返回）；pending 前缀 = 他人处置中（409）
      if (row.released_at?.startsWith('pending:')) {
        throw new ApiError('SEC_QUARANTINE_BUSY', { id });
      }
      return { row, already: true };
    }
    return { row, already: false };
  }

  /** 处置失败时释放占位，样本回到未处置状态供重试 */
  abandonQuarantineClaim(id: string): void {
    this.db.run("UPDATE security_scans SET released_at = NULL, released_by = NULL WHERE id = ? AND released_at LIKE 'pending:%'", id);
  }

  async completeQuarantineDisposition(id: string, actorId: string, mode: 'release' | 'delete', row: ScanRow): Promise<void> {
    if (row.quarantine_path) {
      try {
        await fsp.rm(path.join(getConfig().security.quarantineDir, row.id), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(`隔离文件清理失败 ${row.quarantine_path}: ${(err as Error).message}`);
      }
    }

    if (row.package_version_id) {
      // 复检隔离的存量版本：放行恢复 active，废弃则软删除
      this.db.run(
        'UPDATE package_versions SET status = ? WHERE id = ?',
        mode === 'delete' ? 'deleted' : 'active',
        row.package_version_id,
      );
    } else if (mode === 'delete') {
      // 上传期隔离且决定废弃：清理未被引用的对象
      await this.discardObjectIfUnreferenced(row.sha256);
    }

    // 占位值落为真实处置时间，标记整个处置闭环完成
    this.db.run(
      "UPDATE security_scans SET released_at = ?, released_by = ? WHERE id = ? AND released_at LIKE 'pending:%'",
      nowIso(),
      mode === 'delete' ? `deleted:${actorId}` : actorId,
      id,
    );

    this.audit.log({
      actorId,
      action: mode === 'delete' ? 'security.quarantine.delete' : 'security.quarantine.release',
      resourceType: 'security_scan',
      resourceId: id,
      result: 'success',
      detail: { package: `${row.ecosystem}:${row.package_name}@${row.package_version}`, verdict: row.verdict },
    });
    this.telemetry.record('security.quarantine.released', { scanId: id, mode, verdict: row.verdict });
  }

  // ---------- 定期复检 ----------

  /** RV-19：manual/schedule 复检互斥（进程内 flag + DB 运行锁，锁通过 security_rescan_runs 的 RUNNING 态判定） */
  private rescanInflight = false;
  private static readonly RESCAN_STALE_MS = 24 * 60 * 60 * 1000;

  async runRescan(trigger: 'manual' | 'schedule', actorId?: string | null) {
    if (this.rescanInflight) throw new ApiError('SEC_RESCAN_BUSY', { trigger });
    // 字典管理关闭漏洞扫描后复检一并停用：扫描结论不再更新，避免误导安全台账
    if (!getConfig().security.scanEnabled) throw new ApiError('SEC_SCAN_DISABLED', { trigger });

    // DB 运行锁兜底跨进程场景；进程崩溃残留的 RUNNING 视为僵尸（超过 24h），标记中断后放行新轮次
    const staleBefore = new Date(Date.now() - SecurityService.RESCAN_STALE_MS).toISOString();
    this.db.run(
      "UPDATE security_rescan_runs SET status = 'ABORTED', detail = COALESCE(detail, '') || '进程中断，运行锁已判定为僵尸并释放' WHERE status = 'RUNNING' AND started_at < ?",
      staleBefore,
    );
    const active = this.db.get<{ id: string }>("SELECT id FROM security_rescan_runs WHERE status = 'RUNNING' LIMIT 1");
    if (active) throw new ApiError('SEC_RESCAN_BUSY', { runningRunId: active.id, trigger });

    this.rescanInflight = true;
    try {
      return await this.executeRescan(trigger, actorId);
    } finally {
      this.rescanInflight = false;
    }
  }

  private async executeRescan(trigger: 'manual' | 'schedule', actorId?: string | null) {
    const runId = randomUUID();
    const startedAt = nowIso();
    this.db.run(
      'INSERT INTO security_rescan_runs (id, trigger, status, started_at) VALUES (?,?,?,?)',
      runId,
      trigger,
      'RUNNING',
      startedAt,
    );

    const versions = this.db.all<{
      id: string;
      ecosystem: 'npm' | 'pypi';
      package_name: string;
      version: string;
      filename: string;
      sha256: string;
      size_bytes: number;
      storage_key: string;
      source: string;
      uploader_id: string | null;
      signature: string | null;
    }>(
      `SELECT v.id, p.ecosystem, p.normalized_name AS package_name, v.version, v.filename, v.sha256, v.size_bytes,
              v.storage_key, v.source, v.uploader_id, v.signature
       FROM package_versions v JOIN packages p ON p.id = v.package_id
       WHERE v.status = 'active' ORDER BY v.created_at ASC`,
    );

    const cfg = getConfig().security;
    let scanned = 0;
    let changed = 0;
    let newFindings = 0;
    let quarantined = 0;
    const errors: string[] = [];
    const changes: Record<string, unknown>[] = [];

    for (const [index, version] of versions.entries()) {
      // 逐包节流：复检串行执行会长时间占满扫描槽，包与包之间让出 CPU 与槽位
      if (index > 0 && cfg.rescanPauseMs > 0) await sleep(cfg.rescanPauseMs);
      try {
        const buffer = await fsp.readFile(this.storage.absolutePath(version.storage_key));
        const previous = this.latestForVersion(version.id);
        // 复用上传时持久化的签名；老数据回退到最近一次扫描记录，避免复检丢失验签上下文
        const signature = version.signature ?? this.signatureOfScan(previous?.id) ?? undefined;
        const input: ScanInput = {
          ecosystem: version.ecosystem,
          name: version.package_name,
          version: version.version,
          filename: version.filename,
          sha256: version.sha256,
          sizeBytes: Number(version.size_bytes),
          source: version.source,
          trigger: 'rescan',
          signature,
          buffer,
        };
        await this.acquireScanSlot();
        let outcome: ScanOutcome;
        try {
          outcome = await this.withTimeout(this.evaluate(input), cfg.scanTimeoutMs);
        } finally {
          this.releaseScanSlot();
        }
        scanned++;

        const previousIds = previous ? this.findingKeys(previous.id) : '';
        const changedNow = !previous || previous.verdict !== outcome.verdict || previousIds !== this.fingerprint(outcome.findings);
        if (!changedNow) continue;

        changed++;
        const previousCount = previousIds ? previousIds.split('|').filter(Boolean).length : 0;
        newFindings += Math.max(0, outcome.findings.length - previousCount);

        const scanId = randomUUID();
        const needQuarantine =
          SEVERITY_RANK[outcome.verdict] >= SEVERITY_RANK[cfg.quarantineSeverity] && outcome.findings.length > 0;
        const quarantinePath = needQuarantine ? await this.writeQuarantine(input, scanId) : null;

        await this.persistScan(scanId, input, outcome, {
          versionId: version.id,
          quarantineKind: quarantinePath ? 'version' : null,
          quarantinePath,
        });

        if (needQuarantine) {
          this.db.run("UPDATE package_versions SET status = 'quarantined' WHERE id = ?", version.id);
          quarantined++;
        }

        this.audit.log({
          actorId: actorId ?? null,
          action: 'security.rescan.changed',
          resourceType: 'package',
          resourceId: `${version.ecosystem}:${version.package_name}@${version.version}`,
          result: outcome.disposition === 'BLOCK' ? 'failure' : 'success',
          detail: {
            scanId,
            previousVerdict: previous?.verdict ?? null,
            verdict: outcome.verdict,
            disposition: outcome.disposition,
            quarantined: needQuarantine,
          },
        });

        changes.push({
          name: version.package_name,
          version: version.version,
          verdict: outcome.verdict,
          disposition: outcome.disposition,
          quarantined: needQuarantine,
          scanId,
        });
      } catch (err) {
        errors.push(`${version.package_name}@${version.version}: ${(err as Error).message}`);
      }
    }

    const finishedAt = nowIso();
    this.db.run(
      `UPDATE security_rescan_runs SET status = ?, scanned = ?, changed = ?, new_findings = ?, quarantined = ?, detail = ?, finished_at = ? WHERE id = ?`,
      errors.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
      scanned,
      changed,
      newFindings,
      quarantined,
      JSON.stringify({ changes: changes.slice(0, 200), errors: errors.slice(0, 100) }),
      finishedAt,
      runId,
    );

    this.audit.log({
      actorId: actorId ?? null,
      action: 'security.rescan.completed',
      resourceType: 'security_rescan',
      resourceId: runId,
      result: errors.length > 0 ? 'failure' : 'success',
      detail: { trigger, scanned, changed, newFindings, quarantined, errors: errors.slice(0, 20) },
    });
    this.telemetry.record('security.rescan.completed', { runId, trigger, scanned, changed, quarantined });

    return { runId, trigger, scanned, changed, newFindings, quarantined, errors, changes };
  }

  private findingKeys(scanId: string): string {
    const rows = this.db.all<{ dimension: string; rule_id: string }>(
      'SELECT dimension, rule_id FROM security_findings WHERE scan_id = ?',
      scanId,
    );
    return rows
      .map((row) => `${row.dimension}:${row.rule_id}`)
      .sort()
      .join('|');
  }

  private fingerprint(findings: SecurityFinding[]): string {
    return Array.from(new Set(findings.map((item) => `${item.dimension}:${item.ruleId}`)))
      .sort()
      .join('|');
  }
}

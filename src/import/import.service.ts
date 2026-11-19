import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors';
import { nowIso, sha256Hex } from '../common/http.util';
import { DatabaseService } from '../db/database.service';
import {
  parseSdistFilename,
  parseWheelFilename,
  readNpmPackageManifest,
  validateNpmPackage,
  validatePypiPackage,
  type CheckIssue,
  type RuntimeTargets,
} from '../packages/package-validator';
import {
  normalizeName,
  normalizeVersion,
  PackagesService,
  type Ecosystem,
} from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';
import { MissingService } from '../missing/missing.service';
import { SecurityService } from '../security/security.service';
import type { SecurityFinding } from '../security/types';
import { getConfig } from '../config/config';

interface BatchRow {
  id: string;
  manifest_hash: string;
  ecosystem: string;
  mode: string;
  status: string;
  operator_id: string | null;
  targets: string | null;
  stats: string | null;
  report_key: string | null;
  manifest_key: string | null;
  created_at: string;
  finished_at: string | null;
}

interface ItemRow {
  id: string;
  batch_id: string;
  item_no: number;
  ecosystem: Ecosystem;
  name: string;
  version: string;
  file_path: string | null;
  sha256: string | null;
  status: string;
  reason_codes: string | null;
  detail: string | null;
  package_version_id: string | null;
}

// CSV 单元格转义：以 = + - @ 开头的内容会被 Excel 当公式执行，前置单引号强制按文本处理
function csvCell(value: unknown): string {
  let raw = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(raw)) raw = `'${raw}`;
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

interface ItemDetail {
  storedFile?: string;
  digests?: { sha256: string; shasum: string; integrity: string };
  issues?: CheckIssue[];
  metadata?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
  /** 校验阶段缓存的安全预扫描结论，strict 提交时直接复用，避免写入后才发现拦截 */
  security?: {
    verdict: string;
    disposition: string;
    score: number;
    signatureStatus: string;
    findings: SecurityFinding[];
  };
}

export interface UploadFileInput {
  filename: string;
  /** 磁盘临时文件路径（优先使用，避免整包进内存） */
  path?: string;
  buffer?: Buffer;
  field?: string;
}

const BATCH_STATUS = {
  parsed: 'PARSED',
  validating: 'VALIDATING',
  validated: 'VALIDATED',
  validatedWithErrors: 'VALIDATED_WITH_ERRORS',
  committing: 'COMMITTING',
  completed: 'COMPLETED',
  partial: 'PARTIAL_COMPLETED',
  failed: 'FAILED',
} as const;

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger('Import');

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly packages: PackagesService,
    private readonly missing: MissingService,
    private readonly security: SecurityService,
  ) {}

  /**
   * 「只上传包」入口：从包文件自身识别包名/版本，自动生成清单条目并直接绑定文件。
   * 识别不了的单个文件只进 failed，不影响同批其它文件；后续校验/入库与清单流程完全一致。
   */
  async createBatchFromFiles(input: { files: UploadFileInput[]; operatorId: string }) {
    const cfg = getConfig();
    const identified: {
      filename: string;
      ecosystem: Ecosystem;
      name: string;
      version: string;
      file: UploadFileInput;
    }[] = [];
    const failed: { filename: string; reason: string }[] = [];
    let totalBytes = 0;

    for (const file of input.files) {
      const size = file.path ? (await fsp.stat(file.path)).size : (file.buffer as Buffer).length;
      totalBytes += size;
      if (size > cfg.limits.maxUploadBytes || totalBytes > cfg.limits.maxUploadBytes) {
        throw new ApiError('UPLOAD_FILE_TOO_LARGE', {
          filename: file.filename,
          maxBytes: cfg.limits.maxUploadBytes,
        });
      }
      try {
        identified.push({ ...(await this.identifyPackageFile(file)), file });
      } catch (err) {
        failed.push({ filename: file.filename, reason: (err as Error).message });
      }
    }

    if (identified.length === 0) {
      throw new ApiError('UPLOAD_EMPTY', { reason: '没有可自动识别的包文件', failed });
    }

    // 运行时目标沿用环境默认值：自动模式没有清单可声明 targets
    const targets: RuntimeTargets = {};
    if (identified.some((i) => i.ecosystem === 'npm') && cfg.defaults.node) targets.node = cfg.defaults.node;
    if (identified.some((i) => i.ecosystem === 'pypi') && cfg.defaults.python) targets.python = cfg.defaults.python;

    const id = randomUUID();
    const createdAt = nowIso();
    const ecosystems = new Set(identified.map((i) => i.ecosystem));
    const manifestHash = sha256Hex(
      Buffer.from(JSON.stringify(identified.map((i) => [i.filename, i.ecosystem, i.name, i.version]))),
    );

    this.db.run(
      `INSERT INTO import_batches (id, manifest_hash, ecosystem, mode, status, operator_id, targets, stats, manifest_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      manifestHash,
      ecosystems.size === 1 ? [...ecosystems][0] : 'mixed',
      cfg.defaultBatchMode,
      BATCH_STATUS.parsed,
      input.operatorId,
      JSON.stringify(targets),
      JSON.stringify({ total: 0, autoIdentified: true }),
      null,
      createdAt,
    );

    let itemNo = 0;
    const created: (typeof identified)[number][] = [];
    for (const item of identified) {
      itemNo += 1;
      try {
        const relative = item.file.path
          ? await this.storage.saveBatchFileFromPath(id, item.filename, item.file.path)
          : await this.storage.saveBatchFile(id, item.filename, item.file.buffer as Buffer);
        // storedFile 直接落库：自动模式不需要靠文件名再匹配一次
        this.db.run(
          `INSERT INTO import_batch_items (id, batch_id, item_no, ecosystem, name, version, file_path, sha256, status, reason_codes, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(),
          id,
          itemNo,
          item.ecosystem,
          item.name,
          item.version,
          item.filename,
          null,
          'PENDING',
          JSON.stringify([]),
          JSON.stringify({ storedFile: relative }),
        );
        created.push(item);
      } catch (err) {
        failed.push({ filename: item.filename, reason: `文件保存失败：${(err as Error).message}` });
      }
    }

    if (created.length === 0) {
      this.db.run('UPDATE import_batches SET status = ? WHERE id = ?', BATCH_STATUS.failed, id);
      throw new ApiError('UPLOAD_EMPTY', { reason: '包文件全部处理失败', failed });
    }

    this.db.run('UPDATE import_batches SET stats = ? WHERE id = ?', JSON.stringify({ total: created.length }), id);

    let newCount = 0;
    let existingCount = 0;
    const byEcosystem: Record<string, number> = {};
    for (const item of created) {
      byEcosystem[item.ecosystem] = (byEcosystem[item.ecosystem] || 0) + 1;
      if (this.packages.findVersion(item.ecosystem, item.name, item.version)) existingCount += 1;
      else newCount += 1;
    }

    return {
      batchId: id,
      status: BATCH_STATUS.parsed,
      preview: {
        total: created.length,
        byEcosystem,
        newCount,
        existingCount,
        conflictCount: 0,
        warnings: [] as string[],
        missingTargets: false,
        missingTargetFields: [] as string[],
        targets,
      },
      failed,
    };
  }

  /** 按扩展名识别包身份：.tgz 读包内 package.json，.whl / .tar.gz 解析文件名 */
  private async identifyPackageFile(file: UploadFileInput): Promise<{
    filename: string;
    ecosystem: Ecosystem;
    name: string;
    version: string;
  }> {
    const filename = (file.filename || '').split('/').pop() || file.filename;
    const lower = filename.toLowerCase();

    if (lower.endsWith('.tgz')) {
      const buffer = file.buffer ?? (await fsp.readFile(file.path as string));
      const manifest = await readNpmPackageManifest(buffer).catch((err) => {
        throw new Error(`npm 包解析失败：${(err as Error).message}`);
      });
      if (!manifest.name || !manifest.version) throw new Error('package.json 缺少 name 或 version');
      return { filename, ecosystem: 'npm', name: manifest.name, version: manifest.version };
    }

    if (lower.endsWith('.whl')) {
      const info = parseWheelFilename(filename);
      if (!info || !info.name || !info.version) throw new Error('wheel 文件名不符合规范，无法识别包名/版本');
      return { filename, ecosystem: 'pypi', name: info.name, version: info.version };
    }

    if (lower.endsWith('.tar.gz')) {
      const info = parseSdistFilename(filename);
      if (!info) throw new Error('sdist 文件名缺少名称或版本，无法识别');
      return { filename, ecosystem: 'pypi', name: info.name, version: info.version };
    }

    if (lower.endsWith('.zip')) {
      // zip 已由 controller 展开一层；走到这里的 zip 只能是嵌套 zip，不递归展开
      throw new Error('zip 内不支持再嵌套 zip，请直接打包 .tgz / .whl / .tar.gz');
    }
    throw new Error('不支持的文件类型，仅支持 .tgz / .whl / .tar.gz');
  }

  private missingTargets(items: { ecosystem: Ecosystem }[], targets: RuntimeTargets): string[] {
    const missing: string[] = [];
    if (items.some((i) => i.ecosystem === 'npm') && !targets.node) missing.push('targets.node');
    if (items.some((i) => i.ecosystem === 'pypi') && !targets.python) missing.push('targets.python');
    return missing;
  }

  // ---------- 全量校验 ----------

  async validate(batchId: string) {
    const batch = this.requireBatch(batchId);
    if (!['PARSED', 'VALIDATED', 'VALIDATED_WITH_ERRORS'].includes(batch.status)) {
      throw new ApiError('BATCH_STATE_INVALID', { status: batch.status });
    }

    this.db.run('UPDATE import_batches SET status = ? WHERE id = ?', BATCH_STATUS.validating, batchId);
    const items = this.loadItems(batchId);
    const targets = safeJson<RuntimeTargets>(batch.targets, {});
    const targetIssues = this.missingTargets(items, targets);
    const batchVersions = new Map<string, string[]>();

    let validCount = 0;
    let invalidCount = 0;
    let warningCount = 0;

    for (const item of items) {
      const detail = safeJson<ItemDetail>(item.detail, {});
      const issues: CheckIssue[] = [];

      if (!detail.storedFile) {
        issues.push({ code: 'PKG_FILE_UNMATCHED', severity: 'error', message: '未匹配到包文件，请先上传' });
        this.markItem(item, 'INVALID', issues, detail, null);
        invalidCount++;
        continue;
      }
      if (targetIssues.length > 0) {
        issues.push({
          code: 'TARGET_UNDECLARED',
          severity: 'error',
          message: `批次缺少运行时目标声明：${targetIssues.join(', ')}`,
        });
      }

      let buffer: Buffer;
      try {
        buffer = await fsp.readFile(this.storage.absolutePath(detail.storedFile));
      } catch (err) {
        issues.push({ code: 'PKG_FILE_MISSING', severity: 'error', message: `文件读取失败：${(err as Error).message}` });
        this.markItem(item, 'INVALID', issues, detail, null);
        invalidCount++;
        continue;
      }

      const existsInRegistry = Boolean(this.packages.findVersion(item.ecosystem, item.name, item.version));
      const resolveVersions = (depName: string) => {
        const key = normalizeName('npm', depName);
        return [...this.packages.availableVersions('npm', key), ...(batchVersions.get(key) || [])];
      };

      let outcome;
      if (item.ecosystem === 'npm') {
        outcome = await validateNpmPackage({
          buffer,
          name: item.name,
          version: item.version,
          declaredSha256: item.sha256 ?? undefined,
          existsInRegistry,
          targets,
          resolveVersions,
        });
      } else {
        const requiresPython = String(detail.metadata?.requiresPython || '') || undefined;
        outcome = validatePypiPackage({
          buffer,
          filename: (item.file_path || '').split('/').pop() || `${item.name}-${item.version}.tar.gz`,
          name: item.name,
          version: item.version,
          declaredSha256: item.sha256 ?? undefined,
          existsInRegistry,
          targets,
          requiresPython,
        });
      }

      issues.push(...outcome.issues);
      detail.digests = outcome.digests;
      detail.metadata = outcome.metadata;
      detail.compatibility = outcome.compatibility;

      // 结构校验通过后再做安全预扫描：批次页面即可看到拦截结论，避免提交时才发现部分条目失败
      if (!issues.some((i) => i.severity === 'error')) {
        const securityIssue = await this.attachSecurityPreview(item, buffer, detail, outcome.digests.sha256);
        if (securityIssue) issues.push(securityIssue);
      }

      if (item.ecosystem === 'npm' && outcome.status === 'valid') {
        const key = normalizeName('npm', item.name);
        const list = batchVersions.get(key) || [];
        list.push(item.version);
        batchVersions.set(key, list);
      }

      if (issues.some((i) => i.severity === 'error')) {
        invalidCount++;
        this.markItem(item, 'INVALID', issues, detail, outcome.digests);
      } else {
        validCount++;
        if (issues.length > 0) warningCount++;
        this.markItem(item, 'VALID', issues, detail, outcome.digests);
      }
    }

    const reloaded = this.loadItems(batchId);
    const securityBlocked = reloaded.filter((item) =>
      safeJson<string[]>(item.reason_codes, []).some((code) =>
        code === 'SEC_BLOCKED' || code === 'SEC_QUARANTINED' || code === 'SEC_SCAN_FAILED',
      ),
    ).length;
    const stats = {
      total: items.length,
      valid: validCount,
      invalid: invalidCount,
      warnings: warningCount,
      securityBlocked,
      targetIssues,
    };
    const status = invalidCount > 0 ? BATCH_STATUS.validatedWithErrors : BATCH_STATUS.validated;
    const report = {
      batchId,
      generatedAt: nowIso(),
      targets,
      stats,
      items: this.loadItems(batchId).map((item) => ({
        itemNo: item.item_no,
        ecosystem: item.ecosystem,
        name: item.name,
        version: item.version,
        status: item.status,
        sha256: item.sha256,
        reasonCodes: safeJson<string[]>(item.reason_codes, []),
        issues: safeJson<ItemDetail>(item.detail, {}).issues || [],
        securityDisposition: safeJson<ItemDetail>(item.detail, {}).security?.disposition || null,
      })),
    };
    const reportKey = await this.storage.putMeta(`report-${batchId}`, JSON.stringify(report, null, 2));

    this.db.run(
      'UPDATE import_batches SET status = ?, stats = ?, report_key = ? WHERE id = ?',
      status,
      JSON.stringify(stats),
      reportKey,
      batchId,
    );

    this.logger.log(`批次 ${batchId} 校验完成: ${validCount}/${items.length} 通过`);
    return { batchId, status, stats };
  }

  /**
   * 安全预扫描并缓存结论。BLOCK/QUARANTINE 均视为不可入库，
   * 直接转成 error issue，让批次报告与 strict 提交使用同一份判定。
   * 字典管理关闭漏洞扫描时跳过预扫描，条目按无安全结论处理。
   */
  private async attachSecurityPreview(
    item: ItemRow,
    buffer: Buffer,
    detail: ItemDetail,
    digestSha256: string,
  ): Promise<CheckIssue | null> {
    if (!getConfig().security.scanEnabled) return null;
    try {
      const outcome = await this.security.preview({
        ecosystem: item.ecosystem,
        name: item.name,
        version: item.version,
        filename: this.filenameOf(item),
        sha256: digestSha256,
        sizeBytes: buffer.length,
        source: 'batch',
        buffer,
      });
      detail.security = {
        verdict: outcome.verdict,
        disposition: outcome.disposition,
        score: outcome.score,
        signatureStatus: outcome.signature,
        findings: outcome.findings,
      };
      if (outcome.disposition !== 'BLOCK' && outcome.disposition !== 'QUARANTINE') return null;
      const top = outcome.findings
        .slice(0, 3)
        .map((finding) => `${finding.ruleId}(${finding.severity}) ${finding.title}`)
        .join('；');
      return {
        code: outcome.disposition === 'BLOCK' ? 'SEC_BLOCKED' : 'SEC_QUARANTINED',
        severity: 'error',
        message: `安全校验${outcome.disposition === 'BLOCK' ? '拦截' : '需隔离复核'}：${top || outcome.verdict}`,
      };
    } catch (err) {
      // 预扫描失败按阻断处理，和入库闸门的 fail-closed 语义保持一致
      return { code: 'SEC_SCAN_FAILED', severity: 'error', message: `安全预扫描失败：${(err as Error).message}` };
    }
  }

  private filenameOf(item: ItemRow): string {
    const base = (item.file_path || '').split('/').pop();
    if (base) return base;
    return item.ecosystem === 'pypi' ? `${item.name}-${item.version}.tar.gz` : `${item.name}-${item.version}.tgz`;
  }

  private markItem(
    item: ItemRow,
    status: string,
    issues: CheckIssue[],
    detail: ItemDetail,
    digests: { sha256: string; shasum: string; integrity: string } | null,
  ): void {
    detail.issues = issues;
    if (digests) detail.digests = digests;
    this.db.run(
      'UPDATE import_batch_items SET status = ?, reason_codes = ?, detail = ? WHERE id = ?',
      status,
      JSON.stringify(Array.from(new Set(issues.map((i) => i.code)))),
      JSON.stringify(detail),
      item.id,
    );
  }

  // ---------- 批量入库 ----------

  async commit(batchId: string, mode: 'partial' | 'strict', operatorId: string) {
    const batch = this.requireBatch(batchId);
    if (!['VALIDATED', 'VALIDATED_WITH_ERRORS'].includes(batch.status)) {
      throw new ApiError('BATCH_STATE_INVALID', { status: batch.status, hint: '请先完成全量校验' });
    }
    const items = this.loadItems(batchId);
    const invalid = items.filter((i) => i.status === 'INVALID');
    if (mode === 'strict' && invalid.length > 0) {
      throw new ApiError('BATCH_HAS_BLOCKING_ITEMS', {
        items: invalid.map((i) => ({ itemNo: i.item_no, name: i.name, version: i.version })),
      });
    }
    if (items.length === 0) throw new ApiError('BATCH_EMPTY');

    // strict 是全有或全无：写入前完成全部安全判定，任一 BLOCK/QUARANTINE 直接终止，零写入
    if (mode === 'strict') {
      const blocked: { itemNo: number; name: string; version: string; disposition: string }[] = [];
      for (const item of items) {
        if (item.status !== 'VALID') continue;
        const detail = safeJson<ItemDetail>(item.detail, {});
        let blockedReason: string | null = null;
        if (!detail.security) {
          // 历史批次没有预扫描结论，写入前补做一次
          const buffer = await fsp.readFile(this.storage.absolutePath(detail.storedFile as string));
          const issue = await this.attachSecurityPreview(item, buffer, detail, detail.digests?.sha256 || item.sha256 || '');
          this.db.run('UPDATE import_batch_items SET detail = ? WHERE id = ?', JSON.stringify(detail), item.id);
          if (issue) blockedReason = issue.code;
        }
        const disposition = detail.security?.disposition;
        if (blockedReason || disposition === 'BLOCK' || disposition === 'QUARANTINE') {
          blocked.push({
            itemNo: item.item_no,
            name: item.name,
            version: item.version,
            disposition: blockedReason ?? (disposition as string),
          });
        }
      }
      if (blocked.length > 0) throw new ApiError('BATCH_HAS_BLOCKING_ITEMS', { security: blocked });
    }

    this.db.run('UPDATE import_batches SET status = ?, mode = ? WHERE id = ?', BATCH_STATUS.committing, mode, batchId);

    let committed = 0;
    let failed = 0;
    let skipped = 0;
    const unresolvedDeps: string[] = [];

    for (const item of items) {
      const detail = safeJson<ItemDetail>(item.detail, {});
      if (item.status !== 'VALID') {
        skipped++;
        this.db.run("UPDATE import_batch_items SET status = 'SKIPPED' WHERE id = ?", item.id);
        continue;
      }
      try {
        if (!detail.storedFile) throw new ApiError('PKG_FILE_MISSING');
        const buffer = await fsp.readFile(this.storage.absolutePath(detail.storedFile));
        const stored = await this.storage.putObject(buffer);

        const versionRow = await this.packages.insertVersion({
          ecosystem: item.ecosystem,
          name: item.name,
          version: item.version,
          filename: (item.file_path || '').split('/').pop() || `${item.name}-${item.version}`,
          sha256: stored.sha256,
          sizeBytes: stored.size,
          storageKey: stored.key,
          metadata: { ...(detail.metadata || {}), dist: { shasum: stored.shasum, integrity: stored.integrity } },
          compatibility: detail.compatibility || null,
          uploaderId: operatorId,
          source: 'batch',
        });

        this.db.run(
          "UPDATE import_batch_items SET status = 'COMMITTED', package_version_id = ? WHERE id = ?",
          versionRow.id,
          item.id,
        );
        committed++;

        const issues = detail.issues || [];
        if (item.ecosystem === 'npm') {
          const deps = (detail.metadata?.dependencies as Record<string, string> | null) || null;
          if (deps && issues.some((i) => i.code === 'PKG_DEP_UNRESOLVED')) {
            for (const depName of Object.keys(deps)) {
              if (this.packages.availableVersions('npm', depName).length === 0) unresolvedDeps.push(depName);
            }
          }
        }
      } catch (err) {
        failed++;
        const reason = err instanceof ApiError ? err.code : 'SYS_INTERNAL';
        const detailNext: ItemDetail = { ...detail, issues: [...(detail.issues || []), {
          code: reason,
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
        }] };
        this.db.run(
          "UPDATE import_batch_items SET status = 'FAILED', reason_codes = ?, detail = ? WHERE id = ?",
          JSON.stringify(Array.from(new Set([...(detail.issues || []).map((i) => i.code), reason]))),
          JSON.stringify(detailNext),
          item.id,
        );
      }
    }

    if (unresolvedDeps.length > 0) {
      this.missing.reportSilently('npm', unresolvedDeps, `batch:${batchId}`);
    }

    const stats = {
      total: items.length,
      committed,
      failed,
      skipped,
      mode,
    };
    const status =
      committed === 0
        ? BATCH_STATUS.failed
        : failed === 0 && skipped === 0
          ? BATCH_STATUS.completed
          : BATCH_STATUS.partial;

    this.db.run(
      'UPDATE import_batches SET status = ?, stats = ?, finished_at = ? WHERE id = ?',
      status,
      JSON.stringify(stats),
      nowIso(),
      batchId,
    );

    return { batchId, status, stats };
  }

  // ---------- 查询与报告 ----------

  getBatch(batchId: string) {
    const batch = this.requireBatch(batchId);
    const items = this.loadItems(batchId).map((item) => {
      const detail = safeJson<ItemDetail>(item.detail, {});
      return {
        itemNo: item.item_no,
        ecosystem: item.ecosystem,
        name: item.name,
        version: item.version,
        filePath: item.file_path,
        sha256: item.sha256,
        status: item.status,
        reasonCodes: safeJson<string[]>(item.reason_codes, []),
        issues: detail.issues || [],
        packageVersionId: item.package_version_id,
      };
    });
    return {
      batchId: batch.id,
      ecosystem: batch.ecosystem,
      mode: batch.mode,
      status: batch.status,
      targets: safeJson<RuntimeTargets>(batch.targets, {}),
      stats: safeJson<Record<string, unknown>>(batch.stats, {}),
      createdAt: batch.created_at,
      finishedAt: batch.finished_at,
      items,
    };
  }

  async getReport(batchId: string, format: 'json' | 'csv') {
    const batch = this.requireBatch(batchId);
    if (!batch.report_key) throw new ApiError('BATCH_STATE_INVALID', { status: batch.status, hint: '尚未生成校验报告' });
    const raw = await this.storage.readMeta(batch.report_key);
    if (format === 'json') return { contentType: 'application/json', body: raw.toString('utf8') };

    const report = JSON.parse(raw.toString('utf8')) as {
      items: { itemNo: number; ecosystem: string; name: string; version: string; status: string; reasonCodes: string[]; issues: { message: string }[] }[];
    };
    const header = 'itemNo,ecosystem,name,version,status,reasonCodes,message';
    const lines = report.items.map((item) =>
      [
        item.itemNo,
        item.ecosystem,
        item.name,
        item.version,
        item.status,
        item.reasonCodes.join('|'),
        item.issues.map((i) => i.message).join('；'),
      ]
        .map(csvCell)
        .join(','),
    );
    return { contentType: 'text/csv; charset=utf-8', body: `\ufeff${[header, ...lines].join('\n')}` };
  }

  private requireBatch(batchId: string): BatchRow {
    const batch = this.db.get<BatchRow>('SELECT * FROM import_batches WHERE id = ?', batchId);
    if (!batch) throw new ApiError('BATCH_NOT_FOUND', { batchId });
    return batch;
  }

  private loadItems(batchId: string): ItemRow[] {
    return this.db.all<ItemRow>('SELECT * FROM import_batch_items WHERE batch_id = ? ORDER BY item_no ASC', batchId);
  }
}

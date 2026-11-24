import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../common/errors';
import { nowIso, sha256File, sha256Hex } from '../common/http.util';
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
  normalizeVersion,
  PackagesService,
  type Ecosystem,
  type InsertVersionInput,
} from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';
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

/**
 * 批次条目对外展示的失败原因。
 * ApiError 的 message 来自 ERROR_DEFS 固定文案，可以安全返回；
 * 其余异常（fs/sqlite/底层库）的 message 常含服务器绝对路径或内部细节，
 * 统一换成通用文案，原始信息只写服务端日志。
 */
function publicIssueMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return '处理失败，详情见服务端日志';
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger('Import');

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly packages: PackagesService,
    private readonly security: SecurityService,
  ) {}

  /**
   * 「只上传包」入口：从包文件自身识别包名/版本，自动生成清单条目并直接绑定文件。
   * 识别不了的单个文件只进 failed，不影响同批其它文件；后续校验/入库与清单流程完全一致。
   *
   * 幂等：manifest_hash 由「文件内容 sha256 + 包身份 + 运行时目标」算出，
   * 同一个人重复提交同一批包（双击、浏览器重发、网络重试）会命中同一批在途批次，
   * 不会重复落盘、重复扫描。已结束的批次不复用——那多半是「删了版本想重导」，
   * 交给版本查重给出明确提示，比静默返回旧批次更容易理解。
   */
  async createBatchFromFiles(input: { files: UploadFileInput[]; operatorId: string }) {
    const cfg = getConfig();
    const identified: {
      filename: string;
      ecosystem: Ecosystem;
      name: string;
      version: string;
      sha256: string;
      sizeBytes: number;
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
        const identity = await this.identifyPackageFile(file);
        // 内容指纹：文件内容才是「同一批包」的真正标识，文件名+版本相同但内容被重新打包时必须区分开
        const sha256 = file.path ? await sha256File(file.path) : sha256Hex(file.buffer as Buffer);
        identified.push({ ...identity, sha256, sizeBytes: size, file });
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

    // 排序后再摘要：同内容不同上传顺序应算同一批，否则「先传 A 再传 B」与「先 B 后 A」会被当成两批
    const fingerprint = identified
      .map((i) => [i.filename, i.ecosystem, i.name, i.version, i.sha256, i.sizeBytes])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[4]).localeCompare(String(b[4])));
    const manifestHash = sha256Hex(
      JSON.stringify({ v: 1, targets, items: fingerprint, unrecognized: failed.map((f) => f.filename).sort() }),
    );

    const existing = this.db.get<BatchRow>(
      `SELECT * FROM import_batches
        WHERE manifest_hash = ? AND operator_id = ?
          AND status IN (?,?,?,?)
        ORDER BY created_at DESC LIMIT 1`,
      manifestHash,
      input.operatorId,
      BATCH_STATUS.parsed,
      BATCH_STATUS.validating,
      BATCH_STATUS.validated,
      BATCH_STATUS.validatedWithErrors,
    );
    if (existing) {
      const stats = safeJson<{
        total?: number;
        preview?: Record<string, unknown>;
        unrecognized?: { filename: string; reason: string }[];
      }>(existing.stats, {});
      this.logger.log(`批次 ${existing.id} 命中幂等去重（manifest_hash=${manifestHash.slice(0, 12)}），复用未结束批次`);
      return {
        batchId: existing.id,
        status: existing.status,
        preview: stats.preview ?? { total: stats.total ?? 0, byEcosystem: {}, newCount: 0, existingCount: 0, conflictCount: 0 },
        failed: stats.unrecognized ?? [],
        deduplicated: true,
      };
    }

    const id = randomUUID();
    const createdAt = nowIso();
    const ecosystems = new Set(identified.map((i) => i.ecosystem));

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

    let newCount = 0;
    let existingCount = 0;
    const byEcosystem: Record<string, number> = {};
    for (const item of created) {
      byEcosystem[item.ecosystem] = (byEcosystem[item.ecosystem] || 0) + 1;
      if (this.packages.findVersion(item.ecosystem, item.name, item.version)) existingCount += 1;
      else newCount += 1;
    }

    const preview = {
      total: created.length,
      byEcosystem,
      newCount,
      existingCount,
      conflictCount: 0,
      warnings: [] as string[],
      missingTargets: false,
      missingTargetFields: [] as string[],
      targets,
    };
    // preview 与未识别文件一并落库：幂等去重命中时直接回放，不必重新识别文件
    this.db.run(
      'UPDATE import_batches SET stats = ? WHERE id = ?',
      JSON.stringify({ total: created.length, autoIdentified: true, preview, unrecognized: failed }),
      id,
    );

    return {
      batchId: id,
      status: BATCH_STATUS.parsed,
      preview,
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
        // 仓库端按通用源策略入库：运行时目标只用于兼容性提示，不参与准入判定。
        // 与 PKG_RUNTIME_INCOMPATIBLE 保持同一口径——记 code 告警，条目仍可 VALID/入库。
        issues.push({
          code: 'TARGET_UNDECLARED',
          severity: 'warning',
          message: `批次未声明运行时目标（${targetIssues.join(', ')}），已跳过兼容性提示，不影响入库`,
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

      let outcome;
      if (item.ecosystem === 'npm') {
        outcome = await validateNpmPackage({
          buffer,
          name: item.name,
          version: item.version,
          declaredSha256: item.sha256 ?? undefined,
          existsInRegistry,
          targets,
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
      // 保留创建阶段的 preview / 未识别清单：幂等在 VALIDATED 状态下命中时要回放同一份预览
      ...safeJson<Record<string, unknown>>(batch.stats, {}),
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

    // strict 走两阶段原子提交；partial 保留逐项容错写入
    if (mode === 'strict') return this.commitStrict(batchId, items, operatorId);

    let committed = 0;
    let failed = 0;
    let skipped = 0;

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
      } catch (err) {
        failed++;
        const reason = err instanceof ApiError ? err.code : 'SYS_INTERNAL';
        // 对外只给错误码 + 固定文案：底层异常（如 fsp.readFile 失败）的 message 含服务器绝对路径，
        // 直接写进 issues 会随批次报告返回给有 import:run 权限的用户。原始信息只落服务端日志。
        this.logger.warn(
          `批次 ${batchId} 条目 ${item.id} 入库失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        const detailNext: ItemDetail = { ...detail, issues: [...(detail.issues || []), {
          code: reason,
          severity: 'error',
          message: publicIssueMessage(err),
        }] };
        this.db.run(
          "UPDATE import_batch_items SET status = 'FAILED', reason_codes = ?, detail = ? WHERE id = ?",
          JSON.stringify(Array.from(new Set([...(detail.issues || []).map((i) => i.code), reason]))),
          JSON.stringify(detailNext),
          item.id,
        );
      }
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

  /**
   * strict 原子提交：阶段一（事务外）完成读文件、putObject、安全扫描等异步工作，
   * 任一失败整体中止、零 DB 写入；阶段二在单个 db.tx() 内写入全部版本并更新条目状态，
   * 任一失败整批回滚。对象文件在扫描通过后先落盘，失败留下的孤儿由孤儿清扫回收。
   */
  private async commitStrict(batchId: string, items: ItemRow[], operatorId: string) {
    try {
      const prepared: {
        input: InsertVersionInput;
        gate: Awaited<ReturnType<PackagesService['prepareScan']>>;
        item: ItemRow;
      }[] = [];
      for (const item of items) {
        if (item.status !== 'VALID') continue;
        const detail = safeJson<ItemDetail>(item.detail, {});
        if (!detail.storedFile) throw new ApiError('PKG_FILE_MISSING');
        const buffer = await fsp.readFile(this.storage.absolutePath(detail.storedFile));
        const stored = await this.storage.putObject(buffer);
        const input: InsertVersionInput = {
          ecosystem: item.ecosystem as InsertVersionInput['ecosystem'],
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
        };
        // 异步安全扫描在事务外完成；BLOCK/QUARANTINE 抛错即整体中止，零版本入库
        const gate = await this.packages.prepareScan(input);
        prepared.push({ input, gate, item });
      }

      // 阶段二：单事务原子写入 + 同步更新条目状态（含 assertNotDuplicate 含软删除复检）
      this.packages.insertVersionsAtomic(
        prepared.map((p) => ({ input: p.input, gate: p.gate })),
        (row, index) => {
          this.db.run(
            "UPDATE import_batch_items SET status = 'COMMITTED', package_version_id = ? WHERE id = ?",
            row.id,
            prepared[index].item.id,
          );
        },
      );
      // 非 VALID 条目标记为 SKIPPED
      for (const item of items) {
        if (item.status !== 'VALID') {
          this.db.run("UPDATE import_batch_items SET status = 'SKIPPED' WHERE id = ?", item.id);
        }
      }

      const stats = {
        total: items.length,
        committed: prepared.length,
        failed: 0,
        skipped: items.length - prepared.length,
        mode: 'strict' as const,
      };
      this.db.run(
        'UPDATE import_batches SET status = ?, stats = ?, finished_at = ? WHERE id = ?',
        BATCH_STATUS.completed,
        JSON.stringify(stats),
        nowIso(),
        batchId,
      );
      return { batchId, status: BATCH_STATUS.completed, stats };
    } catch (err) {
      // 原子语义：任一阶段失败都零入库，批次明确标记失败，不留 committing 悬挂态
      this.db.run(
        'UPDATE import_batches SET status = ?, stats = ?, finished_at = ? WHERE id = ?',
        BATCH_STATUS.failed,
        JSON.stringify({ total: items.length, committed: 0, failed: items.length, skipped: 0, mode: 'strict' }),
        nowIso(),
        batchId,
      );
      throw err;
    }
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

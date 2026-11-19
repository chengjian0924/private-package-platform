import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as semver from 'semver';
import { ApiError } from '../common/errors';
import { nowIso } from '../common/http.util';
import { getConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import {
  parseSdistFilename,
  parseWheelFilename,
  readNpmPackageManifest,
  validateNpmPackage,
  validatePypiPackage,
} from '../packages/package-validator';
import { normalizeName, PackagesService, type Ecosystem } from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';

export interface MissingRow {
  id: string;
  dedupe_key: string;
  ecosystem: Ecosystem;
  normalized_name: string;
  version_spec: string;
  project_id: string | null;
  hits: number;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
  resolved_version_id: string | null;
  source: 'ci' | 'registry' | 'import';
  requester_ip: string | null;
  user_agent: string | null;
  auth_present: number;
}

/**
 * 从下载路径的文件名尽力解析缺失版本，解析不出返回 '*'。
 * npm tarball 形如 <name>-<version>.tgz；pypi 走 wheel/sdist 文件名解析。
 */
export function versionFromMissedFilename(ecosystem: Ecosystem, filename: string): string {
  if (!filename) return '*';
  const base = filename.split('/').pop() || filename;
  if (ecosystem === 'npm') {
    const match = base.match(/-([0-9][^-]*(?:-[^-]+)*)\.tgz$/i);
    return match ? match[1].slice(0, 128) : '*';
  }
  const wheel = parseWheelFilename(base);
  if (wheel) return wheel.version.slice(0, 128);
  const sdist = parseSdistFilename(base);
  return sdist ? sdist.version.slice(0, 128) : '*';
}

/** 缺失依赖：登记、查询、员工补包并自动闭环 */
@Injectable()
export class MissingService {
  private readonly logger = new Logger('Missing');

  constructor(
    private readonly db: DatabaseService,
    private readonly packages: PackagesService,
    private readonly storage: StorageService,
  ) {}

  report(
    input: {
      projectId?: string;
      ecosystem: Ecosystem;
      dependencies: { name: string; versionSpec?: string }[];
      source?: MissingRow['source'];
    },
  ): { created: number; updated: number; skipped: number; items: MissingRow[] } {
    const projectId = (input.projectId || 'unknown').slice(0, 128);
    const source = input.source ?? 'ci';
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const dep of input.dependencies || []) {
      const normalized = normalizeName(input.ecosystem, dep.name);
      if (!normalized) continue;
      // 显式上报常被接成 CI 全量依赖清单：本地已入库的包必须跳过，
      // 否则每条依赖都会变成一条待补记录，缺失列表瞬间被噪音淹没。
      if (this.packages.availableVersions(input.ecosystem, normalized).length > 0) {
        skipped++;
        continue;
      }
      const versionSpec = (dep.versionSpec || '*').slice(0, 128);
      const dedupeKey = `${input.ecosystem}:${normalized}:${versionSpec}:${projectId}`;
      const existing = this.db.get<MissingRow>('SELECT * FROM missing_dependencies WHERE dedupe_key = ?', dedupeKey);
      const now = nowIso();
      if (existing) {
        this.db.run(
          'UPDATE missing_dependencies SET hits = hits + 1, last_seen_at = ?, source = ? WHERE id = ?',
          now,
          source,
          existing.id,
        );
        updated++;
      } else {
        this.db.run(
          `INSERT INTO missing_dependencies (id, dedupe_key, ecosystem, normalized_name, version_spec, project_id, hits, first_seen_at, last_seen_at, status, source)
           VALUES (?,?,?,?,?,?,1,?,?,'open',?)`,
          randomUUID(),
          dedupeKey,
          input.ecosystem,
          normalized,
          versionSpec,
          projectId,
          now,
          now,
          source,
        );
        created++;
      }
    }

    return { created, updated, skipped, items: this.list({ pageSize: 100 }).items };
  }

  /** 批量导入过程中发现无法解析的依赖时静默登记，不影响入库 */
  reportSilently(ecosystem: Ecosystem, names: string[], projectId: string): void {
    try {
      const unique = Array.from(new Set(names));
      if (unique.length === 0) return;
      this.report({
        ecosystem,
        projectId,
        source: 'import',
        dependencies: unique.map((name) => ({ name, versionSpec: '*' })),
      });
    } catch (err) {
      this.logger.warn(`缺失依赖登记失败: ${(err as Error).message}`);
    }
  }

  /**
   * A 兜底：下游把本平台设为源后拉取失败（404），由 registry controller 静默调用。
   * 同包同版本要求聚合到一条，只更新最后一次请求方元数据；开关关闭时不新增。
   * 全程 try/catch —— 上报失败绝不能影响客户端拿到的 404 响应。
   */
  reportRegistryMiss(input: {
    ecosystem: Ecosystem;
    name: string;
    versionSpec: string;
    ip: string;
    userAgent: string;
    authPresent: boolean;
  }): void {
    if (!getConfig().missing.autoReport) return;
    try {
      const normalized = normalizeName(input.ecosystem, input.name);
      if (!normalized) return;
      const versionSpec = (input.versionSpec || '*').slice(0, 128) || '*';
      // 独立去重空间：CI 上报按 projectId 分，探针按生态+包名+版本聚合，互不覆盖
      const dedupeKey = `registry:${input.ecosystem}:${normalized}:${versionSpec}`;
      const ip = (input.ip || '').slice(0, 64);
      const userAgent = (input.userAgent || '').slice(0, 256);
      const authPresent = input.authPresent ? 1 : 0;
      const now = nowIso();
      const existing = this.db.get<MissingRow>('SELECT * FROM missing_dependencies WHERE dedupe_key = ?', dedupeKey);
      if (existing) {
        this.db.run(
          `UPDATE missing_dependencies SET hits = hits + 1, last_seen_at = ?, requester_ip = ?, user_agent = ?, auth_present = ?
           WHERE id = ?`,
          now,
          ip,
          userAgent,
          authPresent,
          existing.id,
        );
        return;
      }
      this.db.run(
        `INSERT INTO missing_dependencies
           (id, dedupe_key, ecosystem, normalized_name, version_spec, project_id, hits, first_seen_at, last_seen_at, status, source, requester_ip, user_agent, auth_present)
         VALUES (?,?,?,?,?,?,1,?,?,'open','registry',?,?,?)`,
        randomUUID(),
        dedupeKey,
        input.ecosystem,
        normalized,
        versionSpec,
        'auto-probe',
        now,
        now,
        ip,
        userAgent,
        authPresent,
      );
    } catch (err) {
      this.logger.warn(`缺包自动登记失败（不影响 404 响应）: ${(err as Error).message}`);
    }
  }

  list(params: { status?: string; ecosystem?: string; source?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.status) {
      where.push('status = ?');
      args.push(params.status);
    }
    if (params.ecosystem) {
      where.push('ecosystem = ?');
      args.push(params.ecosystem);
    }
    if (params.source) {
      where.push('source = ?');
      args.push(params.source);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM missing_dependencies ${clause}`, ...args)?.c ?? 0;
    const rows = this.db.all<MissingRow>(
      `SELECT * FROM missing_dependencies ${clause} ORDER BY hits DESC, last_seen_at DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows, total: Number(total), page, pageSize };
  }

  getById(id: string): MissingRow {
    const row = this.db.get<MissingRow>('SELECT * FROM missing_dependencies WHERE id = ?', id);
    if (!row) throw new ApiError('MISSING_NOT_FOUND', { id });
    return row;
  }

  async supplement(
    id: string,
    input: {
      /** 上传临时文件路径；校验时读取一次，入库按路径流式写入 */
      path: string;
      filename: string;
      name?: string;
      version?: string;
      requiresPython?: string;
      uploaderId: string;
    },
  ): Promise<{ missing: MissingRow; versionId: string }> {
    const record = this.getById(id);
    if (!['open', 'supplementing'].includes(record.status)) {
      throw new ApiError('MISSING_STATE_INVALID', { status: record.status });
    }

    const buffer = await fsp.readFile(input.path);
    let name = input.name || record.normalized_name;
    let version = input.version || '';

    if (record.ecosystem === 'npm') {
      if (!input.filename.toLowerCase().endsWith('.tgz')) {
        throw new ApiError('MISSING_SUPPLEMENT_MISMATCH', { expected: 'tgz' });
      }
      if (!version) {
        try {
          const manifest = await readNpmPackageManifest(buffer);
          version = String(manifest.version || '');
          if (!input.name && manifest.name) name = String(manifest.name);
        } catch (err) {
          throw new ApiError('PKG_TARBALL_INVALID', { reason: (err as Error).message });
        }
      }
    } else {
      const wheel = parseWheelFilename(input.filename);
      const sdist = parseSdistFilename(input.filename);
      const parsed = wheel ?? sdist;
      if (!parsed) throw new ApiError('PKG_FILE_UNMATCHED', { filename: input.filename });
      if (!version) version = parsed.version;
      if (!input.name) name = parsed.name;
    }

    if (normalizeName(record.ecosystem, name) !== record.normalized_name) {
      throw new ApiError('MISSING_SUPPLEMENT_MISMATCH', {
        expected: record.normalized_name,
        actual: normalizeName(record.ecosystem, name),
      });
    }
    if (!version) throw new ApiError('SYS_VALIDATION', { field: 'version' });

    const outcome =
      record.ecosystem === 'npm'
        ? await validateNpmPackage({
            buffer,
            name,
            version,
            existsInRegistry: Boolean(this.packages.findVersion('npm', name, version)),
            targets: {},
            resolveVersions: () => [],
          })
        : validatePypiPackage({
            buffer,
            filename: input.filename,
            name,
            version,
            existsInRegistry: Boolean(this.packages.findVersion('pypi', name, version)),
            targets: {},
            requiresPython: input.requiresPython,
          });

    if (outcome.status === 'invalid') {
      throw new ApiError('PKG_TARBALL_INVALID', { issues: outcome.issues });
    }

    const stored = await this.storage.putObjectFromFile(input.path);
    const versionRow = await this.packages.insertVersion({
      ecosystem: record.ecosystem,
      name,
      version,
      filename: input.filename,
      sha256: stored.sha256,
      sizeBytes: stored.size,
      storageKey: stored.key,
      metadata: { ...outcome.metadata, dist: { shasum: stored.shasum, integrity: stored.integrity } },
      compatibility: outcome.compatibility,
      uploaderId: input.uploaderId,
      source: 'supplement',
    });

    this.db.run(
      "UPDATE missing_dependencies SET status = 'resolved', resolved_version_id = ?, last_seen_at = ? WHERE id = ?",
      versionRow.id,
      nowIso(),
      id,
    );

    return { missing: this.getById(id), versionId: versionRow.id };
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as semver from 'semver';
import { ApiError } from '../common/errors';
import { nowIso } from '../common/http.util';
import { DatabaseService, isUniqueViolation } from '../db/database.service';
import { isValidName, normalizeName, type Ecosystem } from './names';
import { fallbackPypiVersionKey, pep440VersionKey } from './pep440';
import { pickNpmMetadata } from './npm-metadata';
import { SecurityService, type GateResult } from '../security/security.service';
import { StorageService } from '../storage/storage.service';
import { getConfig } from '../config/config';

// 保持原有导出路径不变，避免调用方全部改导入
export { isValidName, normalizeName };
export type { Ecosystem };

export interface PackageRow {
  id: string;
  ecosystem: Ecosystem;
  normalized_name: string;
  display_name: string;
  scope: string | null;
  status: string;
  dist_tags: string | null;
  created_at: string;
}

export interface VersionRow {
  id: string;
  package_id: string;
  version: string;
  normalized_version: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  metadata: string | null;
  compatibility: string | null;
  status: string;
  uploader_id: string | null;
  source: string;
  signature: string | null;
  created_at: string;
  /** 软删除时间：非空即视为已下架，可被上传者本人恢复 */
  deleted_at: string | null;
}

export interface InsertVersionInput {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  metadata?: Record<string, unknown> | null;
  compatibility?: Record<string, unknown> | null;
  uploaderId?: string | null;
  source: 'batch' | 'web' | 'cli' | 'supplement';
  /** base64 分离签名，提供时参与完整性校验 */
  signature?: string;
}

export interface InsertVersionOptions {
  /** 仅管理员复核放行隔离包时使用，跳过安全扫描；调用方必须记录审计 */
  skipSecurityScan?: boolean;
}

export function normalizeVersion(ecosystem: Ecosystem, version: string): string {
  if (ecosystem === 'npm') {
    const valid = semver.valid(version);
    return valid ?? version.trim();
  }
  // PyPI 按 PEP 440 相等语义归一：1 / 1.0 / 1.0.0 / v1.0 落到同一个键，
  // 由 UNIQUE(package_id, normalized_version) 保证同一个包版本只允许存在一个。
  // 非法版本回退到历史口径，真正的拦截交给校验层的 PKG_VERSION_INVALID。
  return pep440VersionKey(version) ?? fallbackPypiVersionKey(version);
}

@Injectable()
export class PackagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly security: SecurityService,
  ) {}

  ensurePackage(ecosystem: Ecosystem, name: string): PackageRow {
    const normalized = normalizeName(ecosystem, name);
    if (!isValidName(ecosystem, name)) throw new ApiError('PKG_NAME_INVALID', { name });

    const existing = this.db.get<PackageRow>(
      'SELECT * FROM packages WHERE ecosystem = ? AND normalized_name = ?',
      ecosystem,
      normalized,
    );
    if (existing) {
      // 同名包被删除后重新上传：原行仍占着 UNIQUE(ecosystem, normalized_name)，直接复活即可
      if (existing.status !== 'active') {
        this.db.run("UPDATE packages SET status = 'active', dist_tags = NULL WHERE id = ?", existing.id);
        existing.status = 'active';
      }
      return existing;
    }

    const scope = ecosystem === 'npm' && normalized.startsWith('@') ? normalized.split('/')[0] : null;
    const row: PackageRow = {
      id: randomUUID(),
      ecosystem,
      normalized_name: normalized,
      display_name: (name || '').trim(),
      scope,
      status: 'active',
      dist_tags: null,
      created_at: nowIso(),
    };
    try {
      this.db.run(
        'INSERT INTO packages (id, ecosystem, normalized_name, display_name, scope, status, created_at) VALUES (?,?,?,?,?,?,?)',
        row.id,
        row.ecosystem,
        row.normalized_name,
        row.display_name,
        row.scope,
        row.status,
        row.created_at,
      );
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        return this.db.get<PackageRow>(
          'SELECT * FROM packages WHERE ecosystem = ? AND normalized_name = ?',
          ecosystem,
          normalized,
        )!;
      }
      throw err;
    }
  }

  findPackage(ecosystem: Ecosystem, name: string): PackageRow | undefined {
    return this.db.get<PackageRow>(
      'SELECT * FROM packages WHERE ecosystem = ? AND normalized_name = ?',
      ecosystem,
      normalizeName(ecosystem, name),
    );
  }

  /**
   * 唯一入库收口：先查重 → 全量安全校验 → 通过后写入版本表。
   * BLOCK 抛 SEC_BLOCKED、QUARANTINE 抛 SEC_QUARANTINED，调用方不得吞掉这两个错误。
   * 字典管理关闭漏洞扫描（security.scanEnabled=false）时跳过校验直接入库。
   */
  /**
   * 对已落对象的版本执行安全扫描闸门，返回 gate（BLOCK/QUARANTINE 直接抛错）。
   * 抽出为公开方法，供批量导入在事务外完成异步扫描、再把 gate 交给原子写入。
   */
  async prepareScan(input: InsertVersionInput): Promise<GateResult | null> {
    if (!getConfig().security.scanEnabled) return null;
    try {
      const buffer = await this.storage.readObject(input.sha256);
      const gate = await this.security.scanAndGate({
        ecosystem: input.ecosystem,
        name: input.name,
        version: input.version,
        filename: input.filename,
        sha256: input.sha256,
        sizeBytes: buffer.length,
        source: input.source,
        uploaderId: input.uploaderId ?? null,
        signature: input.signature,
        trigger: 'upload',
        buffer,
      });

      const { disposition, verdict, score, findings } = gate.outcome;
      const payload = {
        scanId: gate.scanId,
        package: `${input.ecosystem}:${input.name}@${input.version}`,
        verdict,
        score,
        findings: findings.slice(0, 10),
        // 最高等级命中项的整改建议，供 npm/pypi 错误体直接透出
        remediation: findings[0]?.remediation || null,
      };
      if (disposition === 'BLOCK') throw new ApiError('SEC_BLOCKED', payload);
      if (disposition === 'QUARANTINE') throw new ApiError('SEC_QUARANTINED', payload);
      return gate;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // 扫描失败按 fail-closed 处理，绝不放行未经校验的包
      throw new ApiError('SEC_SCAN_FAILED', { reason: (err as Error).message });
    }
  }

  async insertVersion(input: InsertVersionInput, options?: InsertVersionOptions): Promise<VersionRow> {
    const normalizedVersion = this.assertNotDuplicate(input.ecosystem, input.name, input.version);
    const gate = options?.skipSecurityScan ? null : await this.prepareScan(input);
    return this.insertVersionSync(input, normalizedVersion, gate);
  }

  /**
   * 多版本原子入库（RV-22）：预检与预扫描全部通过后，在单事务内写入全部版本，
   * 任一版本失败整体回滚，杜绝「前两个版本已入库、第三个失败」的半发布状态。
   * gate 允许为 null：字典管理关闭漏洞扫描时 npm publish 不产生扫描记录，直接入库。
   */
  insertVersionsAtomic(
    items: { input: InsertVersionInput; gate: GateResult | null }[],
    /** 事务内每条写入成功后回调，用于同步更新导入条目状态；抛错会随整批回滚 */
    onInserted?: (row: VersionRow, index: number) => void,
  ): VersionRow[] {
    return this.db.tx(() =>
      items.map(({ input, gate }, index) => {
        const row = this.insertVersionSync(
          input,
          this.assertNotDuplicate(input.ecosystem, input.name, input.version),
          gate,
        );
        onInserted?.(row, index);
        return row;
      }),
    );
  }

  /**
   * 合并 npm 自定义 dist-tags（如 npm publish --tag beta）。
   * latest 始终按 semver 最大值动态计算，不接受指定；标签值必须在本次发布的版本范围内（npm 协议约束）。
   */
  mergeDistTags(name: string, tags: Record<string, string>, publishedVersions: string[]): void {
    const pkg = this.findPackage('npm', name);
    if (!pkg) throw new ApiError('PKG_NOT_FOUND', { name });

    const custom: Record<string, string> = pkg.dist_tags
      ? ((safeJson(pkg.dist_tags) as Record<string, string>) ?? {})
      : {};
    for (const [tag, version] of Object.entries(tags)) {
      if (tag === 'latest') continue;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) {
        throw new ApiError('SYS_VALIDATION', { field: `dist-tags.${tag}`, reason: '标签名含非法字符' });
      }
      if (!publishedVersions.includes(version)) {
        throw new ApiError('SYS_VALIDATION', {
          field: `dist-tags.${tag}`,
          reason: `标签指向的版本 ${version} 不在本次发布范围内`,
        });
      }
      custom[tag] = version;
    }
    const keys = Object.keys(custom);
    this.db.run(
      'UPDATE packages SET dist_tags = ? WHERE id = ?',
      keys.length ? JSON.stringify(custom) : null,
      pkg.id,
    );
  }

  /** 查重：放在扫描之前，避免重复上传白白消耗扫描资源；返回归一化版本号。npm 多版本预检也会调用 */
  assertNotDuplicate(ecosystem: Ecosystem, name: string, version: string): string {
    const normalizedVersion = normalizeVersion(ecosystem, version);
    if (!normalizedVersion) throw new ApiError('PKG_VERSION_INVALID', { version });
    if (!isValidName(ecosystem, name)) throw new ApiError('PKG_NAME_INVALID', { name });

    const existingPkg = this.findPackage(ecosystem, name);
    if (existingPkg) {
      // 已删除版本仍占着 UNIQUE(package_id, normalized_version)：命中时提示去恢复，而不是让用户改版本号
      const existing = this.db.get<{ id: string; deleted_at: string | null }>(
        'SELECT id, deleted_at FROM package_versions WHERE package_id = ? AND normalized_version = ?',
        existingPkg.id,
        normalizedVersion,
      );
      if (existing && existing.deleted_at) throw new ApiError('PKG_VERSION_DELETED', { name, version });
      if (existing) throw new ApiError('PKG_VERSION_DUPLICATE', { name, version });
    }
    return normalizedVersion;
  }

  /** 同步插入核心：node:sqlite 单连接同步写，天然可纳入 db.tx()；调用方须已完成扫描或显式跳过 */
  private insertVersionSync(input: InsertVersionInput, normalizedVersion: string, gate: GateResult | null): VersionRow {
    const pkg = this.ensurePackage(input.ecosystem, input.name);
    const row: VersionRow = {
      id: randomUUID(),
      package_id: pkg.id,
      version: input.version.trim(),
      normalized_version: normalizedVersion,
      filename: input.filename,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      storage_key: input.storageKey,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      compatibility: input.compatibility ? JSON.stringify(input.compatibility) : null,
      status: 'active',
      uploader_id: input.uploaderId ?? null,
      source: input.source,
      signature: input.signature ?? null,
      created_at: nowIso(),
      deleted_at: null,
    };

    try {
      this.db.run(
        `INSERT INTO package_versions
         (id, package_id, version, normalized_version, filename, sha256, size_bytes, storage_key, metadata, compatibility, status, uploader_id, source, signature, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.id,
        row.package_id,
        row.version,
        row.normalized_version,
        row.filename,
        row.sha256,
        row.size_bytes,
        row.storage_key,
        row.metadata,
        row.compatibility,
        row.status,
        row.uploader_id,
        row.source,
        row.signature,
        row.created_at,
      );
      // 扫描记录回填版本 ID，供包详情页展示安全徽标
      if (gate) this.security.attachVersion(gate.scanId, row.id);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError('PKG_VERSION_DUPLICATE', { name: input.name, version: input.version });
      }
      throw err;
    }
  }

  findVersion(ecosystem: Ecosystem, name: string, version: string): VersionRow | undefined {
    const pkg = this.findPackage(ecosystem, name);
    if (!pkg) return undefined;
    return this.db.get<VersionRow>(
      // 只有 active 版本对外可见，隔离/已删除版本不参与解析与下载
      "SELECT * FROM package_versions WHERE package_id = ? AND normalized_version = ? AND status = 'active'",
      pkg.id,
      normalizeVersion(ecosystem, version),
    );
  }

  getVersionById(id: string): VersionRow | undefined {
    return this.db.get<VersionRow>('SELECT * FROM package_versions WHERE id = ?', id);
  }

  findVersionByFilename(ecosystem: Ecosystem, filename: string): VersionRow | undefined {
    return this.db.get<VersionRow>(
      `SELECT v.* FROM package_versions v JOIN packages p ON p.id = v.package_id
       WHERE p.ecosystem = ? AND v.filename = ? AND v.status = 'active' LIMIT 1`,
      ecosystem,
      filename,
    );
  }

  listPackageNames(ecosystem: Ecosystem): string[] {
    return this.db
      .all<{ normalized_name: string }>(
        `SELECT p.normalized_name FROM packages p WHERE p.ecosystem = ? AND p.status = 'active'
         AND EXISTS (SELECT 1 FROM package_versions v WHERE v.package_id = p.id AND v.status = 'active')
         ORDER BY p.normalized_name ASC`,
        ecosystem,
      )
      .map((row) => row.normalized_name);
  }

  versionsOf(packageId: string): VersionRow[] {
    return this.db.all<VersionRow>(
      "SELECT * FROM package_versions WHERE package_id = ? AND status = 'active' ORDER BY created_at ASC",
      packageId,
    );
  }

  /** 供 S4 依赖可解析性校验使用 */
  availableVersions(ecosystem: Ecosystem, name: string): string[] {
    const pkg = this.findPackage(ecosystem, name);
    if (!pkg) return [];
    return this.versionsOf(pkg.id).map((v) => v.version);
  }

  listPackages(params: {
    ecosystem?: Ecosystem;
    q?: string;
    page?: number;
    pageSize?: number;
    includeDeleted?: boolean;
    viewerId?: string;
    viewerIsAdmin?: boolean;
  }) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
    const viewerId = params.viewerId ?? '';
    const isAdmin = !!params.viewerIsAdmin;
    const where: string[] = ["p.status = 'active'"];
    const args: unknown[] = [];
    if (params.ecosystem) {
      where.push('p.ecosystem = ?');
      args.push(params.ecosystem);
    }
    if (params.q) {
      where.push('(p.normalized_name LIKE ? OR p.display_name LIKE ?)');
      args.push(`%${params.q.toLowerCase()}%`, `%${params.q}%`);
    }
    // 默认只显示仍有在用版本的包；勾选「含已删除」后，本人删除过的包即使版本全删也保留包壳。
    // 管理员要维护全站数据，能看到任何包的删除记录；其他用户只认自己的删除——别人的撤回不该被围观。
    if (!params.includeDeleted) {
      where.push("EXISTS (SELECT 1 FROM package_versions x WHERE x.package_id = p.id AND x.status = 'active')");
    } else if (isAdmin) {
      where.push(
        `(EXISTS (SELECT 1 FROM package_versions x WHERE x.package_id = p.id AND x.status = 'active')
          OR EXISTS (SELECT 1 FROM package_versions y WHERE y.package_id = p.id AND y.deleted_at IS NOT NULL))`,
      );
    } else {
      where.push(
        `(EXISTS (SELECT 1 FROM package_versions x WHERE x.package_id = p.id AND x.status = 'active')
          OR EXISTS (SELECT 1 FROM package_versions y
                     WHERE y.package_id = p.id AND y.deleted_at IS NOT NULL AND y.uploader_id = ?))`,
      );
      args.push(viewerId);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total =
      this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM packages p ${clause}`, ...args)?.c ?? 0;
    // 「已删除」计数：管理员看全站，其余人只看自己删的。
    // 注意这里不能只在 includeDeleted 时过滤——默认列表也会展示这段文案，
    // 不过滤的话别人照样能看出「这个包被删过几个版本」。
    const selectArgs: unknown[] = [];
    let deletedCountExpr = 'COUNT(CASE WHEN v.deleted_at IS NOT NULL THEN 1 END)';
    if (!isAdmin) {
      deletedCountExpr = 'COUNT(CASE WHEN v.deleted_at IS NOT NULL AND v.uploader_id = ? THEN 1 END)';
      selectArgs.push(viewerId);
    }
    const rows = this.db.all<
      PackageRow & { version_count: number; deleted_count: number; latest: string | null }
    >(
      `SELECT p.*,
              COUNT(CASE WHEN v.status = 'active' THEN 1 END) AS version_count,
              ${deletedCountExpr} AS deleted_count,
              MAX(v.created_at) AS latest_at
       FROM packages p LEFT JOIN package_versions v ON v.package_id = p.id
       ${clause} GROUP BY p.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      ...selectArgs,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        ecosystem: row.ecosystem,
        name: row.display_name,
        normalizedName: row.normalized_name,
        status: row.status,
        versionCount: Number(row.version_count),
        deletedVersionCount: Number(row.deleted_count),
        createdAt: row.created_at,
      })),
      total: Number(total),
      page,
      pageSize,
    };
  }

  /**
   * 版本级删除：上传者本人，或管理员代为删除（软删除，保留记录供恢复）。
   *
   * 管理员代删是治理动作，必须留痕：返回值带 `deletedByAdmin`，controller 记账时一并写入审计。
   * 归属不变——被删除版本的 uploader_id 不动，原上传人仍可在「含已删除」里恢复。
   * 隔离中的版本不在此列，由安全复核流程处置（放行/废弃），避免绕过隔离直接下架。
   */
  deleteVersion(versionId: string, viewerId: string, options: { isAdmin?: boolean } = {}) {
    const version = this.getVersionById(versionId);
    if (!version || version.deleted_at) throw new ApiError('PKG_NOT_FOUND', { versionId });
    // 隔离中的版本由安全校验流程处置（放行/隔离复核），不允许直接删除
    if (version.status !== 'active') throw new ApiError('PKG_VERSION_STATE_INVALID', { versionId, status: version.status });
    const isAdmin = !!options.isAdmin;
    const isOwner = version.uploader_id === viewerId;
    if (!isOwner && !isAdmin) {
      throw new ApiError('AUTH_FORBIDDEN', { reason: '只能删除本人上传的版本（管理员可代为删除）' });
    }
    const pkg = this.db.get<PackageRow>('SELECT * FROM packages WHERE id = ?', version.package_id);

    this.db.run(
      "UPDATE package_versions SET status = 'deleted', deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      nowIso(),
      versionId,
    );

    return {
      versionId,
      version: version.version,
      packageId: version.package_id,
      name: pkg?.display_name ?? null,
      ecosystem: pkg?.ecosystem ?? null,
      deletedByAdmin: isAdmin && !isOwner,
    };
  }

  /**
   * 恢复已删除版本：上传者本人，或管理员代为恢复。
   *
   * 归属不变：恢复后 uploader_id 仍是原上传人，本人后续仍可再次删除。
   * 恢复前校验版本号唯一性，避免与后续重传冲突。
   */
  restoreVersion(versionId: string, viewerId: string, options: { isAdmin?: boolean } = {}) {
    const version = this.getVersionById(versionId);
    if (!version) throw new ApiError('PKG_NOT_FOUND', { versionId });
    if (!version.deleted_at) throw new ApiError('PKG_VERSION_NOT_DELETED', { versionId });
    const isAdmin = !!options.isAdmin;
    const isOwner = version.uploader_id === viewerId;
    if (!isOwner && !isAdmin) {
      throw new ApiError('AUTH_FORBIDDEN', { reason: '只能恢复本人上传的版本（管理员可代为恢复）' });
    }

    const pkg = this.db.get<PackageRow>('SELECT * FROM packages WHERE id = ?', version.package_id);
    if (!pkg) throw new ApiError('PKG_NOT_FOUND', { versionId });
    const normalized = normalizeVersion(pkg.ecosystem, version.version);
    const conflict = this.db.get<{ id: string }>(
      'SELECT id FROM package_versions WHERE package_id = ? AND normalized_version = ? AND id <> ?',
      version.package_id,
      normalized,
      versionId,
    );
    if (conflict) throw new ApiError('PKG_VERSION_DUPLICATE', { name: pkg.display_name, version: version.version });

    this.db.tx(() => {
      this.db.run(
        "UPDATE package_versions SET status = 'active', deleted_at = NULL, normalized_version = ? WHERE id = ?",
        normalized,
        versionId,
      );
      // 历史数据里包可能因旧版整包删除被标记为 deleted，恢复任一版本时一并拉回
      if (pkg.status !== 'active') {
        this.db.run("UPDATE packages SET status = 'active' WHERE id = ?", pkg.id);
      }
    });

    return {
      versionId,
      version: version.version,
      packageId: pkg.id,
      name: pkg.display_name,
      ecosystem: pkg.ecosystem,
      // 审计要能区分「本人恢复」和「管理员代恢复」，后者属于代操作，必须留痕
      restoredByAdmin: isAdmin && !isOwner,
    };
  }

  getPackageDetail(
    ecosystem: Ecosystem,
    name: string,
    options: { viewerId?: string; includeDeleted?: boolean; viewerIsAdmin?: boolean } = {},
  ) {
    const pkg = this.findPackage(ecosystem, name);
    if (!pkg) throw new ApiError('PKG_NOT_FOUND', { name });
    const viewerId = options.viewerId;
    const isAdmin = !!options.viewerIsAdmin;
    // 上传人必须 LEFT JOIN：历史版本或补包失败时 uploader_id 可能为 NULL，不能因此丢版本行
    // 「含已删除」：管理员看全站历史，普通用户只看自己的删除记录
    const versionArgs: unknown[] = [pkg.id];
    let versionFilter = " AND v.status = 'active'";
    if (options.includeDeleted) {
      if (isAdmin) {
        versionFilter = '';
      } else {
        versionFilter = ' AND (v.deleted_at IS NULL OR v.uploader_id = ?)';
        versionArgs.push(viewerId ?? '');
      }
    }
    const rows = this.db.all<
      VersionRow & {
        uploader_username: string | null;
        uploader_display_name: string | null;
        deleted_at: string | null;
      }
    >(
      `SELECT v.*, u.username AS uploader_username, u.display_name AS uploader_display_name
       FROM package_versions v LEFT JOIN users u ON u.id = v.uploader_id
       WHERE v.package_id = ?${versionFilter} ORDER BY v.created_at ASC`,
      ...versionArgs,
    );
    // 版本被上传者删光的包，对当前用户等于不存在；但「有版本只是不在本次筛选内」（例如全被隔离）
    // 仍要返回 200 + 空列表，安全复核流程依赖这个语义。
    if (!rows.length) {
      const live =
        this.db.get<{ c: number }>(
          'SELECT COUNT(*) AS c FROM package_versions WHERE package_id = ? AND deleted_at IS NULL',
          pkg.id,
        )?.c ?? 0;
      if (!live) throw new ApiError('PKG_NOT_FOUND', { name });
    }
    const versions = rows.map((v) => {
      const deleted = !!v.deleted_at;
      // 隔离中的版本既不可下载也不可删除，恢复只针对已删除行
      const isActive = v.status === 'active' && !deleted;
      // 权限只对外给布尔：前端据此决定是否渲染删除/恢复按钮，真实校验仍在服务层
      const isOwner = !!viewerId && v.uploader_id === viewerId;
      return {
        id: v.id,
        version: v.version,
        filename: v.filename,
        sha256: v.sha256,
        sizeBytes: Number(v.size_bytes),
        status: v.status,
        source: v.source,
        // 只对外给姓名：回退登录名是为了不给读者看空列，但绝不返回 uploader_id
        uploaderName: v.uploader_display_name || v.uploader_username || null,
        // 只给布尔：前端据此区分「本人操作」与「管理员代操作」，不暴露 uploader_id
        uploadedByViewer: isOwner,
        createdAt: v.created_at,
        deletedAt: v.deleted_at,
        // 管理员可代删代恢复（治理动作，审计留痕）；普通用户仅限本人版本
        canDelete: (isOwner || isAdmin) && isActive,
        canRestore: (isOwner || isAdmin) && deleted,
        metadata: v.metadata ? safeJson(v.metadata) : null,
        compatibility: v.compatibility ? safeJson(v.compatibility) : null,
        // 已删除/隔离版本不暴露下载地址：registry 侧本来也会 404，前端更不该给按钮
        downloadUrl: isActive
          ? ecosystem === 'npm'
            ? `${getConfig().npmBaseUrl}/npm/${pkg.display_name}/-/${v.filename}`
            : `${getConfig().pypiBaseUrl}/pypi/packages/${v.filename}`
          : null,
      };
    });
    return {
      id: pkg.id,
      ecosystem: pkg.ecosystem,
      name: pkg.display_name,
      normalizedName: pkg.normalized_name,
      status: pkg.status,
      createdAt: pkg.created_at,
      versions,
    };
  }

  /** 版本级安全标识，供 packument 与下载响应复用 */
  securityBadge(versionId: string): { status: string; scannedAt: string; scanId: string } | null {
    const row = this.db.get<{ id: string; disposition: string; created_at: string }>(
      `SELECT id, disposition, created_at FROM security_scans
       WHERE package_version_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      versionId,
    );
    return row ? { status: row.disposition, scannedAt: row.created_at, scanId: row.id } : null;
  }

  /** npm packument 文档 */
  packument(name: string) {
    const pkg = this.findPackage('npm', name);
    if (!pkg) throw new ApiError('PKG_NOT_FOUND', { name });
    const rows = this.versionsOf(pkg.id);
    if (rows.length === 0) throw new ApiError('PKG_NOT_FOUND', { name });

    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = { created: pkg.created_at, modified: pkg.created_at };
    let latest: string | null = null;

    for (const row of rows) {
      const meta = row.metadata ? (safeJson(row.metadata) as Record<string, unknown>) : {};
      const dist = (meta.dist as Record<string, string>) || {};
      versions[row.version] = {
        // 白名单字段与原包 package.json 保持一致；dsh 供 harness 识别组合包
        ...pickNpmMetadata(meta),
        _id: `${pkg.display_name}@${row.version}`,
        name: pkg.display_name,
        version: row.version,
        description: meta.description || '',
        deprecated: undefined,
        // 消费方可直接判断该版本是否通过安全校验，无需登录管理端
        security: this.securityBadge(row.id),
        dist: {
          tarball: `${getConfig().npmBaseUrl}/npm/${pkg.display_name}/-/${row.filename}`,
          shasum: dist.shasum || row.sha256,
          integrity: dist.integrity || `sha256-${Buffer.from(row.sha256, 'hex').toString('base64')}`,
        },
      };
      time[row.version] = row.created_at;
      if (!latest || semver.gt(semver.coerce(row.version) ?? '0.0.0', semver.coerce(latest) ?? '0.0.0')) {
        latest = row.version;
      }
    }

    const latestMeta = latest ? (versions[latest] as Record<string, unknown>) : {};
    // 自定义标签（beta/next 等）合并输出；指向已下架/隔离版本的标签过滤掉，避免 npm install pkg@beta 解析 404
    const storedTags = pkg.dist_tags ? ((safeJson(pkg.dist_tags) as Record<string, string>) ?? {}) : {};
    const activeTags = Object.fromEntries(Object.entries(storedTags).filter(([, v]) => v in versions));
    return {
      ...pickNpmMetadata(latestMeta),
      _id: pkg.display_name,
      _rev: `1-${pkg.id}`,
      name: pkg.display_name,
      description: (latestMeta.description as string) || '',
      'dist-tags': { latest: latest ?? '0.0.0', ...activeTags },
      versions,
      time,
      readme: '',
    };
  }

  /**
   * npm search 协议（/-/v1/search）。
   *
   * 消费方 dshmarket 内网版把 registry 当插件目录：先按 size/from 翻页枚举包名，
   * 再逐个拉 packument，用 manifest 上的 dsh 字段判定是否为可安装插件；它自身
   * 最多只取前 400 个候选。因此这里必须支持分页，且让带 dsh 的插件包排在前面，
   * 否则插件被 500+ 个普通依赖挤到 400 名之后就会在插件市场里"显示不全"。
   *
   * total 是匹配总数（不是当页条数），与 npm 搜索协议一致，供客户端正确翻页。
   */
  searchNpm(text: string, size: number, from: number): { objects: Record<string, unknown>[]; total: number } {
    const likeName = `%${text.toLowerCase()}%`;
    const likeDisplay = `%${text}%`;
    const where = `p.ecosystem = 'npm' AND p.status = 'active'
       AND EXISTS (SELECT 1 FROM package_versions v WHERE v.package_id = p.id AND v.status = 'active')
       AND (p.normalized_name LIKE ? OR p.display_name LIKE ?)`;

    // 有 dsh 字段的插件优先（json_valid 短路保护，避免历史脏 metadata 让整条查询失败）
    const isPlugin = `EXISTS (
        SELECT 1 FROM package_versions pv
        WHERE pv.package_id = p.id AND pv.status = 'active'
          AND json_valid(pv.metadata) AND json_extract(pv.metadata, '$.dsh') IS NOT NULL
      )`;

    const total = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM packages p WHERE ${where}`,
      likeName,
      likeDisplay,
    )?.c ?? 0;

    const rows = this.db.all<{ display_name: string; normalized_name: string }>(
      `SELECT p.display_name, p.normalized_name FROM packages p
       WHERE ${where}
       ORDER BY CASE WHEN ${isPlugin} THEN 0 ELSE 1 END, p.created_at DESC, p.id ASC
       LIMIT ? OFFSET ?`,
      likeName,
      likeDisplay,
      size,
      from,
    );
    return {
      total,
      objects: rows.map((row) => {
        const versions = this.availableVersions('npm', row.display_name);
        const latest = versions.length ? versions.sort(semver.rcompare)[0] : '0.0.0';
        return {
          package: {
            name: row.display_name,
            version: latest,
            description: '',
            date: nowIso(),
          },
          score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
          searchScore: 1,
        };
      }),
    };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

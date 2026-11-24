import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import * as semver from 'semver';
import { nowIso } from '../common/http.util';
import { likeContains } from '../common/sql.util';
import { DatabaseService } from '../db/database.service';
import { normalizeName, type Ecosystem } from '../packages/names';
import type { AdvisoryInput, AdvisoryRow, DependencyRef, SecurityFinding, Severity } from './types';

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

function severityOf(value: unknown, cvss?: number | null): Exclude<Severity, 'none'> {
  const raw = String(value ?? '').toLowerCase();
  if (SEVERITIES.includes(raw as Severity) && raw !== 'none') return raw as Exclude<Severity, 'none'>;
  if (typeof cvss === 'number' && Number.isFinite(cvss)) {
    if (cvss >= 9) return 'critical';
    if (cvss >= 7) return 'high';
    if (cvss >= 4) return 'medium';
    return 'low';
  }
  return 'medium';
}

/** 名称归一到包管理器口径，并额外保留一份折叠写法用于跨库匹配 */
function nameVariants(ecosystem: Ecosystem, name: string): string[] {
  const primary = normalizeName(ecosystem, name);
  const collapsed = name.trim().toLowerCase().replace(/[-_.]+/g, '-');
  return Array.from(new Set([primary, collapsed].filter(Boolean)));
}

function versionParts(raw: string): number[] {
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)*)/);
  return match ? match[1].split('.').map((n) => Number(n)) : [];
}

function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function compareLoose(a: string, b: string): number {
  return compareTuples(versionParts(a), versionParts(b));
}

/** PEP 440 常用比较符；无法解析的表达式按“可能受影响”处理，避免漏报 */
function satisfiesPep440(version: string, spec: string): boolean {
  const clauses = spec
    .replace(/\s+/g, ' ')
    .replace(/\s+(?=[<>=!~])/g, ',')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;

  for (const clause of clauses) {
    const match = clause.match(/^(>=|<=|==|!=|~=|>|<)\s*([0-9][0-9A-Za-z.*+!-]*)$/);
    if (!match) return true;
    const op = match[1];
    const target = match[2];

    if (op === '==' && target.endsWith('.*')) {
      const prefix = versionParts(target.slice(0, -2));
      if (compareTuples(versionParts(version).slice(0, prefix.length), prefix) !== 0) return false;
      continue;
    }
    const cmp = compareLoose(version, target);
    if (op === '>=' && cmp < 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<' && cmp >= 0) return false;
    if (op === '==' && cmp !== 0) return false;
    if (op === '!=' && cmp === 0) return false;
    if (op === '~=') {
      const base = versionParts(target);
      if (cmp < 0) return false;
      if (compareTuples(versionParts(version).slice(0, Math.max(1, base.length - 1)), base.slice(0, Math.max(1, base.length - 1))) !== 0) {
        return false;
      }
    }
  }
  return true;
}

function satisfiesNpm(version: string, range: string): boolean {
  const clean = range.trim();
  if (!clean || clean === '*') return true;
  if (semver.valid(version)) {
    try {
      if (semver.validRange(clean)) return semver.satisfies(version, clean, { includePrerelease: true });
    } catch {
      /* 退回区间比较 */
    }
  }
  return satisfiesInterval(version, clean);
}

function satisfiesInterval(version: string, spec: string): boolean {
  const parts = spec.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  for (const part of parts) {
    const match = part.match(/^(>=|<=|==|!=|>|<)\s*(.+)$/);
    if (!match) continue;
    const cmp = compareLoose(version, match[2].replace(/[~^]/g, ''));
    if (match[1] === '>=' && cmp < 0) return false;
    if (match[1] === '<=' && cmp > 0) return false;
    if (match[1] === '>' && cmp <= 0) return false;
    if (match[1] === '<' && cmp >= 0) return false;
    if (match[1] === '==' && cmp !== 0) return false;
    if (match[1] === '!=' && cmp === 0) return false;
  }
  return true;
}

export function versionInRange(version: string, range: string, ecosystem: Ecosystem): boolean {
  const value = (range || '*').trim();
  if (!value || value === '*') return true;
  return value.split('||').some((alt) => {
    const branch = alt.trim();
    if (!branch) return false;
    return ecosystem === 'npm' ? satisfiesNpm(version, branch) : satisfiesPep440(version, branch);
  });
}

function inferSource(input: AdvisoryInput): string {
  if (input.source) return String(input.source).toUpperCase();
  const id = String(input.advisoryId || input.id || '');
  if (/^CVE-/i.test(id)) return 'CVE';
  if (/^CNVD-/i.test(id)) return 'CNVD';
  if (/^GHSA-/i.test(id)) return 'OSV';
  return 'OSV';
}

/**
 * 生态必须显式声明。缺失或写成不认识的家族一律拒绝导入：
 * 早先把无法识别的值静默折叠成 '*'，结果同名的 npm / pypi 包会被同一条漏洞同时命中。
 */
function parseEcosystem(value: unknown): 'npm' | 'pypi' | '*' | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'npm') return 'npm';
  if (raw === 'pypi' || raw === 'pip' || raw === 'python') return 'pypi';
  if (raw === '*' || raw === 'any' || raw === 'all') return '*';
  return null;
}

@Injectable()
export class VulnerabilityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 按生态缓存的漏洞索引。早先每次扫描都把该生态全部条目读一遍建 Map，
   * 一个包一次扫描、复检时成百上千个包，库大了就是重复的全表读 + 反复分配内存。
   * 漏洞库只在本 service 里写入，导入成功后自增版本号即可让所有缓存失效。
   */
  private advisoryCache = new Map<Ecosystem, { revision: number; rows: Map<string, AdvisoryRow[]> }>();
  private advisoryRevision = 0;

  private invalidateAdvisoryCache(): void {
    this.advisoryRevision += 1;
    this.advisoryCache.clear();
  }

  // ---------- 漏洞库导入 ----------

  importAdvisories(payload: unknown): { imported: number; updated: number; skipped: number; errors: string[] } {
    const list = this.extractList(payload);
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of list) {
      const record = (item ?? {}) as Record<string, unknown>;
      const ecosystem = parseEcosystem(record.ecosystem);
      if (!ecosystem) {
        skipped++;
        const label = String(record.advisoryId || record.id || '未命名条目');
        errors.push(`${label}: ecosystem 缺失或不受支持（必须显式写 npm / pypi / *）`);
        continue;
      }
      const normalized = this.normalize(item, ecosystem);
      if (!normalized) {
        skipped++;
        continue;
      }
      const existing = this.db.get<{ id: string }>(
        'SELECT id FROM vulnerability_advisories WHERE source = ? AND advisory_id = ? AND ecosystem = ? AND package_name = ? AND affected_range = ?',
        normalized.source,
        normalized.advisoryId,
        normalized.ecosystem,
        normalized.packageName,
        normalized.affectedRange,
      );
      try {
        if (existing) {
          this.db.run(
            `UPDATE vulnerability_advisories
             SET severity = ?, cvss = ?, title = ?, description = ?, fixed_version = ?, refs = ?, published_at = ?, imported_at = ?
             WHERE id = ?`,
            normalized.severity,
            normalized.cvss,
            normalized.title,
            normalized.description,
            normalized.fixedVersion,
            JSON.stringify(normalized.references),
            normalized.publishedAt,
            nowIso(),
            existing.id,
          );
          updated++;
        } else {
          this.db.run(
            `INSERT INTO vulnerability_advisories
             (id, source, advisory_id, ecosystem, package_name, affected_range, severity, cvss, title, description, fixed_version, refs, published_at, imported_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            randomUUID(),
            normalized.source,
            normalized.advisoryId,
            normalized.ecosystem,
            normalized.packageName,
            normalized.affectedRange,
            normalized.severity,
            normalized.cvss,
            normalized.title,
            normalized.description,
            normalized.fixedVersion,
            JSON.stringify(normalized.references),
            normalized.publishedAt,
            nowIso(),
          );
          imported++;
        }
      } catch (err) {
        errors.push(`${normalized.advisoryId}: ${(err as Error).message}`);
      }
    }

    // 每次有效导入生成一条快照：报告里的 advisorySnapshotId 指向它，可回放当时匹配所用的数据
    if (imported + updated > 0) {
      // 先失效索引再写快照：保证同一轮请求之后的匹配一定看到新数据
      this.invalidateAdvisoryCache();
      const checksum = createHash('sha256').update(JSON.stringify(list)).digest('hex');
      const sources = Array.from(
        new Set(list.map((item) => String((item as Record<string, unknown>).source || 'unknown'))),
      ).join(',');
      this.db.run(
        `INSERT INTO advisory_snapshots (id, source, advisory_count, checksum, imported_by, created_at)
         VALUES (?,?,?,?,?,?)`,
        randomUUID(),
        sources || 'unknown',
        imported + updated,
        checksum,
        null,
        nowIso(),
      );
    }

    return { imported, updated, skipped, errors };
  }

  private extractList(payload: unknown): AdvisoryInput[] {
    if (Array.isArray(payload)) return payload as AdvisoryInput[];
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.advisories)) return obj.advisories as AdvisoryInput[];
      if (Array.isArray(obj.data)) return obj.data as AdvisoryInput[];
    }
    return [];
  }

  private normalize(
    input: AdvisoryInput,
    ecosystem: 'npm' | 'pypi' | '*',
  ): {
    source: string;
    advisoryId: string;
    ecosystem: string;
    packageName: string;
    affectedRange: string;
    severity: Exclude<Severity, 'none'>;
    cvss: number | null;
    title: string | null;
    description: string | null;
    fixedVersion: string | null;
    references: string[];
    publishedAt: string | null;
  } | null {
    if (!input || typeof input !== 'object') return null;
    const advisoryId = String(input.advisoryId || input.id || '').trim();
    const pkgRaw = String(input.packageName || input.package || '').trim();
    if (!advisoryId || !pkgRaw) return null;

    const packageName =
      ecosystem === 'npm' || ecosystem === 'pypi'
        ? normalizeName(ecosystem, pkgRaw)
        : pkgRaw.toLowerCase().replace(/[-_.]+/g, '-');
    const affectedRaw = input.affectedRange || input.affected || '*';
    const affectedRange = Array.isArray(affectedRaw) ? affectedRaw.join(' || ') : String(affectedRaw).trim() || '*';
    const cvss = typeof input.cvss === 'number' && Number.isFinite(input.cvss) ? input.cvss : null;

    return {
      source: inferSource({ ...input, advisoryId }),
      advisoryId,
      ecosystem,
      packageName,
      affectedRange,
      severity: severityOf(input.severity, cvss),
      cvss,
      title: input.title || input.summary || null,
      description: input.description || input.summary || null,
      fixedVersion: input.fixedVersion || input.fixed || null,
      references: Array.isArray(input.references) ? input.references.slice(0, 20).map(String) : [],
      publishedAt: input.publishedAt || null,
    };
  }

  list(params: { ecosystem?: string; q?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 20));
    const where: string[] = [];
    const args: unknown[] = [];
    const eco = (params.ecosystem || '').trim();
    if (eco === '*') {
      // 精确查跨生态条目，与"某个生态可见的条目"区分开
      where.push("ecosystem = '*'");
    } else if (eco) {
      where.push("(ecosystem = ? OR ecosystem = '*')");
      args.push(eco);
    }
    if (params.q) {
      where.push("(package_name LIKE ? ESCAPE '\\' OR advisory_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')");
      const like = likeContains(params.q);
      args.push(likeContains(params.q.toLowerCase()), like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM vulnerability_advisories ${clause}`, ...args)?.c ?? 0;
    const items = this.db.all<AdvisoryRow>(
      `SELECT * FROM vulnerability_advisories ${clause} ORDER BY imported_at DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items, total: Number(total), page, pageSize };
  }

  // ---------- 漏洞匹配 ----------

  match(
    ecosystem: Ecosystem,
    name: string,
    version: string,
    dependencies: DependencyRef[],
  ): { findings: SecurityFinding[]; matched: number } {
    const findings: SecurityFinding[] = [];
    let matched = 0;

    // 一次加载该生态全部漏洞，避免每个依赖都查一次库（大包 + 大 lockfile 时是 N+1）
    const index = this.advisoryIndex(ecosystem);
    const selfRows = this.rowsFrom(index, ecosystem, name);
    for (const row of selfRows) {
      if (!versionInRange(version, row.affected_range, ecosystem)) continue;
      matched++;
      const severity = severityOf(row.severity, row.cvss);
      const fixed = row.fixed_version ? `，修复版本 ${row.fixed_version}` : '';
      findings.push({
        dimension: 'vulnerability',
        ruleId: `VULN-${row.advisory_id}`,
        severity,
        title: `${row.advisory_id} ${row.title || '已知漏洞'}`,
        detail: `当前版本 ${name}@${version} 命中 ${row.source} ${row.advisory_id}，影响范围 ${row.affected_range}${fixed}`,
        location: `${name}@${version}`,
        remediation: row.fixed_version
          ? `升级到 ${row.fixed_version} 或更高版本`
          : '关注厂商公告，升级到已修复版本',
      });
    }

    // 包内依赖组件：有 lockfile 精确版本时按实际版本判定；无解析版本只做提示，避免误隔离
    for (const dep of dependencies.slice(0, 300)) {
      const depRows = this.rowsFrom(index, ecosystem, dep.name);
      if (depRows.length === 0) continue;

      const affected: AdvisoryRow[] = [];
      const unresolved: AdvisoryRow[] = [];
      for (const row of depRows) {
        const status = this.dependencyMatch(dep, row, ecosystem);
        if (status === 'affected') affected.push(row);
        else if (status === 'unresolved') unresolved.push(row);
      }

      if (affected.length > 0) {
        matched += affected.length;
        const worst = affected.reduce((acc, item) => {
          const severity = severityOf(item.severity, item.cvss);
          return SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(acc) ? severity : acc;
        }, 'low' as Exclude<Severity, 'none'>);
        const top = affected
          .slice(0, 5)
          .map((row) => `${row.advisory_id}(${row.severity}${row.fixed_version ? `→${row.fixed_version}` : ''})`)
          .join('、');
        const current = dep.resolvedVersion ? `实际版本 ${dep.resolvedVersion}` : `声明范围 ${dep.range}`;
        findings.push({
          dimension: 'vulnerability',
          ruleId: dep.transitive ? 'VULN-TRANSITIVE' : 'VULN-DEP',
          severity: worst,
          title: `${dep.transitive ? '传递依赖' : '依赖组件'} ${dep.name} 存在已知漏洞`,
          detail: `${current} 命中 ${affected.length} 条漏洞：${top}`,
          location: `${name}@${version}`,
          remediation: '升级该依赖到已修复版本，重新锁定后发布',
        });
      } else if (unresolved.length > 0) {
        const top = unresolved
          .slice(0, 5)
          .map((row) => `${row.advisory_id}(${row.severity})`)
          .join('、');
        findings.push({
          dimension: 'vulnerability',
          ruleId: 'VULN-DEP-UNRESOLVED',
          severity: 'medium',
          title: `依赖 ${dep.name} 无法确认实际版本`,
          detail: `声明范围 ${dep.range}，包内未提供 lockfile，${unresolved.length} 条漏洞仅作提示：${top}`,
          location: `${name}@${version}`,
          remediation: '在包内附带 package-lock.json / poetry.lock 等锁定文件，或在私有源中确认实际版本',
        });
      }
    }

    return { findings: findings.slice(0, 40), matched };
  }

  /** 按生态预加载漏洞库：package_name 归一化后建立索引，供依赖批量比对；结果按导入版本缓存 */
  private advisoryIndex(ecosystem: Ecosystem): Map<string, AdvisoryRow[]> {
    const cached = this.advisoryCache.get(ecosystem);
    if (cached && cached.revision === this.advisoryRevision) return cached.rows;

    const index = new Map<string, AdvisoryRow[]>();
    const rows = this.db.all<AdvisoryRow>(
      `SELECT * FROM vulnerability_advisories WHERE ecosystem = ? OR ecosystem = '*'`,
      ecosystem,
    );
    for (const row of rows) {
      const list = index.get(row.package_name) || [];
      list.push(row);
      index.set(row.package_name, list);
    }
    this.advisoryCache.set(ecosystem, { revision: this.advisoryRevision, rows: index });
    return index;
  }

  private rowsFrom(
    index: Map<string, AdvisoryRow[]>,
    ecosystem: Ecosystem,
    name: string,
  ): AdvisoryRow[] {
    const out: AdvisoryRow[] = [];
    for (const variant of nameVariants(ecosystem, name)) {
      const rows = index.get(variant);
      if (rows) out.push(...rows);
    }
    return out;
  }

  /** 判定依赖是否确实受影响；无法解析实际版本时返回 unresolved，交由调用方降级为提示 */
  private dependencyMatch(
    dep: DependencyRef,
    row: AdvisoryRow,
    ecosystem: Ecosystem,
  ): 'affected' | 'unresolved' | 'none' {
    const resolved = (dep.resolvedVersion || '').trim();
    if (resolved) return versionInRange(resolved, row.affected_range, ecosystem) ? 'affected' : 'none';

    const range = (dep.range || '').trim();
    if (!range || range === '*') return 'unresolved';

    // 声明本身就是精确版本时可以直接判定
    const exact = range.match(/^[=]{0,2}\s*v?(\d+(?:\.\d+){0,3}[0-9A-Za-z.+-]*)$/);
    if (exact) return versionInRange(exact[1], row.affected_range, ecosystem) ? 'affected' : 'none';

    // npm 区间可求交：不相交即确定不受影响
    if (ecosystem === 'npm' && semver.validRange(range) && semver.validRange(row.affected_range)) {
      try {
        return semver.intersects(range, row.affected_range, { includePrerelease: true }) ? 'affected' : 'none';
      } catch {
        /* 退回 unresolved */
      }
    }
    return 'unresolved';
  }
}

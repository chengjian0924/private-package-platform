import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { nowIso } from '../common/http.util';
import { getConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';
import { StorageService } from '../storage/storage.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 单轮最多处理的版本数：避免首次上线积压过多时一次性长时间占用写锁 */
const PURGE_BATCH_LIMIT = 500;

export interface DeletedVersionPurgeResult {
  /** 生效的保留天数；0 表示当前不自动清理 */
  retentionDays: number;
  cutoff: string | null;
  /** 实际硬删除的版本数 */
  purgedVersions: number;
  /** 清理后已无任何版本、被一并删除的包壳数 */
  purgedPackages: number;
  /** 释放的对象存储字节数 */
  freedBytes: number;
  /** 与其它版本共享对象、只删记录不删文件的次数 */
  sharedBlobs: number;
  /** 供审计与排障的样例（最多 20 条） */
  sample: string[];
}

export interface LogPurgeResult {
  retentionDays: number;
  cutoff: string | null;
  dir: string;
  /** 目录下命中的候选日志文件数 */
  scanned: number;
  deleted: number;
  freedBytes: number;
  sample: string[];
}

interface ExpiredVersionRow {
  id: string;
  package_id: string;
  sha256: string;
  size_bytes: number;
  deleted_at: string;
}

/**
 * 保留期清理：
 * - 软删除的版本超过保留天数后硬删除（记录 + 对象文件 + 关联扫描记录/报告）；
 * - 按天落盘的日志文件超过保留天数后删除。
 *
 * 两个阈值都从 getConfig().retention 读取，字典管理保存后下一轮立即生效，
 * 无需重启；0 表示关闭该类清理。
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 硬删除超期未恢复的软删除版本。
   * 内容寻址存储按 sha256 去重，同一对象可能被其它版本引用，此时只删记录不删文件。
   */
  async purgeDeletedPackages(): Promise<DeletedVersionPurgeResult> {
    const retentionDays = getConfig().retention.deletedPackageDays;
    if (retentionDays <= 0) {
      return {
        retentionDays: 0,
        cutoff: null,
        purgedVersions: 0,
        purgedPackages: 0,
        freedBytes: 0,
        sharedBlobs: 0,
        sample: [],
      };
    }
    const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
    const rows = this.db.all<ExpiredVersionRow>(
      `SELECT id, package_id, sha256, size_bytes, deleted_at
         FROM package_versions
        WHERE deleted_at IS NOT NULL AND deleted_at < ?
        ORDER BY deleted_at ASC
        LIMIT ?`,
      cutoff,
      PURGE_BATCH_LIMIT,
    );

    let purgedVersions = 0;
    let freedBytes = 0;
    let sharedBlobs = 0;
    const sample: string[] = [];
    const touchedPackages = new Set<string>();

    for (const row of rows) {
      const scans = this.db.all<{ id: string; report_key: string | null }>(
        'SELECT id, report_key FROM security_scans WHERE package_version_id = ?',
        row.id,
      );
      // 去重对象仍被别的版本引用时不能删文件，否则会把正常版本的内容删掉
      const shared = this.db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM package_versions WHERE sha256 = ? AND id <> ?',
        row.sha256,
        row.id,
      );
      const isShared = (shared?.c ?? 0) > 0;

      this.db.tx(() => {
        for (const scan of scans) {
          this.db.run('DELETE FROM security_findings WHERE scan_id = ?', scan.id);
          this.db.run('DELETE FROM security_scan_jobs WHERE scan_id = ?', scan.id);
          this.db.run('DELETE FROM security_scans WHERE id = ?', scan.id);
        }
        // 引用了该版本的外部记录改成悬空指针，保留历史语义但不指向已删数据
        this.db.run('UPDATE missing_dependencies SET resolved_version_id = NULL WHERE resolved_version_id = ?', row.id);
        this.db.run('UPDATE import_batch_items SET package_version_id = NULL WHERE package_version_id = ?', row.id);
        this.db.run('DELETE FROM package_versions WHERE id = ?', row.id);
      });

      // 文件删除放在事务提交之后：DB 回滚时不留「记录还在、文件没了」的半截状态
      for (const scan of scans) {
        if (!scan.report_key) continue;
        await fsp.rm(path.join(getConfig().dataDir, scan.report_key), { force: true }).catch((err) => {
          this.logger.warn(`扫描报告文件清理失败 ${scan.report_key}: ${(err as Error).message}`);
        });
      }
      if (isShared) {
        sharedBlobs += 1;
      } else {
        try {
          if (await this.storage.deleteObject(row.sha256)) freedBytes += row.size_bytes;
        } catch (err) {
          this.logger.warn(`包对象删除失败 ${row.sha256}: ${(err as Error).message}`);
        }
      }

      purgedVersions += 1;
      touchedPackages.add(row.package_id);
      if (sample.length < 20) sample.push(`${row.id}@${row.deleted_at}`);
    }

    // 包壳在所有版本都被删光后没有存在意义：一并回收，避免留下空分组
    let purgedPackages = 0;
    for (const packageId of touchedPackages) {
      const left = this.db.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM package_versions WHERE package_id = ?',
        packageId,
      );
      if ((left?.c ?? 0) > 0) continue;
      purgedPackages += this.db.run('DELETE FROM packages WHERE id = ?', packageId).changes;
    }

    if (purgedVersions > 0) {
      this.logger.log(
        `软删除包超期清理完成：版本 ${purgedVersions} 个、包壳 ${purgedPackages} 个，释放 ${freedBytes} 字节，保留期 ${retentionDays} 天`,
      );
      this.audit.log({
        actorId: 'system',
        action: 'retention.packages.purge',
        resourceType: 'package_version',
        resourceId: null,
        result: 'success',
        detail: {
          retentionDays,
          cutoff,
          purgedVersions,
          purgedPackages,
          freedBytes,
          sharedBlobs,
        },
      });
    }

    return { retentionDays, cutoff, purgedVersions, purgedPackages, freedBytes, sharedBlobs, sample };
  }

  /**
   * 删除超期日志文件。只处理 *.log / *.log.N / *.log.gz，
   * 目录里若有其它文件（例如运维手工放置的说明）一律不动。
   */
  async purgeLogFiles(): Promise<LogPurgeResult> {
    const cfg = getConfig();
    const retentionDays = cfg.retention.logDays;
    const dir = cfg.log.dir;
    if (retentionDays <= 0) {
      return { retentionDays: 0, cutoff: null, dir, scanned: 0, deleted: 0, freedBytes: 0, sample: [] };
    }
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    const cutoff = new Date(cutoffMs).toISOString();

    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    let scanned = 0;
    let deleted = 0;
    let freedBytes = 0;
    const sample: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.log(\.\d+)?(\.gz)?$/i.test(entry.name)) continue;
      scanned += 1;
      const absPath = path.join(dir, entry.name);
      const stat = await fsp.stat(absPath).catch(() => null);
      if (!stat || stat.mtimeMs >= cutoffMs) continue;
      try {
        await fsp.rm(absPath, { force: true });
        deleted += 1;
        freedBytes += stat.size;
        if (sample.length < 20) sample.push(entry.name);
      } catch (err) {
        this.logger.warn(`日志文件删除失败 ${entry.name}: ${(err as Error).message}`);
      }
    }

    if (deleted > 0) {
      this.logger.log(`日志清理完成：删除 ${deleted} 个文件，释放 ${freedBytes} 字节，保留期 ${retentionDays} 天`);
    }
    return { retentionDays, cutoff, dir, scanned, deleted, freedBytes, sample };
  }

  /**
   * 删除已失效且超过保留期的会话行。
   * 会话只会随登录增加：不清理时，长期运行的实例每次登录都留一行，
   * sessions 表最终会比包版本表还大，且保留期整表扫描会拖慢共享库的写锁。
   * 保留期内保留是为了排障（谁在何时从哪个 IP 登录过），过期后即无查询价值。
   */
  purgeExpiredSessions(): { retentionDays: number; deleted: number } {
    const retentionDays = getConfig().retention.sessionDays;
    if (retentionDays <= 0) return { retentionDays: 0, deleted: 0 };
    const deleted = this.auth.purgeExpiredSessions(retentionDays);
    if (deleted > 0) {
      this.logger.log(`会话清理完成：删除 ${deleted} 行失效会话，保留期 ${retentionDays} 天`);
    }
    return { retentionDays, deleted };
  }

  /** 一轮完整清理：包、日志与会话互不影响，任一失败不阻塞另一个 */
  async runOnce(): Promise<{
    packages: DeletedVersionPurgeResult;
    logs: LogPurgeResult;
    sessions: { retentionDays: number; deleted: number };
    at: string;
  }> {
    const at = nowIso();
    const packages = await this.purgeDeletedPackages().catch((err) => {
      this.logger.error(`软删除包清理失败: ${(err as Error).message}`);
      return {
        retentionDays: getConfig().retention.deletedPackageDays,
        cutoff: null,
        purgedVersions: 0,
        purgedPackages: 0,
        freedBytes: 0,
        sharedBlobs: 0,
        sample: [],
      };
    });
    const logs = await this.purgeLogFiles().catch((err) => {
      this.logger.error(`日志清理失败: ${(err as Error).message}`);
      return {
        retentionDays: getConfig().retention.logDays,
        cutoff: null,
        dir: getConfig().log.dir,
        scanned: 0,
        deleted: 0,
        freedBytes: 0,
        sample: [],
      };
    });
    const sessions = (() => {
      try {
        return this.purgeExpiredSessions();
      } catch (err) {
        this.logger.error(`会话清理失败: ${(err as Error).message}`);
        return { retentionDays: getConfig().retention.sessionDays, deleted: 0 };
      }
    })();
    return { packages, logs, sessions, at };
  }
}

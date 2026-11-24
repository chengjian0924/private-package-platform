import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { getConfig } from '../config/config';
import { DatabaseService } from '../db/database.service';

export interface BackupSweepResult {
  /** 本轮是否真正执行；false 表示备份开关处于关闭状态，什么都没做 */
  enabled: boolean;
  dir: string;
  intervalMinutes: number;
  /** 对象存储中扫描到的包文件数（含孤儿对象） */
  scanned: number;
  /** 本轮新复制到备份目录的文件数 */
  copied: number;
  /** 备份文件大小与源不一致、被覆盖修复的数量 */
  repaired: number;
  /** 备份目录里已存在且大小一致，直接跳过的数量 */
  skipped: number;
  failed: number;
  copiedBytes: number;
  /** 未被任何版本引用的孤儿对象数量：本轮跳过，避免备份被垃圾撑大 */
  orphanSkipped: number;
  /** 隔离区复制到备份的文件数（隔离样本可恢复、可追溯） */
  quarantineCopied: number;
  quarantineFailed: number;
  /** 失败样例（最多 5 条），便于排障 */
  errors: string[];
}

/** 对象键形如 objects/<sha256 前 2 位>/<sha256>；不符合的一律不进备份，避免把临时文件带进去 */
const OBJECT_KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

/**
 * 包文件备份：把内容寻址存储中的包对象增量复制到备份目录。
 *
 * 三条硬约束（对应字典里的开关语义）：
 * - 关闭开关只停止后续备份，**从不删除**备份目录里的任何文件；
 * - 只复制、不移动，源对象被保留期清理后备份仍然保留；
 * - 每轮都是「补齐差集」，重复执行幂等，可以在任意时刻安全重跑。
 *
 * 备份范围：
 * - 只备份被 package_versions 引用的对象。上传失败或入库前中断会留下无引用的孤儿对象，
 *   这些垃圾不该被固化进备份（备份从不删除，一旦进去就永久占空间），交给孤儿清扫回收。
 * - 隔离区单独镜像到 <backupDir>/quarantine/，位于隔离区等待处置的样本在源卷损坏后
 *   仍可恢复；隔离目录常挂在独立卷，不能从对象存储的备份里还原。
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger('Backup');

  constructor(
    private readonly audit: AuditService,
    private readonly db: DatabaseService,
  ) {}

  async runSweep(): Promise<BackupSweepResult> {
    const cfg = getConfig();
    const result: BackupSweepResult = {
      enabled: cfg.backup.enabled,
      dir: cfg.backup.dir,
      intervalMinutes: cfg.backup.intervalMinutes,
      scanned: 0,
      copied: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
      copiedBytes: 0,
      orphanSkipped: 0,
      quarantineCopied: 0,
      quarantineFailed: 0,
      errors: [],
    };
    if (!cfg.backup.enabled) {
      // 关闭时连目录都不创建：避免「关了还多出一个空目录」被误读成仍在备份
      return result;
    }

    try {
      await fsp.mkdir(cfg.backup.dir, { recursive: true });
    } catch (err) {
      result.failed += 1;
      result.errors.push(`备份目录不可用 ${cfg.backup.dir}: ${(err as Error).message}`);
      this.logger.error(`备份目录创建失败 ${cfg.backup.dir}: ${(err as Error).message}`);
      return result;
    }

    // storage_key 相对 DATA_DIR 存储（形如 objects/<xx>/<sha>），这里统一去掉 objects/ 前缀，
    // 与 listObjects 返回的 <xx>/<sha> 对齐，再做引用判定
    const referenced = new Set(
      this.db
        .all<{ storage_key: string }>('SELECT DISTINCT storage_key FROM package_versions')
        .map((row) => row.storage_key.replace(/\\/g, '/').replace(/^objects\//, '')),
    );
    const allEntries = await this.listObjects(cfg.objectDir);
    result.scanned = allEntries.length;
    const entries = allEntries.filter((rel) => referenced.has(rel));
    result.orphanSkipped = allEntries.length - entries.length;

    for (const rel of entries) {
      const src = path.join(cfg.objectDir, rel);
      const dest = path.join(cfg.backup.dir, rel);
      try {
        const outcome = await this.syncFile(src, dest);
        if (outcome.status === 'skipped') {
          result.skipped += 1;
          continue;
        }
        if (outcome.status === 'repaired') result.repaired += 1;
        else result.copied += 1;
        result.copiedBytes += outcome.bytes;
      } catch (err) {
        result.failed += 1;
        if (result.errors.length < 5) result.errors.push(`${rel}: ${(err as Error).message}`);
        this.logger.warn(`备份失败 ${rel}: ${(err as Error).message}`);
      }
    }

    // 隔离区镜像：目录结构原样复制到 <backupDir>/quarantine/，与对象键（两位十六进制桶）不会冲突
    const quarantineRoot = cfg.security.quarantineDir;
    const quarantineFiles = await this.listFilesRecursive(quarantineRoot);
    for (const rel of quarantineFiles) {
      const src = path.join(quarantineRoot, rel);
      const dest = path.join(cfg.backup.dir, 'quarantine', rel);
      try {
        const outcome = await this.syncFile(src, dest);
        if (outcome.status !== 'skipped') {
          result.quarantineCopied += 1;
          result.copiedBytes += outcome.bytes;
        }
      } catch (err) {
        result.quarantineFailed += 1;
        if (result.errors.length < 5) result.errors.push(`quarantine/${rel}: ${(err as Error).message}`);
        this.logger.warn(`隔离区备份失败 ${rel}: ${(err as Error).message}`);
      }
    }

    if (result.copied + result.repaired + result.quarantineCopied > 0) {
      this.logger.log(
        `包备份完成：新增 ${result.copied} 个、修复 ${result.repaired} 个、跳过 ${result.skipped} 个，` +
          `隔离区 ${result.quarantineCopied} 个，孤儿对象跳过 ${result.orphanSkipped} 个，` +
          `写入 ${result.copiedBytes} 字节 → ${cfg.backup.dir}`,
      );
      this.audit.log({
        actorId: 'system',
        action: 'backup.objects.copy',
        resourceType: 'object',
        resourceId: null,
        result: result.failed + result.quarantineFailed > 0 ? 'failure' : 'success',
        detail: {
          dir: cfg.backup.dir,
          intervalMinutes: cfg.backup.intervalMinutes,
          scanned: result.scanned,
          copied: result.copied,
          repaired: result.repaired,
          skipped: result.skipped,
          failed: result.failed,
          orphanSkipped: result.orphanSkipped,
          quarantineCopied: result.quarantineCopied,
          quarantineFailed: result.quarantineFailed,
          copiedBytes: result.copiedBytes,
        },
      });
    }

    return result;
  }

  /** 单文件增量同步：大小一致视为已备份；先写临时文件再 rename，避免半截文件被当成完整备份 */
  private async syncFile(src: string, dest: string): Promise<{ status: 'copied' | 'repaired' | 'skipped'; bytes: number }> {
    const srcStat = await fsp.stat(src);
    const destStat = await fsp.stat(dest).catch(() => null);
    if (destStat && destStat.isFile() && destStat.size === srcStat.size) {
      return { status: 'skipped', bytes: 0 };
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}`;
    await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, dest);
    return { status: destStat ? 'repaired' : 'copied', bytes: srcStat.size };
  }

  /** 递归列出目录下的普通文件（相对路径，正斜杠分隔）；目录不存在时返回空数组 */
  private async listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    const entries = await fsp
      .readdir(path.join(root, prefix), { withFileTypes: true })
      .catch(() => [] as import('node:fs').Dirent[]);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(...(await this.listFilesRecursive(root, rel)));
        continue;
      }
      if (!entry.isFile()) continue;
      // 跳过自己写的半截临时文件与隐藏文件，避免把中间态备份出去
      if (entry.name.endsWith('.part') || entry.name.includes('.part-') || entry.name.startsWith('.')) continue;
      out.push(rel);
    }
    return out;
  }

  /** 列出对象存储里的包对象（相对键），目录不存在时返回空数组 */
  private async listObjects(objectDir: string): Promise<string[]> {
    const out: string[] = [];
    const buckets = await fsp.readdir(objectDir, { withFileTypes: true }).catch(() => []);
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/.test(bucket.name)) continue;
      const files = await fsp.readdir(path.join(objectDir, bucket.name), { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile()) continue;
        const rel = `${bucket.name}/${file.name}`;
        if (OBJECT_KEY.test(rel)) out.push(rel);
      }
    }
    return out;
  }
}

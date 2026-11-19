import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { getConfig } from '../config/config';

export interface BackupSweepResult {
  /** 本轮是否真正执行；false 表示备份开关处于关闭状态，什么都没做 */
  enabled: boolean;
  dir: string;
  intervalMinutes: number;
  /** 对象存储中扫描到的包文件数 */
  scanned: number;
  /** 本轮新复制到备份目录的文件数 */
  copied: number;
  /** 备份文件大小与源不一致、被覆盖修复的数量 */
  repaired: number;
  /** 备份目录里已存在且大小一致，直接跳过的数量 */
  skipped: number;
  failed: number;
  copiedBytes: number;
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
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger('Backup');

  constructor(private readonly audit: AuditService) {}

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

    const entries = await this.listObjects(cfg.objectDir);
    result.scanned = entries.length;

    for (const rel of entries) {
      const src = path.join(cfg.objectDir, rel);
      const dest = path.join(cfg.backup.dir, rel);
      try {
        const srcStat = await fsp.stat(src);
        const destStat = await fsp.stat(dest).catch(() => null);
        if (destStat && destStat.isFile() && destStat.size === srcStat.size) {
          result.skipped += 1;
          continue;
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        // 先写临时文件再 rename：避免备份中断留下「大小对得上但内容半截」的文件
        const tmp = `${dest}.part-${process.pid}`;
        await fsp.copyFile(src, tmp);
        await fsp.rename(tmp, dest);
        if (destStat) {
          result.repaired += 1;
        } else {
          result.copied += 1;
        }
        result.copiedBytes += srcStat.size;
      } catch (err) {
        result.failed += 1;
        if (result.errors.length < 5) result.errors.push(`${rel}: ${(err as Error).message}`);
        this.logger.warn(`备份失败 ${rel}: ${(err as Error).message}`);
      }
    }

    if (result.copied + result.repaired > 0) {
      this.logger.log(
        `包备份完成：新增 ${result.copied} 个、修复 ${result.repaired} 个、跳过 ${result.skipped} 个，` +
          `写入 ${result.copiedBytes} 字节 → ${cfg.backup.dir}`,
      );
      this.audit.log({
        actorId: 'system',
        action: 'backup.objects.copy',
        resourceType: 'object',
        resourceId: null,
        result: result.failed > 0 ? 'failure' : 'success',
        detail: {
          dir: cfg.backup.dir,
          intervalMinutes: cfg.backup.intervalMinutes,
          scanned: result.scanned,
          copied: result.copied,
          repaired: result.repaired,
          skipped: result.skipped,
          failed: result.failed,
          copiedBytes: result.copiedBytes,
        },
      });
    }

    return result;
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

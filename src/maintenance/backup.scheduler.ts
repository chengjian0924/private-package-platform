import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getConfig } from '../config/config';
import { BackupService } from './backup.service';

/**
 * 心跳周期：每 60 秒检查一次「距上次备份是否已过配置的间隔」。
 * 之所以不直接把 setInterval 设成备份间隔，是因为字典里改间隔后需要即时生效——
 * 心跳固定、间隔每轮重读，改完最多一分钟就按新节奏走。
 */
const DEFAULT_HEARTBEAT_MS = 60_000;

/**
 * 包备份调度器：只在控制台进程启用（与复检、保留期清理一致，保证全平台单实例执行）。
 * 间隔与开关都在每轮重新读 getConfig()，字典保存后无需重启。
 */
@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BackupScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt = 0;

  constructor(private readonly backup: BackupService) {}

  onModuleInit(): void {
    const heartbeat = Number(process.env.BACKUP_HEARTBEAT_MS ?? DEFAULT_HEARTBEAT_MS);
    if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
      this.logger.log('包备份调度已关闭（BACKUP_HEARTBEAT_MS <= 0）');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, heartbeat);
    this.timer.unref();
    const cfg = getConfig().backup;
    this.logger.log(
      `包备份调度已启用：心跳 ${heartbeat} 毫秒，${cfg.enabled ? `每 ${cfg.intervalMinutes} 分钟增量备份到 ${cfg.dir}` : '当前开关为关闭，不会执行备份'}`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const cfg = getConfig().backup;
    if (!cfg.enabled) return;
    const intervalMs = Math.max(1, cfg.intervalMinutes) * 60_000;
    if (Date.now() - this.lastRunAt < intervalMs) return;

    this.running = true;
    try {
      await this.backup.runSweep();
      // 即使本轮部分文件失败也推进计时：否则失败文件会让每一拍都重跑整轮
      this.lastRunAt = Date.now();
    } catch (err) {
      this.logger.error(`包备份失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getConfig } from '../config/config';
import { RetentionService } from './retention.service';

/** 默认每小时扫一次：保留期以天为单位，扫描频率只需保证「当天能触发」 */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 保留期清理调度器：只在控制台进程启用（与复检、隔离销毁一致，保证全平台单实例执行）。
 * 两个阈值都在每轮执行时重新读取，字典管理保存后无需重启即可按新保留期清理。
 */
@Injectable()
export class RetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RetentionScheduler');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly retention: RetentionService) {}

  onModuleInit(): void {
    const interval = Number(process.env.RETENTION_SWEEP_INTERVAL_MS || DEFAULT_SWEEP_INTERVAL_MS);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.logger.log('保留期清理已关闭（RETENTION_SWEEP_INTERVAL_MS <= 0）');
      return;
    }
    // 先跑一次：进程按天重启时只靠 setInterval 永远等不到第一次触发
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref();
    this.logger.log(
      `保留期清理已启用，间隔 ${interval} 毫秒（软删除包 ${getConfig().retention.deletedPackageDays} 天，日志 ${getConfig().retention.logDays} 天，失效会话 ${getConfig().retention.sessionDays} 天）`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮保留期清理尚未结束，跳过本次调度');
      return;
    }
    this.running = true;
    try {
      await this.retention.runOnce();
    } catch (err) {
      this.logger.error(`保留期清理失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

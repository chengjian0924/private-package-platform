import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getConfig } from '../config/config';
import { SecurityService } from './security.service';

/**
 * 低峰窗口判断：start/end 为 -1 表示不限制；支持跨零点（如 23 → 5）。
 * 采用 [start, end) 半开区间，避免边界小时重复执行。
 */
export function isWithinRescanWindow(hour: number, start: number, end: number): boolean {
  if (start === -1 && end === -1) return true;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * 定期复检调度器：进程内 setInterval，timer.unref() 避免阻塞进程退出。
 * 单实例部署足够；多实例部署时需引入分布式锁，避免重复扫描。
 */
@Injectable()
export class SecurityScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SecurityScheduler');
  private timer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private purging = false;

  constructor(private readonly security: SecurityService) {}

  onModuleInit(): void {
    const interval = getConfig().security.rescanIntervalSec;
    if (!Number.isFinite(interval) || interval <= 0) {
      this.logger.log('定期复检已关闭（SECURITY_RESCAN_INTERVAL_SEC <= 0）');
    } else {
      this.timer = setInterval(() => {
        void this.tick();
      }, interval * 1000);
      this.timer.unref();
      this.logger.log(`定期复检已启用，间隔 ${interval} 秒`);
    }

    // B6：隔离样本超期销毁独立于复检，复检关闭时仍要执行
    const purgeInterval = getConfig().security.quarantinePurgeIntervalMs;
    if (!Number.isFinite(purgeInterval) || purgeInterval <= 0) {
      this.logger.log('隔离样本超期销毁已关闭（QUARANTINE_PURGE_INTERVAL_MS <= 0）');
      return;
    }
    // 先跑一次：进程按天重启时，只靠 setInterval 永远等不到第一次触发
    void this.purgeTick();
    this.purgeTimer = setInterval(() => {
      void this.purgeTick();
    }, purgeInterval);
    this.purgeTimer.unref();
    this.logger.log(`隔离样本超期销毁已启用，间隔 ${purgeInterval} 毫秒`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  private async purgeTick(): Promise<void> {
    if (this.purging) return;
    this.purging = true;
    try {
      const result = await this.security.purgeExpiredQuarantine(true);
      if (result.count > 0) {
        this.logger.log(
          `隔离样本超期销毁完成：${result.count} 条，释放 ${result.bytes} 字节，保留期 ${result.retentionDays} 天`,
        );
      }
    } catch (err) {
      this.logger.error(`隔离样本超期销毁失败: ${(err as Error).message}`);
    } finally {
      this.purging = false;
    }
    // RV-26：扫描记录/报告/埋点保留期清理，与隔离销毁同频执行；scanRetentionDays=0 表示关闭
    try {
      const purge = await this.security.purgeExpiredScans(true);
      if (purge.applied && (purge.scanCount > 0 || purge.jobCount > 0 || purge.telemetryCount > 0)) {
        this.logger.log(
          `扫描保留期清理完成：扫描 ${purge.scanCount} 条、任务 ${purge.jobCount} 条、埋点 ${purge.telemetryCount} 条`,
        );
      }
    } catch (err) {
      this.logger.error(`扫描保留期清理失败: ${(err as Error).message}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮复检尚未结束，跳过本次调度');
      return;
    }
    const cfg = getConfig().security;
    // 字典管理关闭漏洞扫描后，定时复检同步停跑（隔离区销毁不受影响，仍按保留期执行）
    if (!cfg.scanEnabled) {
      this.logger.log('漏洞扫描已关闭（字典 security.scanEnabled=false），跳过本次复检调度');
      return;
    }
    const hour = new Date().getHours();
    if (!isWithinRescanWindow(hour, cfg.rescanWindowStartHour, cfg.rescanWindowEndHour)) {
      this.logger.log(
        `当前 ${hour} 点不在复检窗口 ${cfg.rescanWindowStartHour}-${cfg.rescanWindowEndHour}，跳过本次调度`,
      );
      return;
    }
    this.running = true;
    try {
      const result = await this.security.runRescan('schedule', null);
      this.logger.log(
        `定期复检完成：扫描 ${result.scanned}，变化 ${result.changed}，新增风险 ${result.newFindings}，隔离 ${result.quarantined}`,
      );
    } catch (err) {
      this.logger.error(`定期复检失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

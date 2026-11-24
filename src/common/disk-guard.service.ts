import { CanActivate, ExecutionContext, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import * as fsp from 'node:fs/promises';
import { getConfig } from '../config/config';
import { ApiError } from './errors';

export type DiskMode = 'normal' | 'alert' | 'readonly';

export interface DiskThresholds {
  alertPercent: number;
  readonlyPercent: number;
  minFreeBytes: number;
  /**
   * 滞回带宽（百分点）。进入告警/只读用原阈值，退出必须回落到阈值以下这么多，
   * 避免水位在阈值附近抖动时状态反复翻转（只读/告警来回切换会让写入随机失败）。
   * 缺省 0 表示不做滞回，行为与旧版一致。
   */
  hysteresisPercent?: number;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export interface DiskState extends DiskUsage {
  mode: DiskMode;
  usedPercent: number;
  checkedAt: string;
}

/** 只读模式下仍放行的写入口：登录换取会话、健康检查、指标采集 */
const EXEMPT_PREFIXES = ['/api/v1/auth', '/api/v1/health', '/metrics'];

/**
 * 纯函数便于边界用例：freeBytes 取 bavail，即非 root 实际可写空间。
 *
 * 传入上一个状态即可获得滞回：进入只读看 `readonlyPercent`，退出只读需要
 * 回落到 `readonlyPercent - hysteresis` 以下（且可用空间补回同样的缓冲）；
 * 告警同理。这样水位恰好卡在阈值上时状态不会每轮翻转。
 */
export function evaluateDiskState(
  usage: DiskUsage,
  thresholds: DiskThresholds,
  previous: DiskMode = 'normal',
): DiskMode {
  if (usage.totalBytes <= 0) return 'normal';
  const usedPercent = ((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100;
  const hysteresis = Math.max(0, thresholds.hysteresisPercent ?? 0);
  // 可用空间的滞回量按磁盘总容量的百分点换算，和百分比阈值保持同一量纲
  const freeHysteresis = (usage.totalBytes * hysteresis) / 100;

  const enterReadonly = usedPercent >= thresholds.readonlyPercent || usage.freeBytes < thresholds.minFreeBytes;

  if (previous === 'readonly') {
    const leaveReadonly =
      usedPercent < thresholds.readonlyPercent - hysteresis &&
      usage.freeBytes >= thresholds.minFreeBytes + freeHysteresis;
    if (!leaveReadonly) return 'readonly';
    // 已真正回落到只读阈值以下：按常规重新评估（可能停在告警档）
    return usedPercent >= thresholds.alertPercent ? 'alert' : 'normal';
  }

  if (enterReadonly) return 'readonly';

  if (previous === 'alert') {
    // 告警档需要跌破 alertPercent - hysteresis 才恢复正常
    return usedPercent >= thresholds.alertPercent - hysteresis ? 'alert' : 'normal';
  }

  if (usedPercent >= thresholds.alertPercent) return 'alert';
  return 'normal';
}

/**
 * 磁盘水位守卫（A-05）：周期采样 DATA_DIR 所在文件系统。
 * 采样失败时沿用上次状态，避免监控抖动误开放写入。
 */
@Injectable()
export class DiskGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DiskGuard');
  private state: DiskState = {
    mode: 'normal',
    usedPercent: 0,
    freeBytes: Number.MAX_SAFE_INTEGER,
    totalBytes: 0,
    checkedAt: '',
  };
  private thresholds: DiskThresholds = { alertPercent: 85, readonlyPercent: 95, minFreeBytes: 0 };
  private dir = '';
  private timer?: NodeJS.Timeout;
  private sampling = false;

  async onModuleInit(): Promise<void> {
    const cfg = getConfig();
    this.dir = cfg.dataDir;
    this.thresholds = {
      alertPercent: cfg.storage.diskAlertPercent,
      readonlyPercent: cfg.storage.diskReadonlyPercent,
      minFreeBytes: cfg.storage.minFreeBytes,
      hysteresisPercent: cfg.storage.diskHysteresisPercent,
    };
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, cfg.storage.checkIntervalMs);
    // 不阻止进程退出，容器与测试环境下无需显式清理
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const usage = await this.sample();
      const previous = this.state.mode;
      const mode = evaluateDiskState(usage, this.thresholds, previous);
      this.state = {
        mode,
        usedPercent:
          usage.totalBytes > 0
            ? Number((((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100).toFixed(1))
            : 0,
        freeBytes: usage.freeBytes,
        totalBytes: usage.totalBytes,
        checkedAt: new Date().toISOString(),
      };
      if (mode !== previous) {
        const detail = `状态 ${previous} → ${mode}，已用 ${this.state.usedPercent}%，可用 ${formatBytes(usage.freeBytes)}`;
        if (mode === 'readonly') this.logger.error(`磁盘空间不足，平台进入只读模式：${detail}`);
        else if (mode === 'alert') this.logger.warn(`磁盘空间告警：${detail}`);
        else this.logger.log(`磁盘空间恢复正常：${detail}`);
      }
    } catch (err) {
      this.logger.warn(`磁盘采样失败，沿用上次状态 ${this.state.mode}：${(err as Error).message}`);
    } finally {
      this.sampling = false;
    }
  }

  private async sample(): Promise<DiskUsage> {
    const stats = await fsp.statfs(this.dir);
    const blockSize = Number(stats.bsize);
    return {
      totalBytes: Number(stats.blocks) * blockSize,
      freeBytes: Number(stats.bavail) * blockSize,
    };
  }

  snapshot(): DiskState {
    return { ...this.state };
  }

  isReadOnly(): boolean {
    return this.state.mode === 'readonly';
  }

  /** 写入口统一调用：只读时抛出 507，由全局异常过滤器转成响应信封 */
  assertWritable(): void {
    if (!this.isReadOnly()) return;
    throw new ApiError('STORAGE_READ_ONLY', {
      usedPercent: this.state.usedPercent,
      freeBytes: this.state.freeBytes,
    });
  }
}

/**
 * 全局写拦截：在 multer 落临时文件之前拒绝请求。
 * GET/HEAD/OPTIONS 与登录、健康检查、指标不受影响，保证只读期间仍可排查。
 */
@Injectable()
export class DiskWriteGuard implements CanActivate {
  constructor(private readonly disk: DiskGuardService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const reqPath = (req.path || '/').toLowerCase();
    if (EXEMPT_PREFIXES.some((prefix) => reqPath.startsWith(prefix))) return true;
    this.disk.assertWritable();
    return true;
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)}${units[index]}`;
}

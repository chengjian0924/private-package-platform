import { Controller, Get, Header, Headers, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';
import { getConfig } from '../config/config';
import { ClockService } from '../common/clock.service';
import { DiskGuardService } from '../common/disk-guard.service';
import { SecurityService } from '../security/security.service';

/**
 * Prometheus 指标（B3）：文本格式手工拼装，不引入 prom-client。
 * 指标基数受控：HTTP 只按「请求类别 + 状态码」聚合，不做路径维度。
 */

type Scope = 'auth' | 'read' | 'write';

/** 秒级桶，覆盖内网正常请求到扫描类慢请求 */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface DurationStat {
  count: number;
  sum: number;
  buckets: number[];
}

function scopeOf(req: Request): Scope {
  const path = (req.path || '').toLowerCase();
  if (path.startsWith('/api/v1/auth/') || path.startsWith('/auth/')) return 'auth';
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  return 'write';
}

@Injectable()
export class MetricsService {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<Scope, DurationStat>();
  private readonly startedCpu = process.cpuUsage();

  record(scope: Scope, status: number, durationSeconds: number): void {
    const key = `${scope}|${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);

    let stat = this.durations.get(scope);
    if (!stat) {
      stat = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.durations.set(scope, stat);
    }
    stat.count += 1;
    stat.sum += durationSeconds;
    for (let i = 0; i < BUCKETS.length; i += 1) {
      if (durationSeconds <= BUCKETS[i]) stat.buckets[i] += 1;
    }
  }

  async render(): Promise<string> {
    const lines: string[] = [];
    const add = (line: string) => lines.push(line);

    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.startedCpu);

    add('# HELP yj_up 进程存活标记');
    add('# TYPE yj_up gauge');
    add('yj_up 1');
    add('# HELP yj_build_info 运行环境信息');
    add('# TYPE yj_build_info gauge');
    add(`yj_build_info{node="${process.version}",platform="${os.platform()}"} 1`);
    add('# HELP yj_uptime_seconds 进程运行时长');
    add('# TYPE yj_uptime_seconds gauge');
    add(`yj_uptime_seconds ${process.uptime().toFixed(3)}`);
    add('# HELP yj_process_resident_memory_bytes 常驻内存');
    add('# TYPE yj_process_resident_memory_bytes gauge');
    add(`yj_process_resident_memory_bytes ${memory.rss}`);
    add('# HELP yj_nodejs_heap_used_bytes V8 堆使用量');
    add('# TYPE yj_nodejs_heap_used_bytes gauge');
    add(`yj_nodejs_heap_used_bytes ${memory.heapUsed}`);
    add('# HELP yj_process_cpu_seconds_total CPU 累计耗时');
    add('# TYPE yj_process_cpu_seconds_total counter');
    add(`yj_process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`);

    // A-05：磁盘水位直接取守卫快照，避免每次抓取都做一次 statfs
    const disk = this.disk.snapshot();
    add('# HELP yj_disk_used_percent DATA_DIR 所在文件系统已用百分比');
    add('# TYPE yj_disk_used_percent gauge');
    add(`yj_disk_used_percent ${disk.usedPercent}`);
    add('# HELP yj_disk_available_bytes DATA_DIR 所在文件系统可用字节数');
    add('# TYPE yj_disk_available_bytes gauge');
    add(`yj_disk_available_bytes ${disk.freeBytes}`);
    add('# HELP yj_disk_readonly 是否因磁盘水位进入只读模式');
    add('# TYPE yj_disk_readonly gauge');
    add(`yj_disk_readonly ${disk.mode === 'readonly' ? 1 : 0}`);
    add('# HELP yj_disk_last_check_timestamp_seconds 最近一次磁盘采样时间');
    add('# TYPE yj_disk_last_check_timestamp_seconds gauge');
    add(`yj_disk_last_check_timestamp_seconds ${disk.checkedAt ? Math.floor(Date.parse(disk.checkedAt) / 1000) : 0}`);

    // 时钟状态：未配置 NTP_SERVER 时 offsetMs 为 NaN，表示未采样
    const clock = this.clock.snapshot();
    add('# HELP yj_clock_offset_ms 主机时钟相对 NTP 的偏移毫秒数；未采样为 NaN');
    add('# TYPE yj_clock_offset_ms gauge');
    add(`yj_clock_offset_ms{server="${escapeLabel(clock.server)}"} ${clock.offsetMs ?? 'NaN'}`);
    add('# HELP yj_clock_healthy 时钟偏移是否在阈值内（1 正常 / 0 超限 / -1 未知）');
    add('# TYPE yj_clock_healthy gauge');
    add(`yj_clock_healthy ${clock.healthy === null ? -1 : clock.healthy ? 1 : 0}`);

    add('# HELP yj_http_requests_total HTTP 请求数');
    add('# TYPE yj_http_requests_total counter');
    for (const [key, value] of this.requests) {
      const [scope, status] = key.split('|');
      add(`yj_http_requests_total{scope="${scope}",status="${status}"} ${value}`);
    }

    add('# HELP yj_http_request_duration_seconds HTTP 请求耗时分布');
    add('# TYPE yj_http_request_duration_seconds histogram');
    for (const [scope, stat] of this.durations) {
      stat.buckets.forEach((count, index) => {
        add(`yj_http_request_duration_seconds_bucket{scope="${scope}",le="${BUCKETS[index]}"} ${count}`);
      });
      add(`yj_http_request_duration_seconds_bucket{scope="${scope}",le="+Inf"} ${stat.count}`);
      add(`yj_http_request_duration_seconds_sum{scope="${scope}"} ${stat.sum.toFixed(3)}`);
      add(`yj_http_request_duration_seconds_count{scope="${scope}"} ${stat.count}`);
    }

    // 业务侧指标依赖数据库，采集失败时不要让整个 /metrics 挂掉
    try {
      const metrics = this.securityMetrics();
      if (metrics) {
        add('# HELP yj_security_scan_active 正在执行的扫描数');
        add('# TYPE yj_security_scan_active gauge');
        add(`yj_security_scan_active ${metrics.queue.active}`);
        add('# HELP yj_security_scan_queued 排队中的扫描数');
        add('# TYPE yj_security_scan_queued gauge');
        add(`yj_security_scan_queued ${metrics.queue.queued}`);
        add('# HELP yj_security_advisories 已知漏洞条目数');
        add('# TYPE yj_security_advisories gauge');
        add(`yj_security_advisories ${metrics.advisories}`);
        add('# HELP yj_security_scans_recent 近 24 小时扫描数');
        add('# TYPE yj_security_scans_recent gauge');
        add(`yj_security_scans_recent ${metrics.scans}`);
      }
    } catch {
      // 数据库繁忙或未初始化时静默跳过业务指标
    }

    // B6：隔离区规模与超期积压，用于容量与销毁流程监控
    try {
      const quarantine = await this.security.quarantineStats();
      add('# HELP yj_quarantine_pending 待人工复核的隔离样本数');
      add('# TYPE yj_quarantine_pending gauge');
      add(`yj_quarantine_pending ${quarantine.pending}`);
      add('# HELP yj_quarantine_expired 已超过保留期但尚未销毁的隔离样本数');
      add('# TYPE yj_quarantine_expired gauge');
      add(`yj_quarantine_expired ${quarantine.expired}`);
      add('# HELP yj_quarantine_bytes 隔离区占用字节数');
      add('# TYPE yj_quarantine_bytes gauge');
      add(`yj_quarantine_bytes ${quarantine.bytes}`);
      add('# HELP yj_quarantine_last_purge_timestamp_seconds 最近一次真正执行超期销毁的时间，0 表示从未执行');
      add('# TYPE yj_quarantine_last_purge_timestamp_seconds gauge');
      add(
        `yj_quarantine_last_purge_timestamp_seconds ${
          quarantine.lastPurgeAt ? Math.floor(Date.parse(quarantine.lastPurgeAt) / 1000) : 0
        }`,
      );
    } catch {
      // 隔离区不可读时跳过，避免拖垮整轮采集
    }

    return `${lines.join('\n')}\n`;
  }

  constructor(
    private readonly security: SecurityService,
    private readonly disk: DiskGuardService,
    private readonly clock: ClockService,
  ) {}

  private securityMetrics(): { queue: { active: number; queued: number }; advisories: number; scans: number } {
    return this.security.metrics(1);
  }
}

/** HTTP 指标中间件：在响应结束时按类别与状态码聚合 */
export function metricsMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: () => void): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      metrics.record(scopeOf(req), res.statusCode, seconds);
    });
    next();
  };
}

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    const token = getConfig().metrics.token;
    if (token && !sameToken(authorization, `Bearer ${token}`)) {
      throw new UnauthorizedException('metrics 采集令牌无效');
    }
    return this.metrics.render();
  }
}

/** 定长比较，避免通过响应时间推断令牌 */
function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Prometheus 文本标签转义，防止 NTP_SERVER 中的引号破坏抓取 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

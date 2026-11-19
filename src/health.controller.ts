import { Controller, Get } from '@nestjs/common';
import { getConfig } from './config/config';
import { ClockService } from './common/clock.service';
import { DiskGuardService } from './common/disk-guard.service';
import { DatabaseService } from './db/database.service';
import { SecurityService } from './security/security.service';

@Controller('api/v1')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly disk: DiskGuardService,
    private readonly clock: ClockService,
    private readonly security: SecurityService,
  ) {}

  @Get('health')
  async health() {
    const cfg = getConfig();
    // 只统计仍有在用版本的包：版本全部删除后包壳虽在，但对客户端已不可见
    const packageCount =
      this.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM packages p WHERE p.status = 'active'
         AND EXISTS (SELECT 1 FROM package_versions v WHERE v.package_id = p.id AND v.status = 'active')`,
      )?.c ?? 0;
    return {
      status: 'ok',
      env: cfg.envName,
      port: cfg.port,
      dataDir: cfg.dataDir,
      // CLI 接入地址：登录页与控制台展示的唯一来源，拆分端口部署时三个地址各自独立
      endpoints: {
        console: `${cfg.publicBaseUrl}/`,
        npm: `${cfg.npmBaseUrl}/npm/`,
        pypi: `${cfg.pypiBaseUrl}/pypi/simple/`,
      },
      packages: Number(packageCount),
      // 只读模式下仍返回 200，便于探针与人工排查；写接口由 DiskWriteGuard 返回 507
      storage: this.disk.snapshot(),
      // 未配置 NTP_SERVER 时 offsetMs 与 healthy 均为 null
      clock: this.clock.snapshot(),
      // 探针高频调用，不统计占用字节（避免递归遍历隔离目录）
      quarantine: await this.security.quarantineStats(false),
      time: new Date().toISOString(),
    };
  }
}

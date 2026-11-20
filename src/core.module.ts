import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { AuthService } from './auth/auth.service';
import { ClockService } from './common/clock.service';
import { DiskGuardService, DiskWriteGuard } from './common/disk-guard.service';
import { ShutdownService } from './common/shutdown.service';
import { DatabaseService } from './db/database.service';
import { DictionaryService } from './dictionary/dictionary.service';
import { HealthController } from './health.controller';
import { MetricsController, MetricsService } from './metrics/metrics';
import { ManualService } from './manual/manual.service';
import { MissingService } from './missing/missing.service';
import { PackagesService } from './packages/packages.service';
import { SecurityService } from './security/security.service';
import { VulnerabilityService } from './security/vuln.service';
import { StorageService } from './storage/storage.service';
import { TelemetryService } from './telemetry/telemetry.service';

/**
 * 三个进程角色共用的基础设施：数据库、存储、安全扫描、认证、审计与指标。
 * 一个进程只会实例化一份（三个角色模块都 import 本模块，Nest 按类去重）。
 */
const SHARED = [
  DiskGuardService,
  ShutdownService,
  ClockService,
  DatabaseService,
  DictionaryService,
  ManualService,
  StorageService,
  AuditService,
  TelemetryService,
  AuthService,
  PackagesService,
  MissingService,
  VulnerabilityService,
  SecurityService,
  MetricsService,
];

@Global()
@Module({
  // 健康检查与指标留在共享层：npm / pypi 进程也要能被探针与 Prometheus 采到
  controllers: [HealthController, MetricsController],
  providers: [...SHARED, { provide: APP_GUARD, useClass: DiskWriteGuard }],
  exports: SHARED,
})
export class CoreModule {}

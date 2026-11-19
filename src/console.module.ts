import { Module } from '@nestjs/common';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { CertificatesModule } from './certificates/certificates.module';
import { CoreModule } from './core.module';
import { DictionaryController } from './dictionary/dictionary.controller';
import { ImportController } from './import/import.controller';
import { ImportService } from './import/import.service';
import { BackupScheduler } from './maintenance/backup.scheduler';
import { BackupService } from './maintenance/backup.service';
import { RetentionScheduler } from './maintenance/retention.scheduler';
import { RetentionService } from './maintenance/retention.service';
import { MissingController } from './missing/missing.controller';
import { PackagesController } from './packages/packages.controller';
import { SecurityController } from './security/security.controller';
import { SecurityScheduler } from './security/scheduler';

/**
 * 控制台进程：Web 界面、账号/权限、导入、审计与安全复核。
 * 后台任务（定期复检、隔离区销毁、扫描恢复）只在本角色启用，保证全平台单实例执行。
 */
@Module({
  imports: [CoreModule, CertificatesModule],
  controllers: [
    AuthController,
    PackagesController,
    ImportController,
    MissingController,
    AuditController,
    SecurityController,
    DictionaryController,
  ],
  providers: [
    ImportService,
    SecurityScheduler,
    RetentionService,
    RetentionScheduler,
    BackupService,
    BackupScheduler,
  ],
})
export class ConsoleModule {}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { ApiError } from '../common/errors';
import { clientIp } from '../common/http.util';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { PackagesService } from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';
import { SecurityService } from './security.service';
import { VulnerabilityService } from './vuln.service';

@Controller('api/v1/security')
@UseGuards(AuthGuard)
@RequirePermission('security:read')
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly packages: PackagesService,
    private readonly vuln: VulnerabilityService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /** 无全局 security:read 时只能看自己的包 */
  private ownOnly(req: AuthedRequest): boolean {
    return !this.auth.hasPermission(req.user!, 'security:read');
  }

  @Post('maintenance/orphans')
  @RequirePermission('security:manage')
  sweepOrphans(@Body() body: { apply?: boolean }) {
    return this.security.sweepOrphans(Boolean(body?.apply));
  }

  @Get('metrics')
  @RequirePermission('security:read')
  metrics(@Query('days') days: string) {
    return this.security.metrics(days ? Number(days) : 7);
  }

  @Get('attestations')
  @RequirePermission('package:read')
  attestation(
    @Query('ecosystem') ecosystem: string,
    @Query('name') name: string,
    @Query('version') version: string,
  ) {
    if (!name) throw new ApiError('PKG_NAME_INVALID', { name });
    if (!version) throw new ApiError('PKG_VERSION_INVALID', { version });
    return this.security.attestation(ecosystem === 'pypi' ? 'pypi' : 'npm', name, version);
  }

  @Get('overview')
  @RequirePermission('security:read')
  overview() {
    return this.security.getOverview();
  }

  @Get('scans')
  @RequirePermission('security:read:own')
  scans(@Req() req: AuthedRequest, @Query() query: Record<string, string>) {
    return this.security.listScans({
      verdict: query.verdict,
      disposition: query.disposition,
      ecosystem: query.ecosystem,
      versionId: query.versionId,
      name: query.name,
      actorId: this.ownOnly(req) ? req.user!.id : undefined,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });
  }

  @Get('scans/:id')
  @RequirePermission('security:read:own')
  scan(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (this.ownOnly(req) && !this.security.isScanOwnedBy(id, req.user!.id)) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'security:read' });
    }
    return this.security.getScan(id);
  }

  @Get('scans/:id/report')
  @RequirePermission('security:read:own')
  async report(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ): Promise<void> {
    if (this.ownOnly(req) && !this.security.isScanOwnedBy(id, req.user!.id)) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'security:read' });
    }
    const kind = format === 'csv' ? 'csv' : 'json';
    const { contentType, body } = await this.security.getReport(id, kind);
    const scan = this.security.requireScan(id);
    const filename = `security-${scan.package_name}-${scan.package_version}-${id.slice(0, 8)}.${kind}`.replace(
      /[^\w.@+-]/g,
      '_',
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // RV-31：报告属于安全数据出口，下载行为落审计（含导出格式，便于追溯数据外发范围）
    this.audit.log({
      traceId: (req as Request & { traceId?: string }).traceId,
      actorId: req.user?.id ?? null,
      actorTokenHash: req.user?.tokenId ?? null,
      action: 'security.report.download',
      resourceType: 'security_scan',
      resourceId: id,
      result: 'success',
      ip: clientIp(req),
      detail: {
        format: kind,
        package: `${scan.ecosystem}:${scan.package_name}@${scan.package_version}`,
        verdict: scan.verdict,
      },
    });
    res.send(body);
  }

  /** 扫描记录保留期清理（RV-26）：默认 dry-run 预览可清理范围，apply=true 才执行 */
  @Post('maintenance/purge-scans')
  @RequirePermission('security:manage')
  purgeScans(@Body() body: { apply?: boolean }) {
    return this.security.purgeExpiredScans(body?.apply === true);
  }

  @Get('advisories')
  @RequirePermission('security:read')
  advisories(@Query() query: Record<string, string>) {
    return this.vuln.list({
      ecosystem: query.ecosystem,
      q: query.q,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });
  }

  @Post('advisories/import')
  @RequirePermission('security:manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }))
  importAdvisories(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    let payload: unknown = body;
    if (file?.buffer) {
      try {
        payload = JSON.parse(file.buffer.toString('utf8'));
      } catch {
        throw new ApiError('SEC_ADVISORY_INVALID', { reason: '漏洞库文件不是合法 JSON' });
      }
    }
    const result = this.vuln.importAdvisories(payload);
    this.audit.log({
      actorId: req.user?.id ?? null,
      action: 'security.advisory.import',
      resourceType: 'vulnerability_advisory',
      resourceId: file?.originalname ?? 'inline',
      result: result.errors.length > 0 ? 'failure' : 'success',
      detail: { imported: result.imported, updated: result.updated, skipped: result.skipped, errors: result.errors.slice(0, 10) },
    });
    if (result.imported === 0 && result.updated === 0 && result.skipped === 0 && result.errors.length === 0) {
      throw new ApiError('SEC_ADVISORY_INVALID', { reason: '请求体为空或不包含 advisories 数组' });
    }
    return result;
  }

  @Post('rescan')
  @RequirePermission('security:manage')
  rescan(@Req() req: AuthedRequest, @Body() _body: { scope?: string }) {
    return this.security.runRescan('manual', req.user?.id ?? null);
  }

  @Get('quarantine')
  quarantine() {
    return this.security.listQuarantine();
  }

  /** 超期销毁：默认 dry-run，body.apply=true 才真正删除文件 */
  @Post('quarantine/purge')
  @RequirePermission('security:manage')
  purgeQuarantine(@Body() body: { apply?: boolean }) {
    return this.security.purgeExpiredQuarantine(Boolean(body?.apply));
  }

  /**
   * 放行单个隔离样本（RV-18 幂等）：
   * claim 原子占位 → 上传期隔离补录入库 → complete 落处置痕迹；编排失败 abandon 释放占位。
   * 重复放行已处置样本幂等返回 already=true，不再重复入库。
   */
  @Post('quarantine/:id/release')
  @RequirePermission('security:manage')
  async release(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actorId = req.user?.id ?? 'system';
    const { row, already } = this.security.claimQuarantineDisposition(id, actorId, 'release');
    if (already) return { released: true, id, already: true };

    try {
      if (!row.package_version_id) {
        // 上传期隔离：先从隔离区取出原始文件写入对象存储，再补录版本记录
        const { buffer, filename } = await this.security.readQuarantineFile(id);
        const stored = await this.storage.putObject(buffer);
        try {
          await this.packages.insertVersion(
            {
              ecosystem: row.ecosystem,
              name: row.package_name,
              version: row.package_version,
              filename,
              sha256: stored.sha256,
              sizeBytes: stored.size,
              storageKey: stored.key,
              uploaderId: req.user?.id ?? null,
              source: 'web',
              signature: this.security.signatureOfScan(row.id) ?? undefined,
            },
            { skipSecurityScan: true },
          );
        } catch (err) {
          // 版本已存在说明历史放行曾完成入库但未落处置痕迹，视为已入库继续闭环
          if (!(err instanceof ApiError && err.code === 'PKG_VERSION_DUPLICATE')) throw err;
        }
      }
      await this.security.completeQuarantineDisposition(id, actorId, 'release', row);
      return { released: true, id };
    } catch (err) {
      this.security.abandonQuarantineClaim(id);
      throw err;
    }
  }

  /** 批量放行（RV-17）：一次处置分组内多个样本，逐条独立幂等，单条失败不影响其余 */
  @Post('quarantine/release')
  @RequirePermission('security:manage')
  async releaseBatch(@Req() req: AuthedRequest, @Body() body: { ids?: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100) : [];
    if (ids.length === 0) throw new ApiError('SYS_VALIDATION', { field: 'ids' });

    const results: { id: string; released: boolean; already?: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        const outcome = await this.release(req, id);
        results.push({ id, released: true, ...(outcome.already ? { already: true } : {}) });
      } catch (err) {
        results.push({ id, released: false, error: err instanceof ApiError ? err.code : 'SYS_INTERNAL' });
      }
    }
    return { results, releasedCount: results.filter((item) => item.released).length };
  }

  @Delete('quarantine/:id')
  @RequirePermission('security:manage')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actorId = req.user?.id ?? 'system';
    const { row, already } = this.security.claimQuarantineDisposition(id, actorId, 'delete');
    if (already) return { deleted: true, id, already: true };
    try {
      await this.security.completeQuarantineDisposition(id, actorId, 'delete', row);
      return { deleted: true, id };
    } catch (err) {
      this.security.abandonQuarantineClaim(id);
      throw err;
    }
  }
}

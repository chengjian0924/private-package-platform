import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { ApiError } from '../common/errors';
import { clientIp, randomToken } from '../common/http.util';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { getConfig } from '../config/config';
import type { Ecosystem } from '../packages/packages.service';
import { MissingService } from './missing.service';

/** 补包上传先落磁盘，避免大包整块驻留内存（B1） */
function diskTmpStorage() {
  return diskStorage({
    destination: (_req, _file, cb) => {
      const dir = getConfig().tmpDir;
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}-${randomToken(6)}`),
  });
}

@Controller('api/v1')
@UseGuards(AuthGuard)
export class MissingController {
  constructor(
    private readonly service: MissingService,
    private readonly audit: AuditService,
  ) {}

  /** 下游项目/流水线上报依赖清单，命中私有源中不存在的包时登记为缺失 */
  @Post('dependency-reports')
  @RequirePermission('import:run')
  report(
    @Req() req: AuthedRequest,
    @Body() body: { projectId?: string; ecosystem?: Ecosystem; dependencies?: { name: string; versionSpec?: string }[] },
  ) {
    if (!body?.ecosystem || !['npm', 'pypi'].includes(body.ecosystem)) {
      throw new ApiError('SYS_VALIDATION', { field: 'ecosystem' });
    }
    if (!Array.isArray(body.dependencies) || body.dependencies.length === 0) {
      throw new ApiError('SYS_VALIDATION', { field: 'dependencies' });
    }
    const result = this.service.report({
      projectId: body.projectId,
      ecosystem: body.ecosystem,
      dependencies: body.dependencies,
    });
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      // CI 用机器账号令牌上报，必须落令牌哈希，审计才能按令牌名反查是哪个项目
      actorTokenHash: req.user!.tokenId ?? null,
      action: 'missing.report',
      resourceType: 'dependency_report',
      resourceId: body.projectId || 'unknown',
      result: 'success',
      ip: clientIp(req),
      detail: { ecosystem: body.ecosystem, created: result.created, updated: result.updated },
    });
    return result;
  }

  @Get('missing-dependencies')
  @RequirePermission('package:read')
  list(@Query() query: Record<string, string>) {
    return this.service.list({
      status: query.status,
      ecosystem: query.ecosystem,
      source: query.source,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });
  }

  @Get('missing-dependencies/:id')
  @RequirePermission('package:read')
  detail(@Param('id') id: string) {
    return this.service.getById(id);
  }

  /** 员工补包：上传文件后自动完成校验与入库，并关闭缺失记录 */
  @Post('missing-dependencies/:id/supplement')
  @RequirePermission('missing:supplement')
  @UseInterceptors(FileInterceptor('file', { storage: diskTmpStorage(), limits: { fileSize: 200 * 1024 * 1024 } }))
  async supplement(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { name?: string; version?: string; requiresPython?: string },
  ) {
    if (!file) throw new ApiError('UPLOAD_EMPTY', { field: 'file' });
    try {
      const result = await this.service.supplement(id, {
        path: file.path,
        filename: file.originalname,
        name: body?.name,
        version: body?.version,
        requiresPython: body?.requiresPython,
        uploaderId: req.user!.id,
      });
      this.audit.log({
        traceId: req.traceId,
        actorId: req.user!.id,
        actorTokenHash: req.user!.tokenId ?? null,
        action: 'missing.supplement',
        resourceType: 'missing_dependency',
        resourceId: id,
        result: 'success',
        ip: clientIp(req),
        detail: { filename: file.originalname, versionId: result.versionId },
      });
      return result;
    } catch (err) {
      this.audit.log({
        traceId: req.traceId,
        actorId: req.user!.id,
        actorTokenHash: req.user!.tokenId ?? null,
        action: 'missing.supplement',
        resourceType: 'missing_dependency',
        resourceId: id,
        result: 'failure',
        ip: clientIp(req),
        detail: { filename: file.originalname, error: err instanceof ApiError ? err.code : 'SYS_INTERNAL' },
      });
      throw err;
    } finally {
      await fsp.rm(file.path, { force: true }).catch(() => undefined);
    }
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import AdmZip from 'adm-zip';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ApiError } from '../common/errors';
import { clientIp, randomToken } from '../common/http.util';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { getConfig } from '../config/config';
import { ImportService, type UploadFileInput } from './import.service';

/** 上传先落磁盘再处理：避免多文件同时驻留内存（B1） */
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

@Controller('api/v1/import-batches')
@UseGuards(AuthGuard)
export class ImportController {
  constructor(
    private readonly service: ImportService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 只上传包：不提供清单，由服务端从包文件识别 name/version 自动建批次。
   * 与清单流程共用后续校验与入库，安全扫描不跳过。
   */
  @Post('auto')
  @RequirePermission('import:run')
  @UseInterceptors(
    AnyFilesInterceptor({ storage: diskTmpStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 200 } }),
  )
  async createFromFiles(@Req() req: AuthedRequest, @UploadedFiles() files: Express.Multer.File[] = []) {
    if (!files.length) throw new ApiError('UPLOAD_EMPTY', { field: 'files' });
    const tempPaths = new Set(files.map((file) => file.path));

    try {
      // zip 压缩包在此展开一层：条目落临时目录后与普通文件走同一识别流程
      const expanded: UploadFileInput[] = [];
      let totalBytes = 0;
      const maxBytes = getConfig().limits.maxUploadBytes;
      for (const file of files) {
        totalBytes += file.size;
        if (totalBytes > maxBytes) {
          throw new ApiError('UPLOAD_FILE_TOO_LARGE', {
            reason: `本次请求上传总大小超过 ${maxBytes} 字节上限`,
          });
        }
        if (!/\.zip$/i.test(file.originalname)) {
          expanded.push({ filename: file.originalname, path: file.path });
          continue;
        }
        let zip: AdmZip;
        try {
          zip = new AdmZip(file.path);
          if (zip.getEntries().length > 2000) {
            throw new ApiError('UPLOAD_FILE_TOO_LARGE', { reason: '压缩包条目过多' });
          }
        } catch (err) {
          if (err instanceof ApiError) throw err;
          throw new ApiError('UPLOAD_UNSUPPORTED_TYPE', { filename: file.originalname, reason: 'zip 解析失败' });
        }
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const data = entry.getData();
          totalBytes += data.length;
          if (totalBytes > maxBytes) {
            throw new ApiError('UPLOAD_FILE_TOO_LARGE', { reason: '压缩包解压后超过上限' });
          }
          // 逐条落盘，避免解压结果整体驻留内存
          const tmpPath = path.join(getConfig().tmpDir, `upload-${Date.now()}-${randomToken(6)}`);
          await fsp.writeFile(tmpPath, data);
          tempPaths.add(tmpPath);
          expanded.push({ filename: entry.entryName.split('/').pop() || entry.entryName, path: tmpPath });
        }
      }

      const result = await this.service.createBatchFromFiles({
        files: expanded,
        operatorId: req.user!.id,
      });
      // 幂等命中时批次是复用的，审计里标出来，避免「一次上传两条创建记录」看起来像重复提交成功
      const deduplicated = 'deduplicated' in result && result.deduplicated === true;
      this.audit.log({
        traceId: req.traceId,
        actorId: req.user!.id,
        action: 'import.batch.create',
        resourceType: 'import_batch',
        resourceId: result.batchId,
        result: 'success',
        ip: clientIp(req),
        detail: {
          mode: 'auto',
          uploaded: files.length,
          expanded: expanded.length,
          preview: result.preview,
          failed: result.failed,
          deduplicated,
        },
      });
      return result;
    } finally {
      await Promise.all([...tempPaths].map((tmpPath) => fsp.rm(tmpPath, { force: true }).catch(() => undefined)));
    }
  }

  @Post(':id/validate')
  @RequirePermission('import:run')
  async validate(@Req() req: AuthedRequest, @Param('id') id: string) {
    const result = await this.service.validate(id);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'import.batch.validate',
      resourceType: 'import_batch',
      resourceId: id,
      result: 'success',
      ip: clientIp(req),
      detail: result.stats,
    });
    return result;
  }

  @Post(':id/commit')
  @RequirePermission('import:run')
  async commit(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { mode?: 'partial' | 'strict' },
  ) {
    const mode = body?.mode === 'strict' ? 'strict' : 'partial';
    const result = await this.service.commit(id, mode, req.user!.id);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'import.batch.commit',
      resourceType: 'import_batch',
      resourceId: id,
      result: result.stats.failed > 0 ? 'failure' : 'success',
      ip: clientIp(req),
      detail: result.stats,
    });
    return result;
  }

  @Get(':id')
  @RequirePermission('package:read')
  getBatch(@Param('id') id: string) {
    return this.service.getBatch(id);
  }

  @Get(':id/report')
  @RequirePermission('package:read')
  async getReport(
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ): Promise<void> {
    const type = format === 'csv' ? 'csv' : 'json';
    const report = await this.service.getReport(id, type);
    res.setHeader('Content-Type', report.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="import-report-${id}.${type}"`,
    );
    res.send(report.body);
  }
}

import {
  All,
  Controller,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ApiError } from '../common/errors';
import { clientIp, parseBasicAuth, bearerToken, randomToken } from '../common/http.util';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config/config';
import { MissingService } from '../missing/missing.service';
import { parseSdistFilename, parseWheelFilename, validatePypiPackage } from '../packages/package-validator';
import { PackagesService } from '../packages/packages.service';
import { StorageService } from '../storage/storage.service';

/** twine 上传先落磁盘，避免 200MB 包整块驻留内存（B1） */
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

/**
 * PyPI 兼容接口：PEP 503 Simple API + twine legacy 上传。
 * pip 安装走 /pypi/simple/，twine 上传走 /pypi/legacy/。
 */
@Controller()
export class RegistryPypiController {
  constructor(
    private readonly packages: PackagesService,
    private readonly storage: StorageService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly missing: MissingService,
  ) {}

  /** 拉取失败（404）时静默登记缺失依赖；异常由 MissingService 吞掉，不影响 pip 收到的响应 */
  private noteMiss(req: Request, name: string, versionSpec: string): void {
    this.missing.reportRegistryMiss({
      ecosystem: 'pypi',
      name,
      versionSpec,
      ip: clientIp(req),
      userAgent: req.header('user-agent') || '',
      authPresent: Boolean(req.header('authorization') || req.header('cookie')),
    });
  }

  @All('pypi/*')
  @UseInterceptors(
    FilesInterceptor('file', 10, {
      storage: diskTmpStorage(),
      // 硬天花板启动时固定；运行时的业务上限在 upload() 里按字典值校验
      limits: { fileSize: getConfig().limits.maxPypiPublishBytes },
    }),
  )
  async handle(
    @Req() req: Request,
    @Res() res: Response,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<void> {
    let sub: string;
    try {
      sub = decodeURIComponent(req.path.slice('/pypi'.length));
    } catch {
      res.status(400).send('bad request');
      return;
    }

    if (sub === '/simple') {
      res.redirect('/pypi/simple/');
      return;
    }

    if (sub === '/simple/') {
      res.type('text/html').send(this.indexPage());
      return;
    }

    if (sub.startsWith('/simple/')) {
      const name = sub.slice('/simple/'.length).replace(/\/$/, '');
      try {
        res.type('text/html').send(this.projectPage(name));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PKG_NOT_FOUND') this.noteMiss(req, name, '*');
        throw err;
      }
      return;
    }

    if ((sub === '/legacy' || sub === '/legacy/') && req.method === 'POST') {
      await this.upload(req, res, files || []);
      return;
    }

    if (sub.startsWith('/packages/')) {
      const filename = sub.slice('/packages/'.length).replace(/^\//, '');
      const version = this.packages.findVersionByFilename('pypi', filename);
      if (!version) {
        // 缺包上报只认「能解析出包名与版本、且该版本本地确实不存在」的请求：
        // - 文件名解析不出的（favicon 探测、残缺路径）不是依赖，登记只会污染待补列表；
        // - 版本已入库但文件名不同（pip 探测另一个平台标签的 wheel 变体）不是缺包，
        //   真实缺的是这个构件而已，登记成「缺这个版本」反而是假阳性。
        const parsed = parseWheelFilename(filename) ?? parseSdistFilename(filename);
        if (parsed && !this.packages.findVersion('pypi', parsed.name, parsed.version)) {
          this.noteMiss(req, parsed.name, parsed.version);
        }
        throw new ApiError('PKG_NOT_FOUND', { filename });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(version.size_bytes));
      res.setHeader('ETag', `"${version.sha256}"`);
      const badge = this.packages.securityBadge(version.id);
      if (badge) res.setHeader('X-Package-Security', badge.status);
      res.sendFile(this.storage.absolutePath(version.storage_key));
      return;
    }

    res.status(404).send('not found');
  }

  private indexPage(): string {
    const names = this.packages.listPackageNames('pypi');
    const links = names
      .map((name) => `<a href="/pypi/simple/${encodeURIComponent(name)}/">${this.escape(name)}</a>`)
      .join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Simple index</title></head><body>\n${links}\n</body></html>`;
  }

  private projectPage(name: string): string {
    const pkg = this.packages.findPackage('pypi', name);
    if (!pkg) throw new ApiError('PKG_NOT_FOUND', { name });
    const versions = this.packages.versionsOf(pkg.id);
    const links = versions
      .map(
        (v) =>
          `<a href="/pypi/packages/${encodeURIComponent(v.filename)}#sha256=${v.sha256}">${this.escape(v.filename)}</a><br/>`,
      )
      .join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Links for ${this.escape(
      pkg.normalized_name,
    )}</title></head><body><h1>Links for ${this.escape(pkg.normalized_name)}</h1>\n${links}\n</body></html>`;
  }

  private async resolveUser(req: Request) {
    const bearer = bearerToken(req.header('authorization'));
    if (bearer) {
      const user = this.auth.resolveApiToken(bearer);
      if (user) return user;
    }
    const basic = parseBasicAuth(req.header('authorization'));
    if (basic) {
      return this.auth.resolveApiToken(basic.password) ?? (await this.auth.verifyBasicCredentials(basic.username, basic.password));
    }
    return null;
  }

  private async upload(req: Request, res: Response, files: Express.Multer.File[]): Promise<void> {
    const user = await this.resolveUser(req);
    if (!user) throw new ApiError('AUTH_UNAUTHENTICATED');
    // 初始密码未修改前禁止上传，拦截 registry 这条旁路
    if (user.mustChangePassword) throw new ApiError('AUTH_PASSWORD_CHANGE_REQUIRED');
    if (!this.auth.hasPermission(user, 'package:publish')) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'package:publish' });
    }

    const file = files[0];
    try {
      const body = (req.body || {}) as Record<string, string>;
      if (body[':action'] && body[':action'] !== 'file_upload') {
        throw new ApiError('SYS_VALIDATION', { field: ':action', value: body[':action'] });
      }
      // twine 每次请求只上传一个 distribution。多余文件既不会被处理，若静默忽略则
      // 临时文件永不清理、业务大小上限也绕过（仅 files[0] 被校验），故显式拒绝。
      if (files.length > 1) throw new ApiError('UPLOAD_MULTIPLE_FILES', { received: files.length });
      if (!file) throw new ApiError('UPLOAD_EMPTY', { field: 'file' });
      if (!body.name || !body.version) throw new ApiError('SYS_VALIDATION', { fields: ['name', 'version'] });
      // 业务上限取自字典（可运行时调整），与 multer 的启动期硬天花板分层
      const maxBytes = getConfig().limits.maxPypiUploadBytes;
      if (file.size > maxBytes) {
        throw new ApiError('UPLOAD_FILE_TOO_LARGE', { filename: file.originalname, maxBytes });
      }

      const existing = this.packages.findVersion('pypi', body.name, body.version);
      // 校验需要完整字节；校验完成后释放，入库按临时文件流式写入，避免二次整包驻留
      const outcome = validatePypiPackage({
        buffer: await fsp.readFile(file.path),
        filename: file.originalname,
        name: body.name,
        version: body.version,
        declaredSha256: body.sha256_digest,
        existsInRegistry: Boolean(existing),
        targets: { python: body.python_version || undefined },
        requiresPython: body.requires_python || body.requires_dist || undefined,
      });

      if (outcome.status === 'invalid') {
        throw new ApiError('PKG_TARBALL_INVALID', {
          issues: outcome.issues,
        }, `包校验失败：${outcome.issues.map((i) => i.message).join('；')}`);
      }

      const stored = await this.storage.putObjectFromFile(file.path);
      const version = await this.packages.insertVersion({
        ecosystem: 'pypi',
        name: body.name,
        version: body.version,
        filename: file.originalname,
        sha256: stored.sha256,
        sizeBytes: stored.size,
        storageKey: stored.key,
        metadata: {
          summary: body.summary || '',
          requiresPython: body.requires_python || null,
          filetype: body.filetype || null,
          kind: outcome.metadata.kind,
          dist: { shasum: stored.shasum, integrity: stored.integrity },
        },
        compatibility: outcome.compatibility,
        uploaderId: user.id,
        source: 'cli',
        // twine 无签名字段；如调用方额外提交 signature（base64 分离签名）则参与验签
        signature: body.signature || undefined,
      });

      this.audit.log({
        traceId: (req as Request & { traceId?: string }).traceId,
        actorId: user.id,
        actorTokenHash: user.tokenId ?? null,
        action: 'package.publish',
        resourceType: 'package',
        resourceId: `${body.name}@${body.version}`,
        result: 'success',
        ip: clientIp(req),
        detail: { ecosystem: 'pypi', filename: file.originalname, versionId: version.id },
      });

      res.status(200).send('OK');
    } finally {
      // 必须清理本次请求落盘的全部临时文件，而非只删 files[0]：
      // multer 会先把所有 multipart 文件写盘，多文件被拒绝后其余文件同样会残留。
      for (const item of files) {
        if (item?.path) await fsp.rm(item.path, { force: true }).catch(() => undefined);
      }
    }
  }

  private escape(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => {
      const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[ch];
    });
  }
}

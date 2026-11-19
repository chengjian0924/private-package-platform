import { All, Controller, Headers, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as semver from 'semver';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ApiError } from '../common/errors';
import { clientIp, parseCookies, parseBasicAuth, bearerToken } from '../common/http.util';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config/config';
import { MissingService, versionFromMissedFilename } from '../missing/missing.service';
import { PackagesService, type InsertVersionInput } from '../packages/packages.service';
import { SecurityService, type GateResult } from '../security/security.service';
import { StorageService } from '../storage/storage.service';

interface PublishAttachment {
  data?: string;
  content?: string;
  length?: number;
}

/**
 * npm publish 的附件是 JSON 里的 base64，无法直接流式落盘；
 * 按 4 字符对齐分块解码写入临时文件，避免整段解码缓冲（B1）。
 */
async function decodeBase64ToFile(encoded: string, destPath: string): Promise<void> {
  const chunkSize = 4 * 1024 * 1024; // 必须是 4 的倍数，保证每组 3 字节对齐
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const handle = await fsp.open(destPath, 'w');
  try {
    for (let offset = 0; offset < encoded.length; offset += chunkSize) {
      const piece = Buffer.from(encoded.slice(offset, offset + chunkSize), 'base64');
      await handle.write(piece);
    }
  } finally {
    await handle.close();
  }
}

/**
 * npm registry 协议实现（catch-all 路由以兼容 @scope/name 与 tarball 路径）。
 * 支持：ping / whoami / search / login / publish / packument / tarball。
 */
@Controller()
export class RegistryNpmController {
  constructor(
    private readonly packages: PackagesService,
    private readonly storage: StorageService,
    private readonly security: SecurityService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly missing: MissingService,
  ) {}

  /** 拉取失败（404）时静默登记缺失依赖；任何异常都被 MissingService 吞掉，绝不影响协议响应 */
  private noteMiss(req: Request, name: string, versionSpec: string): void {
    this.missing.reportRegistryMiss({
      ecosystem: 'npm',
      name,
      versionSpec,
      ip: clientIp(req),
      userAgent: req.header('user-agent') || '',
      // 私有 scope 的鉴权失败也表现为 404，标注出来供管理端区分“缺包”与“无权限”
      authPresent: Boolean(req.header('authorization') || req.header('cookie')),
    });
  }

  private resolveUser(req: Request) {
    const cookies = parseCookies(req.header('cookie'));
    const sid = cookies['yj_sid'];
    if (sid) {
      const user = this.auth.resolveSession(sid);
      if (user) return user;
    }
    const bearer = bearerToken(req.header('authorization'));
    if (bearer) {
      const user = this.auth.resolveApiToken(bearer);
      if (user) return user;
    }
    const basic = parseBasicAuth(req.header('authorization'));
    if (basic) {
      // 非登录请求的 Basic 只认 API Token：口令校验走 scrypt 较慢，不宜挂在每次 packument 拉取上
      return this.auth.resolveApiToken(basic.password);
    }
    return null;
  }

  @All('npm/*')
  async handle(@Req() req: Request, @Res() res: Response, @Headers() _headers: Record<string, string>): Promise<void> {
    let sub: string;
    try {
      sub = decodeURIComponent(req.path.slice('/npm'.length));
    } catch {
      res.status(400).json({ error: 'PKG_NAME_INVALID' });
      return;
    }

    if (sub === '/-/ping' || sub === '/-/ping/') {
      res.json({});
      return;
    }

    if (sub === '/-/whoami') {
      const user = this.resolveUser(req);
      if (!user) throw new ApiError('AUTH_UNAUTHENTICATED');
      res.json({ username: user.username });
      return;
    }

    if (sub.startsWith('/-/v1/search')) {
      const query = String(req.query.text || '');
      const objects = this.packages.searchNpm(query);
      res.json({ objects, total: objects.length, time: new Date().toISOString() });
      return;
    }

    // npm audit 等旁路接口：返回空结果，保证 install 流程不被阻断
    if (sub.startsWith('/-/npm/v1/security/')) {
      res.json({});
      return;
    }

    if (sub.startsWith('/-/user/') && (req.method === 'PUT' || req.method === 'POST')) {
      await this.login(req, res, sub);
      return;
    }

    const marker = sub.indexOf('/-/');
    if (marker > 0) {
      const name = sub.slice(1, marker);
      const filename = sub.slice(marker + 3).replace(/^\//, '');
      this.download(req, res, name, filename);
      return;
    }

    if (req.method === 'PUT') {
      await this.publish(req, res, sub.slice(1));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const name = sub.replace(/^\//, '');
      if (!name) throw new ApiError('PKG_NOT_FOUND');
      let doc;
      try {
        doc = this.packages.packument(name);
      } catch (err) {
        // 只有“包不存在”才登记；其他异常（如数据损坏）照常抛出，不制造假缺失记录
        if (err instanceof ApiError && err.code === 'PKG_NOT_FOUND') this.noteMiss(req, name, '*');
        throw err;
      }
      res.json(doc);
      return;
    }

    res.status(405).json({ error: 'unsupported_method' });
  }

  private async login(req: Request, res: Response, sub: string): Promise<void> {
    const body = (req.body || {}) as { name?: string; password?: string };
    const username = (body.name || sub.replace('/-/user/org.couchdb.user:', '')).replace(/^org\.couchdb\.user:/, '');
    if (!username || !body.password) throw new ApiError('AUTH_UNAUTHENTICATED', { reason: 'missing_credentials' });

    const user =
      (await this.auth.verifyBasicCredentials(username, body.password)) ??
      this.auth.resolveApiToken(body.password);
    if (!user) throw new ApiError('AUTH_TOKEN_INVALID');
    // 首登未改密的账号不发放 CLI 令牌，避免绕过 Web 端强制改密
    if (user.mustChangePassword) throw new ApiError('AUTH_PASSWORD_CHANGE_REQUIRED');

    const token = this.auth.createApiToken(user.id, `npm-cli-${user.username}`);
    this.audit.log({
      traceId: (req as Request & { traceId?: string }).traceId,
      actorId: user.id,
      action: 'auth.npm_login',
      resourceType: 'user',
      resourceId: user.id,
      result: 'success',
      ip: clientIp(req),
    });
    res.status(201).json({ ok: true, id: `org.couchdb.user:${username}`, token: token.token });
  }

  private download(req: Request, res: Response, name: string, filename: string): void {
    const version = this.packages.findVersionByFilename('npm', filename);
    if (!version) {
      this.noteMiss(req, name, versionFromMissedFilename('npm', filename));
      throw new ApiError('PKG_NOT_FOUND', { filename });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(version.size_bytes));
    res.setHeader('ETag', `"${version.sha256}"`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // 消费方下载时即可看到安全校验结论，避免只信任管理端
    const badge = this.packages.securityBadge(version.id);
    if (badge) res.setHeader('X-Package-Security', badge.status);
    res.sendFile(this.storage.absolutePath(version.storage_key));
  }

  /**
   * npm publish 两阶段实现（RV-22 原子发布）：
   * 阶段一逐版本预检（解码 → 大小 → SRI → 查重 → 预扫描），任一失败直接拒绝、未写入任何版本；
   * 阶段二在单事务内写入全部版本，失败整体回滚，只可能留下可被孤儿清扫回收的对象文件。
   * SEC_* 错误统一抛给全局 filter，registry 错误体会透出 scanId/findings/remediation 供上传者整改。
   */
  private async publish(req: Request, res: Response, rawName: string): Promise<void> {
    const user = this.resolveUser(req);
    if (!user) throw new ApiError('AUTH_UNAUTHENTICATED');
    // 初始密码未修改前禁止发布，拦截 registry 这条旁路
    if (user.mustChangePassword) throw new ApiError('AUTH_PASSWORD_CHANGE_REQUIRED');
    if (!this.auth.hasPermission(user, 'package:publish')) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'package:publish' });
    }

    const body = (req.body || {}) as {
      name?: string;
      _id?: string;
      description?: string;
      versions?: Record<string, Record<string, unknown>>;
      _attachments?: Record<string, PublishAttachment>;
      'dist-tags'?: Record<string, string>;
      signature?: unknown;
    };
    const name = body.name || body._id || rawName;
    if (!name) throw new ApiError('PKG_NAME_INVALID');

    const versions = body.versions || {};
    const attachments = body._attachments || {};
    const versionKeys = Object.keys(versions);
    if (versionKeys.length === 0) throw new ApiError('SYS_VALIDATION', { field: 'versions' });

    // npm 协议本身不带签名，允许发布方在文档根节点附加 signature 字段做可选验签
    const declaredSignature = typeof body.signature === 'string' ? body.signature : undefined;
    const basename = name.split('/').pop()!;
    const traceId = (req as Request & { traceId?: string }).traceId;

    // 查重前置到预检：多版本场景下任何一个版本重复，整个发布在扫描前就被拒绝
    for (const version of versionKeys) {
      this.packages.assertNotDuplicate('npm', name, version);
    }

    const consumedAttachments = new Set<string>();
    const prepared: { input: InsertVersionInput; gate: GateResult | null }[] = [];
    const tmpPaths: string[] = [];
    try {
      for (const version of versionKeys) {
        const meta = versions[version] as {
          description?: string;
          engines?: Record<string, string>;
          dependencies?: Record<string, string>;
          dist?: { integrity?: string; shasum?: string };
        };
        if (!semver.valid(version)) throw new ApiError('PKG_VERSION_INVALID', { version });

        // 附件 key 精确匹配优先（RV-23）：npm 固定 <basename>-<version>.tgz；同一附件不允许被两个版本复用
        const expectedKey = `${basename}-${version}.tgz`;
        const attachmentKey =
          attachments[expectedKey] && !consumedAttachments.has(expectedKey)
            ? expectedKey
            : (Object.keys(attachments).find((key) => !consumedAttachments.has(key) && key.endsWith(`${version}.tgz`)) ??
              Object.keys(attachments).find((key) => !consumedAttachments.has(key)));
        const attachment = attachmentKey ? attachments[attachmentKey] : undefined;
        const encoded = attachment?.data || attachment?.content;
        if (!attachmentKey || !encoded) throw new ApiError('PKG_FILE_MISSING', { version });
        consumedAttachments.add(attachmentKey);

        const tmpPath = path.join(
          getConfig().tmpDir,
          `npm-publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        tmpPaths.push(tmpPath);
        await decodeBase64ToFile(encoded, tmpPath);
        // 及时断开 base64 字符串引用，让 GC 可以回收，降低峰值内存
        delete attachments[attachmentKey];
        const size = (await fsp.stat(tmpPath)).size;
        // 业务上限取自字典（可运行时调整）；HTTP body 的硬天花板由 express.json 单点把关
        const maxBytes = getConfig().limits.maxNpmUploadBytes;
        if (size > maxBytes) {
          throw new ApiError('UPLOAD_FILE_TOO_LARGE', { version, maxBytes });
        }
        const stored = await this.storage.putObjectFromFile(tmpPath);

        // SRI 权威校验（RV-23）：integrity 一旦声明即为唯一权威，shasum 一致也不能掩盖其不匹配
        const declaredIntegrity = meta.dist?.integrity;
        const declaredSha1 = meta.dist?.shasum;
        if (declaredIntegrity && declaredIntegrity !== stored.integrity) {
          throw new ApiError('PKG_INTEGRITY_MISMATCH', { version });
        }
        if (declaredSha1 && declaredSha1 !== stored.shasum) {
          throw new ApiError('PKG_INTEGRITY_MISMATCH', { version });
        }

        // 预扫描：与单版本入库（packages.insertVersion）走同一收口，BLOCK/QUARANTINE 语义一致
        // 字典管理关闭漏洞扫描时跳过校验直接放行（管理员显式选择的 fail-open）
        let gate: GateResult | null = null;
        if (getConfig().security.scanEnabled) {
          try {
            const buffer = await fsp.readFile(tmpPath);
            gate = await this.security.scanAndGate({
              ecosystem: 'npm',
              name,
              version,
              filename: expectedKey,
              sha256: stored.sha256,
              sizeBytes: size,
              source: 'cli',
              uploaderId: user.id,
              signature: declaredSignature,
              trigger: 'upload',
              buffer,
              traceId,
            });
          } catch (err) {
            if (err instanceof ApiError) throw err;
            // 扫描失败按 fail-closed 处理，绝不放行未经校验的包
            throw new ApiError('SEC_SCAN_FAILED', { reason: (err as Error).message });
          }
          const { disposition, verdict, score, findings } = gate.outcome;
          if (disposition === 'BLOCK' || disposition === 'QUARANTINE') {
            throw new ApiError(disposition === 'BLOCK' ? 'SEC_BLOCKED' : 'SEC_QUARANTINED', {
              scanId: gate.scanId,
              package: `npm:${name}@${version}`,
              verdict,
              score,
              findings: findings.slice(0, 10),
              remediation: findings[0]?.remediation || null,
            });
          }
        }

        prepared.push({
          input: {
            ecosystem: 'npm',
            name,
            version,
            filename: expectedKey,
            sha256: stored.sha256,
            sizeBytes: stored.size,
            storageKey: stored.key,
            metadata: {
              description: meta.description || body.description || '',
              engines: meta.engines || null,
              dependencies: meta.dependencies || null,
              dist: { shasum: stored.shasum, integrity: stored.integrity },
            },
            compatibility: { engines: meta.engines || null, targets: null },
            uploaderId: user.id,
            source: 'cli',
            signature: declaredSignature,
          },
          gate,
        });
      }
    } finally {
      for (const tmpPath of tmpPaths) {
        await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      }
    }

    // 阶段二：单事务原子写入，任一失败整体回滚（RV-22）
    this.packages.insertVersionsAtomic(prepared);
    const published = prepared.map((item) => item.input.version);

    // dist-tags：自定义标签（beta/next 等）持久化；latest 始终动态计算，传入的 latest 被忽略
    const distTags = body['dist-tags'] || {};
    if (Object.keys(distTags).length > 0) {
      this.packages.mergeDistTags(name, distTags, published);
    }

    this.audit.log({
      traceId,
      actorId: user.id,
      actorTokenHash: user.tokenId ?? null,
      action: 'package.publish',
      resourceType: 'package',
      resourceId: name,
      result: 'success',
      ip: clientIp(req),
      detail: { ecosystem: 'npm', versions: published, source: 'cli', distTags },
    });

    res.status(201).json({ ok: true, id: name, rev: `1-${name}`, versions: published });
  }
}

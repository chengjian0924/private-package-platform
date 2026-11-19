import { All, Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/errors';
import { clientIp, parseCookies } from '../common/http.util';
import { getConfig } from '../config/config';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, RequirePermission, type AuthedRequest } from './auth.guard';
import { AuthService, type BatchUserInput, type Role } from './auth.service';
import { MAX_BATCH_USERS, buildUserImportTemplate, parseUserImportFile } from './batch-import.util';

interface LoginBody {
  username?: string;
  password?: string;
}

interface CreateUserBody {
  username?: string;
  displayName?: string;
  email?: string;
  role?: Role;
  /** human（默认）或 service：service 为 CI/流水线机器账号，只接受访问令牌 */
  accountType?: 'human' | 'service';
}

interface BatchCreateBody {
  /** 上传文件：仅接受 .xlsx，内容为 base64 */
  fileName?: string;
  contentBase64?: string;
}

interface UpdateUserBody {
  role?: Role;
  status?: 'active' | 'disabled';
  displayName?: string;
  email?: string;
}

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** 本地账号登录：成功后下发会话 Cookie；失败/锁定记录审计后原样抛出 */
  @Post('api/v1/auth/login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const username = (body?.username || '').trim();
    if (!username || !body?.password) {
      throw new ApiError('SYS_VALIDATION', { field: 'username/password', reason: '用户名与密码均为必填' });
    }

    try {
      const result = await this.auth.login(username, body.password, {
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
      });
      res.setHeader('Set-Cookie', this.auth.sessionCookie(result.sid, result.maxAge));
      this.audit.log({
        traceId: req.traceId,
        actorId: result.user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: result.user.id,
        result: 'success',
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
        detail: { username: result.user.username, role: result.user.role },
      });
      return { user: result.user, mustChangePassword: result.user.mustChangePassword };
    } catch (err) {
      this.audit.log({
        traceId: req.traceId,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: username,
        result: 'failure',
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
        // 只记录失败类型，不记录任何口令片段
        detail: { code: (err as { code?: string }).code ?? 'AUTH_INVALID_CREDENTIALS' },
      });
      throw err;
    }
  }

  @All('auth/logout')
  logout(@Req() req: AuthedRequest, @Res() res: Response): void {
    const cookies = parseCookies(req.header('cookie'));
    const sid = cookies['yj_sid'];
    const user = sid ? this.auth.resolveSession(sid) : null;
    if (user) {
      // 全局登出：吊销该用户在所有端的会话
      const revoked = this.auth.revokeUserSessions(user.id, 'logout');
      this.audit.log({
        traceId: req.traceId,
        actorId: user.id,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: user.id,
        result: 'success',
        ip: clientIp(req),
        detail: { revokedSessions: revoked, scope: 'global' },
      });
    }
    res.setHeader('Set-Cookie', this.auth.clearSessionCookie());
    if (req.method === 'GET') {
      res.redirect('/');
    } else {
      res.json({ code: 0, message: 'ok', data: { loggedOut: true }, traceId: req.traceId });
    }
  }

  /** 首次登录/口令重置后的强制改密入口 */
  @Post('api/v1/auth/change-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async changePassword(
    @Req() req: AuthedRequest,
    @Body() body: { oldPassword?: string; newPassword?: string; confirmPassword?: string },
  ) {
    // 原密码是否必填由 service 按账号状态决定：强制首登改密不需要，主动改密必须要
    if (!body?.newPassword || body?.confirmPassword === undefined) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'newPassword/confirmPassword',
        reason: '新密码与确认密码均为必填',
      });
    }
    const sid = parseCookies(req.header('cookie'))['yj_sid'];
    // 二次确认在后端再校验一次，避免跳过前端直接调接口
    await this.auth.changePassword({
      userId: req.user!.id,
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
      currentSid: sid,
    });
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.password.change',
      resourceType: 'user',
      resourceId: req.user!.id,
      result: 'success',
      ip: clientIp(req),
    });
    return { changed: true };
  }

  @Get('api/v1/auth/me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthedRequest) {
    const user = req.user!;
    return { user, permissions: this.auth.permissionsOf(user), features: this.features() };
  }

  /**
   * 登录用户可读的功能开关：控制台据此决定侧栏模块与批量导入形态。
   * 只暴露布尔能力位，不泄露任何配置值；关闭漏洞扫描后普通用户立即不再看到安全校验入口。
   */
  @Get('api/v1/features')
  @UseGuards(AuthGuard)
  features() {
    return { securityScanEnabled: getConfig().security.scanEnabled };
  }

  @Get('api/v1/auth/permissions/check')
  @UseGuards(AuthGuard)
  checkPermission(@Req() req: AuthedRequest, @Query('permission') permission: string) {
    if (!permission) throw new ApiError('SYS_VALIDATION', { field: 'permission' });
    return { permission, allowed: this.auth.hasPermission(req.user!, permission) };
  }

  // ---------- 用户管理（admin） ----------

  @Get('api/v1/users')
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  listUsers() {
    return { items: this.auth.listUsers() };
  }

  @Post('api/v1/users')
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  async createUser(@Req() req: AuthedRequest, @Body() body: CreateUserBody) {
    const created = await this.auth.createUser({
      username: body?.username || '',
      displayName: body?.displayName,
      email: body?.email,
      role: body?.role,
      accountType: body?.accountType,
    });
    const isService = created.user.accountType === 'service';
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.user.create',
      resourceType: 'user',
      resourceId: created.user.id,
      result: 'success',
      ip: clientIp(req),
      detail: { username: created.user.username, role: created.user.role, accountType: created.user.accountType },
    });
    return {
      ...created,
      notice: isService
        ? '机器账号已创建：不支持口令登录，请在本页为其签发访问令牌'
        : '初始密码仅展示一次，请通过安全渠道转交本人，首次登录必须改密',
    };
  }

  /** 下载批量建号 Excel 模板：表头与解析规则同源，避免用户手搓格式 */
  @Get('api/v1/users/batch/template')
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  async downloadBatchTemplate(@Req() req: AuthedRequest, @Res() res: Response) {
    const buffer = await buildUserImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="user-import-template.xlsx"');
    res.setHeader('Content-Length', String(buffer.length));
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.user.batch_template',
      resourceType: 'user',
      resourceId: 'template',
      result: 'success',
      ip: clientIp(req),
      detail: { bytes: buffer.length },
    });
    res.end(buffer);
  }

  /** 批量建号：只接受 Excel（.xlsx）上传，逐行返回成功/失败明细 */
  @Post('api/v1/users/batch')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  async createUsersBatch(@Req() req: AuthedRequest, @Body() body: BatchCreateBody) {
    if (!body?.fileName || !body?.contentBase64) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'file',
        reason: '请上传填写好的 Excel 模板（.xlsx）',
      });
    }
    const items: BatchUserInput[] = await parseUserImportFile(body.fileName, body.contentBase64);
    if (!items.length) {
      throw new ApiError('SYS_VALIDATION', { field: 'file', reason: 'Excel 中没有可用的账号数据' });
    }
    if (items.length > MAX_BATCH_USERS) {
      throw new ApiError('SYS_VALIDATION', {
        field: 'file',
        reason: `单次最多创建 ${MAX_BATCH_USERS} 个账号，当前 ${items.length} 个`,
      });
    }

    const result = await this.auth.createUsersBatch(items);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.user.batch_create',
      resourceType: 'user',
      // 批量操作不落单个资源 id，用成功数标识一次操作
      resourceId: `batch:${result.createdCount}`,
      result: result.failedCount > 0 ? 'failure' : 'success',
      ip: clientIp(req),
      detail: {
        total: result.total,
        created: result.createdCount,
        failed: result.failedCount,
        failedUsers: result.failed.map((item) => item.username),
      },
    });
    return {
      ...result,
      notice: '初始密码统一为 123123123（管理员账号唯一，不可批量创建）；首次登录必须改密',
    };
  }

  @Patch('api/v1/users/:id')
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  updateUser(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateUserBody) {
    const updated = this.auth.updateUser(id, {
      role: body?.role,
      status: body?.status,
      displayName: body?.displayName,
      email: body?.email,
    });
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.user.update',
      resourceType: 'user',
      resourceId: id,
      result: 'success',
      ip: clientIp(req),
      detail: { role: updated.role, status: updated.status },
    });
    return { user: updated };
  }

  @Post('api/v1/users/:id/reset-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  async resetPassword(@Req() req: AuthedRequest, @Param('id') id: string) {
    const result = await this.auth.resetPassword(id);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.user.reset_password',
      resourceType: 'user',
      resourceId: id,
      result: 'success',
      ip: clientIp(req),
      detail: { username: result.user.username },
    });
    return { ...result, notice: '新密码仅展示一次，该用户所有会话已失效' };
  }

  /**
   * 管理员代为签发令牌：机器账号没有口令、无法自助登录，只能由管理员在这里发。
   * 令牌明文仅本次响应返回，服务端只存 sha256 哈希。
   */
  @Post('api/v1/users/:id/tokens')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  issueUserToken(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { name?: string }) {
    const target = this.auth.findUserById(id);
    if (!target) throw new ApiError('SYS_NOT_FOUND', { resource: 'user' });
    const name = (body?.name || `ci-${target.username}`).slice(0, 80);
    const created = this.auth.createApiToken(target.id, name);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.token.issue',
      resourceType: 'api_token',
      resourceId: name,
      result: 'success',
      ip: clientIp(req),
      detail: { name, targetUserId: target.id, targetUsername: target.username, accountType: target.accountType },
    });
    return { ...created, notice: '令牌仅在本次响应中展示，请立即写入 CI 密文变量' };
  }

  /**
   * 批量吊销该账号名下全部令牌。
   * 与「禁用账号」互补：禁用只是让令牌暂时失效、可随账号恢复而恢复；
   * 本操作不可逆，用于离职、凭据泄露、项目下线等需要彻底断开的场景。
   */
  @Post('api/v1/users/:id/tokens/revoke-all')
  @UseGuards(AuthGuard)
  @RequirePermission('user:manage')
  revokeAllUserTokens(@Req() req: AuthedRequest, @Param('id') id: string) {
    // 必须用含禁用账号的查询：已禁用的账号恰恰是最需要清凭据的对象
    const target = this.auth.findUserByIdAnyStatus(id);
    if (!target) throw new ApiError('SYS_NOT_FOUND', { resource: 'user' });
    const revoked = this.auth.revokeAllApiTokens(target.id, 'bulk_revoke');
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.token.revoke_all',
      resourceType: 'user',
      resourceId: target.id,
      result: 'success',
      ip: clientIp(req),
      detail: { targetUsername: target.username, revoked },
    });
    return { revoked, notice: '令牌已永久作废，重新启用账号也不会恢复，需要重新签发' };
  }

  // ---------- API 令牌（CLI 使用） ----------

  @Post('api/v1/auth/tokens')
  @UseGuards(AuthGuard)
  @RequirePermission('token:manage')
  createToken(@Req() req: AuthedRequest, @Body() body: { name?: string }) {
    const name = (body?.name || 'cli-token').slice(0, 80);
    const created = this.auth.createApiToken(req.user!.id, name);
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.token.create',
      resourceType: 'api_token',
      resourceId: name,
      result: 'success',
      ip: clientIp(req),
      detail: { name },
    });
    return { ...created, notice: '令牌仅在创建时展示一次，请立即保存' };
  }

  /**
   * 令牌清单。默认self：只返回调用者自己的令牌，任何角色都无法通过参数越权。
   * scope=all 是独立分支且要求 user:manage，普通用户传了也只会拿到 403。
   */
  @Get('api/v1/auth/tokens')
  @UseGuards(AuthGuard)
  listTokens(@Req() req: AuthedRequest, @Query('scope') scope?: string, @Query('keyword') keyword?: string) {
    if (scope !== 'all') {
      return { scope: 'self', items: this.auth.listApiTokens(req.user!.id) };
    }
    if (!this.auth.hasPermission(req.user!, 'user:manage')) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'user:manage', scope: 'all' });
    }
    return { scope: 'all', items: this.auth.listAllApiTokens({ keyword }) };
  }

  /**
   * 吊销令牌：
   * - 本人令牌：任何持有 token:manage 的账号都能吊销（自助回收）。
   * - 他人令牌：仅管理员，用于离职、泄露、项目下线等场景。
   * 非管理员对他人令牌统一返回 403，不区分「不存在」与「不属于你」，避免哈希枚举。
   */
  @Post('api/v1/auth/tokens/:tokenHash/revoke')
  @UseGuards(AuthGuard)
  revokeToken(@Req() req: AuthedRequest) {
    const hash = (req.params as Record<string, string>).tokenHash;
    if (this.auth.revokeApiToken(req.user!.id, hash)) {
      this.audit.log({
        traceId: req.traceId,
        actorId: req.user!.id,
        action: 'auth.token.revoke',
        resourceType: 'api_token',
        resourceId: hash,
        result: 'success',
        ip: clientIp(req),
        detail: { scope: 'self' },
      });
      return { revoked: true, scope: 'self' };
    }

    if (!this.auth.hasPermission(req.user!, 'user:manage')) {
      throw new ApiError('AUTH_FORBIDDEN', { required: 'user:manage', reason: '只能吊销自己的令牌' });
    }
    const owner = this.auth.revokeApiTokenByHash(hash, 'admin_revoke');
    if (!owner) throw new ApiError('AUTH_TOKEN_INVALID');
    this.audit.log({
      traceId: req.traceId,
      actorId: req.user!.id,
      action: 'auth.token.revoke',
      resourceType: 'api_token',
      resourceId: hash,
      result: 'success',
      ip: clientIp(req),
      detail: { scope: 'other', targetUserId: owner.userId, targetUsername: owner.username },
    });
    return { revoked: true, scope: 'other', ownerUsername: owner.username };
  }
}

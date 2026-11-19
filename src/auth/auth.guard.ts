import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/errors';
import { bearerToken, parseBasicAuth, parseCookies } from '../common/http.util';
import { AuthService, type AuthUser } from './auth.service';

export const PERMISSION_KEY = 'required_permission';
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

export type AuthedRequest = Request & { user?: AuthUser; traceId?: string };

const SESSION_COOKIE = 'yj_sid';

// 强制改密期间只放行最小集合，避免一次性口令在改掉之前就能发布或管理用户
const ALLOW_WHILE_MUST_CHANGE = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/permissions/check',
  '/auth/logout',
]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  /** 认证 + 权限一并校验：控制器只需声明 @RequirePermission */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.resolve(req);
    if (!user) throw new ApiError('AUTH_UNAUTHENTICATED');
    req.user = user;

    if (user.mustChangePassword && !ALLOW_WHILE_MUST_CHANGE.has(req.path)) {
      throw new ApiError('AUTH_PASSWORD_CHANGE_REQUIRED');
    }

    const required = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !this.auth.hasPermission(user, required)) {
      throw new ApiError('AUTH_FORBIDDEN', { required, role: user.role });
    }
    return true;
  }

  /** 会话 Cookie → Bearer 令牌 → Basic（registry 客户端）三选一 */
  private async resolve(req: AuthedRequest): Promise<AuthUser | null> {
    const cookies = parseCookies(req.header('cookie'));
    const sid = cookies[SESSION_COOKIE];
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
      // npm/twine 的 Basic 口令既可能是 API Token，也可能是账号密码
      const byToken = this.auth.resolveApiToken(basic.password);
      if (byToken) return byToken;
      return this.auth.verifyBasicCredentials(basic.username, basic.password);
    }

    return null;
  }
}

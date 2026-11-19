import { Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiError } from '../common/errors';
import { clientIp } from '../common/http.util';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { PackagesService, type Ecosystem } from './packages.service';

@Controller('api/v1/packages')
@UseGuards(AuthGuard)
@RequirePermission('package:read')
export class PackagesController {
  constructor(
    private readonly packages: PackagesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: Record<string, string>) {
    const ecosystem = query.ecosystem === 'npm' || query.ecosystem === 'pypi' ? (query.ecosystem as Ecosystem) : undefined;
    return this.packages.listPackages({
      ecosystem,
      q: query.q,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
      includeDeleted: query.includeDeleted === '1' || query.includeDeleted === 'true',
      viewerId: req.user!.id,
      viewerIsAdmin: req.user!.role === 'admin',
    });
  }

  @Get('detail')
  detail(
    @Req() req: AuthedRequest,
    @Query('ecosystem') ecosystem: string,
    @Query('name') name: string,
    @Query('includeDeleted') includeDeleted: string,
  ) {
    if (ecosystem !== 'npm' && ecosystem !== 'pypi') throw new ApiError('SYS_VALIDATION', { field: 'ecosystem' });
    if (!name) throw new ApiError('SYS_VALIDATION', { field: 'name' });
    return this.packages.getPackageDetail(ecosystem, name, {
      viewerId: req.user!.id,
      includeDeleted: includeDeleted === '1' || includeDeleted === 'true',
      viewerIsAdmin: req.user!.role === 'admin',
    });
  }

  /**
   * 删除单个版本。权限两层：
   * 1) 方法级 @RequirePermission 挡住没有发布权的角色（如 reader）；
   * 2) 服务层校验归属：上传者本人，或管理员代为删除（代删写审计 `deletedByAdmin`）。
   */
  @Delete('versions/:id')
  @RequirePermission('package:publish')
  removeVersion(@Req() req: AuthedRequest, @Param('id') id: string) {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    try {
      const result = this.packages.deleteVersion(id, user.id, { isAdmin });
      this.audit.log({
        traceId: req.traceId,
        actorId: user.id,
        actorTokenHash: user.tokenId,
        action: 'package.version.delete',
        resourceType: 'package_version',
        resourceId: id,
        result: 'success',
        ip: clientIp(req),
        detail: { ...result, actorRole: user.role },
      });
      return result;
    } catch (err) {
      this.audit.log({
        traceId: req.traceId,
        actorId: user.id,
        actorTokenHash: user.tokenId,
        action: 'package.version.delete',
        resourceType: 'package_version',
        resourceId: id,
        result: 'failure',
        ip: clientIp(req),
        detail: { versionId: id, actorRole: user.role, reason: (err as Error).message },
      });
      throw err;
    }
  }

  /**
   * 恢复已删除版本：上传者本人，或管理员代为恢复。
   * 与删除对称：管理员既能代删也能代恢复，两个方向都写审计（`restoredByAdmin` / `actorRole`）。
   */
  @Post('versions/:id/restore')
  @RequirePermission('package:publish')
  restoreVersion(@Req() req: AuthedRequest, @Param('id') id: string) {
    const user = req.user!;
    const isAdmin = user.role === 'admin';
    try {
      const result = this.packages.restoreVersion(id, user.id, { isAdmin });
      this.audit.log({
        traceId: req.traceId,
        actorId: user.id,
        actorTokenHash: user.tokenId,
        action: 'package.version.restore',
        resourceType: 'package_version',
        resourceId: id,
        result: 'success',
        ip: clientIp(req),
        detail: { ...result, actorRole: user.role },
      });
      return result;
    } catch (err) {
      this.audit.log({
        traceId: req.traceId,
        actorId: user.id,
        actorTokenHash: user.tokenId,
        action: 'package.version.restore',
        resourceType: 'package_version',
        resourceId: id,
        result: 'failure',
        ip: clientIp(req),
        detail: { versionId: id, actorRole: user.role, reason: (err as Error).message },
      });
      throw err;
    }
  }
}

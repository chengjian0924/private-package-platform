import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';
import { clientIp } from '../common/http.util';
import { ManualService } from './manual.service';

/**
 * 用户手册内容：所有登录用户可读，只有管理员能改。
 * 修改落在共享库，普通用户下次进入手册页即可看到，不依赖本地缓存。
 */
@Controller('api/v1/manual')
@UseGuards(AuthGuard)
export class ManualController {
  constructor(
    private readonly manual: ManualService,
    private readonly audit: AuditService,
  ) {}

  @Get('content')
  content() {
    return this.manual.list();
  }

  @Put('content')
  @RequirePermission('config:manage')
  update(@Req() req: AuthedRequest, @Body() body: unknown) {
    const result = this.manual.save(body, req.user?.id ?? null);
    this.audit.log({
      traceId: req.traceId ?? null,
      actorId: req.user?.id ?? null,
      actorTokenHash: req.user?.tokenId ?? null,
      action: 'manual.content.update',
      resourceType: 'user_manual',
      resourceId: 'default',
      result: 'success',
      ip: clientIp(req),
      detail: { sections: result.changed },
    });
    return result;
  }
}

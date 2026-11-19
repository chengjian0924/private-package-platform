import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiError } from '../common/errors';
import { clientIp } from '../common/http.util';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';
import { DictionaryService } from './dictionary.service';

/**
 * 字典管理 API：统一维护限流、漏洞扫描等运行时配置。
 * 保存后由 DictionaryService 即时套用覆盖层，业务模块经 getConfig() 立即读到新值。
 */
@Controller('api/v1/dictionary')
@UseGuards(AuthGuard)
@RequirePermission('config:manage')
export class DictionaryController {
  constructor(
    private readonly dictionary: DictionaryService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return { groups: this.dictionary.describe() };
  }

  @Put()
  update(@Req() req: AuthedRequest, @Body() body: { values?: unknown }) {
    if (!body || typeof body !== 'object' || body.values === undefined) {
      throw new ApiError('SYS_VALIDATION', { reason: '缺少 values 字段' });
    }
    const groups = this.dictionary.save(body.values, req.user?.id ?? null);
    // 配置变更直接影响限流与扫描行为，全部落审计；值本身不敏感，原样记录便于追溯
    this.audit.log({
      traceId: req.traceId ?? null,
      actorId: req.user?.id ?? null,
      actorTokenHash: req.user?.tokenId ?? null,
      action: 'config.dictionary.update',
      resourceType: 'sys_dictionary',
      resourceId: 'all',
      result: 'success',
      ip: clientIp(req),
      detail: { values: body.values as Record<string, unknown> },
    });
    return { groups };
  }
}

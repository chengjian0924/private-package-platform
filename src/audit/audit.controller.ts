import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from './audit.service';
import { AuthGuard, RequirePermission, type AuthedRequest } from '../auth/auth.guard';

@Controller('api/v1/audit-logs')
@UseGuards(AuthGuard)
@RequirePermission('audit:read')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: Record<string, string>, @Req() req: AuthedRequest, @Res() res: Response): void {
    const result = this.audit.query({
      action: query.action,
      actorId: query.actorId,
      resourceType: query.resourceType,
      result: query.result,
      tokenName: query.tokenName,
      from: query.from,
      to: query.to,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 20,
    });

    if (query.format === 'csv') {
      const header = 'id,createdAt,traceId,actorId,actorToken,action,resourceType,resourceId,result,detail';
      const lines = result.items.map((item) =>
        [
          item.id,
          item.created_at,
          item.trace_id ?? '',
          item.actor_id ?? '',
          item.actor_token_name ?? '',
          item.action,
          item.resource_type ?? '',
          item.resource_id ?? '',
          item.result,
          JSON.stringify(item.detail ?? {}).replace(/"/g, '""'),
        ]
          .map((cell) => {
            const text = String(cell);
            return /[",\n]/.test(text) ? `"${text}"` : text;
          })
          .join(','),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      res.send([header, ...lines].join('\n'));
      return;
    }

    // 使用 @Res() 直出，避免 CSV 导出被统一信封包装
    res.json({
      code: 0,
      message: 'ok',
      data: { ...result, requestedBy: req.user!.username },
      traceId: req.traceId ?? null,
    });
  }
}

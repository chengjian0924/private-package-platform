import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, ERROR_DEFS } from './errors';
import type { TracedRequest } from './http.util';

/**
 * 全局异常出口：
 * - /api/* 返回统一信封（code 为字符串错误码）
 * - /npm/* /pypi/* 返回 registry 风格错误体，保证 npm/twine 客户端可读
 * - /auth/callback 失败时重定向回控制台并带错误码，避免白屏
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<TracedRequest>();
    const path = req.path || req.url || '';
    const traceId = req.traceId || '-';

    let status = 500;
    let code = 'SYS_INTERNAL';
    let message = ERROR_DEFS.SYS_INTERNAL.message;
    let details: unknown;

    if (exception instanceof ApiError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const typed = body as Record<string, unknown>;
        message = (typed.message as string) || exception.message;
        if (Array.isArray(typed.message)) message = (typed.message as string[]).join('; ');
      }
      code = status === 401 ? 'AUTH_UNAUTHENTICATED' : status === 403 ? 'AUTH_FORBIDDEN' : 'SYS_VALIDATION';
      if (status === 404) code = 'SYS_NOT_FOUND';
      if (status === 413) code = 'UPLOAD_FILE_TOO_LARGE';
    } else if (exception instanceof Error) {
      message = ERROR_DEFS.SYS_INTERNAL.message;
      this.logger.error(`[${traceId}] ${path} ${exception.message}`, exception.stack);
    }

    if (status >= 500) {
      this.logger.error(`[${traceId}] ${req.method} ${path} -> ${status} ${code}`);
    }

    if (path.startsWith('/auth/callback')) {
      res.redirect(`/?auth_error=${encodeURIComponent(code)}`);
      return;
    }

    if (path.startsWith('/npm') || path.startsWith('/pypi')) {
      // registry 客户端只需要 error/reason；额外透出拦截明细，上传者才能自助整改
      const extra = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
      res.status(status).json({
        error: code,
        reason: message,
        traceId,
        ...(extra.scanId ? { scanId: extra.scanId } : {}),
        ...(Array.isArray(extra.findings) && extra.findings.length > 0
          ? { findings: extra.findings.slice(0, 3) }
          : {}),
        ...(extra.remediation ? { remediation: extra.remediation } : {}),
      });
      return;
    }

    res.status(status).json({ code, message, traceId, details: details ?? null });
  }
}

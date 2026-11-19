import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { TracedRequest } from './http.util';

/** 仅对 /api/* 生效：统一为 { code: 0, message: 'ok', data, traceId } 信封 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<TracedRequest>();
    const res = http.getResponse<Response>();
    const path = req.path || '';

    if (!path.startsWith('/api/')) {
      return next.handle();
    }

    if (res.getHeader('X-No-Envelope')) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'ok',
        data: data === undefined ? null : data,
        traceId: req.traceId || null,
      })),
    );
  }
}

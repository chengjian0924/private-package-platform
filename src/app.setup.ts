import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AllExceptionsFilter } from './common/exception.filter';
import { rateLimit, securityHeaders } from './common/http-security';
import { JsonLogger, requestLog } from './common/logger';
import { traceMiddleware } from './common/http.util';
import { MetricsService, metricsMiddleware } from './metrics/metrics';
import { ResponseInterceptor } from './common/response.interceptor';
import { ShutdownService } from './common/shutdown.service';
import { getConfig } from './config/config';

/** main.ts 与 e2e 测试共用同一套中间件/过滤器配置，保证测试环境与生产行为一致 */
export function configureApp(app: NestExpressApplication): void {
  const cfg = getConfig();

  app.useLogger(new JsonLogger());
  app.use(securityHeaders);
  app.use(traceMiddleware);
  app.use(requestLog);
  app.use(metricsMiddleware(app.get(MetricsService)));
  // 停机排空：解码请求体之前直接 503，避免停机瞬间再写临时文件
  app.use(app.get(ShutdownService).middleware());
  // 放在 body 解析之前：被限流的请求不应先占用请求体内存
  app.use(rateLimit);
  // npm publish 的附件在 JSON 里以 base64 传输，单独限高，避免大包整块进内存
  app.use(express.json({ limit: cfg.limits.maxNpmPublishBytes }));
  app.use(express.urlencoded({ extended: true, limit: cfg.limits.maxNpmPublishBytes }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useStaticAssets(cfg.publicDir, { index: 'index.html' });
  app.enableShutdownHooks();
}

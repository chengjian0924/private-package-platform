import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getConfig } from '../config/config';
import { ERROR_DEFS } from './errors';
import type { TracedRequest } from './http.util';

/**
 * 优雅停机（A-07）：
 * 1. SIGTERM 后进入 draining，新请求直接 503，提前告知客户端重试；
 * 2. 统计在途请求，等在途归零或宽限期超时；
 * 3. 硬超时看门狗由 main.ts 负责强制退出，避免 keep-alive 长连接无限拖延。
 *
 * 存储层是临时文件 + 原子 rename，停机不会产生半截对象；强制退出最多残留 tmp 文件。
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger('Shutdown');
  private readonly graceMs = getConfig().shutdown.graceMs;
  private draining = false;
  private inflight = 0;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;
  private graceTimer?: NodeJS.Timeout;
  private drainStartedAt = 0;
  /** 排空结束时通知 main.ts 撤掉硬超时看门狗，避免正常停机被误判为「强制退出」 */
  private drainedCallback: ((timedOut: boolean) => void) | null = null;

  /** 注册排空结束回调（成功或超时都会触发），重复注册以最后一次为准 */
  whenDrained(callback: (timedOut: boolean) => void): void {
    this.drainedCallback = callback;
  }

  /** 全局中间件：必须在 body 解析与 multer 之前注册 */
  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (this.draining) {
        const traced = req as TracedRequest;
        const traceId = traced.traceId || '-';
        const message = ERROR_DEFS.SYS_SHUTTING_DOWN.message;
        // 让客户端与连接池立即停止复用这条连接
        res.setHeader('Connection', 'close');
        res.setHeader('Retry-After', '5');
        if (traced.path.startsWith('/npm') || traced.path.startsWith('/pypi')) {
          res.status(ERROR_DEFS.SYS_SHUTTING_DOWN.status).json({ error: 'SYS_SHUTTING_DOWN', reason: message, traceId });
        } else {
          res
            .status(ERROR_DEFS.SYS_SHUTTING_DOWN.status)
            .json({ code: 'SYS_SHUTTING_DOWN', message, traceId, details: null });
        }
        return;
      }

      this.inflight += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.inflight -= 1;
        if (this.inflight === 0) this.finishDrain();
      };
      res.on('finish', release);
      res.on('close', release);
      next();
    };
  }

  /** 开始排空；重复调用返回同一个 Promise */
  beginDrain(reason = 'shutdown'): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    this.drainStartedAt = Date.now();
    this.logger.warn(`开始排空在途请求（${reason}），当前 ${this.inflight} 个`);

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      if (this.inflight === 0) {
        this.finishDrain();
        return;
      }
      this.graceTimer = setTimeout(() => {
        this.logger.error(`优雅停机超时：仍有 ${this.inflight} 个请求未完成，交由硬超时强制退出`);
        this.settleDrain(true);
      }, this.graceMs);
      // 不阻塞进程自然退出
      this.graceTimer.unref();
    });
    return this.drainPromise;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.beginDrain('SIGTERM/SIGINT');
  }

  isDraining(): boolean {
    return this.draining;
  }

  inflightCount(): number {
    return this.inflight;
  }

  private finishDrain(): void {
    this.settleDrain(false);
  }

  private settleDrain(timedOut: boolean): void {
    if (!this.drainResolve) return;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    const elapsed = Date.now() - this.drainStartedAt;
    if (!timedOut) {
      this.logger.log(`在途请求已排空，耗时 ${elapsed}ms，开始关闭数据库`);
    }
    const resolve = this.drainResolve;
    this.drainResolve = null;
    try {
      this.drainedCallback?.(timedOut);
    } catch {
      // 回调只做看门狗清理，失败不能影响停机主流程
    }
    resolve();
  }
}

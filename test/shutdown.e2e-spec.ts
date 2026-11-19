import { EventEmitter } from 'node:events';
import request from 'supertest';
import type { Response } from 'express';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { ShutdownService } from '../src/common/shutdown.service';

/** 最小 Response 桩：只覆盖中间件用到的 setHeader/status/json 与 finish 事件 */
function fakeResponse(): { res: Response; result: () => { statusCode: number; payload: unknown } } {
  let statusCode = 0;
  let payload: unknown;
  const res = new EventEmitter() as unknown as Response;
  res.setHeader = jest.fn() as unknown as Response['setHeader'];
  res.status = ((code: number) => {
    statusCode = code;
    return res;
  }) as Response['status'];
  res.json = ((body: unknown) => {
    payload = body;
    return res;
  }) as Response['json'];
  return { res, result: () => ({ statusCode, payload }) };
}

function npmPublishBody(name: string, version: string, tarball: Buffer): Record<string, unknown> {
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: { [version]: { name, version, dist: {} } },
    _attachments: {
      [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
    },
  };
}

describe('优雅停机（e2e）', () => {
  let ctx: TestContext;
  let shutdown: ShutdownService;

  beforeAll(async () => {
    ctx = await createTestApp('shutdown');
    shutdown = ctx.app.get(ShutdownService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('排空会等待在途请求归零', async () => {
    const svc = new ShutdownService();
    const { res } = fakeResponse();
    const next = jest.fn();

    svc.middleware()({ path: '/api/v1/packages', method: 'GET' } as never, res, next);
    expect(next).toHaveBeenCalled();
    expect(svc.inflightCount()).toBe(1);

    let settled = false;
    const drain = svc.beginDrain('test').then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    res.emit('finish');
    await drain;
    expect(svc.inflightCount()).toBe(0);
  });

  it('排空后新请求返回 503 并提示重试', async () => {
    const svc = new ShutdownService();
    await svc.beginDrain('test');

    const { res, result } = fakeResponse();
    svc.middleware()({ path: '/npm/demo', method: 'PUT' } as never, res, jest.fn());

    const { statusCode, payload } = result();
    expect(statusCode).toBe(503);
    expect(payload).toEqual(expect.objectContaining({ error: 'SYS_SHUTTING_DOWN' }));
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('在途发布可完成，随后读接口也返回 503', async () => {
    const tarball = await makeNpmTarball('e2e-shutdown', '1.0.0');
    const body = npmPublishBody('e2e-shutdown', '1.0.0', tarball);

    // 先发起请求并让中间件计数，再触发排空
    const pending = request(ctx.baseUrl)
      .put('/npm/e2e-shutdown')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send(body)
      .then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const drain = shutdown.beginDrain('e2e');

    const publish = await pending;
    expect([200, 201]).toContain(publish.status);
    await drain;

    // 排空完成后所有新请求都不再进入业务逻辑，健康检查也返回 503（就绪语义）
    const health = await request(ctx.baseUrl).get('/api/v1/health');
    expect(health.status).toBe(503);
    expect(health.body.code).toBe('SYS_SHUTTING_DOWN');

    const blocked = await request(ctx.baseUrl)
      .put('/npm/e2e-shutdown')
      .auth(ADMIN.username, ADMIN.password)
      .send(npmPublishBody('e2e-shutdown', '1.0.1', tarball));
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toBe('SYS_SHUTTING_DOWN');
  });
});

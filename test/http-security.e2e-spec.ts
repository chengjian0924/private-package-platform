import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { checkRateLimit, resetRateLimitState } from '../src/common/http-security';
import { resetConfigCache } from '../src/config/config';

describe('B4 安全响应头与限流（e2e）', () => {
  let ctx: TestContext;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // 测试环境默认关闭限流，这里显式打开并把阈值压到 2 次
    for (const key of ['RATE_LIMIT_ENABLED', 'RATE_LIMIT_AUTH_MAX', 'RATE_LIMIT_WINDOW_MS', 'METRICS_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_AUTH_MAX = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.METRICS_TOKEN = 'm-token';
    resetRateLimitState();
    ctx = await createTestApp('http-security');
  });

  afterAll(async () => {
    await ctx.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRateLimitState();
    resetConfigCache();
  });

  it('所有响应带安全头，http 部署不下发 HSTS', async () => {
    const res = await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('登录失败超限返回 429、Retry-After 与统一错误码', async () => {
    const badLogin = () =>
      request(ctx.baseUrl)
        .post('/api/v1/auth/login')
        .send({ username: 'nobody-here', password: 'Wrong-Pass-2kR5m' });

    await badLogin().expect(401);
    await badLogin().expect(401);

    const limited = await badLogin().expect(429);
    expect(limited.body.code).toBe('SYS_RATE_LIMITED');
    expect(limited.body.traceId).toBeTruthy();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('令牌接口不计入鉴权类配额（管理员集中管理令牌不该被 429 打断）', async () => {
    // 鉴权配额已被上一条用例打满，这里仍要能正常签发：说明令牌接口走的是写配额
    for (const name of ['b4-1', 'b4-2', 'b4-3']) {
      await request(ctx.baseUrl)
        .post('/api/v1/auth/tokens')
        .auth(ADMIN.username, ADMIN.password)
        .send({ name })
        .expect(201);
    }
    await request(ctx.baseUrl).get('/api/v1/auth/tokens').auth(ADMIN.username, ADMIN.password).expect(200);
  });

  it('读请求不计入鉴权类配额', async () => {
    await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    await request(ctx.baseUrl).get('/api/v1/health').expect(200);
  });

  it('/metrics 设置令牌后必须携带 Bearer 才可抓取', async () => {
    await request(ctx.baseUrl).get('/metrics').expect(401);
    const ok = await request(ctx.baseUrl).get('/metrics').set('Authorization', 'Bearer m-token').expect(200);
    expect(ok.text).toContain('yj_up 1');
    expect(ok.text).toContain('yj_http_requests_total');
    expect(ok.headers['content-type']).toContain('text/plain');
  });

  it('固定窗口计数在窗口结束后重置', () => {
    resetRateLimitState();
    const start = 1_000_000;
    expect(checkRateLimit('unit', 2, 1000, start).allowed).toBe(true);
    expect(checkRateLimit('unit', 2, 1000, start + 10).allowed).toBe(true);
    const blocked = checkRateLimit('unit', 2, 1000, start + 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(1);
    // 窗口过期后重新计数
    expect(checkRateLimit('unit', 2, 1000, start + 1001).allowed).toBe(true);
  });
});

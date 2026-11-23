import request from 'supertest';
import { createTestApp, type TestContext } from './app-factory';
import { resetRateLimitState } from '../src/common/http-security';
import { resetConfigCache } from '../src/config/config';

/**
 * 回归：dshmarket / pip / npm 的批量 GET 曾与控制台 API 共用 readMax=600，
 * 打开一次插件市场页就打满配额，安装阶段 search 收到 429，客户端误判“不是 registry”。
 * 这里把两个桶的阈值都压到 2，验证 registry 请求既不占 read 桶，npm/pypi 之间也不互相挤占。
 */
describe('registry 独立限流（e2e）', () => {
  let ctx: TestContext;
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'RATE_LIMIT_ENABLED',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_AUTH_MAX',
    'RATE_LIMIT_WRITE_MAX',
    'RATE_LIMIT_READ_MAX',
    'RATE_LIMIT_REGISTRY_MAX',
  ];

  beforeAll(async () => {
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_AUTH_MAX = '10';
    process.env.RATE_LIMIT_WRITE_MAX = '100';
    process.env.RATE_LIMIT_READ_MAX = '2';
    process.env.RATE_LIMIT_REGISTRY_MAX = '2';
    resetRateLimitState();
    ctx = await createTestApp('registry-rate-limit');
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

  it('npm/pypi 协议 GET 独立计数，不占用控制台 read 配额', async () => {
    // 控制台 read 桶：第 3 次即 429
    const health = await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    expect(health.headers['ratelimit-limit']).toBe('2');
    await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    const readBlocked = await request(ctx.baseUrl).get('/api/v1/health').expect(429);
    expect(readBlocked.body.code).toBe('SYS_RATE_LIMITED');

    // read 桶已满，npm 仍用独立桶放行 2 次，第 3 次才 429
    const ping = await request(ctx.baseUrl).get('/npm/-/ping').expect(200);
    expect(ping.headers['ratelimit-limit']).toBe('2');
    await request(ctx.baseUrl).get('/npm/-/ping').expect(200);
    const npmBlocked = await request(ctx.baseUrl).get('/npm/-/ping').expect(429);
    expect(npmBlocked.headers['retry-after']).toBeTruthy();

    // pypi 不受 npm 桶影响，同样独立计数
    const simple = await request(ctx.baseUrl).get('/pypi/simple/').expect(200);
    expect(simple.headers['ratelimit-limit']).toBe('2');
    await request(ctx.baseUrl).get('/pypi/simple/').expect(200);
    await request(ctx.baseUrl).get('/pypi/simple/').expect(429);

    // registry 请求不会清空/补充 read 桶：控制台依旧被限
    await request(ctx.baseUrl).get('/api/v1/health').expect(429);
  });

  it('direct 形态忽略伪造 X-Forwarded-For，所有客户端仍按真实对端共用同一限流桶', async () => {
    resetRateLimitState(); // 上一条用例已打满 npm 桶，这里用干净窗口
    const forged = (ip: string) => request(ctx.baseUrl).get('/npm/-/ping').set('X-Forwarded-For', ip);

    // 三个不同的伪造来源 IP，在 direct 形态下应落到同一个桶（真实对端 127.0.0.1）：
    // 前 2 次放行（registryMax=2），第 3 次无论换成哪个伪造 IP 都被拒。
    await forged('203.0.113.1').expect(200);
    await forged('198.51.100.2').expect(200);
    const blocked = await forged('192.0.2.3').expect(429);
    expect(blocked.body.code).toBe('SYS_RATE_LIMITED');
  });
});

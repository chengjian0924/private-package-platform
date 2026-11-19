import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

describe('缺失依赖补包与审计追溯（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('admin');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('上报缺失依赖并按去重键累计命中次数', async () => {
    const first = await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({
        projectId: 'ci-demo',
        ecosystem: 'npm',
        dependencies: [{ name: 'e2e-missing-lib', versionSpec: '^1.0.0' }],
      })
      .expect(201);
    expect(first.body.data.created).toBe(1);

    const second = await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({
        projectId: 'ci-demo',
        ecosystem: 'npm',
        dependencies: [{ name: 'e2e-missing-lib', versionSpec: '^1.0.0' }],
      })
      .expect(201);
    expect(second.body.data.updated).toBe(1);

    const list = await request(ctx.baseUrl)
      .get('/api/v1/missing-dependencies?status=open')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    const record = (list.body.data.items as { id: string; hits: number; status: string }[]).find(
      (item) => item.status === 'open',
    );
    expect(record).toBeTruthy();
    expect(record!.hits).toBe(2);
  });

  it('员工上传补包文件后自动校验入库并关闭缺失记录', async () => {
    const list = await request(ctx.baseUrl)
      .get('/api/v1/missing-dependencies?status=open')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    const record = (list.body.data.items as { id: string }[])[0];
    expect(record).toBeTruthy();

    const tarball = await makeNpmTarball('e2e-missing-lib', '1.0.0', { engines: { node: '>=18' } });
    const supplemented = await request(ctx.baseUrl)
      .post(`/api/v1/missing-dependencies/${record.id}/supplement`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .attach('file', tarball, 'e2e-missing-lib-1.0.0.tgz')
      .expect(201);
    expect(supplemented.body.data.missing.status).toBe('resolved');
    expect(supplemented.body.data.versionId).toBeTruthy();

    const resolved = await request(ctx.baseUrl)
      .get(`/api/v1/missing-dependencies/${record.id}`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(resolved.body.data.status).toBe('resolved');

    const again = await request(ctx.baseUrl)
      .post(`/api/v1/missing-dependencies/${record.id}/supplement`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .attach('file', tarball, 'e2e-missing-lib-1.0.0.tgz')
      .expect(409);
    expect(again.body.code).toBe('MISSING_STATE_INVALID');
  });

  it('管理员可按动作检索审计日志并导出 CSV', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=missing.supplement')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(res.body.data.requestedBy).toBe('admin');
    expect((res.body.data.items as unknown[]).length).toBeGreaterThanOrEqual(1);

    const csv = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?format=csv&pageSize=50')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('audit-logs.csv');
    expect(csv.text.split('\n')[0]).toBe('id,createdAt,traceId,actorId,actorToken,action,resourceType,resourceId,result,detail');
  });

  it('无审计权限的角色被拒绝', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('不存在的资源返回 404 与可读错误码', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail?ecosystem=npm&name=definitely-not-exists')
      .auth(ADMIN.username, ADMIN.password)
      .expect(404);
    expect(res.body.code).toBe('PKG_NOT_FOUND');
    expect(res.body.traceId).toBeTruthy();

    const unknown = await request(ctx.baseUrl).get('/api/v1/not-exists').expect(404);
    expect(unknown.body.code).toBe('SYS_NOT_FOUND');
  });

  it('控制台静态页面可访问', async () => {
    const html = await request(ctx.baseUrl).get('/').expect(200);
    // 站点标题随品牌改名，断言只认「这是控制台首页」这一事实
    expect(html.text).toContain('<title>源鉴');
    const js = await request(ctx.baseUrl).get('/app.js').expect(200);
    expect(js.text).toContain('loadPackages');
  });
});

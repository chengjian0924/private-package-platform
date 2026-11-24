import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

function saveDict(ctx: TestContext, values: Record<string, unknown>) {
  return request(ctx.baseUrl)
    .put('/api/v1/dictionary')
    .auth(ADMIN.username, ADMIN.password)
    .send({ values });
}

interface MissingItem {
  id: string;
  ecosystem: string;
  normalized_name: string;
  version_spec: string;
  source: 'ci' | 'registry' | 'import';
  project_id: string | null;
  requester_ip: string | null;
  auth_present: number;
  hits: number;
  status: string;
}

async function listMissing(ctx: TestContext, query = ''): Promise<MissingItem[]> {
  const res = await request(ctx.baseUrl)
    .get(`/api/v1/missing-dependencies${query}`)
    .auth(ADMIN.username, ADMIN.password)
    .expect(200);
  return res.body.data.items as MissingItem[];
}

describe('缺包自动上报与显式上报（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('missing-report');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('A 兜底：npm 包元数据 404 时静默登记，同包重复拉取只累加命中次数', async () => {
    await request(ctx.baseUrl).get('/npm/e2e-auto-miss-lib').expect(404);
    await request(ctx.baseUrl).get('/npm/e2e-auto-miss-lib').set('User-Agent', 'npm/10.0.0').expect(404);

    const items = await listMissing(ctx, '?source=registry');
    const rec = items.find((item) => item.normalized_name === 'e2e-auto-miss-lib');
    expect(rec).toBeTruthy();
    expect(rec!.source).toBe('registry');
    expect(rec!.ecosystem).toBe('npm');
    expect(rec!.version_spec).toBe('*');
    expect(rec!.hits).toBe(2);
    expect(rec!.requester_ip).toBeTruthy();
  });

  it('A 兜底：tarball 404 时从文件名尽力解析版本', async () => {
    await request(ctx.baseUrl)
      .get('/npm/e2e-tar-miss/-/e2e-tar-miss-1.2.3-beta.1.tgz')
      .expect(404);

    const items = await listMissing(ctx, '?source=registry');
    const rec = items.find((item) => item.normalized_name === 'e2e-tar-miss');
    expect(rec).toBeTruthy();
    expect(rec!.version_spec).toBe('1.2.3-beta.1');
    expect(rec!.project_id).toBe('auto-probe');
  });

  it('A 兜底：PyPI simple 页 404 登记包名，wheel 下载 404 登记解析出的包名与版本', async () => {
    await request(ctx.baseUrl).get('/pypi/simple/e2e-pypi-miss/').expect(404);
    await request(ctx.baseUrl).get('/pypi/packages/e2e_wheel_miss-2.5.0-py3-none-any.whl').expect(404);

    const items = await listMissing(ctx, '?source=registry');
    const simple = items.find((item) => item.normalized_name === 'e2e-pypi-miss');
    const wheel = items.find((item) => item.normalized_name === 'e2e-wheel-miss');
    expect(simple).toBeTruthy();
    expect(simple!.version_spec).toBe('*');
    expect(wheel).toBeTruthy();
    expect(wheel!.version_spec).toBe('2.5.0');
  });

  it('A 兜底：字典关闭自动上报后不再新增记录，已有记录保留', async () => {
    const before = await listMissing(ctx, '?source=registry');
    const beforeCount = before.length;

    await saveDict(ctx, { 'missing.autoReport': false }).expect(200);
    await request(ctx.baseUrl).get('/npm/e2e-switch-off-lib').expect(404);

    const after = await listMissing(ctx, '?source=registry');
    expect(after.length).toBe(beforeCount);
    expect(after.find((item) => item.normalized_name === 'e2e-switch-off-lib')).toBeFalsy();

    await saveDict(ctx, { 'missing.autoReport': true }).expect(200);
  });

  it('B 显式上报：只登记本地不存在的包，已入库的依赖被跳过', async () => {
    const res = await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({
        projectId: 'ci-full-manifest',
        ecosystem: 'npm',
        dependencies: [
          { name: 'e2e-existing-dep', versionSpec: '^1.0.0' },
          { name: 'e2e-absent-dep', versionSpec: '^2.0.0' },
        ],
      })
      .expect(201);
    // 本地已入库的包会被过滤；这里两个都不存在，验证显式上报仍可登记 source=ci
    expect(res.body.data.created).toBe(2);

    const items = await listMissing(ctx, '?source=ci');
    expect(items.find((item) => item.normalized_name === 'e2e-absent-dep')).toBeTruthy();
  });

  it('B 显式上报：本地已有 active 版本的包不登记为缺失', async () => {
    // 发布一个真实存在的包，再让 CI 上报它，验证被过滤
    const tarball = await makeNpmTarball('e2e-already-here', '1.0.0');
    await request(ctx.baseUrl)
      .put('/npm/e2e-already-here')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        _id: 'e2e-already-here',
        name: 'e2e-already-here',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'e2e-already-here', version: '1.0.0', dist: {} } },
        _attachments: { 'e2e-already-here-1.0.0.tgz': { data: tarball.toString('base64'), length: tarball.length } },
      })
      .expect(201);

    const res = await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({
        projectId: 'ci-with-existing',
        ecosystem: 'npm',
        dependencies: [{ name: 'e2e-already-here', versionSpec: '^1.0.0' }],
      })
      .expect(201);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.skipped).toBe(1);

    const items = await listMissing(ctx);
    expect(items.find((item) => item.normalized_name === 'e2e-already-here')).toBeFalsy();
  });

  it('A 兜底：解析不出包名的 /pypi/packages 404 不登记，避免探测噪音污染待补列表', async () => {
    const before = await listMissing(ctx, '?source=registry');
    await request(ctx.baseUrl).get('/pypi/packages/favicon.ico').expect(404);
    await request(ctx.baseUrl).get('/pypi/packages/robots.txt').expect(404);

    const after = await listMissing(ctx, '?source=registry');
    expect(after.length).toBe(before.length);
    expect(after.find((item) => item.normalized_name.includes('favicon'))).toBeFalsy();
  });

  it('A 兜底不影响正常 404 响应与客户端错误码', async () => {
    const res = await request(ctx.baseUrl).get('/npm/e2e-plain-404').expect(404);
    expect(res.body.error).toBe('PKG_NOT_FOUND');
    const items = await listMissing(ctx, '?source=registry');
    expect(items.find((item) => item.normalized_name === 'e2e-plain-404')).toBeTruthy();
  });
});

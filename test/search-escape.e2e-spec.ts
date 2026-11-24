import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

/** 发布一个最小 npm 包，供列表搜索用 */
async function publish(ctx: TestContext, name: string, version = '1.0.0') {
  const tarball = await makeNpmTarball(name, version);
  await request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: { [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length } },
    })
    .expect(201);
}

async function search(ctx: TestContext, q: string): Promise<{ total: number; names: string[] }> {
  const res = await request(ctx.baseUrl)
    .get('/api/v1/packages')
    .query({ q, pageSize: 100 })
    .auth(ADMIN.username, ADMIN.password)
    .expect(200);
  const items = (res.body.data?.items ?? res.body.items) as { name: string }[];
  const total = res.body.data?.total ?? res.body.total;
  return { total, names: items.map((item) => item.name) };
}

/**
 * 搜索结果必须按字面量匹配：用户输入的 % 和 _ 不能当通配符用。
 * 否则搜 `%` 会命中全表、搜 `e2e_like` 会命中 `e2e-like-*`，看起来像搜索坏了。
 */
describe('包列表搜索的 LIKE 转义（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('search-escape');
    await publish(ctx, 'e2e-like-alpha');
    await publish(ctx, 'e2e-other-beta');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('正常关键词按子串命中', async () => {
    const res = await search(ctx, 'e2e-like');
    expect(res.names).toContain('e2e-like-alpha');
    expect(res.names).not.toContain('e2e-other-beta');
  });

  it('百分号按字面量处理，不会命中全部包', async () => {
    const res = await search(ctx, '%');
    expect(res.total).toBe(0);
    expect(res.names).toEqual([]);
  });

  it('下划线按字面量处理，不会匹配任意字符', async () => {
    const res = await search(ctx, 'e2e_like');
    expect(res.total).toBe(0);
  });

  it('反斜杠不会破坏 SQL，仍返回 200', async () => {
    const res = await search(ctx, '\\');
    expect(res.total).toBe(0);
  });
});

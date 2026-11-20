import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';

function content(ctx: TestContext, user = ADMIN) {
  return request(ctx.baseUrl).get('/api/v1/manual/content').auth(user.username, user.password);
}

describe('用户手册内容（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('manual');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('默认没有覆盖项，所有登录用户可读', async () => {
    const admin = await content(ctx).expect(200);
    expect(admin.body.data.sections).toEqual({});

    const reader = await content(ctx, DEVELOPER).expect(200);
    expect(reader.body.data.sections).toEqual({});
  });

  it('普通用户不能编辑手册', async () => {
    const res = await request(ctx.baseUrl)
      .put('/api/v1/manual/content')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({ sections: { 'manual-login': '<p>越权</p>' } })
      .expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('管理员保存后普通用户读到同一份内容，且危险 HTML 被过滤', async () => {
    const html =
      '<p>管理员改过的手册</p>' +
      '<script>alert(1)</script>' +
      '<a href="javascript:alert(1)">bad</a>' +
      '<a href="/npm/">good</a>' +
      '<span onclick="alert(1)">safe</span>';

    const saved = await request(ctx.baseUrl)
      .put('/api/v1/manual/content')
      .auth(ADMIN.username, ADMIN.password)
      .send({ sections: { 'manual-login': html } })
      .expect(200);
    expect(saved.body.data.changed).toEqual(['manual-login']);

    const stored = saved.body.data.sections['manual-login'].html as string;
    expect(stored).toContain('<p>管理员改过的手册</p>');
    expect(stored).toContain('href="/npm/"');
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('javascript:');
    expect(stored).not.toContain('onclick');

    const reader = await content(ctx, DEVELOPER).expect(200);
    expect(reader.body.data.sections['manual-login'].html).toBe(stored);
  });

  it('未登记的章节被拒绝且不落库', async () => {
    const res = await request(ctx.baseUrl)
      .put('/api/v1/manual/content')
      .auth(ADMIN.username, ADMIN.password)
      .send({ sections: { 'manual-evil': '<p>x</p>' } })
      .expect(400);
    expect(res.body.code).toBe('SYS_VALIDATION');

    const after = await content(ctx).expect(200);
    expect(after.body.data.sections['manual-evil']).toBeUndefined();
  });

  it('空内容恢复内置默认，并写审计', async () => {
    await request(ctx.baseUrl)
      .put('/api/v1/manual/content')
      .auth(ADMIN.username, ADMIN.password)
      .send({ sections: { 'manual-login': '' } })
      .expect(200);

    const after = await content(ctx).expect(200);
    expect(after.body.data.sections['manual-login']).toBeUndefined();

    const audit = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=manual.content.update')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const rows = audit.body.data.items as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].resource_type).toBe('user_manual');
  });
});

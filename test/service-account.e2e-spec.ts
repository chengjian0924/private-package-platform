import request from 'supertest';
import { ADMIN, READER, createTestApp, type TestContext } from './app-factory';

/**
 * 机器账号（CI）闭环：
 * 管理员建号 → 口令登录被拒 → 代签令牌 → 令牌上报缺包 → 审计可按令牌名归因 → 不支持重置口令。
 */
describe('机器账号与 CI 令牌（e2e）', () => {
  let ctx: TestContext;
  let admin: ReturnType<typeof request.agent>;
  let userId = '';
  let token = '';
  const username = 'ci-demo-repo';

  beforeAll(async () => {
    ctx = await createTestApp('service-account');
    admin = request.agent(ctx.baseUrl);
    await admin
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('创建机器账号：不设口令、不要求改密', async () => {
    const created = await admin
      .post('/api/v1/users')
      .send({ username, role: 'developer', accountType: 'service', displayName: 'CI · demo/repo' })
      .expect(201);

    const user = created.body.data.user;
    expect(user.accountType).toBe('service');
    expect(user.mustChangePassword).toBe(false);
    // 机器账号没有可交付的初始口令
    expect(created.body.data.initialPassword).toBeNull();
    expect(created.body.data.notice).toContain('不支持口令登录');
    userId = user.id;
  });

  it('机器账号口令登录被拒绝，且不泄露口令是否正确', async () => {
    const res = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username, password: '123123123' })
      .expect(403);
    expect(res.body.code).toBe('AUTH_SERVICE_ACCOUNT');
  });

  it('管理员可代签令牌，普通用户无权签发', async () => {
    const reader = request.agent(ctx.baseUrl);
    await reader
      .post('/api/v1/auth/login')
      .send({ username: READER.username, password: READER.password })
      .expect(200);
    const forbidden = await reader.post(`/api/v1/users/${userId}/tokens`).send({ name: 'ci-demo-repo' }).expect(403);
    expect(forbidden.body.code).toBe('AUTH_FORBIDDEN');

    const issued = await admin.post(`/api/v1/users/${userId}/tokens`).send({ name: 'ci-demo-repo' }).expect(201);
    token = issued.body.data.token as string;
    expect(token.startsWith('yj_')).toBe(true);
    expect(issued.body.data.name).toBe('ci-demo-repo');
  });

  it('令牌可上报缺包，审计按令牌名可追溯到该项目', async () => {
    const report = await request(ctx.baseUrl)
      .post('/api/v1/dependency-reports')
      .set('authorization', `Bearer ${token}`)
      .send({
        projectId: 'demo/repo',
        ecosystem: 'npm',
        dependencies: [{ name: 'left-pad', versionSpec: '^1.3.0' }],
      })
      .expect(201);
    expect(report.body.data.created).toBe(1);

    const audit = await admin.get('/api/v1/audit-logs').query({ tokenName: 'ci-demo-repo' }).expect(200);
    const items = audit.body.data.items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    const reportRow = items.find((item) => item.action === 'missing.report');
    expect(reportRow).toBeTruthy();
    // Token 归属法：审计行必须落令牌名，否则事后无法判断是哪个项目报的
    expect(reportRow?.actor_token_name).toBe('ci-demo-repo');
    expect(reportRow?.resource_id).toBe('demo/repo');
  });

  it('机器账号不支持重置口令，并提示改用令牌', async () => {
    const res = await admin.post(`/api/v1/users/${userId}/reset-password`).expect(400);
    expect(res.body.code).toBe('SYS_VALIDATION');
    expect(res.body.details.field).toBe('accountType');
  });

  it('machine 账号的令牌可按角色访问接口，/auth/me 返回机器账号类型', async () => {
    const me = await request(ctx.baseUrl)
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.data.user.username).toBe(username);
    expect(me.body.data.user.accountType).toBe('service');
    expect(me.body.data.permissions).toContain('import:run');
  });
});

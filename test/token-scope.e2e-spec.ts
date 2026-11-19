import request from 'supertest';
import { ADMIN, READER, createTestApp, type TestContext } from './app-factory';

/**
 * 令牌可见范围：
 *   管理员：可以看、可以吊销所有账号的令牌（离职清理、泄露处置）
 *   普通用户：只能看、只能吊销自己的令牌，scope=all 一律 403
 * 这组用例锁住这条边界，防止后续给列表接口加参数时把越权口子放开。
 */
describe('令牌可见范围：管理员全量、普通用户仅自己（e2e）', () => {
  let ctx: TestContext;
  let admin: ReturnType<typeof request.agent>;
  let reader: ReturnType<typeof request.agent>;
  let readerToken = '';
  let adminToken = '';
  let readerTokenHash = '';
  let adminTokenHash = '';

  const probe = (token: string) =>
    request(ctx.baseUrl).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp('token-scope');
    admin = request.agent(ctx.baseUrl);
    reader = request.agent(ctx.baseUrl);
    await admin.post('/api/v1/auth/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(200);
    await reader.post('/api/v1/auth/login').send({ username: READER.username, password: READER.password }).expect(200);

    const readerCreated = await reader.post('/api/v1/auth/tokens').send({ name: 'scope-reader' }).expect(201);
    readerToken = readerCreated.body.data.token;
    const adminCreated = await admin.post('/api/v1/auth/tokens').send({ name: 'scope-admin' }).expect(201);
    adminToken = adminCreated.body.data.token;

    const readerList = await reader.get('/api/v1/auth/tokens').expect(200);
    readerTokenHash = (readerList.body.data.items as Record<string, string>[]).find((t) => t.name === 'scope-reader')!
      .token_hash;
    const adminList = await admin.get('/api/v1/auth/tokens').expect(200);
    adminTokenHash = (adminList.body.data.items as Record<string, string>[]).find((t) => t.name === 'scope-admin')!
      .token_hash;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('普通用户默认只拿到自己的令牌', async () => {
    const res = await reader.get('/api/v1/auth/tokens').expect(200);
    expect(res.body.data.scope).toBe('self');
    const names = (res.body.data.items as Record<string, string>[]).map((t) => t.name);
    expect(names).toContain('scope-reader');
    // 同库里有 admin 的令牌，但绝不能出现在 reader 的列表里
    expect(names).not.toContain('scope-admin');
  });

  it('普通用户强行请求 scope=all 被 403 拒绝', async () => {
    const res = await reader.get('/api/v1/auth/tokens').query({ scope: 'all' }).expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
    expect(res.body.details.required).toBe('user:manage');
  });

  it('管理员 scope=all 拿到全部令牌，并带出归属账号信息', async () => {
    const res = await admin.get('/api/v1/auth/tokens').query({ scope: 'all' }).expect(200);
    expect(res.body.data.scope).toBe('all');
    const items = res.body.data.items as Record<string, unknown>[];
    const owner = items.find((t) => t.name === 'scope-reader');
    expect(owner?.username).toBe(READER.username);
    expect(owner?.account_type).toBe('human');
    expect(owner?.user_status).toBe('active');
    expect(items.some((t) => t.name === 'scope-admin')).toBe(true);
  });

  it('管理员 scope=all 支持按账号名过滤', async () => {
    const res = await admin.get('/api/v1/auth/tokens').query({ scope: 'all', keyword: READER.username }).expect(200);
    const items = res.body.data.items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((t) => t.username === READER.username)).toBe(true);
  });

  it('普通用户吊销他人令牌被 403 拒绝，且该令牌仍然可用', async () => {
    const res = await reader
      .post(`/api/v1/auth/tokens/${adminTokenHash}/revoke`)
      .expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
    // 关键：拒绝之后不能留下副作用
    await probe(adminToken).expect(200);
  });

  it('管理员可代吊销他人令牌，令牌立即失效并标记为管理员吊销', async () => {
    const res = await admin.post(`/api/v1/auth/tokens/${readerTokenHash}/revoke`).expect(201);
    expect(res.body.data.revoked).toBe(true);
    expect(res.body.data.scope).toBe('other');
    expect(res.body.data.ownerUsername).toBe(READER.username);

    await probe(readerToken).expect(401);

    const list = await admin.get('/api/v1/auth/tokens').query({ scope: 'all', keyword: 'scope-reader' }).expect(200);
    const row = (list.body.data.items as Record<string, unknown>[]).find((t) => t.name === 'scope-reader');
    expect(row?.revoke_reason).toBe('admin_revoke');
  });

  it('本人吊销与代吊销的审计可区分，代吊销落目标账号', async () => {
    // 先造一个自己吊销的样本
    const own = await reader.post('/api/v1/auth/tokens').send({ name: 'scope-reader-own' }).expect(201);
    const ownHash = ((await reader.get('/api/v1/auth/tokens').expect(200)).body.data.items as Record<string, string>[]).find(
      (t) => t.name === 'scope-reader-own',
    )!.token_hash;
    await reader.post(`/api/v1/auth/tokens/${ownHash}/revoke`).expect(201);
    expect(own.body.data.token.startsWith('yj_')).toBe(true);

    const rows = (await admin.get('/api/v1/audit-logs').query({ action: 'auth.token.revoke' }).expect(200)).body.data
      .items as Record<string, unknown>[];
    const self = rows.find((r) => r.resource_id === ownHash);
    const other = rows.find((r) => r.resource_id === readerTokenHash);
    expect((self?.detail as Record<string, unknown>)?.scope).toBe('self');
    expect((other?.detail as Record<string, unknown>)?.scope).toBe('other');
    expect((other?.detail as Record<string, unknown>)?.targetUsername).toBe(READER.username);
  });

  it('重复吊销已失效令牌返回 401，不暴露令牌是否存在', async () => {
    const res = await admin.post(`/api/v1/auth/tokens/${readerTokenHash}/revoke`).expect(401);
    expect(res.body.code).toBe('AUTH_TOKEN_INVALID');

    const missing = await admin.post('/api/v1/auth/tokens/deadbeef/revoke').expect(401);
    expect(missing.body.code).toBe('AUTH_TOKEN_INVALID');
  });
});

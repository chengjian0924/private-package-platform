import request from 'supertest';
import { ADMIN, READER, createTestApp, type TestContext } from './app-factory';

/**
 * 令牌生命周期语义：
 * 「禁用账号」与「吊销令牌」是两个正交动作——
 *   禁用：可逆，令牌暂时不可用，重新启用后自动恢复；
 *   吊销：不可逆，凭据永久作废，重新启用账号也不恢复。
 * 这组用例锁住这条边界，避免后续改动把二者合并成同一个行为。
 */
describe('令牌吊销语义：禁用与作废的边界（e2e）', () => {
  let ctx: TestContext;
  let admin: ReturnType<typeof request.agent>;
  let serviceId = '';
  let tokenA = '';
  let tokenB = '';
  const username = 'ci-revoke-demo';

  /** 用令牌访问 /auth/me：200 表示凭据可用，401 表示被拒 */
  const probe = (token: string) =>
    request(ctx.baseUrl).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp('token-revoke');
    admin = request.agent(ctx.baseUrl);
    await admin
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);

    const created = await admin
      .post('/api/v1/users')
      .send({ username, role: 'developer', accountType: 'service' })
      .expect(201);
    serviceId = created.body.data.user.id;

    tokenA = (await admin.post(`/api/v1/users/${serviceId}/tokens`).send({ name: 'ci-a' }).expect(201)).body.data.token;
    tokenB = (await admin.post(`/api/v1/users/${serviceId}/tokens`).send({ name: 'ci-b' }).expect(201)).body.data.token;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('用户列表带出未吊销令牌数，管理员能看出账号还挂着几个凭据', async () => {
    const res = await admin.get('/api/v1/users').expect(200);
    const row = (res.body.data.items as Record<string, unknown>[]).find((u) => u.id === serviceId);
    expect(row).toBeTruthy();
    expect(row?.activeTokenCount).toBe(2);
  });

  it('禁用账号后令牌立即不可用——但凭据本身未被作废', async () => {
    await admin.patch(`/api/v1/users/${serviceId}`).send({ status: 'disabled' }).expect(200);
    await probe(tokenA).expect(401);
    await probe(tokenB).expect(401);

    // 关键：revoked 语义没有变化，令牌仍是「未吊销」状态，这正是「禁用可逆」的前提
    const res = await admin.get('/api/v1/users').expect(200);
    const row = (res.body.data.items as Record<string, unknown>[]).find((u) => u.id === serviceId);
    expect(row?.activeTokenCount).toBe(2);
  });

  it('重新启用后令牌自动恢复——禁用是可逆状态', async () => {
    await admin.patch(`/api/v1/users/${serviceId}`).send({ status: 'active' }).expect(200);
    await probe(tokenA).expect(200);
    await probe(tokenB).expect(200);
  });

  it('批量吊销返回实际数量，两个令牌同时失效', async () => {
    const res = await admin.post(`/api/v1/users/${serviceId}/tokens/revoke-all`).expect(201);
    expect(res.body.data.revoked).toBe(2);
    await probe(tokenA).expect(401);
    await probe(tokenB).expect(401);

    const list = await admin.get('/api/v1/users').expect(200);
    const row = (list.body.data.items as Record<string, unknown>[]).find((u) => u.id === serviceId);
    expect(row?.activeTokenCount).toBe(0);
  });

  it('吊销不可逆：禁用再启用也不会让令牌复活', async () => {
    await admin.patch(`/api/v1/users/${serviceId}`).send({ status: 'disabled' }).expect(200);
    await admin.patch(`/api/v1/users/${serviceId}`).send({ status: 'active' }).expect(200);
    await probe(tokenA).expect(401);
    await probe(tokenB).expect(401);
  });

  it('重复吊销是幂等的，返回 0 而不报错', async () => {
    const res = await admin.post(`/api/v1/users/${serviceId}/tokens/revoke-all`).expect(201);
    expect(res.body.data.revoked).toBe(0);
  });

  it('对已禁用账号仍可批量吊销——离职清理的典型场景', async () => {
    const other = await admin
      .post('/api/v1/users')
      .send({ username: 'ci-offboard', role: 'developer', accountType: 'service' })
      .expect(201);
    const otherId = other.body.data.user.id;
    const otherToken = (await admin.post(`/api/v1/users/${otherId}/tokens`).send({ name: 'ci-off' }).expect(201)).body
      .data.token;

    await admin.patch(`/api/v1/users/${otherId}`).send({ status: 'disabled' }).expect(200);
    // 已禁用账号在 findUserById 里等同不存在，批量吊销必须走含禁用状态的查询
    const res = await admin.post(`/api/v1/users/${otherId}/tokens/revoke-all`).expect(201);
    expect(res.body.data.revoked).toBe(1);
    await probe(otherToken).expect(401);
  });

  it('普通用户无权批量吊销令牌', async () => {
    const reader = request.agent(ctx.baseUrl);
    await reader
      .post('/api/v1/auth/login')
      .send({ username: READER.username, password: READER.password })
      .expect(200);
    const res = await reader.post(`/api/v1/users/${serviceId}/tokens/revoke-all`).expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('审计记录吊销动作、目标账号与实际数量', async () => {
    const res = await admin.get('/api/v1/audit-logs').query({ action: 'auth.token.revoke_all' }).expect(200);
    const items = res.body.data.items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    // 同一账号被吊销过两次（第二次为幂等空操作），按次数集合断言而不是取最新一条
    const rows = items.filter((item) => item.resource_id === serviceId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const counts = rows.map((item) => (item.detail as Record<string, unknown>)?.revoked);
    expect(counts).toContain(2);
    expect(counts).toContain(0);
  });

  it('单令牌吊销的审计只留短标识，导出里不含完整 token_hash', async () => {
    await admin.post(`/api/v1/users/${serviceId}/tokens`).send({ name: 'ci-audit' }).expect(201);
    const list = await admin.get('/api/v1/auth/tokens').query({ scope: 'all' }).expect(200);
    const target = (list.body.data.items as { name: string; token_hash: string }[]).find((t) => t.name === 'ci-audit');
    expect(target).toBeTruthy();

    await admin.post(`/api/v1/auth/tokens/${target!.token_hash}/revoke`).expect(201);

    const logs = await admin.get('/api/v1/audit-logs').query({ action: 'auth.token.revoke' }).expect(200);
    const rows = logs.body.data.items as { resource_id: string }[];
    // 完整哈希是吊销接口的路径参数，写进审计等于留一份可重放的凭据
    expect(rows.some((row) => row.resource_id === target!.token_hash)).toBe(false);
    expect(rows.some((row) => row.resource_id === `token:${target!.token_hash.slice(0, 8)}`)).toBe(true);
  });
});

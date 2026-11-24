import request from 'supertest';
import { ADMIN, READER, createTestApp, type TestContext } from './app-factory';
import { DatabaseService } from '../src/db/database.service';

interface TokenItem {
  name: string;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/**
 * 令牌有效期：
 * - 默认签发带到期时间（配置 API_TOKEN_TTL_DAYS，默认 90 天）；
 * - 显式 0 表示不过期，兼容长期 CI；
 * - 到期后立即失效，并在库里标记吊销原因，管理端能看出是过期而非人工吊销。
 */
describe('API 令牌有效期（e2e）', () => {
  let ctx: TestContext;
  let admin: ReturnType<typeof request.agent>;

  const probe = (token: string) => request(ctx.baseUrl).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);

  async function listTokens(): Promise<TokenItem[]> {
    const res = await admin.get('/api/v1/auth/tokens').expect(200);
    return res.body.data.items as TokenItem[];
  }

  beforeAll(async () => {
    ctx = await createTestApp('token-expiry');
    admin = request.agent(ctx.baseUrl);
    await admin.post('/api/v1/auth/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('默认签发带到期时间，清单里可见 expires_at', async () => {
    const res = await admin.post('/api/v1/auth/tokens').send({ name: 'ttl-default' }).expect(201);
    expect(res.body.data.expiresAt).toBeTruthy();
    const days = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 86400_000;
    // 默认 90 天，允许执行耗时带来的微小偏差
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const item = (await listTokens()).find((t) => t.name === 'ttl-default')!;
    expect(item.expires_at).toBe(res.body.data.expiresAt);
  });

  it('显式 expiresInDays=0 表示不过期', async () => {
    const res = await admin.post('/api/v1/auth/tokens').send({ name: 'ttl-never', expiresInDays: 0 }).expect(201);
    expect(res.body.data.expiresAt).toBeNull();
    const item = (await listTokens()).find((t) => t.name === 'ttl-never')!;
    expect(item.expires_at).toBeNull();
    // 不过期的令牌照常可用
    await probe(res.body.data.token).expect(200);
  });

  it('可选期限 30/60/180/365 天按选择生效', async () => {
    for (const days of [30, 60, 180, 365]) {
      const res = await admin
        .post('/api/v1/auth/tokens')
        .send({ name: `ttl-${days}`, expiresInDays: days })
        .expect(201);
      const actual = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 86400_000;
      // 四舍五入 + 执行耗时，允许不到 1 天的偏差
      expect(actual).toBeGreaterThan(days - 1);
      expect(actual).toBeLessThan(days + 0.01);
      const item = (await listTokens()).find((t) => t.name === `ttl-${days}`)!;
      expect(item.expires_at).toBe(res.body.data.expiresAt);
    }
  });

  it('非法有效期被拒绝：负数与超上限', async () => {
    const negative = await admin.post('/api/v1/auth/tokens').send({ name: 'ttl-bad', expiresInDays: -1 }).expect(400);
    expect(negative.body.code).toBe('SYS_VALIDATION');
    const tooLong = await admin.post('/api/v1/auth/tokens').send({ name: 'ttl-bad', expiresInDays: 5000 }).expect(400);
    expect(tooLong.body.code).toBe('SYS_VALIDATION');
  });

  it('到期后令牌立即失效，并被标记为过期吊销', async () => {
    const created = await admin.post('/api/v1/auth/tokens').send({ name: 'ttl-expired', expiresInDays: 1 }).expect(201);
    const token: string = created.body.data.token;
    await probe(token).expect(200);

    // 直接把到期时间改到过去，模拟时间流逝
    const db = ctx.app.get(DatabaseService);
    const hash = (await listTokens()).find((t) => t.name === 'ttl-expired')!.token_hash;
    db.run('UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?', new Date(Date.now() - 1000).toISOString(), hash);

    await probe(token).expect(401);

    const after = (await listTokens()).find((t) => t.name === 'ttl-expired')!;
    expect(after.revoked_at).toBeTruthy();
    expect(after.revoke_reason).toBe('expired');
  });

  it('管理员代签机器账号令牌同样受默认有效期约束', async () => {
    const users = await admin.get('/api/v1/users').expect(200);
    const items = (users.body.data?.items ?? users.body.items) as { id: string; username: string }[];
    const target = items.find((u) => u.username === READER.username)!;
    const res = await admin
      .post(`/api/v1/users/${target.id}/tokens`)
      .send({ name: 'ttl-machine' })
      .expect(201);
    expect(res.body.data.expiresAt).toBeTruthy();
  });

  it('管理员代签时也可指定期限或不过期', async () => {
    const users = await admin.get('/api/v1/users').expect(200);
    const items = (users.body.data?.items ?? users.body.items) as { id: string; username: string }[];
    const target = items.find((u) => u.username === READER.username)!;

    const custom = await admin
      .post(`/api/v1/users/${target.id}/tokens`)
      .send({ name: 'ttl-machine-30', expiresInDays: 30 })
      .expect(201);
    const days = (new Date(custom.body.data.expiresAt).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(30.01);

    const never = await admin
      .post(`/api/v1/users/${target.id}/tokens`)
      .send({ name: 'ttl-machine-never', expiresInDays: 0 })
      .expect(201);
    expect(never.body.data.expiresAt).toBeNull();
  });
});

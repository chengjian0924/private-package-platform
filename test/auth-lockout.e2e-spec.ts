import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { AuthService } from '../src/auth/auth.service';
import { resetConfigCache } from '../src/config/config';

/**
 * 登录防护的两处低危缺陷：
 * - 失败计数曾用「SELECT 再写回」，并发爆破时计数会丢失、锁定被推迟；
 * - registry Basic（npm login）曾把锁定/禁用吞成「令牌无效」，用户无法排障。
 */
describe('登录失败计数与锁定语义（e2e）', () => {
  let ctx: TestContext;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['LOGIN_MAX_FAILURES', 'LOGIN_LOCK_MINUTES'];

  const WRONG = 'Definitely-Wrong-9x';
  // 口令不能包含用户名（强度校验会拒绝），也不能与初始口令相同
  const lockedUser = { username: 'lock-target', password: 'Zx7#Qm2PvL' };
  const disabledUser = { username: 'disabled-target', password: 'Ry4#Nw8KdT' };

  beforeAll(async () => {
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.LOGIN_MAX_FAILURES = '3';
    process.env.LOGIN_LOCK_MINUTES = '1';
    resetConfigCache();
    ctx = await createTestApp('auth-lockout');

    const auth = ctx.app.get(AuthService);
    for (const account of [lockedUser, disabledUser]) {
      const created = await auth.createUser({ username: account.username, role: 'reader' });
      await auth.changePassword({
        userId: created.user.id,
        oldPassword: created.initialPassword ?? undefined,
        newPassword: account.password,
      });
    }
  });

  afterAll(async () => {
    await ctx.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  });

  const login = (username: string, password: string) =>
    request(ctx.baseUrl).post('/api/v1/auth/login').send({ username, password });

  it('并发失败登录不丢计数：累计到阈值即锁定，之后正确口令也进不来', async () => {
    // 三个并发请求同时打：改造前它们会读到同一个旧计数，可能只累加 1~2 次
    const results = await Promise.all([1, 2, 3].map(() => login(lockedUser.username, WRONG)));
    for (const res of results) {
      expect([401, 423]).toContain(res.status);
    }

    const locked = await login(lockedUser.username, lockedUser.password).expect(423);
    expect(locked.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(locked.body.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('npm login 对已锁定账号透出 AUTH_ACCOUNT_LOCKED，而不是「令牌无效」', async () => {
    const res = await request(ctx.baseUrl)
      .put(`/npm/-/user/org.couchdb.user:${lockedUser.username}`)
      .send({ name: lockedUser.username, password: lockedUser.password })
      .expect(423);
    // registry 风格错误体：字段是 error
    expect(res.body.error).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('禁用账号登录返回 AUTH_USER_DISABLED，npm login 同样透出真实原因', async () => {
    const disabled = await request(ctx.baseUrl)
      .patch(`/api/v1/users/${await userId(ctx, disabledUser.username)}`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ status: 'disabled' })
      .expect(200);
    expect(disabled.body.data.user.status).toBe('disabled');

    const web = await login(disabledUser.username, disabledUser.password).expect(403);
    expect(web.body.code).toBe('AUTH_USER_DISABLED');

    const npm = await request(ctx.baseUrl)
      .put(`/npm/-/user/org.couchdb.user:${disabledUser.username}`)
      .send({ name: disabledUser.username, password: disabledUser.password })
      .expect(403);
    expect(npm.body.error).toBe('AUTH_USER_DISABLED');
  });
});

async function userId(ctx: TestContext, username: string): Promise<string> {
  const res = await request(ctx.baseUrl)
    .get('/api/v1/users')
    .auth(ADMIN.username, ADMIN.password)
    .expect(200);
  const items = (res.body.data?.items ?? res.body.items) as { id: string; username: string }[];
  const found = items.find((item) => item.username === username);
  if (!found) throw new Error(`测试用户不存在: ${username}`);
  return found.id;
}

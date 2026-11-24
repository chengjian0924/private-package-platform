import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { AuthService } from '../src/auth/auth.service';
import { RetentionService } from '../src/maintenance/retention.service';
import { DatabaseService } from '../src/db/database.service';

/**
 * 会话卫生：
 * - Cookie 的 Secure 由「本次请求的协议」决定，而不是 ALLOW_INSECURE_BASE_URL；
 *   SESSION_COOKIE_SECURE 可以强制 always / never；
 * - 清除 Cookie 必须与下发时属性一致（否则浏览器会当成两条 Cookie，退出后仍是登录态）；
 * - 单账号有效会话数封顶，防止异常客户端反复登录把会话表撑爆；
 * - 失效会话超过保留期由维护任务清理。
 */
const sidOf = (setCookie: string | string[] | undefined): string => {
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie || '');
  const match = raw.match(/yj_sid=([^;]*)/);
  return match ? `yj_sid=${match[1]}` : '';
};

const cookieHeader = (setCookie: string | string[] | undefined): string =>
  Array.isArray(setCookie) ? setCookie[0] : String(setCookie || '');

describe('会话 Cookie 与累积（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // 测试环境基址是 http：auto 模式不应下发 Secure
    ctx = await createTestApp('session-hygiene');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('auto 模式下 http 请求不下发 Secure，登录态可用', async () => {
    const login = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);
    const cookie = cookieHeader(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    await request(ctx.baseUrl).get('/api/v1/auth/me').set('cookie', sidOf(login.headers['set-cookie'])).expect(200);
  });

  it('用户不存在时登录不下发任何会话 Cookie', async () => {
    const failed = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'nobody-here', password: 'Zx7#Qm2PvL' })
      .expect(401);
    expect(failed.headers['set-cookie']).toBeUndefined();
  });
});

describe('SESSION_COOKIE_SECURE=always 与登出清 Cookie（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('session-secure', { env: { SESSION_COOKIE_SECURE: 'always' } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('登录与登出的 Cookie 属性一致，都带 Secure', async () => {
    const login = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);
    expect(cookieHeader(login.headers['set-cookie'])).toContain('; Secure');

    const logout = await request(ctx.baseUrl)
      .post('/auth/logout')
      .set('cookie', sidOf(login.headers['set-cookie']))
      .expect(200);
    const cleared = cookieHeader(logout.headers['set-cookie']);
    expect(cleared).toContain('yj_sid=;');
    expect(cleared).toContain('Max-Age=0');
    // 与下发时同属性，否则浏览器会保留旧 Cookie
    expect(cleared).toContain('; Secure');
    expect(cleared).toContain('HttpOnly');
  });
});

describe('会话上限与保留期清理（e2e）', () => {
  let ctx: TestContext;
  let auth: AuthService;
  let db: DatabaseService;

  beforeAll(async () => {
    ctx = await createTestApp('session-limit', { env: { SESSION_MAX_PER_USER: '2' } });
    auth = ctx.app.get(AuthService);
    db = ctx.app.get(DatabaseService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('超出 SESSION_MAX_PER_USER 时吊销最早签发的会话', async () => {
    const cookies: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const login = await request(ctx.baseUrl)
        .post('/api/v1/auth/login')
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      cookies.push(sidOf(login.headers['set-cookie']));
    }
    // 最新一次可用
    await request(ctx.baseUrl).get('/api/v1/auth/me').set('cookie', cookies[2]).expect(200);
    // 最早一次已被顶下线
    await request(ctx.baseUrl).get('/api/v1/auth/me').set('cookie', cookies[0]).expect(401);

    const active = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.username = ? AND s.revoked_at IS NULL`,
      ADMIN.username,
    );
    expect(active?.n).toBe(2);
  });

  it('超过保留期的失效会话被清理，保留期内的留着', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const userId = db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', ADMIN.username)!.id;
    const insert = (sid: string, revokedAt: string) =>
      db.run(
        `INSERT INTO sessions (sid, user_id, issued_at, expires_at, idle_expires_at, last_seen_at, revoked_at, revoke_reason)
         VALUES (?,?,?,?,?,?,?,'logout')`,
        sid,
        userId,
        revokedAt,
        revokedAt,
        revokedAt,
        revokedAt,
        revokedAt,
      );
    insert('sid-old-1', old);
    insert('sid-recent-1', recent);

    const result = ctx.app.get(RetentionService).purgeExpiredSessions();
    expect(result.retentionDays).toBe(30);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(db.get('SELECT sid FROM sessions WHERE sid = ?', 'sid-old-1')).toBeUndefined();
    expect(db.get<{ sid: string }>('SELECT sid FROM sessions WHERE sid = ?', 'sid-recent-1')).toBeTruthy();
  });

  it('保留天数设 0 时不做清理', () => {
    const authService = ctx.app.get(AuthService);
    expect(authService.purgeExpiredSessions(0)).toBe(0);
  });
});

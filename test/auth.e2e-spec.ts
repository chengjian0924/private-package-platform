import request from 'supertest';
import { ADMIN, DEVELOPER, READER, createTestApp, type TestContext } from './app-factory';

describe('A2 本地账号认证（e2e）', () => {
  let ctx: TestContext;
  // lock-user 的初始口令：锁定用例创建后供最后的重置密码用例验证“旧口令失效”
  let lockUserInitial = '';

  beforeAll(async () => {
    ctx = await createTestApp('auth');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('健康检查返回运行环境信息', async () => {
    const res = await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.env).toBe('test');
    expect(res.body.data.port).toBe(ctx.port);
    expect(typeof res.body.data.packages).toBe('number');
  });

  it('未登录访问受保护接口返回统一错误信封与 traceId', async () => {
    const res = await request(ctx.baseUrl).get('/api/v1/auth/me').expect(401);
    expect(res.body.code).toBe('AUTH_UNAUTHENTICATED');
    expect(res.body.message).toBeTruthy();
    expect(res.body.traceId).toBeTruthy();
  });

  it('本地账号密码登录、会话复用与全局登出', async () => {
    const agent = request.agent(ctx.baseUrl);

    const login = await agent.post('/api/v1/auth/login').send({ username: ADMIN.username, password: ADMIN.password }).expect(200);
    expect(login.body.data.user.username).toBe('admin');
    expect(login.body.data.user.role).toBe('admin');
    // seed 阶段已完成改密，会话不应再带强制改密标记
    expect(login.body.data.mustChangePassword).toBe(false);
    expect(String(login.headers['set-cookie'])).toContain('yj_sid=');

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.user.username).toBe('admin');
    expect(me.body.data.permissions).toContain('audit:read');

    const logout = await agent.post('/auth/logout').expect(200);
    expect(logout.body.data.loggedOut).toBe(true);

    const afterLogout = await agent.get('/api/v1/auth/me').expect(401);
    expect(afterLogout.body.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('密码错误返回 401 并提示剩余次数，用户不存在不泄露差异', async () => {
    const wrong = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: 'totally-wrong-pass' })
      .expect(401);
    expect(wrong.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(wrong.body.details.remainingAttempts).toBe(4);

    // 用户不存在时错误码与口令错误一致，防止通过响应枚举账号
    const unknown = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'no-such-user', password: 'whatever-pass' })
      .expect(401);
    expect(unknown.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    // 登录成功后失败计数清零，不累计到后续锁定判定
    await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: ADMIN.username, password: ADMIN.password })
      .expect(200);
  });

  it('连续失败达到阈值触发账号临时锁定，锁定期间正确密码也拒绝', async () => {
    const created = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'lock-user', role: 'reader' })
      .expect(201);
    const initialPassword = created.body.data.initialPassword as string;
    lockUserInitial = initialPassword;

    // 阈值 5 次：前 4 次仍返回 401 并递减剩余次数
    for (let i = 4; i >= 1; i -= 1) {
      const res = await request(ctx.baseUrl)
        .post('/api/v1/auth/login')
        .send({ username: 'lock-user', password: 'still-wrong-pass' })
        .expect(401);
      expect(res.body.details.remainingAttempts).toBe(i);
    }

    // 第 5 次失败触发锁定
    const locked = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'lock-user', password: 'still-wrong-pass' })
      .expect(423);
    expect(locked.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(locked.body.details.retryAfterSec).toBeGreaterThan(0);

    // 锁定期间即使口令正确也被拒绝
    const blocked = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'lock-user', password: initialPassword })
      .expect(423);
    expect(blocked.body.code).toBe('AUTH_ACCOUNT_LOCKED');

    const list = await request(ctx.baseUrl).get('/api/v1/users').auth(ADMIN.username, ADMIN.password).expect(200);
    const row = (list.body.data.items as Record<string, unknown>[]).find((item) => item.username === 'lock-user');
    expect(row?.lockedUntil).toBeTruthy();
  });

  it('Basic 认证可直接访问控制台 API，角色权限按角色下发', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/auth/me')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(res.body.data.user.role).toBe('developer');
    expect(res.body.data.permissions).toContain('import:run');
    expect(res.body.data.permissions).not.toContain('audit:read');

    const check = await request(ctx.baseUrl)
      .get('/api/v1/auth/permissions/check?permission=audit:read')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(check.body.data.allowed).toBe(false);
  });

  it('只读角色越权执行导入被拒绝', async () => {
    const res = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(READER.username, READER.password)
      .expect(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
    expect(res.body.details.required).toBe('import:run');
  });

  it('访问令牌可创建、用于 Bearer 鉴权并可吊销', async () => {
    const created = await request(ctx.baseUrl)
      .post('/api/v1/auth/tokens')
      .auth(ADMIN.username, ADMIN.password)
      .send({ name: 'e2e-ci-token' })
      .expect(201);
    const token = created.body.data.token as string;
    expect(token.startsWith('yj_')).toBe(true);

    const me = await request(ctx.baseUrl).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.data.user.username).toBe('admin');

    const list = await request(ctx.baseUrl)
      .get('/api/v1/auth/tokens')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = (list.body.data.items as Record<string, string>[]).find((item) => item.name === 'e2e-ci-token');
    expect(record).toBeTruthy();

    await request(ctx.baseUrl)
      .post(`/api/v1/auth/tokens/${record!.token_hash}/revoke`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);

    const revoked = await request(ctx.baseUrl).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    expect(revoked.body.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('新用户首登强制改密：拦截业务接口直至完成改密，并吊销其它会话', async () => {
    const created = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'fresh-user', role: 'reader' })
      .expect(201);
    const initialPassword = created.body.data.initialPassword as string;

    // 两台"设备"分别登录，改密后旧会话应被吊销
    const deviceA = request.agent(ctx.baseUrl);
    const deviceB = request.agent(ctx.baseUrl);
    const loginA = await deviceA
      .post('/api/v1/auth/login')
      .send({ username: 'fresh-user', password: initialPassword })
      .expect(200);
    expect(loginA.body.data.mustChangePassword).toBe(true);
    await deviceB.post('/api/v1/auth/login').send({ username: 'fresh-user', password: initialPassword }).expect(200);

    // 白名单内的 me 可访问，业务接口被守卫拦截
    await deviceA.get('/api/v1/auth/me').expect(200);
    const blocked = await deviceA.get('/api/v1/packages').expect(403);
    expect(blocked.body.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');

    // 弱口令被服务端拒绝（短于最小长度 8）
    const weak = await deviceA
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: initialPassword, newPassword: 'Fresh-7', confirmPassword: 'Fresh-7' })
      .expect(400);
    expect(weak.body.code).toBe('SYS_VALIDATION');
    expect(String(weak.body.details?.reason)).toContain('长度');

    // 两次输入不一致被服务端拒绝：前端校验可被绕过，后端必须兜底
    const mismatch = await deviceA
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: initialPassword, newPassword: 'Reset-Pass-4dH8n', confirmPassword: 'Reset-Pass-4dH8m' })
      .expect(400);
    expect(mismatch.body.code).toBe('SYS_VALIDATION');
    expect(String(mismatch.body.details?.reason)).toContain('不一致');

    // 新旧密码相同被拒绝
    const same = await deviceA
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: initialPassword, newPassword: initialPassword, confirmPassword: initialPassword })
      .expect(400);
    expect(same.body.code).toBe('SYS_VALIDATION');

    // 合规改密成功，业务接口恢复访问
    await deviceA
      .post('/api/v1/auth/change-password')
      .send({
        oldPassword: initialPassword,
        newPassword: 'Reset-Pass-4dH8n',
        confirmPassword: 'Reset-Pass-4dH8n',
      })
      .expect(200);
    await deviceA.get('/api/v1/packages').expect(200);

    // 改密吊销其它端会话：deviceB 的旧会话失效，deviceA 仍在线
    const kicked = await deviceB.get('/api/v1/auth/me').expect(401);
    expect(kicked.body.code).toBe('AUTH_UNAUTHENTICATED');
    await deviceA.get('/api/v1/auth/me').expect(200);
  });

  it('首登强制改密不要求原密码，主动改密仍必须校验原密码', async () => {
    const created = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'no-old-pwd', role: 'reader' })
      .expect(201);
    const initialPassword = created.body.data.initialPassword as string;

    const agent = request.agent(ctx.baseUrl);
    await agent.post('/api/v1/auth/login').send({ username: 'no-old-pwd', password: initialPassword }).expect(200);

    // 强制改密：不传 oldPassword 也放行
    await agent
      .post('/api/v1/auth/change-password')
      .send({ newPassword: 'NoOld-Pass-71', confirmPassword: 'NoOld-Pass-71' })
      .expect(200);
    await agent.get('/api/v1/packages').expect(200);

    // 主动改密：缺原密码被拒，原密码错误被拒，且状态不受影响
    const missing = await agent
      .post('/api/v1/auth/change-password')
      .send({ newPassword: 'NoOld-Pass-72', confirmPassword: 'NoOld-Pass-72' })
      .expect(400);
    expect(missing.body.code).toBe('SYS_VALIDATION');
    expect(String(missing.body.details?.reason)).toContain('原密码');

    const wrong = await agent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: 'Wrong-Pass-72', newPassword: 'NoOld-Pass-72', confirmPassword: 'NoOld-Pass-72' })
      .expect(400);
    expect(wrong.body.code).toBe('SYS_VALIDATION');
    expect(String(wrong.body.details?.reason)).toContain('原密码错误');

    // 旧口令仍然有效，说明两次失败没有改到库里
    await agent.get('/api/v1/packages').expect(200);
    await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'no-old-pwd', password: 'NoOld-Pass-71' })
      .expect(200);
  });

  it('用户管理：管理员唯一、重复用户名、禁用与重置密码', async () => {
    // 重复用户名冲突
    const dup = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: DEVELOPER.username, role: 'reader' })
      .expect(409);
    expect(dup.body.code).toBe('SYS_CONFLICT');

    const list = await request(ctx.baseUrl).get('/api/v1/users').auth(ADMIN.username, ADMIN.password).expect(200);
    const items = list.body.data.items as Record<string, string>[];
    const adminRow = items.find((item) => item.username === ADMIN.username);
    expect(adminRow).toBeTruthy();

    // 系统只剩一个启用管理员时，降级与禁用都被拒绝，避免把系统锁死到无人可管理
    const demote = await request(ctx.baseUrl)
      .patch(`/api/v1/users/${adminRow!.id}`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ role: 'reader' })
      .expect(400);
    expect(String(demote.body.details?.reason)).toContain('管理员');
    await request(ctx.baseUrl)
      .patch(`/api/v1/users/${adminRow!.id}`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ status: 'disabled' })
      .expect(400);

    // 管理员账号唯一：普通账号不能被提升为管理员，也不能新建管理员
    const developerRow = items.find((item) => item.username === DEVELOPER.username);
    const promote = await request(ctx.baseUrl)
      .patch(`/api/v1/users/${developerRow!.id}`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ role: 'admin' })
      .expect(400);
    expect(String(promote.body.details?.reason)).toContain('管理员账号唯一');
    await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'second-admin', role: 'admin' })
      .expect(400);

    // 禁用普通用户：会话吊销 + 登录被拒
    const created = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'disabled-user', role: 'reader' })
      .expect(201);
    const disabledId = created.body.data.user.id as string;
    const disabledInitial = created.body.data.initialPassword as string;

    await request(ctx.baseUrl)
      .patch(`/api/v1/users/${disabledId}`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ status: 'disabled' })
      .expect(200);
    const rejected = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'disabled-user', password: disabledInitial })
      .expect(403);
    expect(rejected.body.code).toBe('AUTH_USER_DISABLED');

    // 重置密码：恢复角色固定初始密码，锁定解除并回到强制改密态
    const target = items.find((item) => item.username === 'lock-user');
    expect(target).toBeTruthy();
    const reset = await request(ctx.baseUrl)
      .post(`/api/v1/users/${target!.id}/reset-password`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const newPassword = reset.body.data.initialPassword as string;
    expect(newPassword).toBe('123123123');

    // 锁定随重置一并解除，重新回到强制改密态
    const relogin = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'lock-user', password: newPassword })
      .expect(200);
    expect(relogin.body.data.mustChangePassword).toBe(true);

    // 已改过密码的账号被重置后，改后的旧口令立即失效
    const resetUser = await request(ctx.baseUrl)
      .post('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .send({ username: 'reset-user', role: 'reader' })
      .expect(201);
    const resetUserId = resetUser.body.data.user.id as string;
    const resetAgent = request.agent(ctx.baseUrl);
    await resetAgent
      .post('/api/v1/auth/login')
      .send({ username: 'reset-user', password: resetUser.body.data.initialPassword })
      .expect(200);
    await resetAgent
      .post('/api/v1/auth/change-password')
      .send({
        oldPassword: resetUser.body.data.initialPassword,
        newPassword: 'RstUser-9q7',
        confirmPassword: 'RstUser-9q7',
      })
      .expect(200);
    await request(ctx.baseUrl)
      .post(`/api/v1/users/${resetUserId}/reset-password`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);

    await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'reset-user', password: 'RstUser-9q7' })
      .expect(401);
    const afterReset = await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'reset-user', password: '123123123' })
      .expect(200);
    expect(afterReset.body.data.mustChangePassword).toBe(true);
  });
});

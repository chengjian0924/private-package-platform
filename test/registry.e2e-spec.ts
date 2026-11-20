import request from 'supertest';
import AdmZip from 'adm-zip';
import * as crypto from 'node:crypto';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

/** 构造最小合法 wheel（zip），安全校验会做文件头与结构检查，不能再上传纯文本占位内容 */
function makeWheel(name: string, version: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `${name.replace(/-/g, '_')}-${version}.dist-info/METADATA`,
    Buffer.from(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`),
  );
  zip.addFile(`${name.replace(/-/g, '_')}/__init__.py`, Buffer.from(`VERSION = "${version}"\n`));
  zip.addFile(`${name.replace(/-/g, '_')}-${version}.dist-info/RECORD`, Buffer.from(''));
  return zip.toBuffer();
}

describe('npm / PyPI registry 协议（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('registry');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('npm ping 与未认证 whoami', async () => {
    const ping = await request(ctx.baseUrl).get('/npm/-/ping').expect(200);
    expect(ping.body).toEqual({});

    const whoami = await request(ctx.baseUrl).get('/npm/-/whoami').expect(401);
    expect(whoami.body.error).toBe('AUTH_UNAUTHENTICATED');
    expect(whoami.body.traceId).toBeTruthy();
  });

  it('npm whoami 使用 Basic 认证返回用户名', async () => {
    // npm 路由的 Basic 只认 API Token（password 位传 Token）
    const res = await request(ctx.baseUrl)
      .get('/npm/-/whoami')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .expect(200);
    expect(res.body.username).toBe('admin');
  });

  it('npm CLI 登录返回可复用令牌', async () => {
    const res = await request(ctx.baseUrl)
      .put('/npm/-/user/org.couchdb.user:admin')
      .send({ name: 'admin', password: ADMIN.password })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(String(res.body.token).startsWith('yj_')).toBe(true);
  });

  it('npm publish → packument → tarball 下载全链路', async () => {
    const dsh = { bundle: { patch: './cordis.patch.yml' } };
    const tarball = await makeNpmTarball('e2e-npm-lib', '1.0.0', {
      description: '端到端测试包',
      engines: { node: '>=18' },
      dsh,
    });

    const publish = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        _id: 'e2e-npm-lib',
        name: 'e2e-npm-lib',
        description: '端到端测试包',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'e2e-npm-lib', version: '1.0.0', dsh, dist: {} } },
        _attachments: {
          'e2e-npm-lib-1.0.0.tgz': { data: tarball.toString('base64'), length: tarball.length },
        },
      })
      .expect(201);
    expect(publish.body.versions).toEqual(['1.0.0']);

    // Token 归属法：Token 认证的发布审计行带 Token 维度，可按 Token 名过滤（下游项目追踪）
    const auditByToken = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=package.publish&tokenName=e2e-seed-admin')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const tokenRows = auditByToken.body.data.items as Array<Record<string, unknown>>;
    expect(tokenRows.length).toBeGreaterThanOrEqual(1);
    const publishRow = tokenRows.find((r) => r.resource_id === 'e2e-npm-lib');
    expect(publishRow?.actor_token_name).toBe('e2e-seed-admin');
    expect(publishRow?.actor_token_hash).toBeTruthy();

    const packument = await request(ctx.baseUrl).get('/npm/e2e-npm-lib').expect(200);
    expect(packument.body.name).toBe('e2e-npm-lib');
    expect(packument.body['dist-tags'].latest).toBe('1.0.0');
    // dsh 组合包声明必须从 package.json 透传到 packument，harness 据此识别插件
    expect(packument.body.dsh).toEqual(dsh);
    expect(packument.body.versions['1.0.0'].dsh).toEqual(dsh);
    expect(packument.body.versions['1.0.0'].dist.tarball).toContain('/npm/e2e-npm-lib/-/e2e-npm-lib-1.0.0.tgz');

    const download = await request(ctx.baseUrl).get('/npm/e2e-npm-lib/-/e2e-npm-lib-1.0.0.tgz').expect(200);
    expect(Number(download.headers['content-length'])).toBe(tarball.length);
    expect(download.headers.etag).toBeTruthy();

    const search = await request(ctx.baseUrl).get('/npm/-/v1/search?text=e2e-npm').expect(200);
    expect(search.body.total).toBeGreaterThanOrEqual(1);

    // 包管理界面按版本展示上传人：详情接口必须回填姓名，且不得暴露 uploader_id
    const users = await request(ctx.baseUrl)
      .get('/api/v1/users')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const adminRow = (users.body.data.items as Array<Record<string, unknown>>).find(
      (u) => u.username === ADMIN.username,
    );
    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail?ecosystem=npm&name=e2e-npm-lib')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions[0].uploaderName).toBe(adminRow?.displayName ?? ADMIN.username);
    expect(detail.body.data.versions[0].uploaderId).toBeUndefined();
  });

  it('npm 重复版本与非法版本返回 registry 错误体', async () => {
    const tarball = await makeNpmTarball('e2e-npm-lib', '1.0.0');
    const duplicate = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        versions: { '1.0.0': { version: '1.0.0' } },
        _attachments: { 'e2e-npm-lib-1.0.0.tgz': { data: tarball.toString('base64') } },
      })
      .expect(409);
    expect(duplicate.body.error).toBe('PKG_VERSION_DUPLICATE');

    const invalid = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib-bad')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib-bad',
        versions: { abc: { version: 'abc' } },
        _attachments: { 'bad.tgz': { data: Buffer.from('x').toString('base64') } },
      })
      .expect(400);
    expect(invalid.body.error).toBe('PKG_VERSION_INVALID');
  });

  it('npm 多版本发布任一版本重复时整体拒绝（原子性）', async () => {
    // 先发布 1.5.0，随后尝试一次性发布 {1.1.0, 1.5.0, 1.2.0}，中途版本重复必须整体失败
    const existing = await makeNpmTarball('e2e-npm-lib', '1.5.0');
    await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        versions: { '1.5.0': { version: '1.5.0' } },
        _attachments: { 'e2e-npm-lib-1.5.0.tgz': { data: existing.toString('base64') } },
      })
      .expect(201);

    const v110 = await makeNpmTarball('e2e-npm-lib', '1.1.0');
    const v120 = await makeNpmTarball('e2e-npm-lib', '1.2.0');
    const partial = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        versions: {
          '1.1.0': { version: '1.1.0' },
          '1.5.0': { version: '1.5.0' },
          '1.2.0': { version: '1.2.0' },
        },
        _attachments: {
          'e2e-npm-lib-1.1.0.tgz': { data: v110.toString('base64') },
          'e2e-npm-lib-1.5.0.tgz': { data: existing.toString('base64') },
          'e2e-npm-lib-1.2.0.tgz': { data: v120.toString('base64') },
        },
      })
      .expect(409);
    expect(partial.body.error).toBe('PKG_VERSION_DUPLICATE');

    // 原子性验证：未重复的 1.1.0 / 1.2.0 不得入库
    const packument = await request(ctx.baseUrl).get('/npm/e2e-npm-lib').expect(200);
    expect(packument.body.versions['1.1.0']).toBeUndefined();
    expect(packument.body.versions['1.2.0']).toBeUndefined();
    expect(packument.body.versions['1.5.0']).toBeTruthy();
  });

  it('npm SRI integrity 为权威校验，shasum 一致不能掩盖不一致（RV-23）', async () => {
    const tarball = await makeNpmTarball('e2e-npm-lib', '1.3.0');
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
    const forged = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        versions: {
          '1.3.0': {
            version: '1.3.0',
            // integrity 填错、shasum 填对：旧实现会放过，必须按 integrity 拒绝
            dist: { integrity: `sha512-${Buffer.from('tampered').toString('base64')}`, shasum },
          },
        },
        _attachments: { 'e2e-npm-lib-1.3.0.tgz': { data: tarball.toString('base64') } },
      })
      .expect(400);
    expect(forged.body.error).toBe('PKG_INTEGRITY_MISMATCH');

    const packument = await request(ctx.baseUrl).get('/npm/e2e-npm-lib').expect(200);
    expect(packument.body.versions['1.3.0']).toBeUndefined();
  });

  it('npm publish --tag 自定义 dist-tags 持久化并在 packument 输出', async () => {
    const tarball = await makeNpmTarball('e2e-npm-lib', '2.0.0');
    const publish = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        'dist-tags': { beta: '2.0.0' },
        versions: { '2.0.0': { version: '2.0.0' } },
        _attachments: { 'e2e-npm-lib-2.0.0.tgz': { data: tarball.toString('base64') } },
      })
      .expect(201);
    expect(publish.body.versions).toEqual(['2.0.0']);

    const packument = await request(ctx.baseUrl).get('/npm/e2e-npm-lib').expect(200);
    // latest 按语义化版本动态计算；beta 为持久化的自定义标签
    expect(packument.body['dist-tags'].latest).toBe('2.0.0');
    expect(packument.body['dist-tags'].beta).toBe('2.0.0');

    // 标签指向非本次发布版本时按 npm 协议拒绝
    const badTag = await request(ctx.baseUrl)
      .put('/npm/e2e-npm-lib')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-npm-lib',
        'dist-tags': { next: '9.9.9' },
        versions: { '2.1.0': { version: '2.1.0' } },
        _attachments: { 'e2e-npm-lib-2.1.0.tgz': { data: (await makeNpmTarball('e2e-npm-lib', '2.1.0')).toString('base64') } },
      })
      .expect(400);
    expect(badTag.body.error).toBe('SYS_VALIDATION');
  });

  it('PyPI twine 上传 → simple 索引 → 文件下载全链路', async () => {
    const wheelName = 'e2e_pypi_lib-1.0.0-py3-none-any.whl';
    const wheel = makeWheel('e2e-pypi-lib', '1.0.0');

    const upload = await request(ctx.baseUrl)
      .post('/pypi/legacy/')
      .auth(ADMIN.username, ADMIN.password)
      .field('name', 'e2e-pypi-lib')
      .field('version', '1.0.0')
      .field(':action', 'file_upload')
      .attach('file', wheel, wheelName)
      .expect(200);
    expect(upload.text).toBe('OK');

    const index = await request(ctx.baseUrl).get('/pypi/simple/').expect(200);
    expect(index.text).toContain('e2e-pypi-lib');

    const project = await request(ctx.baseUrl).get('/pypi/simple/e2e-pypi-lib/').expect(200);
    expect(project.text).toContain(wheelName);

    const download = await request(ctx.baseUrl).get(`/pypi/packages/${wheelName}`).expect(200);
    expect(Number(download.headers['content-length'])).toBe(wheel.length);
  });

  it('PyPI 非法文件名上传被拒绝', async () => {
    const res = await request(ctx.baseUrl)
      .post('/pypi/legacy/')
      .auth(ADMIN.username, ADMIN.password)
      .field('name', 'e2e-pypi-bad')
      .field('version', '1.0.0')
      .attach('file', Buffer.from('bad'), 'not-a-package.txt')
      .expect(400);
    expect(res.body.error).toBe('PKG_TARBALL_INVALID');
  });

  it('registry 未认证上传被拒绝', async () => {
    const res = await request(ctx.baseUrl)
      .put('/npm/e2e-anonymous')
      .send({ name: 'e2e-anonymous', versions: { '1.0.0': {} }, _attachments: {} })
      .expect(401);
    expect(res.body.error).toBe('AUTH_UNAUTHENTICATED');
  });
});

import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { resetConfigCache } from '../src/config/config';

/**
 * 单请求附件总量上限：多版本发布时逐个校验单文件无法约束累计体积，
 * 这里把业务上限压到极小值，验证累计超限的发布在解码/扫描前就被拒绝。
 */
describe('npm 发布附件总量上限（e2e）', () => {
  let ctx: TestContext;
  const saved = process.env.MAX_NPM_UPLOAD_BYTES;

  beforeAll(async () => {
    process.env.MAX_NPM_UPLOAD_BYTES = '64'; // 每个 tarball 都超过 64 字节
    resetConfigCache();
    ctx = await createTestApp('publish-total-limit');
  });
  afterAll(async () => {
    await ctx.close();
    if (saved === undefined) delete process.env.MAX_NPM_UPLOAD_BYTES;
    else process.env.MAX_NPM_UPLOAD_BYTES = saved;
    resetConfigCache();
  });

  it('附件累计超过单请求上限时返回 413，零版本入库', async () => {
    const tarball = await makeNpmTarball('e2e-total-limit', '1.0.0');
    const res = await request(ctx.baseUrl)
      .put('/npm/e2e-total-limit')
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: 'e2e-total-limit',
        versions: { '1.0.0': { version: '1.0.0' } },
        _attachments: { 'e2e-total-limit-1.0.0.tgz': { data: tarball.toString('base64') } },
      })
      .expect(413);
    expect(res.body.error).toBe('UPLOAD_FILE_TOO_LARGE');

    // 校验未产生任何入库：packument 仍为 404
    await request(ctx.baseUrl).get('/npm/e2e-total-limit').expect(404);
  });
});

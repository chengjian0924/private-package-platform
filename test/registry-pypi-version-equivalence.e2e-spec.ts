import request from 'supertest';
import AdmZip from 'adm-zip';
import { ADMIN, createTestApp, type TestContext } from './app-factory';

/** 构造最小 wheel：文件名里的版本与 METADATA 里的版本由调用方分别指定 */
function makeWheel(filenameVersion: string, metadataVersion: string): Buffer {
  const zip = new AdmZip();
  const distInfo = `pep440_dup-${filenameVersion.replace(/[^0-9a-z.]/gi, '_')}.dist-info`;
  zip.addFile(
    `${distInfo}/METADATA`,
    Buffer.from(`Metadata-Version: 2.1\nName: pep440-dup\nVersion: ${metadataVersion}\n`),
  );
  zip.addFile(`${distInfo}/RECORD`, Buffer.from(''));
  return zip.toBuffer();
}

async function upload(ctx: TestContext, version: string): Promise<request.Response> {
  const filename = `pep440_dup-${version}-py3-none-any.whl`;
  return request(ctx.baseUrl)
    .post('/pypi/legacy/')
    .auth(ADMIN.username, ADMIN.password)
    .field('name', 'pep440-dup')
    .field('version', version)
    .field(':action', 'file_upload')
    .attach('file', makeWheel(version, version), filename);
}

describe('PyPI 版本按 PEP 440 相等语义去重（e2e）', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp('pypi-version-equivalence');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('先传 1.0.0 后传 v1.0：第二个被判重复，同一个包版本只保留一个', async () => {
    const first = await upload(ctx, '1.0.0');
    expect(first.status).toBe(200);

    const second = await request(ctx.baseUrl)
      .post('/pypi/legacy/')
      .auth(ADMIN.username, ADMIN.password)
      .field('name', 'pep440-dup')
      .field('version', 'v1.0')
      .field(':action', 'file_upload')
      .attach('file', makeWheel('v1.0', 'v1.0'), 'pep440_dup-v1.0-py3-none-any.whl')
      .expect(400);
    // PyPI 上传校验失败统一以 PKG_TARBALL_INVALID 返回，重复原因在 reason 里
    expect(second.body.error).toBe('PKG_TARBALL_INVALID');
    expect(second.body.reason).toContain('该版本已存在于私有源');

    // 索引中只应看到最初入库的 1.0.0 一个下载链接
    const project = await request(ctx.baseUrl).get('/pypi/simple/pep440-dup/').expect(200);
    expect(project.text.match(/href="\/pypi\/packages\//g)).toHaveLength(1);
    expect(project.text).toContain('pep440_dup-1.0.0-py3-none-any.whl');
  });

  it('真正不同的版本仍可正常入库', async () => {
    const res = await upload(ctx, '2.0.0');
    expect(res.status).toBe(200);
    const project = await request(ctx.baseUrl).get('/pypi/simple/pep440-dup/').expect(200);
    expect(project.text).toContain('pep440_dup-2.0.0-py3-none-any.whl');
  });

  it('查询等价版本可命中已入库条目', async () => {
    // 用 1.0 重新上报，服务端按规范键查重，仍应判重复（而不是当作新版本）
    const res = await upload(ctx, '1.0');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PKG_TARBALL_INVALID');
    expect(res.body.reason).toContain('该版本已存在于私有源');
  });
});

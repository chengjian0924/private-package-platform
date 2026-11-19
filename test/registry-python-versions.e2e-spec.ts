import request from 'supertest';
import AdmZip from 'adm-zip';
import { ADMIN, createTestApp, type TestContext } from './app-factory';

function makeWheel(name: string, version: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `${name.replace(/-/g, '_')}-${version}.dist-info/METADATA`,
    Buffer.from(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nRequires-Python: >=3.15\n`),
  );
  zip.addFile(`${name.replace(/-/g, '_')}/__init__.py`, Buffer.from(`VERSION = "${version}"\n`));
  zip.addFile(`${name.replace(/-/g, '_')}-${version}.dist-info/RECORD`, Buffer.from(''));
  return zip.toBuffer();
}

describe('F1 通用 PyPI 仓库：任意 Python 版本 wheel 全链路（e2e）', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestApp('cp315'); });
  afterAll(async () => { await ctx.close(); });

  it.each([
    ['cp315', 'e2e-lib-315', 'e2e_lib_315-2.0.0-cp315-cp315-manylinux_2_17_x86_64.whl'],
    ['cp312', 'e2e-lib-312', 'e2e_lib_312-2.0.0-cp312-cp312-win_amd64.whl'],
    ['cp38',  'e2e-lib-38',  'e2e_lib_38-2.0.0-cp38-cp38-manylinux1_x86_64.whl'],
  ])('%s wheel 可上传 → 索引 → 下载', async (_tag, name, filename) => {
    const wheel = makeWheel(name, '2.0.0');
    const up = await request(ctx.baseUrl)
      .post('/pypi/legacy/')
      .auth(ADMIN.username, ADMIN.password)
      .field('name', name)
      .field('version', '2.0.0')
      .field(':action', 'file_upload')
      .field('python_version', '3.11')          // 模拟 twine 在 3.11 上上传 cp315 包
      .field('requires_python', '>=3.15')
      .attach('file', wheel, filename)
      .expect(200);
    expect(up.text).toBe('OK');

    const index = await request(ctx.baseUrl).get('/pypi/simple/').expect(200);
    expect(index.text).toContain(name);
    const project = await request(ctx.baseUrl).get(`/pypi/simple/${name}/`).expect(200);
    expect(project.text).toContain(filename);
    const dl = await request(ctx.baseUrl).get(`/pypi/packages/${filename}`).expect(200);
    expect(Number(dl.headers['content-length'])).toBe(wheel.length);
  });
});

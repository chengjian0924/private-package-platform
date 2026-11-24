import request from 'supertest';
import AdmZip from 'adm-zip';
import * as fsp from 'node:fs/promises';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { getConfig } from '../src/config/config';

/** 构造最小 wheel，内容不参与校验重点，仅用于制造 multipart 文件 */
function makeWheel(): Buffer {
  const zip = new AdmZip();
  const distInfo = 'multi_upload-1.0.dist-info';
  zip.addFile(`${distInfo}/METADATA`, Buffer.from('Metadata-Version: 2.1\nName: multi-upload\nVersion: 1.0\n'));
  zip.addFile(`${distInfo}/RECORD`, Buffer.from(''));
  return zip.toBuffer();
}

describe('PyPI 上传只接受单文件且清理全部临时文件（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('pypi-multi-upload');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('一次 multipart 带两个文件：返回 400，且两个临时文件都被清理', async () => {
    const tmpDir = getConfig().tmpDir;
    await fsp.mkdir(tmpDir, { recursive: true });
    const before = new Set(await fsp.readdir(tmpDir));

    const res = await request(ctx.baseUrl)
      .post('/pypi/legacy/')
      .auth(ADMIN.username, ADMIN.password)
      .field('name', 'multi-upload')
      .field('version', '1.0')
      .field(':action', 'file_upload')
      .attach('file', makeWheel(), 'multi_upload-1.0-py3-none-any.whl')
      .attach('file', makeWheel(), 'multi_upload-1.0.tar.gz');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_MULTIPLE_FILES');

    // multer 会先把两个文件都写盘；上传路径必须在 finally 里把本次新增的文件全部删除
    const after = await fsp.readdir(tmpDir);
    const leaked = after.filter((name) => !before.has(name));
    expect(leaked).toHaveLength(0);
  });
});

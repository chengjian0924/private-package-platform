import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { DatabaseService } from '../src/db/database.service';

/**
 * 导入幂等（manifest_hash 去重）：
 * - 同一操作者重复提交同一批包（双击、浏览器重发、网络重试）→ 命中同一批次，不重复落盘；
 * - 文件名相同但内容不同（同名同版本重新打包）→ 视为不同批次，不能被误判成重复；
 * - 已结束的批次不复用（那多半是「删了版本想重导」，交给版本查重给出明确提示）。
 */
describe('导入幂等去重（e2e）', () => {
  let ctx: TestContext;

  const upload = (files: { buf: Buffer; name: string }[]) => {
    const req = request(ctx.baseUrl).post('/api/v1/import-batches/auto').auth(ADMIN.username, ADMIN.password);
    for (const file of files) req.attach('files', file.buf, file.name);
    return req;
  };

  const batchCount = () =>
    ctx.app.get(DatabaseService).get<{ n: number }>('SELECT COUNT(*) AS n FROM import_batches')?.n ?? 0;

  beforeAll(async () => {
    ctx = await createTestApp('import-dedupe');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('同内容重复提交复用同一批次，不再新建批次行', async () => {
    const pkg = await makeNpmTarball('e2e-idem', '1.0.0', { description: '幂等测试' });
    const files = [{ buf: pkg, name: 'e2e-idem-1.0.0.tgz' }];

    const before = await batchCount();
    const first = await upload(files).expect(201);
    expect(first.body.data.deduplicated).toBeUndefined();
    expect(before + 1).toBe(await batchCount());

    const second = await upload(files).expect(201);
    expect(second.body.data.deduplicated).toBe(true);
    expect(second.body.data.batchId).toBe(first.body.data.batchId);
    // 复用不再落一行
    expect(await batchCount()).toBe(before + 1);
    // 预览照常回放：前端依赖它展示「识别 N 个包」
    expect(second.body.data.preview.total).toBe(1);
    expect(second.body.data.preview.newCount).toBe(1);
  });

  it('校验完成后重复提交仍复用该批次，并回放同一份预览', async () => {
    const pkg = await makeNpmTarball('e2e-idem-2', '2.0.0');
    const files = [{ buf: pkg, name: 'e2e-idem-2-2.0.0.tgz' }];
    const first = await upload(files).expect(201);
    const batchId = first.body.data.batchId as string;

    await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);

    const again = await upload(files).expect(201);
    expect(again.body.data.deduplicated).toBe(true);
    expect(again.body.data.batchId).toBe(batchId);
    expect(again.body.data.status).toBe('VALIDATED');
    // preview 在 validate 覆盖 stats 之后仍然保留
    expect(again.body.data.preview.total).toBe(1);
  });

  it('文件名与版本相同但内容不同，视为不同批次', async () => {
    const a = await makeNpmTarball('e2e-idem-3', '3.0.0', { description: 'A' });
    const b = await makeNpmTarball('e2e-idem-3', '3.0.0', { description: 'B' });
    const name = 'e2e-idem-3-3.0.0.tgz';

    const first = await upload([{ buf: a, name }]).expect(201);
    const second = await upload([{ buf: b, name }]).expect(201);
    expect(second.body.data.deduplicated).toBeUndefined();
    expect(second.body.data.batchId).not.toBe(first.body.data.batchId);
  });

  it('上传顺序不同但内容相同，仍算同一批', async () => {
    const x = await makeNpmTarball('e2e-idem-x', '1.0.0');
    const y = await makeNpmTarball('e2e-idem-y', '1.0.0');
    const first = await upload([
      { buf: x, name: 'e2e-idem-x-1.0.0.tgz' },
      { buf: y, name: 'e2e-idem-y-1.0.0.tgz' },
    ]).expect(201);
    const second = await upload([
      { buf: y, name: 'e2e-idem-y-1.0.0.tgz' },
      { buf: x, name: 'e2e-idem-x-1.0.0.tgz' },
    ]).expect(201);
    expect(second.body.data.deduplicated).toBe(true);
    expect(second.body.data.batchId).toBe(first.body.data.batchId);
  });
});

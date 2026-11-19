import * as fs from 'node:fs';
import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';

const WHEEL = '/Users/kong/Downloads/numpy-2.5.5-cp315-cp315t-win_arm64.whl';

describe('F2 官方大包行为规则误报不阻断导入（e2e）', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestApp('numpy-import'); });
  afterAll(async () => { await ctx.close(); });

  it('numpy 官方 wheel 命中 BEH-001/004/006 后仍 VALID 且可提交', async () => {
    // 该用例依赖本地下载的 numpy wheel；缺失时跳过（规则层已有内联单测覆盖）。
    if (!fs.existsSync(WHEEL)) {
      console.warn(`跳过：未找到 ${WHEEL}`);
      return;
    }
    const buffer = fs.readFileSync(WHEEL);
    const filename = 'numpy-2.5.5-cp315-cp315t-win_arm64.whl';

    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', buffer, filename)
      .expect(201);
    const batchId = created.body.data.batchId as string;
    expect(batchId).toBeTruthy();
    expect(created.body.data.failed).toEqual([]);

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats.securityBlocked).toBe(0);
    expect(validated.body.data.stats.valid).toBe(1);

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const items = batch.body.data.items as { name: string; status: string; reasonCodes: string[]; security?: { disposition: string } }[];
    expect(items[0].status).toBe('VALID');
    expect(items[0].reasonCodes).not.toContain('SEC_QUARANTINED');
    expect(items[0].reasonCodes).not.toContain('SEC_BLOCKED');

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'strict' })
      .expect(201);
    expect(committed.body.data.stats.committed).toBe(1);
  }, 120000);
});

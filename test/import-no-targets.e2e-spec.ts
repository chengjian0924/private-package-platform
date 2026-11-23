import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

/**
 * 通用源策略回归：未配置 DEFAULT_NODE_TARGET / DEFAULT_PYTHON_TARGET 时，
 * auto 导入不能因为"缺运行时目标"整批 INVALID（与 engines 不匹配只告警的口径一致）。
 */
describe('A1b 未配置默认运行时目标仍可入库（e2e）', () => {
  let ctx: TestContext;
  const savedNode = process.env.DEFAULT_NODE_TARGET;
  const savedPython = process.env.DEFAULT_PYTHON_TARGET;

  beforeAll(async () => {
    process.env.DEFAULT_NODE_TARGET = '';
    process.env.DEFAULT_PYTHON_TARGET = '';
    ctx = await createTestApp('import-no-targets');
  });

  afterAll(async () => {
    await ctx.close();
    if (savedNode === undefined) delete process.env.DEFAULT_NODE_TARGET;
    else process.env.DEFAULT_NODE_TARGET = savedNode;
    if (savedPython === undefined) delete process.env.DEFAULT_PYTHON_TARGET;
    else process.env.DEFAULT_PYTHON_TARGET = savedPython;
  });

  it('TARGET_UNDECLARED 降级为 warning，条目 VALID 且可提交入库', async () => {
    const tarball = await makeNpmTarball('e2e-no-target-lib', '1.0.0');
    const created = await request(ctx.baseUrl)
      .post('/api/v1/import-batches/auto')
      .auth(ADMIN.username, ADMIN.password)
      .attach('files', tarball, 'e2e-no-target-lib-1.0.0.tgz')
      .expect(201);
    const batchId = created.body.data.batchId as string;
    expect(batchId).toBeTruthy();

    const validated = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/validate`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(validated.body.data.stats).toMatchObject({ valid: 1, invalid: 0 });
    // 批次级提示仍保留，供运维知道没配默认目标
    expect(validated.body.data.stats.targetIssues).toContain('targets.node');

    const batch = await request(ctx.baseUrl)
      .get(`/api/v1/import-batches/${batchId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const item = (
      batch.body.data.items as {
        status: string;
        reasonCodes: string[];
        issues: { code: string; severity: string }[];
      }[]
    )[0];
    expect(item.status).toBe('VALID');
    expect(item.reasonCodes).toContain('TARGET_UNDECLARED');
    expect(item.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TARGET_UNDECLARED', severity: 'warning' })]),
    );

    const committed = await request(ctx.baseUrl)
      .post(`/api/v1/import-batches/${batchId}/commit`)
      .auth(ADMIN.username, ADMIN.password)
      .send({ mode: 'partial' })
      .expect(201);
    expect(committed.body.data.stats).toMatchObject({ committed: 1, skipped: 0, failed: 0 });

    const packument = await request(ctx.baseUrl).get('/npm/e2e-no-target-lib').expect(200);
    expect(packument.body.versions['1.0.0']).toBeTruthy();
  });
});

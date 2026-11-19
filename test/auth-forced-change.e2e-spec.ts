import request from 'supertest';
import ExcelJS from 'exceljs';
import { createTestApp, type TestContext } from './app-factory';

const ADMIN_INITIAL = 'admin123';
const USER_INITIAL = '123123123';
// 新密码满足：≥8 位、不含用户名、无常见弱口令片段
const ADMIN_NEW_PASSWORD = 'Forced-Root-9qK';
const DEV_PASSWORD = 'DevPass-2026-Kx';
const BATCH_PASSWORD = 'BatchA-Pass-2026';
const XLSX_PASSWORD = 'XlsxUser-Pass-7f';

/** 批量建号只接受 xlsx：按表头 + 数据行造一份上传内容 */
async function xlsxBase64(rows: (string | number)[][]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('users');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer).toString('base64');
}

/** 首登账号访问业务接口应统一返回该错误，避免 401/403 混淆导致前端无法区分 */
const FORCED_CODE = 'AUTH_PASSWORD_CHANGE_REQUIRED';

describe('首次登录强制改密与批量建号（e2e）', () => {
  let ctx: TestContext;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    // skipSeed：保留内置管理员 admin/admin123 与 must_change_password=1 的首登态
    ctx = await createTestApp('forced-change', { skipSeed: true });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('内置管理员用 admin123 登录后仅能访问改密白名单接口', async () => {
    adminAgent = request.agent(ctx.baseUrl);

    const login = await adminAgent
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: ADMIN_INITIAL })
      .expect(200);
    expect(login.body.data.mustChangePassword).toBe(true);

    // 白名单：查看自身信息放行
    const me = await adminAgent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.user.username).toBe('admin');

    // 业务接口全部拦截：读接口、写接口、管理接口
    for (const method of ['get', 'post'] as const) {
      const paths = method === 'get'
        ? ['/api/v1/packages', '/api/v1/users', '/api/v1/audit-logs', '/api/v1/security/scans']
        : ['/api/v1/users/batch'];
      for (const path of paths) {
        const res = await (method === 'get' ? adminAgent.get(path) : adminAgent.post(path).send({}));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(FORCED_CODE);
      }
    }
  });

  it('改密参数校验：缺确认密码、长度不足、两次不一致均被拒绝且状态不变', async () => {
    const missing = await adminAgent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: ADMIN_INITIAL, newPassword: ADMIN_NEW_PASSWORD })
      .expect(400);
    expect(missing.body.code).toBe('SYS_VALIDATION');

    const short = await adminAgent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: ADMIN_INITIAL, newPassword: 'Short-7', confirmPassword: 'Short-7' })
      .expect(400);
    expect(short.body.code).toBe('SYS_VALIDATION');
    expect(String(short.body.details?.reason)).toContain('长度');

    const mismatch = await adminAgent
      .post('/api/v1/auth/change-password')
      .send({
        oldPassword: ADMIN_INITIAL,
        newPassword: ADMIN_NEW_PASSWORD,
        confirmPassword: `${ADMIN_NEW_PASSWORD}x`,
      })
      .expect(400);
    expect(mismatch.body.code).toBe('SYS_VALIDATION');
    expect(String(mismatch.body.details?.reason)).toContain('不一致');

    // 校验失败不应推进状态：业务接口依旧被拦
    const stillBlocked = await adminAgent.get('/api/v1/users').expect(403);
    expect(stillBlocked.body.code).toBe(FORCED_CODE);
  });

  it('内置管理员完成首次改密后状态持久化，重新登录不再触发', async () => {
    // 首登强制改密不要求原密码：账号本来就是用初始口令登进来的
    await adminAgent
      .post('/api/v1/auth/change-password')
      .send({
        newPassword: ADMIN_NEW_PASSWORD,
        confirmPassword: ADMIN_NEW_PASSWORD,
      })
      .expect(200);

    // 当前会话立即恢复业务权限
    const users = await adminAgent.get('/api/v1/users').expect(200);
    const adminRow = (users.body.data.items as Record<string, unknown>[]).find((item) => item.username === 'admin');
    expect(adminRow?.mustChangePassword).toBe(false);

    // 新会话不再触发强制改密；旧初始密码失效
    await adminAgent.post('/auth/logout').expect(200);
    const relogin = await adminAgent
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: ADMIN_NEW_PASSWORD })
      .expect(200);
    expect(relogin.body.data.mustChangePassword).toBe(false);
    await adminAgent.get('/api/v1/users').expect(200);

    await request(ctx.baseUrl)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: ADMIN_INITIAL })
      .expect(401);
  });

  it('管理员账号唯一：接口拒绝新建管理员，批量建号也拒绝 admin 行', async () => {
    const created = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'ops-admin', displayName: '运维管理员', role: 'admin' })
      .expect(400);
    expect(created.body.code).toBe('SYS_VALIDATION');
    expect(String(created.body.details?.reason)).toContain('管理员账号唯一');

    const list = await adminAgent.get('/api/v1/users').expect(200);
    const admins = (list.body.data.items as Record<string, unknown>[]).filter((item) => item.role === 'admin');
    expect(admins.length).toBe(1);

    // 批量建号同样不给管理员开口子，失败原因明确指向唯一性
    const batch = await adminAgent
      .post('/api/v1/users/batch')
      .send({
        fileName: 'users.xlsx',
        contentBase64: await xlsxBase64([
          ['账号', '姓名', '邮箱', '角色'],
          ['batch-admin', '', '', 'admin'],
        ]),
      })
      .expect(201);
    expect(batch.body.data.failedCount).toBe(1);
    expect(String((batch.body.data.failed as Record<string, unknown>[])[0].reason)).toContain('管理员账号唯一');
  });

  it('新建普通账号初始密码为 123123123，首登强制改密后才能进入系统', async () => {
    const created = await adminAgent
      .post('/api/v1/users')
      .send({ username: 'dev-user', displayName: '开发同学', role: 'developer' })
      .expect(201);
    expect(created.body.data.initialPassword).toBe(USER_INITIAL);

    const agent = request.agent(ctx.baseUrl);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ username: 'dev-user', password: USER_INITIAL })
      .expect(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    expect((await agent.get('/api/v1/packages')).status).toBe(403);

    await agent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: USER_INITIAL, newPassword: DEV_PASSWORD, confirmPassword: DEV_PASSWORD })
      .expect(200);

    await agent.get('/api/v1/packages').expect(200);
    await agent.post('/auth/logout').expect(200);
    const relogin = await agent
      .post('/api/v1/auth/login')
      .send({ username: 'dev-user', password: DEV_PASSWORD })
      .expect(200);
    expect(relogin.body.data.mustChangePassword).toBe(false);
  });

  it('Excel 批量建号：逐行校验并返回成功/失败明细，成功账号首登强制改密', async () => {
    const res = await adminAgent
      .post('/api/v1/users/batch')
      .send({
        fileName: 'users.xlsx',
        contentBase64: await xlsxBase64([
          ['账号', '姓名', '邮箱', '角色'],
          ['batch-a', '批量 A', '', 'developer'],
          ['batch-b', '', 'batch-b@corp.local', 'reader'],
          ['batch-a', '', '', 'reader'],
          ['ab', '', '', 'reader'],
          ['dev-user', '', '', 'reader'],
          ['batch-c', '', '', 'root'],
        ]),
      })
      .expect(201);

    const data = res.body.data;
    expect(data.total).toBe(6);
    expect(data.createdCount).toBe(2);
    expect(data.failedCount).toBe(4);
    expect((data.created as Record<string, unknown>[]).map((item) => item.username).sort()).toEqual(['batch-a', 'batch-b']);
    expect((data.created as Record<string, unknown>[]).every((item) => item.initialPassword === USER_INITIAL)).toBe(true);

    const failed = data.failed as Record<string, unknown>[];
    expect(failed.map((item) => item.row)).toEqual([3, 4, 5, 6]);
    expect(String(failed[0].reason)).toContain('重复');
    expect(String(failed[1].reason)).toContain('格式');
    expect(String(failed[2].reason)).toContain('已存在');
    expect(String(failed[3].reason)).toContain('角色');

    // 批量创建的账号登录后同样进入强制改密
    const agent = request.agent(ctx.baseUrl);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ username: 'batch-a', password: USER_INITIAL })
      .expect(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    expect((await agent.get('/api/v1/packages')).status).toBe(403);

    await agent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: USER_INITIAL, newPassword: BATCH_PASSWORD, confirmPassword: BATCH_PASSWORD })
      .expect(200);
    await agent.get('/api/v1/packages').expect(200);
  });

  it('只接受 XLSX：CSV 被拒绝，XLSX 建号后账号同样触发强制改密，模板可下载', async () => {
    const csv = ['username,displayName,email,role', 'csv-user,CSV 用户,csv@corp.local,reader', ''].join('\n');
    const csvRes = await adminAgent
      .post('/api/v1/users/batch')
      .send({ fileName: 'users.csv', contentBase64: Buffer.from(csv, 'utf8').toString('base64') })
      .expect(400);
    expect(csvRes.body.code).toBe('SYS_VALIDATION');
    expect(String(csvRes.body.details?.reason)).toContain('.xlsx');

    const xlsxRes = await adminAgent
      .post('/api/v1/users/batch')
      .send({
        fileName: 'users.xlsx',
        contentBase64: await xlsxBase64([
          ['用户名', '显示名', '邮箱', '角色'],
          ['xlsx-user', 'XLSX 用户', 'xlsx@corp.local', 'developer'],
        ]),
      })
      .expect(201);
    expect(xlsxRes.body.data.createdCount).toBe(1);
    expect((xlsxRes.body.data.created as Record<string, unknown>[])[0].role).toBe('developer');

    // 下载的模板必须是能被解析的 xlsx，且表头与解析规则一致
    // 二进制响应需显式 buffer + 自定义 parser，否则 supertest 不会给 Buffer
    const template = await adminAgent
      .get('/api/v1/users/batch/template')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(template.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(template.headers['content-disposition']).toContain('user-import-template.xlsx');
    const templateBuffer = template.body as Buffer;
    expect(templateBuffer.subarray(0, 2).toString()).toBe('PK');
    const resend = await adminAgent
      .post('/api/v1/users/batch')
      .send({ fileName: 'user-import-template.xlsx', contentBase64: templateBuffer.toString('base64') })
      .expect(400);
    expect(String(resend.body.details?.reason)).toContain('没有可用的账号数据');

    const agent = request.agent(ctx.baseUrl);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ username: 'xlsx-user', password: USER_INITIAL })
      .expect(200);
    expect(login.body.data.mustChangePassword).toBe(true);

    await agent
      .post('/api/v1/auth/change-password')
      .send({ oldPassword: USER_INITIAL, newPassword: XLSX_PASSWORD, confirmPassword: XLSX_PASSWORD })
      .expect(200);
    await agent.get('/api/v1/packages').expect(200);
  });

  it('非法导入文件、缺少文件与空 Excel 均被拒绝且不产生账号', async () => {
    for (const body of [
      { fileName: 'users.txt', contentBase64: Buffer.from('a,b', 'utf8').toString('base64') },
      {},
      { items: [{ username: 'a', role: 'reader' }] },
    ]) {
      const res = await adminAgent.post('/api/v1/users/batch').send(body).expect(400);
      expect(res.body.code).toBe('SYS_VALIDATION');
    }

    const list = await adminAgent.get('/api/v1/users').expect(200);
    const usernames = (list.body.data.items as Record<string, unknown>[]).map((item) => item.username);
    expect(usernames).not.toContain('a');
  });
});

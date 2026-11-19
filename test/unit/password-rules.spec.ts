import ExcelJS from 'exceljs';
import { validatePasswordStrength } from '../../src/auth/password';
import { buildUserImportTemplate, parseUserImportFile } from '../../src/auth/batch-import.util';
import { getConfig } from '../../src/config/config';

const toBase64 = (buffer: Buffer): string => buffer.toString('base64');

/** 按模板表头造一份 xlsx，rows 为数据区 */
async function buildXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('users');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

/** 口令强度与批量导入解析：后端兜底校验的边界场景 */
describe('口令规则与批量导入解析（单元）', () => {
  describe('validatePasswordStrength', () => {
    it('7 位被拒绝，8 位通过（最小长度默认 8）', () => {
      expect(validatePasswordStrength('Ab3-def', 'tester', 8)).toContain('长度');
      expect(validatePasswordStrength('Ab3-defgh', 'tester', 8)).toBeNull();
    });

    it('包含用户名（大小写不敏感）被拒绝', () => {
      expect(validatePasswordStrength('Tester-2026', 'tester', 8)).toContain('用户名');
    });

    it('单一字符重复被拒绝', () => {
      expect(validatePasswordStrength('aaaaaaaa', 'tester', 8)).toContain('重复');
    });

    it('常见弱口令片段被拒绝', () => {
      expect(validatePasswordStrength('Welcome-2026', 'tester', 8)).toContain('弱口令');
    });

    it('超过 128 位被拒绝', () => {
      expect(validatePasswordStrength(`Ab3-${'x'.repeat(126)}`, 'tester', 8)).toContain('超过');
    });
  });

  describe('固定初始密码配置', () => {
    it('管理员为 admin123，普通账号为 123123123，最小长度 8', () => {
      const cfg = getConfig();
      expect(cfg.auth.initialPasswordAdmin).toBe('admin123');
      expect(cfg.auth.initialPasswordUser).toBe('123123123');
      expect(cfg.auth.passwordMinLength).toBe(8);
    });
  });

  describe('Excel 解析与模板', () => {
    it('中文表头可正确映射到建号字段', async () => {
      const buffer = await buildXlsx([
        ['账号', '姓名', '邮箱', '角色'],
        ['zhangsan', '张三', 'zhangsan@corp.local', 'developer'],
      ]);
      const rows = await parseUserImportFile('users.xlsx', toBase64(buffer));
      expect(rows).toEqual([
        { username: 'zhangsan', displayName: '张三', email: 'zhangsan@corp.local', role: 'developer' },
      ]);
    });

    it('无表头时按 username/displayName/email/role 列序解析，空行忽略', async () => {
      const buffer = await buildXlsx([
        ['lisi', '李四', '', 'reader'],
        [],
        ['wangwu', '', 'wangwu@corp.local', ''],
      ]);
      const rows = await parseUserImportFile('users.xlsx', toBase64(buffer));
      expect(rows).toEqual([
        { username: 'lisi', displayName: '李四', email: undefined, role: 'reader' },
        { username: 'wangwu', displayName: undefined, email: 'wangwu@corp.local', role: undefined },
      ]);
    });

    it('CSV 等非 xlsx 扩展名与空文件被拒绝', async () => {
      const csv = Buffer.from('账号,姓名\nzhangsan,张三', 'utf8');
      await expect(parseUserImportFile('users.csv', toBase64(csv))).rejects.toMatchObject({
        code: 'SYS_VALIDATION',
      });
      await expect(parseUserImportFile('users.json', toBase64(csv))).rejects.toMatchObject({
        code: 'SYS_VALIDATION',
      });
      await expect(parseUserImportFile('users.xlsx', '')).rejects.toMatchObject({ code: 'SYS_VALIDATION' });
    });

    it('模板只有一个 sheet，说明位于第 1-5 行，表头从第 6 行开始且不被解析成账号', async () => {
      const buffer = await buildUserImportTemplate();
      expect(buffer.length).toBeGreaterThan(0);

      // 模板只有说明区与表头：直接上传模板应解析出 0 条，绝不会凭空建出示例账号
      const rows = await parseUserImportFile('user-import-template.xlsx', toBase64(buffer));
      expect(rows).toEqual([]);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['users']);

      const sheet = workbook.worksheets[0];
      // 填写须知占用第 1-5 行（A1:D5 合并为一个单元格），不再单独建“填写说明”sheet
      expect(sheet.model.merges).toContain('A1:D5');
      expect(String(sheet.getCell(1, 1).value)).toContain('填写须知');
      expect(sheet.getCell(5, 1).isMerged).toBe(true);
      // 表头紧随说明区之后
      expect(sheet.getRow(6).values).toEqual([undefined, '账号', '姓名', '邮箱', '角色']);
    });
  });
});

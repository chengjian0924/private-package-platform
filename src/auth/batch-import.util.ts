import ExcelJS from 'exceljs';
import { ApiError } from '../common/errors';
import type { BatchUserInput } from './auth.service';

/** 批量建号单次上限：一次 scrypt 之后即可落库，数量再大应拆分或走脚本 */
export const MAX_BATCH_USERS = 200;

/** 表头别名：同时兼容英文与中文表头，大小写和下划线不敏感 */
const HEADER_ALIASES: Record<keyof BatchUserInput, string[]> = {
  username: ['username', 'user', '账号', '用户名'],
  displayName: ['displayname', 'display_name', 'name', '显示名', '姓名'],
  email: ['email', 'mail', '邮箱', '邮件'],
  role: ['role', '角色'],
};

function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '');
}

function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  // exceljs 富文本/公式/超链接单元格统一取展示文本
  const obj = value as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
  if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text).join('').trim();
  if (obj.text !== undefined && obj.text !== null) return String(obj.text).trim();
  if (obj.result !== undefined && obj.result !== null) return String(obj.result).trim();
  return '';
}

/** 模板主 sheet 表头：与 HEADER_ALIASES 的识别规则保持一致 */
const TEMPLATE_HEADERS = ['账号', '姓名', '邮箱', '角色'];

/** 模板前置须知占用行数：合并成一格写填写要求，表头从其后开始 */
const TEMPLATE_NOTE_ROWS = 5;
/** 表头扫描范围：兼容用户自行增删说明行，但不至于把数据行误判成表头 */
const HEADER_SCAN_ROWS = 20;

/** 把二维表格转成建号入参：识别表头，缺省按 username/displayName/email/role 列序解析 */
function matrixToInputs(matrix: string[][]): BatchUserInput[] {
  const rows = matrix.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!rows.length) return [];

  // 表头不一定在第一行（模板前 5 行是填写须知），向下扫描定位真正的表头行
  const mapping: Partial<Record<keyof BatchUserInput, number>> = {};
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i += 1) {
    const cells = rows[i].map(normalizeHeader);
    if (cells.some((cell) => HEADER_ALIASES.username.includes(cell))) {
      headerRow = i;
      break;
    }
  }

  let dataRows = rows;
  if (headerRow !== -1) {
    const header = rows[headerRow].map(normalizeHeader);
    (Object.keys(HEADER_ALIASES) as (keyof BatchUserInput)[]).forEach((field) => {
      const index = header.findIndex((cell) => HEADER_ALIASES[field].includes(cell));
      if (index !== -1) mapping[field] = index;
    });
    dataRows = rows.slice(headerRow + 1);
  } else {
    mapping.username = 0;
    mapping.displayName = 1;
    mapping.email = 2;
    mapping.role = 3;
  }

  const pick = (cells: string[], field: keyof BatchUserInput): string | undefined => {
    const index = mapping[field];
    if (index === undefined) return undefined;
    const value = (cells[index] || '').trim();
    return value === '' ? undefined : value;
  };

  return dataRows.map((cells) => ({
    username: pick(cells, 'username'),
    displayName: pick(cells, 'displayName'),
    email: pick(cells, 'email'),
    role: pick(cells, 'role'),
  }));
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ApiError('SYS_VALIDATION', { field: 'file', reason: 'Excel 文件解析失败，请确认格式为 .xlsx' });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // exceljs 的列索引从 1 开始，row.values 首元素为空占位
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      cells.push(cellText(row.getCell(col).value));
    }
    matrix.push(cells);
  });
  return matrix;
}

/** 解析上传的用户清单（仅 XLSX），返回建号入参 */
export async function parseUserImportFile(fileName: string, contentBase64: string): Promise<BatchUserInput[]> {
  const name = (fileName || '').trim();
  const lower = name.toLowerCase();
  if (!contentBase64) {
    throw new ApiError('SYS_VALIDATION', { field: 'file', reason: '文件内容为空' });
  }
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) {
    throw new ApiError('SYS_VALIDATION', { field: 'file', reason: '文件内容为空' });
  }
  // 解析前先限高：用户清单只有几百行，超大文件一律视为误传
  if (buffer.length > 5 * 1024 * 1024) {
    throw new ApiError('SYS_VALIDATION', { field: 'file', reason: '文件不能超过 5MB' });
  }

  if (lower.endsWith('.xlsx')) {
    return matrixToInputs(await parseXlsx(buffer));
  }
  throw new ApiError('SYS_VALIDATION', { field: 'file', reason: '仅支持 .xlsx 文件，请下载模板后填写' });
}

/**
 * 生成批量建号 Excel 模板。
 * 前 5 行合并成一格写填写须知，表头紧随其后，数据区不放示例行：
 * 模板里的任何数据行都会被当成真实账号创建，宁可让用户自己填。
 */
export async function buildUserImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('users');
  sheet.columns = [
    { width: 24, style: { numFmt: '@' } },
    { width: 18 },
    { width: 32, style: { numFmt: '@' } },
    { width: 16 },
  ];

  // 须知区：四列合并，写清必填项、格式与上限，避免用户另开说明页对照
  sheet.mergeCells(1, 1, TEMPLATE_NOTE_ROWS, TEMPLATE_HEADERS.length);
  const note = sheet.getCell(1, 1);
  note.value = [
    '【填写须知】只填写表头下方空白行，请勿修改表头文字与顺序。',
    '账号：必填，3-32 位字母/数字/点/下划线/短横线，如 zhangsan，不可重复。',
    '姓名、邮箱：可选，邮箱作为联系方式记录。',
    '角色：可选，下拉选择 developer / reader，留空默认 reader；管理员账号唯一，不可批量创建。',
    '单次最多 200 行；初始密码由平台统一设置，首次登录必须修改。',
  ].join('\n');
  note.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  note.font = { size: 11, color: { argb: 'FF3A4358' } };
  note.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8FB' } };
  const noteBorder = { style: 'thin' as const, color: { argb: 'FFD3D8E3' } };
  note.border = { top: noteBorder, left: noteBorder, bottom: noteBorder, right: noteBorder };
  for (let r = 1; r <= TEMPLATE_NOTE_ROWS; r += 1) sheet.getRow(r).height = 26;

  const headerRow = sheet.addRow(TEMPLATE_HEADERS);
  headerRow.font = { bold: true };
  headerRow.height = 22;
  // 冻结到表头为止：滚动填写数据时表头与须知始终可见
  sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];

  // 角色列预置下拉，避免手填拼错角色名导致整行失败
  const roleCol = TEMPLATE_HEADERS.indexOf('角色') + 1;
  const firstDataRow = headerRow.number + 1;
  for (let r = firstDataRow; r < firstDataRow + MAX_BATCH_USERS; r += 1) {
    sheet.getCell(r, roleCol).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"developer,reader"'],
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: '角色取值',
      error: '请选择 developer 或 reader（管理员账号唯一，不可批量创建）',
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

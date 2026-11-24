import { ROLE_CODES, ROLE_LABELS, normalizeRole } from '../../src/auth/auth.service';

/**
 * 角色代码唯一来源：admin / developer / reader。
 * 历史上文档与外部脚本用过 viewer 表示「只读」，这里验证别名收敛到 reader，
 * 并且非法值不会被静默降级（静默降级会让「想开开发者权限」变成「只能读」且无人发现）。
 */
describe('角色代码归一', () => {
  it('三个合法角色原样返回', () => {
    for (const code of ROLE_CODES) expect(normalizeRole(code)).toBe(code);
  });

  it('大小写与首尾空格不敏感', () => {
    expect(normalizeRole(' Developer ')).toBe('developer');
    expect(normalizeRole('READER')).toBe('reader');
  });

  it('viewer 等历史命名收敛为 reader', () => {
    expect(normalizeRole('viewer')).toBe('reader');
    expect(normalizeRole('Viewer')).toBe('reader');
    expect(normalizeRole('read_only')).toBe('reader');
    expect(normalizeRole('readonly')).toBe('reader');
  });

  it('非法值与空值返回 null，交给调用方报错', () => {
    expect(normalizeRole('developr')).toBeNull();
    expect(normalizeRole('root')).toBeNull();
    expect(normalizeRole('')).toBeNull();
    expect(normalizeRole(undefined)).toBeNull();
  });

  it('每个角色都有中文展示名', () => {
    for (const code of ROLE_CODES) expect(ROLE_LABELS[code]).toBeTruthy();
  });
});

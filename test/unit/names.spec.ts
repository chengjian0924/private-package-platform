import { isValidName, normalizeName } from '../../src/packages/names';

/** 包名规范化与合法性校验：npm 与 PyPI（PEP 503）两套规则的边界场景 */
describe('包名规范化（单元）', () => {
  describe('npm', () => {
    it('普通包名统一转小写', () => {
      expect(normalizeName('npm', 'Lodash')).toBe('lodash');
    });

    it('scope 包保留 scope 结构并整体小写', () => {
      expect(normalizeName('npm', '@MyScope/Widget.Utils')).toBe('@myscope/widget.utils');
    });

    it('合法 scope 包通过校验', () => {
      expect(isValidName('npm', '@company/ui-kit')).toBe(true);
    });

    it('非法字符（大写、空格、波浪号）规范化为空串', () => {
      expect(normalizeName('npm', 'has space')).toBe('');
      expect(normalizeName('npm', 'tilde~name')).toBe('');
    });

    it('scope 后段不得为空', () => {
      expect(isValidName('npm', '@scope/')).toBe(false);
    });

    it('长度超过 214 拒绝（npm 上限）', () => {
      expect(isValidName('npm', 'a'.repeat(215))).toBe(false);
      expect(isValidName('npm', 'a'.repeat(214))).toBe(true);
    });
  });

  describe('pypi（PEP 503）', () => {
    it('-_ 与 . 折叠为单个 -', () => {
      expect(normalizeName('pypi', 'Flask___Login.Sub')).toBe('flask-login-sub');
    });

    it('合法名通过校验', () => {
      expect(isValidName('pypi', 'requests')).toBe(true);
      expect(isValidName('pypi', 'zope.interface')).toBe(true);
    });

    it('首尾不允许 -（折叠后非法）', () => {
      expect(isValidName('pypi', '-bad-')).toBe(false);
    });

    it('纯符号名折叠后非法', () => {
      expect(isValidName('pypi', '...')).toBe(false);
    });
  });

  it('空串与空白串在两个生态下都非法', () => {
    expect(isValidName('npm', '')).toBe(false);
    expect(isValidName('npm', '   ')).toBe(false);
    expect(isValidName('pypi', '')).toBe(false);
  });

  describe('空值与极端输入', () => {
    it('null/undefined 输入不抛错（按空名处理）', () => {
      expect(normalizeName('npm', null as never)).toBe('');
      expect(normalizeName('pypi', undefined as never)).toBe('');
      expect(isValidName('npm', null as never)).toBe(false);
      expect(isValidName('pypi', undefined as never)).toBe(false);
    });

    it('未知生态回落到 pypi 语义（类型层已约束，运行时记录当前行为）', () => {
      expect(isValidName('gem' as never, 'anything')).toBe(true);
      expect(normalizeName('gem' as never, 'Flask_Login')).toBe('flask-login');
    });

    it('npm 单字符合法、超长边界严格', () => {
      expect(isValidName('npm', 'a')).toBe(true);
      expect(isValidName('npm', 'a'.repeat(214))).toBe(true);
      expect(isValidName('npm', 'a'.repeat(215))).toBe(false);
    });

    it('npm scope 边界：双 scope、空 scope 名、点开头', () => {
      expect(isValidName('npm', '@scope/pkg')).toBe(true);
      expect(isValidName('npm', '@a/b/c')).toBe(false);
      expect(isValidName('npm', '@/pkg')).toBe(false);
      expect(isValidName('npm', '.leading')).toBe(false);
    });

    it('pypi 连续分隔符折叠与超长名', () => {
      expect(normalizeName('pypi', 'a___...---b')).toBe('a-b');
      expect(isValidName('pypi', 'a'.repeat(214))).toBe(true);
    });

    it('Unicode 与非 ASCII 字符被拒绝', () => {
      expect(isValidName('npm', '包名')).toBe(false);
      expect(isValidName('pypi', '包')).toBe(false);
    });
  });
});

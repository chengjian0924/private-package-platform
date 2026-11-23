import {
  isValidPep440Version,
  parsePep440,
  pep440VersionKey,
} from '../../src/packages/pep440';
import { normalizeVersion } from '../../src/packages/packages.service';

describe('PEP 440 版本键：相等版本归一到同一个键', () => {
  it.each([
    ['1', '1.0'],
    ['1.0', '1.0.0'],
    ['1.0.0', 'v1.0.0'],
    ['v1.0', '1.0.0.0'],
    ['0', '0.0'],
    ['1.2.3.0', '1.2.3'],
    ['1.0a', '1.0a0'],
    ['1.0alpha1', '1.0a1'],
    ['1.0c', '1.0rc0'],
    ['1.0preview2', '1.0rc2'],
    ['1.0-1', '1.0.post1'],
    ['1.0rev2', '1.0.post2'],
    ['1.0+ABC-05', '1.0+abc.5'],
    ['01.002.0003', '1.2.3'],
  ])('%s 与 %s 等价', (a, b) => {
    expect(pep440VersionKey(a)).not.toBeNull();
    expect(pep440VersionKey(a)).toBe(pep440VersionKey(b));
  });

  it.each([
    ['1.0', '1.0.post0'],
    ['1.0', '1.0.dev0'],
    ['1.0', '1!1.0'],
    ['1.0', '1.0+abc'],
    ['1.0a0', '1.0'],
    ['1.0rc1', '1.0rc2'],
  ])('%s 与 %s 不等价', (a, b) => {
    expect(pep440VersionKey(a)).not.toBe(pep440VersionKey(b));
  });

  it('normalizeVersion(pypi) 使用 PEP 440 键，npm 仍用 semver', () => {
    expect(normalizeVersion('pypi', 'v1.0')).toBe(normalizeVersion('pypi', '1.0.0'));
    expect(normalizeVersion('npm', 'v1.0.0')).toBe('1.0.0');
  });

  it('非法版本返回 null，由校验层拦截', () => {
    expect(isValidPep440Version('not-a-version')).toBe(false);
    expect(pep440VersionKey('not-a-version')).toBeNull();
    expect(parsePep440('not-a-version')).toBeNull();
  });

  it('解析 epoch / pre / post / dev / local 各段', () => {
    expect(parsePep440('2!1.4.0rc2.post3.dev4+Ubuntu.05')).toEqual({
      epoch: 2,
      release: [1, 4, 0],
      pre: { label: 'rc', num: 2 },
      post: 3,
      dev: 4,
      local: 'ubuntu.5',
    });
  });
});

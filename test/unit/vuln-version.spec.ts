import { versionInRange } from '../../src/security/vuln.service';

/**
 * 漏洞库「受影响版本范围」匹配：npm 走 semver，pypi 走 PEP 440 子集。
 * 误报会把正常包判为有漏洞，漏报会把有漏洞的包放行——两条边都要覆盖。
 */
describe('漏洞版本范围匹配（单元）', () => {
  describe('npm（semver）', () => {
    it('>= / < 区间边界', () => {
      expect(versionInRange('1.2.3', '>=1.0.0', 'npm')).toBe(true);
      expect(versionInRange('0.9.0', '>=1.0.0', 'npm')).toBe(false);
      expect(versionInRange('2.0.0', '<2.0.0', 'npm')).toBe(false);
      expect(versionInRange('1.9.9', '<2.0.0', 'npm')).toBe(true);
    });

    it('caret 范围', () => {
      expect(versionInRange('1.9.0', '^1.0.0', 'npm')).toBe(true);
      expect(versionInRange('2.0.0', '^1.0.0', 'npm')).toBe(false);
    });

    it('|| 或分支：命中任一分支即受影响', () => {
      expect(versionInRange('4.0.0', '>=3.0.0 || <1.0.0', 'npm')).toBe(true);
      expect(versionInRange('0.5.0', '>=3.0.0 || <1.0.0', 'npm')).toBe(true);
      expect(versionInRange('2.0.0', '>=3.0.0 || <1.0.0', 'npm')).toBe(false);
    });

    it('空范围与 * 表示所有版本受影响', () => {
      expect(versionInRange('1.2.3', '*', 'npm')).toBe(true);
      expect(versionInRange('1.2.3', '', 'npm')).toBe(true);
      expect(versionInRange('1.2.3', '   ', 'npm')).toBe(true);
    });

    it('非标准版本回退到区间比较而非直接判为不受影响', () => {
      expect(versionInRange('1.2.3-beta', '>=1.0.0', 'npm')).toBe(true);
      expect(versionInRange('not-a-version', '>=1.0.0', 'npm')).toBe(false);
    });

    it('|| 含空分支时忽略空分支', () => {
      expect(versionInRange('2.0.0', '||  >=1.0.0', 'npm')).toBe(true);
      expect(versionInRange('0.1.0', '>=3.0.0 ||', 'npm')).toBe(false);
    });

    it('精确的等于与不等于', () => {
      expect(versionInRange('1.5.0', '==1.5.0', 'npm')).toBe(true);
      expect(versionInRange('1.5.1', '==1.5.0', 'npm')).toBe(false);
      expect(versionInRange('1.5.1', '!=1.5.0', 'npm')).toBe(true);
    });
  });

  describe('pypi（PEP 440 子集）', () => {
    it('比较符与逗号多子句（AND）', () => {
      expect(versionInRange('2.1', '>=2.0', 'pypi')).toBe(true);
      expect(versionInRange('1.9', '>=2.0', 'pypi')).toBe(false);
      expect(versionInRange('1.5', '>=1.0,<2.0', 'pypi')).toBe(true);
      expect(versionInRange('2.5', '>=1.0,<2.0', 'pypi')).toBe(false);
    });

    it('== 通配符前缀', () => {
      expect(versionInRange('1.2.3', '==1.2.*', 'pypi')).toBe(true);
      expect(versionInRange('1.3.0', '==1.2.*', 'pypi')).toBe(false);
    });

    it('~= 兼容版本', () => {
      expect(versionInRange('1.4', '~=1.4', 'pypi')).toBe(true);
      expect(versionInRange('1.5', '~=1.4', 'pypi')).toBe(true);
      expect(versionInRange('2.0', '~=1.4', 'pypi')).toBe(false);
    });

    it('不可解析的表达式按「可能受影响」保守处理，避免漏报', () => {
      expect(versionInRange('1.0.0', 'latest', 'pypi')).toBe(true);
    });
  });
});

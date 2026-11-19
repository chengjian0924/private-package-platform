import * as crypto from 'node:crypto';
import { digestOf, nowIso, sha256Hex } from '../../src/common/http.util';

/** 摘要与时间工具：与 node:crypto 标准实现逐位对齐 */
describe('摘要工具（单元）', () => {
  it('sha256Hex 与 node:crypto 结果一致', () => {
    const input = 'private-package-platform';
    expect(sha256Hex(input)).toBe(crypto.createHash('sha256').update(input).digest('hex'));
  });

  it('sha256Hex 支持Buffer 输入', () => {
    const buf = Buffer.from([0, 1, 2, 255]);
    expect(sha256Hex(buf)).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
  });

  it('digestOf 同时产出 sha256 / sha1 shasum / sha512 SRI integrity', () => {
    const buf = Buffer.from('hello world');
    const d = digestOf(buf);
    expect(d.sha256).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
    expect(d.shasum).toBe(crypto.createHash('sha1').update(buf).digest('hex'));
    expect(d.integrity).toBe(`sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`);
  });

  it('digestOf 对空内容仍产出合法摘要（空 tarball 等边界）', () => {
    const d = digestOf(Buffer.alloc(0));
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.shasum).toMatch(/^[0-9a-f]{40}$/);
    expect(d.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });

  it('nowIso 输出可被 Date.parse 解析的 UTC ISO 字符串', () => {
    const iso = nowIso();
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
  });
});

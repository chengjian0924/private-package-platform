import { sumPublishAttachmentBytes } from '../../src/registry-npm/registry-npm.controller';

describe('npm 发布附件总量估算（单元）', () => {
  it('data 与 content 两种字段都计入，按 base64 解码后 3/4 计算', () => {
    // 4 个 base64 字符 = 3 字节
    expect(sumPublishAttachmentBytes({ a: { data: 'AAAA' } })).toBe(3);
    expect(sumPublishAttachmentBytes({ a: { content: 'AAAA' } })).toBe(3);
  });

  it('多附件累加，且优先取 data', () => {
    expect(
      sumPublishAttachmentBytes({
        a: { data: 'AAAA', content: 'ignored' }, // 3 字节，content 应被忽略
        b: { content: 'AAAAAAAA' }, // 6 字节
      }),
    ).toBe(9);
  });

  it('空附件与缺失字段按 0 计入', () => {
    expect(sumPublishAttachmentBytes({})).toBe(0);
    expect(sumPublishAttachmentBytes({ a: {} })).toBe(0);
    expect(sumPublishAttachmentBytes({ a: { data: '' } })).toBe(0);
  });
});

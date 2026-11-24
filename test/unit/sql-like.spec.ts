import { likeContains } from '../../src/common/sql.util';

describe('likeContains：LIKE 通配符转义', () => {
  it('普通文本只加首尾通配符', () => {
    expect(likeContains('lodash')).toBe('%lodash%');
  });

  it('百分号被转义，不再匹配任意串', () => {
    expect(likeContains('100%')).toBe('%100\\%%');
  });

  it('下划线被转义，不再匹配单字符', () => {
    expect(likeContains('foo_bar')).toBe('%foo\\_bar%');
  });

  it('反斜杠先被转义，避免成为转义符本身', () => {
    expect(likeContains('a\\b')).toBe('%a\\\\b%');
    expect(likeContains('\\')).toBe('%\\\\%');
  });

  it('组合输入逐字符转义', () => {
    expect(likeContains('%_\\')).toBe('%\\%\\_\\\\%');
  });
});

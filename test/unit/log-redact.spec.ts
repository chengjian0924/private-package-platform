import { redactText } from '../../src/common/logger';

/**
 * 异常日志的字符串级脱敏：底层库抛出的 message 常把凭据拼在句子里，
 * maskDeep 只按 key 脱敏管不到，redactText 负责这层兜底。
 */
describe('日志文本脱敏', () => {
  it('掩掉 Authorization 头里的 Bearer / Basic 凭据', () => {
    expect(redactText('request failed: Authorization: Bearer yj_abc123DEF456')).toBe(
      'request failed: Authorization: Bearer ***',
    );
    const basic = redactText('authorization: Basic dmVyeTpzZWNyZXQ= rejected');
    expect(basic).toContain('Basic ***');
    expect(basic).not.toContain('dmVyeTpzZWNyZXQ=');
    // 「basic auth」是普通措辞，不能把后面的单词当凭据掩掉
    expect(redactText('basic auth rejected')).toBe('basic auth rejected');
  });

  it('掩掉 URL 查询串里的口令类参数', () => {
    const out = redactText('GET https://host/api?token=abc123&page=2&password=p%40ss');
    expect(out).toContain('token=***');
    expect(out).toContain('password=***');
    expect(out).toContain('page=2'); // 非敏感参数保留，便于排障
    expect(out).not.toContain('abc123');
  });

  it('掩掉连接串里的账号口令', () => {
    const out = redactText('connect failed: postgres://root:sup3rs3cret@db:5432/app');
    expect(out).toBe('connect failed: postgres://***@db:5432/app');
  });

  it('不含凭据的文本原样返回', () => {
    const text = 'ENOENT: no such file or directory, open /data/objects/ab/abcd.tgz';
    expect(redactText(text)).toBe(text);
  });
});

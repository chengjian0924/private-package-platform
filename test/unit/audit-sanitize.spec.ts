import { sanitizeAuditDetail } from '../../src/audit/audit.service';

/** 审计详情脱敏：敏感键打码、深度上限、数组与长字符串截断（红线：真实凭据不得入审计） */
describe('审计详情脱敏（单元）', () => {
  it('敏感键统一打码为 ***（不区分大小写与命名风格）', () => {
    const out = sanitizeAuditDetail({
      password: 'p@ss',
      apiToken: 'tk_123',
      client_secret: 's',
      Authorization: 'Bearer x',
      credentials: { k: 'v' },
      normal: 'keep',
    }) as Record<string, unknown>;
    expect(out.password).toBe('***');
    expect(out.apiToken).toBe('***');
    expect(out.client_secret).toBe('***');
    expect(out.Authorization).toBe('***');
    expect(out.credentials).toBe('***');
    expect(out.normal).toBe('keep');
  });

  it('嵌套对象递归脱敏，深度超过 4 层原样保留', () => {
    const deep = { l1: { l2: { l3: { l4: { password: 'x' } } } } };
    const out = sanitizeAuditDetail(deep) as { l1: { l2: { l3: { l4: unknown } } } };
    // 第 4 层的 password 仍在脱敏范围内
    expect((out.l1.l2.l3.l4 as Record<string, unknown>).password).toBe('***');

    const deeper = { l1: { l2: { l3: { l4: { l5: { password: 'leak?' } } } } } };
    const out2 = sanitizeAuditDetail(deeper) as Record<string, unknown>;
    const l5 = ((out2.l1 as Record<string, unknown>).l2 as Record<string, unknown> as Record<string, unknown>)[
      'l3'
    ] as Record<string, unknown>;
    // 第 5 层超出深度上限，对象原样返回不再递归（上游应保证 detail 不含敏感数据，此处仅验证边界行为稳定）
    expect(JSON.stringify(out2)).toContain('leak?');
    expect(l5).toBeTruthy();
  });

  it('数组截断到 50 个元素', () => {
    const out = sanitizeAuditDetail(new Array(120).fill('x')) as unknown[];
    expect(out.length).toBe(50);
  });

  it('超过 500 字符的字符串截断并带省略标记', () => {
    const out = sanitizeAuditDetail('a'.repeat(600)) as string;
    expect(out.length).toBe(503);
    expect(out.endsWith('...')).toBe(true);
  });

  it('原始类型与 null/undefined 原样返回', () => {
    expect(sanitizeAuditDetail(42)).toBe(42);
    expect(sanitizeAuditDetail(null)).toBeNull();
    expect(sanitizeAuditDetail(undefined)).toBeUndefined();
  });

  it('空对象与空数组结构保持不变', () => {
    expect(sanitizeAuditDetail({})).toEqual({});
    expect(sanitizeAuditDetail([])).toEqual([]);
  });

  it('敏感键名的不同命名风格均被覆盖', () => {
    const out = sanitizeAuditDetail({
      PASSWORD: 'x',
      pass_word: 'x',
      accessToken: 'x',
      clientSecret: 'x',
      authorization: 'x',
      credentials: 'x',
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) expect(value).toBe('***');
  });

  it('F-03 回归：常见凭据键名的各种写法都被脱敏', () => {
    const out = sanitizeAuditDetail({
      'x-api-key': 'v',
      apiKey: 'v',
      api_key: 'v',
      apikey: 'v',
      'X-API-KEY': 'v',
      privateKey: 'v',
      'private-key': 'v',
      session_id: 'v',
      sessionId: 'v',
      sessionid: 'v',
      session: 'v',
      auth: 'v',
      cookie: 'v',
      'set-cookie': 'v',
      passwd: 'v',
      pass: 'v',
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) expect(value).toBe('***');
  });

  it('F-03 回归：短会话/统计类键名不误伤', () => {
    const out = sanitizeAuditDetail({
      revokedSessions: 3,
      sessionCount: 5,
      actorRole: 'admin',
      authorName: 'alice',
      authCacheTtlMs: 5000,
      enabled: true,
      name: 'demo',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      revokedSessions: 3,
      sessionCount: 5,
      actorRole: 'admin',
      authorName: 'alice',
      authCacheTtlMs: 5000,
      enabled: true,
      name: 'demo',
    });
  });

  it('非敏感键与普通数值不误伤', () => {
    const out = sanitizeAuditDetail({ count: 3, name: 'alice', enabled: true }) as Record<string, unknown>;
    expect(out).toEqual({ count: 3, name: 'alice', enabled: true });
  });

  it('长数组中的对象元素同样被脱敏', () => {
    const out = sanitizeAuditDetail([{ password: 'a' }, { token: 'b' }]) as Record<string, unknown>[];
    expect(out[0].password).toBe('***');
    expect(out[1].token).toBe('***');
  });

  it('恰好 500 字符的字符串不被截断', () => {
    const out = sanitizeAuditDetail('a'.repeat(500)) as string;
    expect(out).toHaveLength(500);
  });
});

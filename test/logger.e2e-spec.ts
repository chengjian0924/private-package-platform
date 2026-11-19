import { formatLog, maskDeep, runWithTrace } from '../src/common/logger';
import { resetConfigCache } from '../src/config/config';

describe('B2 结构化日志', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ['LOG_LEVEL', 'LOG_FORMAT']) saved[key] = process.env[key];
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FORMAT = 'json';
    resetConfigCache();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  });

  it('敏感字段整体替换，超长内容截断', () => {
    const masked = maskDeep({
      authorization: 'Bearer abc',
      nested: { password: 'p@ss', token: 't', cookie: 'yj_sid=1' },
      note: 'x'.repeat(600),
      list: Array.from({ length: 60 }, (_, i) => i),
    }) as Record<string, unknown>;

    expect(masked.authorization).toBe('***');
    expect((masked.nested as Record<string, unknown>).password).toBe('***');
    expect((masked.nested as Record<string, unknown>).token).toBe('***');
    expect((masked.nested as Record<string, unknown>).cookie).toBe('***');
    expect(String(masked.note).length).toBeLessThanOrEqual(513);
    expect((masked.list as unknown[]).length).toBe(50);
  });

  it('JSON 行包含 time/level/msg/traceId 且可解析', () => {
    const line = runWithTrace('trace-123', () =>
      formatLog('info', 'Test', '扫描完成', { durationMs: 12, detail: { token: 'secret-value' } }),
    );
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.logger).toBe('Test');
    expect(parsed.msg).toBe('扫描完成');
    expect(parsed.traceId).toBe('trace-123');
    expect(parsed.durationMs).toBe(12);
    expect((parsed.detail as Record<string, unknown>).token).toBe('***');
    expect(line).not.toContain('secret-value');
  });

  it('低于配置级别的日志被过滤', () => {
    process.env.LOG_LEVEL = 'error';
    resetConfigCache();
    expect(formatLog('info', 'Test', '不输出')).toBe('');
    expect(formatLog('error', 'Test', '输出')).toContain('"level":"error"');
  });
});

import type { Request } from 'express';
import { checkRateLimit, rateLimitScopeOf, resetRateLimitState } from '../../src/common/http-security';
import { evaluateDiskState } from '../../src/common/disk-guard.service';

/** 固定窗口限流：放行/拒绝边界、窗口重置、retryAfter、禁用分支 */
describe('接口限流（单元）', () => {
  beforeEach(() => resetRateLimitState());
  afterEach(() => resetRateLimitState());

  it('窗口内按次数上限放行，超过即拒绝', () => {
    const t = 1_000_000;
    expect(checkRateLimit('ip:1', 3, 60_000, t)).toMatchObject({ allowed: true, remaining: 2 });
    expect(checkRateLimit('ip:1', 3, 60_000, t)).toMatchObject({ allowed: true, remaining: 1 });
    expect(checkRateLimit('ip:1', 3, 60_000, t)).toMatchObject({ allowed: true, remaining: 0 });
    const denied = checkRateLimit('ip:1', 3, 60_000, t);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('窗口到期后重新计数', () => {
    const t = 1_000_000;
    checkRateLimit('ip:2', 1, 1_000, t);
    expect(checkRateLimit('ip:2', 1, 1_000, t + 500).allowed).toBe(false);
    expect(checkRateLimit('ip:2', 1, 1_000, t + 1001)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('limit<=0 或 windowMs<=0 视为不限流（字典可关闭）', () => {
    expect(checkRateLimit('off:1', 0, 60_000, 100)).toMatchObject({ allowed: true, remaining: 0 });
    expect(checkRateLimit('off:2', -1, 60_000, 100).allowed).toBe(true);
    expect(checkRateLimit('off:3', 5, 0, 100).allowed).toBe(true);
  });

  it('retryAfter 按窗口剩余时间向上取整，至少 1 秒', () => {
    const t = 1_000_000;
    checkRateLimit('retry:1', 1, 5_000, t);
    const denied = checkRateLimit('retry:1', 1, 5_000, t + 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBe(4); // (t+5000 - (t+1000))/1000
  });

  it('不同 key 独立计数', () => {
    const t = 1_000_000;
    checkRateLimit('a', 1, 60_000, t);
    expect(checkRateLimit('b', 1, 60_000, t).allowed).toBe(true);
  });

  it('limit=1 的边界：首次放行，第二次拒绝', () => {
    const t = 500_000;
    expect(checkRateLimit('one:1', 1, 10_000, t).allowed).toBe(true);
    expect(checkRateLimit('one:1', 1, 10_000, t).allowed).toBe(false);
  });

  it('极大 windowMs 与极大 limit 不溢出', () => {
    const t = 1_000;
    const r = checkRateLimit('big:1', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, t);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeGreaterThan(0);
  });

  it('大量不同 key 触达上限时仍能继续计数不抛错（剪枝兜底）', () => {
    const t = 2_000_000;
    for (let i = 0; i < 20_050; i += 1) checkRateLimit(`flood:${i}`, 1, 60_000, t);
    expect(checkRateLimit('flood:after', 1, 60_000, t).allowed).toBe(true);
  });

  it('空字符串 key 也可计数（走 unknown 兜底语义）', () => {
    const t = 3_000_000;
    expect(checkRateLimit('', 1, 1_000, t).allowed).toBe(true);
    expect(checkRateLimit('', 1, 1_000, t).allowed).toBe(false);
  });
});

/** registry 读请求必须分桶，否则 dshmarket/pip 的批量 GET 会打满控制台读配额 */
describe('限流类别判定（单元）', () => {
  const req = (path: string, method = 'GET') =>
    ({ path, method }) as unknown as Request;

  it('npm/pypi 协议 GET/HEAD 走各自独立桶', () => {
    expect(rateLimitScopeOf(req('/npm/-/v1/search'))).toBe('npm');
    expect(rateLimitScopeOf(req('/npm/@types/node', 'HEAD'))).toBe('npm');
    expect(rateLimitScopeOf(req('/pypi/simple/requests/'))).toBe('pypi');
    expect(rateLimitScopeOf(req('/PYPI/packages/foo.whl'))).toBe('pypi');
  });

  it('控制台读请求仍走 read 桶，写请求仍走 write 桶', () => {
    expect(rateLimitScopeOf(req('/api/v1/packages'))).toBe('read');
    expect(rateLimitScopeOf(req('/api/v1/health'))).toBe('read');
    expect(rateLimitScopeOf(req('/npm/pkg', 'PUT'))).toBe('write');
    expect(rateLimitScopeOf(req('/pypi/legacy/', 'POST'))).toBe('write');
  });

  it('认证入口优先级高于协议前缀', () => {
    expect(rateLimitScopeOf(req('/api/v1/auth/login', 'POST'))).toBe('auth');
  });
});

/** 磁盘水位：readonly > alert > normal，minFreeBytes 为硬底线 */
describe('磁盘水位判定（单元）', () => {
  const th = { alertPercent: 85, readonlyPercent: 95, minFreeBytes: 1_000_000 };

  it('total<=0（采样失败兜底）视为 normal', () => {
    expect(evaluateDiskState({ totalBytes: 0, freeBytes: 0 }, th)).toBe('normal');
  });

  it('水位低于警戒线为 normal', () => {
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 90 }, { ...th, minFreeBytes: 0 })).toBe('normal');
  });

  it('达到 alertPercent 进入 alert，未到 readonlyPercent', () => {
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 10 }, { ...th, minFreeBytes: 0 })).toBe('alert');
  });

  it('达到 readonlyPercent 进入 readonly', () => {
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 3 }, { ...th, minFreeBytes: 0 })).toBe('readonly');
  });

  it('百分比未超标但可用字节低于硬底线也进入 readonly', () => {
    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 999 }, { ...th, minFreeBytes: 1_000_000 })).toBe('readonly');
  });

  it('readonly 优先于 alert', () => {
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 0 }, th)).toBe('readonly');
  });

  it('阈值恰好相等时取更严重档位（>= 边界）', () => {
    const t2 = { alertPercent: 85, readonlyPercent: 95, minFreeBytes: 0 };
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 15 }, t2)).toBe('alert'); // 正好 85%
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 5 }, t2)).toBe('readonly'); // 正好 95%
  });

  it('minFreeBytes 恰好相等时不触发只读（严格小于才触发）', () => {
    const t2 = { alertPercent: 85, readonlyPercent: 95, minFreeBytes: 200 };
    // 占用 80% 低于警戒线，且可用字节正好等于硬底线 → normal
    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 200 }, t2)).toBe('normal');
    // 再少 1 字节即触发只读
    expect(evaluateDiskState({ totalBytes: 1000, freeBytes: 199 }, t2)).toBe('readonly');
  });

  it('freeBytes 超过 totalBytes 的异常采样值归一为 normal（占用为负）', () => {
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 200 }, { ...th, minFreeBytes: 0 })).toBe('normal');
  });

  it('阈值为 0 或负数的极端配置按数值语义计算', () => {
    const t2 = { alertPercent: 0, readonlyPercent: 0, minFreeBytes: 0 };
    expect(evaluateDiskState({ totalBytes: 100, freeBytes: 100 }, t2)).toBe('readonly');
  });
});

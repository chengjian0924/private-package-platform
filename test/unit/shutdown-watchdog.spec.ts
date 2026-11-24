import { createShutdownWatchdog } from '../../src/common/shutdown-watchdog';

/**
 * 停机看门狗：
 * - 排空完成后必须能撤掉计时器，否则正常停机也会打出「强制退出」；
 * - 重复 SIGTERM 不能重置计时（systemd 会连发），否则硬超时被无限延后；
 * - 计时器要 unref，别让它成为进程退不出去的理由。
 */
function fakeTimers() {
  let handler: (() => void) | null = null;
  let cleared = 0;
  let unrefed = 0;
  let delay = -1;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        handler = fn;
        delay = ms;
        return {
          unref: () => {
            unrefed += 1;
          },
        };
      },
      clear: () => {
        cleared += 1;
        handler = null;
      },
    },
    fire: () => handler?.(),
    stats: () => ({ cleared, unrefed, delay, armed: handler !== null }),
  };
}

describe('优雅停机看门狗', () => {
  it('arm 后计时器 unref，超时触发回调', () => {
    const fake = fakeTimers();
    let fired = 0;
    const watchdog = createShutdownWatchdog({
      hardTimeoutMs: 35_000,
      onTimeout: () => {
        fired += 1;
      },
      timers: fake.timers as never,
    });

    watchdog.arm();
    expect(watchdog.armed()).toBe(true);
    expect(fake.stats().unrefed).toBe(1);
    expect(fake.stats().delay).toBe(35_000);

    fake.fire();
    expect(fired).toBe(1);
    // 超时后自身解除，不会重复触发
    expect(watchdog.armed()).toBe(false);
  });

  it('重复 arm 不重置计时', () => {
    const fake = fakeTimers();
    const watchdog = createShutdownWatchdog({ hardTimeoutMs: 1000, onTimeout: () => undefined, timers: fake.timers as never });
    watchdog.arm();
    watchdog.arm();
    watchdog.arm();
    expect(fake.stats().unrefed).toBe(1);
  });

  it('排空完成后 clear 掉计时器，不再触发强制退出', () => {
    const fake = fakeTimers();
    let fired = 0;
    const watchdog = createShutdownWatchdog({
      hardTimeoutMs: 1000,
      onTimeout: () => {
        fired += 1;
      },
      timers: fake.timers as never,
    });
    watchdog.arm();
    watchdog.clear();
    expect(watchdog.armed()).toBe(false);
    expect(fake.stats().cleared).toBe(1);
    expect(fired).toBe(0);
    // 重复 clear 安全
    watchdog.clear();
    expect(fake.stats().cleared).toBe(1);
  });
});

/**
 * 优雅停机的硬超时看门狗。
 *
 * 语义边界：
 * - 排空正常完成时必须 clear()，否则进程若因别的 ref 句柄（DB、定时器、keep-alive 连接）
 *   多活几秒，看门狗会误报「强制退出」——一次正常重启在日志里长成一次故障。
 * - 计时器 unref()：它只负责兜底，不应该成为「进程不退出」的理由。
 * - 超时回调默认以退出码 0 结束：停机是预期动作，用非 0 退出码会让 systemd / Docker
 *   把「滚动重启时排空超时」记成崩溃，触发一轮无意义的告警。
 */
export interface ShutdownWatchdog {
  arm(): void;
  clear(): void;
  armed(): boolean;
}

export interface ShutdownWatchdogOptions {
  hardTimeoutMs: number;
  onTimeout: () => void;
  /** 便于单测注入假定时器；默认用全局 setTimeout/clearTimeout */
  timers?: {
    set: (fn: () => void, ms: number) => { unref?: () => void } | number;
    clear: (handle: never) => void;
  };
}

export function createShutdownWatchdog(options: ShutdownWatchdogOptions): ShutdownWatchdog {
  const setTimer = options.timers?.set ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.timers?.clear ?? ((handle: never) => clearTimeout(handle));
  let timer: unknown = null;

  return {
    arm(): void {
      // 重复收到 SIGTERM（systemd 会连发）不应重置计时，否则硬超时被无限延后
      if (timer !== null) return;
      const handle = setTimer(() => {
        timer = null;
        options.onTimeout();
      }, options.hardTimeoutMs);
      (handle as { unref?: () => void })?.unref?.();
      timer = handle;
    },
    clear(): void {
      if (timer === null) return;
      clearTimer(timer as never);
      timer = null;
    },
    armed(): boolean {
      return timer !== null;
    },
  };
}

import { getConfig, resetConfigCache } from '../../src/config/config';

/**
 * 磁盘滞回带宽的配置兜底：存量部署有 99/100 这种紧贴阈值，升级后不能因为
 * 新引入的滞回校验而起不来。未显式配置时按「间距 - 1」自动收敛。
 */
describe('磁盘滞回带宽配置', () => {
  const KEYS = ['DISK_ALERT_PERCENT', 'DISK_READONLY_PERCENT', 'DISK_HYSTERESIS_PERCENT'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  });

  it('默认 85/95 时取 2 个百分点', () => {
    delete process.env.DISK_HYSTERESIS_PERCENT;
    process.env.DISK_ALERT_PERCENT = '85';
    process.env.DISK_READONLY_PERCENT = '95';
    resetConfigCache();
    expect(getConfig().storage.diskHysteresisPercent).toBe(2);
  });

  it('存量 99/100 紧贴阈值：未显式配置时自动退化为 0，不影响启动', () => {
    delete process.env.DISK_HYSTERESIS_PERCENT;
    process.env.DISK_ALERT_PERCENT = '99';
    process.env.DISK_READONLY_PERCENT = '100';
    resetConfigCache();
    expect(getConfig().storage.diskHysteresisPercent).toBe(0);
  });

  it('显式配置超出间距被拒绝', () => {
    process.env.DISK_ALERT_PERCENT = '99';
    process.env.DISK_READONLY_PERCENT = '100';
    process.env.DISK_HYSTERESIS_PERCENT = '1';
    resetConfigCache();
    expect(() => getConfig()).toThrow(/磁盘滞回带宽不合法/);
  });

  it('显式配置 0 表示关闭滞回', () => {
    process.env.DISK_ALERT_PERCENT = '85';
    process.env.DISK_READONLY_PERCENT = '95';
    process.env.DISK_HYSTERESIS_PERCENT = '0';
    resetConfigCache();
    expect(getConfig().storage.diskHysteresisPercent).toBe(0);
  });
});

import {
  applyDictionaryOverrides,
  clearDictionaryOverrides,
  getDictionaryOverrides,
  refreshDictionaryOverrides,
  registerDictionaryLoader,
  setDictionaryOverrides,
  type DictionaryOverrides,
} from '../../src/config/overrides';
import { getConfig, getEnvConfig, resetConfigCache } from '../../src/config/config';

/** 字典覆盖层：env 是基线，DB 字典只保存显式覆盖项；无污染、可清空、即时生效 */
describe('配置字典覆盖层（单元）', () => {
  beforeEach(() => {
    clearDictionaryOverrides();
    resetConfigCache();
  });

  afterEach(() => {
    clearDictionaryOverrides();
    resetConfigCache();
  });

  it('无覆盖时 getConfig 直接返回 env 基线对象（零开销、引用不变）', () => {
    expect(getConfig()).toBe(getEnvConfig());
    expect(applyDictionaryOverrides(getEnvConfig())).toBe(getEnvConfig());
  });

  it('设置覆盖后按分组生效，且基线对象不被污染', () => {
    const baseline = getEnvConfig();
    const oldWindow = baseline.rateLimit.windowMs;
    setDictionaryOverrides({ 'rateLimit.windowMs': 12345, 'security.scanEnabled': false });

    const effective = getConfig();
    expect(effective.rateLimit.windowMs).toBe(12345);
    expect(effective.security.scanEnabled).toBe(false);
    // 基线保持原值
    expect(baseline.rateLimit.windowMs).toBe(oldWindow);
    expect(getEnvConfig().rateLimit.windowMs).toBe(oldWindow);
  });

  it('未登记的字段即使写入覆盖层也不生效', () => {
    const baseline = getEnvConfig();
    setDictionaryOverrides({ 'rateLimit.ghostField': 999 } as never);
    const effective = getConfig();
    expect(effective).toBe(baseline);
  });

  it('只覆盖某组某字段时，其它分组引用保持不变', () => {
    const baseline = getEnvConfig();
    setDictionaryOverrides({ 'missing.autoReport': false });
    const effective = getConfig();
    expect(effective.missing.autoReport).toBe(false);
    expect(effective.security).toBe(baseline.security);
    expect(effective.rateLimit).toBe(baseline.rateLimit);
  });

  it('getDictionaryOverrides 返回副本，外部修改不污染内部状态', () => {
    setDictionaryOverrides({ 'retention.logDays': 7 });
    const copy = getDictionaryOverrides();
    expect(copy['retention.logDays']).toBe(7);
    (copy as Record<string, unknown>)['retention.logDays'] = 999;
    expect(getDictionaryOverrides()['retention.logDays']).toBe(7);
  });

  it('清空覆盖后回到 env 默认值', () => {
    setDictionaryOverrides({ 'rateLimit.authMax': 1 });
    expect(getConfig().rateLimit.authMax).toBe(1);
    clearDictionaryOverrides();
    expect(getConfig().rateLimit.authMax).toBe(getEnvConfig().rateLimit.authMax);
  });

  it('覆盖层的 value 为 null 时，null !== undefined 会被套用（记录当前语义）', () => {
    const baseline = getEnvConfig();
    setDictionaryOverrides({ 'rateLimit.windowMs': null } as never);
    const effective = getConfig();
    expect(effective.rateLimit.windowMs).toBeNull();
    expect(baseline.rateLimit.windowMs).not.toBeNull();
  });

  it('上传大小上限按 npm / PyPI 分别覆盖，HTTP 硬天花板不受影响', () => {
    const baseline = getEnvConfig();
    setDictionaryOverrides({ 'limits.maxNpmUploadBytes': 220 * 1024 * 1024 });
    const effective = getConfig();
    expect(effective.limits.maxNpmUploadBytes).toBe(220 * 1024 * 1024);
    expect(effective.limits.maxPypiUploadBytes).toBe(baseline.limits.maxPypiUploadBytes);
    expect(effective.limits.maxNpmPublishBytes).toBe(baseline.limits.maxNpmPublishBytes);
    expect(effective.limits).not.toBe(baseline.limits);
    expect(baseline.limits.maxNpmUploadBytes).toBe(200 * 1024 * 1024);
  });

  it('一次性覆盖全部分组的所有登记字段均生效', () => {
    setDictionaryOverrides({
      'rateLimit.enabled': false,
      'security.scanEnabled': false,
      'security.requireSignature': true,
      'retention.deletedPackageDays': 0,
      'backup.enabled': false,
      'missing.autoReport': false,
      'limits.maxNpmUploadBytes': 64 * 1024 * 1024,
      'limits.maxPypiUploadBytes': 128 * 1024 * 1024,
    });
    const c = getConfig();
    expect(c.rateLimit.enabled).toBe(false);
    expect(c.security.scanEnabled).toBe(false);
    expect(c.security.requireSignature).toBe(true);
    expect(c.retention.deletedPackageDays).toBe(0);
    expect(c.backup.enabled).toBe(false);
    expect(c.missing.autoReport).toBe(false);
    expect(c.limits.maxNpmUploadBytes).toBe(64 * 1024 * 1024);
    expect(c.limits.maxPypiUploadBytes).toBe(128 * 1024 * 1024);
  });

  it('清空空覆盖层是幂等的', () => {
    clearDictionaryOverrides();
    clearDictionaryOverrides();
    expect(getDictionaryOverrides()).toEqual({});
    expect(getConfig()).toBe(getEnvConfig());
  });
});

/**
 * 跨进程一致性：三角色共享同一 SQLite 库，保存方进程立即生效，
 * 其他进程靠覆盖层的惰性回读自动同步，无需重启容器。
 */
describe('字典覆盖层跨进程同步（单元）', () => {
  let nowSpy: jest.SpyInstance | null = null;

  beforeEach(() => {
    registerDictionaryLoader(null);
    clearDictionaryOverrides();
    resetConfigCache();
  });

  afterEach(() => {
    // 注销 loader 必须在 clear 之前完成，否则 clear 会把 lastSyncAt 复位成强制回读
    registerDictionaryLoader(null);
    nowSpy?.mockRestore();
    nowSpy = null;
    clearDictionaryOverrides();
    resetConfigCache();
  });

  it('注册 loader 后首次 getConfig 自动回读，模拟另一角色进程启动', () => {
    // 共享 DB 中已由 console 进程保存了「关闭扫描」
    const dbValues: DictionaryOverrides = { 'security.scanEnabled': false, 'rateLimit.authMax': 2 };
    const loader = jest.fn(() => dbValues);
    const baseline = getEnvConfig();
    registerDictionaryLoader(loader);

    expect(getConfig().security.scanEnabled).toBe(false);
    expect(getConfig().rateLimit.authMax).toBe(2);
    expect(loader).toHaveBeenCalledTimes(1);
    // env 基线不被字典覆盖污染
    expect(getEnvConfig().security.scanEnabled).toBe(baseline.security.scanEnabled);
    expect(getEnvConfig().rateLimit.authMax).toBe(baseline.rateLimit.authMax);
  });

  it('同步间隔内复用内存值，到期后自动回读到其他进程的变更', () => {
    let value: DictionaryOverrides = { 'rateLimit.authMax': 1 };
    const loader = jest.fn(() => value);
    let now = 10_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    registerDictionaryLoader(loader, { syncIntervalMs: 1000 });

    expect(getConfig().rateLimit.authMax).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);

    now += 999;
    expect(getConfig().rateLimit.authMax).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1); // 未到期，不查库

    value = { 'rateLimit.authMax': 7 }; // 模拟另一个进程保存了新值
    now += 1;
    expect(getConfig().rateLimit.authMax).toBe(7);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('回读失败时沿用上次已生效值并回调 onError，不因读配置让请求失败', () => {
    let fail = false;
    const onError = jest.fn();
    const loader = jest.fn(() => {
      if (fail) throw new Error('SQLITE_BUSY');
      return { 'security.scanEnabled': false } as DictionaryOverrides;
    });
    let now = 10_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    registerDictionaryLoader(loader, { syncIntervalMs: 1000, onError });

    expect(getConfig().security.scanEnabled).toBe(false);
    fail = true;
    now += 1000;
    expect(getConfig().security.scanEnabled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('模拟 console 保存后 npm 进程内存为空：下一次读取自动同步到关闭扫描', () => {
    const sharedDb: DictionaryOverrides = {};
    registerDictionaryLoader(() => ({ ...sharedDb }), { syncIntervalMs: 1000 });

    // console 进程：写入共享 DB 并立即套用
    sharedDb['security.scanEnabled'] = false;
    setDictionaryOverrides({ ...sharedDb });
    expect(getConfig().security.scanEnabled).toBe(false);

    // npm 进程：从未收到保存通知，进程内覆盖层为空
    clearDictionaryOverrides();
    expect(getConfig().security.scanEnabled).toBe(false);
    expect(getEnvConfig().security.scanEnabled).toBe(true);
  });

  it('refreshDictionaryOverrides 忽略间隔立即回读；注销 loader 后停止回读', () => {
    let value: DictionaryOverrides = { 'rateLimit.windowMs': 1000 };
    const loader = jest.fn(() => value);
    registerDictionaryLoader(loader, { syncIntervalMs: 60_000 });

    expect(getConfig().rateLimit.windowMs).toBe(1000);
    value = { 'rateLimit.windowMs': 5000 };
    expect(getConfig().rateLimit.windowMs).toBe(1000); // 间隔内仍是旧值

    refreshDictionaryOverrides();
    expect(getConfig().rateLimit.windowMs).toBe(5000);

    registerDictionaryLoader(null);
    value = { 'rateLimit.windowMs': 9000 };
    expect(getConfig().rateLimit.windowMs).toBe(5000); // 注销后不再回读
  });
});

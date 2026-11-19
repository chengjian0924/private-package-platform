import {
  applyDictionaryOverrides,
  clearDictionaryOverrides,
  getDictionaryOverrides,
  setDictionaryOverrides,
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

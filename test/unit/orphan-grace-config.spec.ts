import { getConfig, resetConfigCache } from '../../src/config/config';

/**
 * 孤儿宽限期的配置护栏：宽限期与「清扫间隔」是两个独立概念，
 * 设成 0 会让正在上传（对象已落盘、DB 尚未提交）的文件在扫描瞬间被删，
 * 因此下限固定 1 小时，配置更小的值按 1 处理（不阻断启动）。
 */
describe('孤儿宽限期配置', () => {
  const KEY = 'SECURITY_ORPHAN_GRACE_HOURS';
  let saved: string | undefined;

  beforeAll(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    resetConfigCache();
  });

  it('默认取一个扫描周期（6 小时）', () => {
    delete process.env[KEY];
    resetConfigCache();
    expect(getConfig().security.orphanGraceHours).toBe(6);
  });

  it('0 或负数被钳制到 1 小时', () => {
    process.env[KEY] = '0';
    resetConfigCache();
    expect(getConfig().security.orphanGraceHours).toBe(1);

    process.env[KEY] = '-5';
    resetConfigCache();
    expect(getConfig().security.orphanGraceHours).toBe(1);
  });

  it('显式配置高于下限时原样生效', () => {
    process.env[KEY] = '24';
    resetConfigCache();
    expect(getConfig().security.orphanGraceHours).toBe(24);
  });
});

import * as fsp from 'node:fs/promises';
import { createTestApp, type TestContext } from './app-factory';
import { getConfig } from '../src/config/config';
import { SecurityService } from '../src/security/security.service';
import { StorageService } from '../src/storage/storage.service';

/**
 * 孤儿对象清扫的两个关键语义：
 * - 宽限期按「无引用 且 mtime 超过宽限期」判定，宽限期内的新对象一律不动；
 * - 内容寻址复用（同一 sha256 再次上传）必须刷新 mtime，否则一个很久以前
 *   创建、恰好无引用的对象会在复用上传的窗口期被扫走。
 */
describe('孤儿对象清扫（e2e）', () => {
  let ctx: TestContext;
  let storage: StorageService;
  let security: SecurityService;

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  beforeAll(async () => {
    ctx = await createTestApp('orphan-sweep');
    storage = ctx.app.get(StorageService);
    security = ctx.app.get(SecurityService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('宽限期内的无引用对象保留，超期的才计入孤儿', async () => {
    const grace = getConfig().security.orphanGraceHours;
    // 两个对象都不写库，天然无引用；只有 mtime 不同
    const stale = await storage.putObject(Buffer.from('orphan-stale-content'));
    await fsp.utimes(stale.path, hoursAgo(grace + 24), hoursAgo(grace + 24));
    const fresh = await storage.putObject(Buffer.from('orphan-fresh-content'));

    const preview = await security.sweepOrphans(false);
    expect(preview.orphanObjects.sample).toContain(stale.key);
    expect(preview.orphanObjects.sample).not.toContain(fresh.key);

    const applied = await security.sweepOrphans(true);
    expect(applied.orphanObjects.sample).toContain(stale.key);
    // 超期的真删，宽限期内的必须还在
    await expect(fsp.stat(stale.path)).rejects.toThrow();
    await expect(fsp.stat(fresh.path)).resolves.toBeTruthy();
  });

  it('复用已存在对象时刷新 mtime，复用窗口不会被清扫误删', async () => {
    const buf = Buffer.from('dedup-same-content');
    const first = await storage.putObject(buf);
    // 模拟对象在库里躺了很久：mtime 拨到宽限期之外
    await fsp.utimes(first.path, hoursAgo(72), hoursAgo(72));

    // 再次上传同一内容：不重写文件，但必须刷新 mtime 表明「刚被引用」
    const second = await storage.putObject(buf);
    expect(second.key).toBe(first.key);
    const stat = await fsp.stat(first.path);
    expect(Date.now() - stat.mtimeMs).toBeLessThan(60_000);

    // 刷新后它不再是孤儿，即使内容与之前完全一致
    const preview = await security.sweepOrphans(false);
    expect(preview.orphanObjects.sample).not.toContain(first.key);
  });
});

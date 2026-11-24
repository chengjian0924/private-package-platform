import request from 'supertest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball, sha256 } from './fixtures';
import { getConfig, getEnvConfig } from '../src/config/config';
import { BackupService } from '../src/maintenance/backup.service';
import { StorageService } from '../src/storage/storage.service';

/** 发布一个最小 npm 包，返回 tarball 的 sha256（内容寻址存储里的对象键就是它） */
async function publishNpm(ctx: TestContext, name: string, version: string): Promise<string> {
  const tarball = await makeNpmTarball(name, version, { description: '备份用例' });
  await request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: { [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length } },
    })
    .expect(201);
  return sha256(tarball);
}

function saveDict(ctx: TestContext, values: Record<string, unknown>) {
  return request(ctx.baseUrl)
    .put('/api/v1/dictionary')
    .auth(ADMIN.username, ADMIN.password)
    .send({ values });
}

/** 备份文件路径：<backupDir>/<sha 前 2 位>/<sha256>，与对象存储同构 */
function backupPath(sha: string): string {
  return path.join(getConfig().backup.dir, sha.slice(0, 2), sha);
}

describe('包文件备份（e2e）', () => {
  let ctx: TestContext;
  let backup: BackupService;
  let shaA = '';

  beforeAll(async () => {
    ctx = await createTestApp('backup');
    backup = ctx.app.get(BackupService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('默认开启：入库的包会被复制到备份目录，重复执行幂等', async () => {
    expect(getConfig().backup.enabled).toBe(true);
    // 默认地址：<DATA_DIR>/backups
    expect(getConfig().backup.dir).toBe(path.join(ctx.dataDir, 'backups'));

    shaA = await publishNpm(ctx, 'e2e-backup-a', '1.0.0');

    const first = await backup.runSweep();
    expect(first.enabled).toBe(true);
    expect(first.copied).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);

    const dest = backupPath(shaA);
    expect(fs.existsSync(dest)).toBe(true);
    // 内容必须逐字节一致：备份不是重新打包，而是原样复制
    const src = fs.readFileSync(path.join(getConfig().objectDir, shaA.slice(0, 2), shaA));
    expect(fs.readFileSync(dest)).toEqual(src);

    // 第二轮：已存在的文件不再复制，只计入 skipped
    const second = await backup.runSweep();
    expect(second.copied).toBe(0);
    expect(second.repaired).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it('关闭开关后不再备份，已生成的备份原样保留', async () => {
    await saveDict(ctx, { 'backup.enabled': false }).expect(200);
    expect(getConfig().backup.enabled).toBe(false);

    const shaB = await publishNpm(ctx, 'e2e-backup-b', '1.0.0');
    const result = await backup.runSweep();
    expect(result).toMatchObject({ enabled: false, copied: 0, skipped: 0, scanned: 0 });
    // 关闭后新包不会被备份
    expect(fs.existsSync(backupPath(shaB))).toBe(false);
    // 但此前的备份一个都不能少
    expect(fs.existsSync(backupPath(shaA))).toBe(true);

    // 重新开启：下一轮把期间新增的包补齐，旧备份仍在
    await saveDict(ctx, { 'backup.enabled': true }).expect(200);
    const resumed = await backup.runSweep();
    expect(resumed.enabled).toBe(true);
    expect(fs.existsSync(backupPath(shaB))).toBe(true);
    expect(fs.existsSync(backupPath(shaA))).toBe(true);
  });

  it('备份间隔可运行时覆盖，越界值整体拒绝且不落库', async () => {
    const saved = await saveDict(ctx, { 'backup.intervalMinutes': 5 }).expect(200);
    const items = (saved.body.data.groups as { key: string; items: { key: string; value: unknown; overridden: boolean }[] }[])
      .find((g) => g.key === 'backup')!.items;
    expect(items.find((i) => i.key === 'backup.intervalMinutes')).toMatchObject({ value: 5, overridden: true });

    // 覆盖层即时生效，env 基线不变
    expect(getConfig().backup.intervalMinutes).toBe(5);
    expect(getEnvConfig().backup.intervalMinutes).toBe(60);

    const tooSmall = await saveDict(ctx, { 'backup.intervalMinutes': 0 }).expect(400);
    expect(tooSmall.body.code).toBe('SYS_VALIDATION');
    expect(String(tooSmall.body.details?.reason)).toContain('不能小于');

    const tooLarge = await saveDict(ctx, { 'backup.intervalMinutes': 10_081 }).expect(400);
    expect(String(tooLarge.body.details?.reason)).toContain('不能大于');

    const badType = await saveDict(ctx, { 'backup.intervalMinutes': 'soon' }).expect(400);
    expect(String(badType.body.details?.reason)).toContain('整数');

    // 校验失败不落库：仍是刚保存的 5
    expect(getConfig().backup.intervalMinutes).toBe(5);

    await saveDict(ctx, { 'backup.intervalMinutes': 60 }).expect(200);
    expect(getConfig().backup.intervalMinutes).toBe(60);
  });

  it('孤儿对象不进备份，隔离区样本会被镜像到备份目录', async () => {
    const cfg = getConfig();

    // 手工造一个符合对象键格式、但没有任何版本引用的孤儿对象
    const orphanSha = 'f'.repeat(64);
    const orphanDir = path.join(cfg.objectDir, orphanSha.slice(0, 2));
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, orphanSha), 'orphan-payload');

    // 隔离区造一个待处置样本
    const quarantineFile = path.join(cfg.security.quarantineDir, 'scan-e2e-quarantine', 'sample.tgz');
    fs.mkdirSync(path.dirname(quarantineFile), { recursive: true });
    fs.writeFileSync(quarantineFile, 'quarantined-payload');

    const result = await backup.runSweep();
    expect(result.failed).toBe(0);
    expect(result.orphanSkipped).toBeGreaterThanOrEqual(1);
    expect(result.quarantineCopied).toBeGreaterThanOrEqual(1);

    // 孤儿对象不复制，避免垃圾被永久固化进备份
    expect(fs.existsSync(path.join(cfg.backup.dir, orphanSha.slice(0, 2), orphanSha))).toBe(false);
    // 隔离样本原样镜像到备份目录的 quarantine 子树
    const backedUp = path.join(cfg.backup.dir, 'quarantine', 'scan-e2e-quarantine', 'sample.tgz');
    expect(fs.existsSync(backedUp)).toBe(true);
    expect(fs.readFileSync(backedUp, 'utf8')).toBe('quarantined-payload');

    // 再跑一轮幂等：已备份的不重复计数
    const again = await backup.runSweep();
    expect(again.quarantineCopied).toBe(0);
  });

  it('源对象被硬删后，备份仍然独立存在', async () => {
    const storage = ctx.app.get(StorageService);
    expect(await storage.deleteObject(shaA)).toBe(true);

    const result = await backup.runSweep();
    expect(result.failed).toBe(0);
    expect(fs.existsSync(backupPath(shaA))).toBe(true);

    // 备份内容不因源对象消失而损坏
    expect(fs.statSync(backupPath(shaA)).size).toBeGreaterThan(0);
  });
});

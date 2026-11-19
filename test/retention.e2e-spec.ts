import request from 'supertest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { getConfig } from '../src/config/config';
import { RetentionService } from '../src/maintenance/retention.service';

/** 直接改库把软删除时间往前拨：保留期以天为单位，只能从数据侧构造超期场景 */
function backdateDeletedAt(dataDir: string, versionId: string, iso: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'platform.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE package_versions SET deleted_at = ? WHERE id = ?').run(iso, versionId);
  } finally {
    db.close();
  }
}

async function publishNpm(ctx: TestContext, name: string, version: string): Promise<string> {
  const tarball = await makeNpmTarball(name, version, { description: '保留期清理用例' });
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

  const detail = await request(ctx.baseUrl)
    .get(`/api/v1/packages/detail?ecosystem=npm&name=${encodeURIComponent(name)}`)
    .auth(ADMIN.username, ADMIN.password)
    .expect(200);
  const row = (detail.body.data.versions as Array<{ id: string; version: string }>).find((v) => v.version === version);
  if (!row) throw new Error('发布后未查询到版本');
  return row.id;
}

function dictionaryValues(groups: Array<{ items: Array<{ key: string; value: unknown }> }>): Record<string, unknown> {
  return Object.fromEntries(groups.flatMap((group) => group.items.map((item) => [item.key, item.value])));
}

describe('保留期清理（e2e）', () => {
  let ctx: TestContext;
  let retention: RetentionService;

  beforeAll(async () => {
    ctx = await createTestApp('retention');
    retention = ctx.app.get(RetentionService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('字典管理下发保留策略分组，默认软删除 30 天、日志 180 天', async () => {
    const res = await request(ctx.baseUrl)
      .get('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);

    const groups = res.body.data.groups as Array<{ key: string; label: string; items: Array<{ key: string; value: unknown; type: string }> }>;
    const retentionGroup = groups.find((g) => g.key === 'retention');
    expect(retentionGroup?.label).toBe('保留与清理');
    expect(retentionGroup?.items.map((i) => i.key)).toEqual([
      'retention.deletedPackageDays',
      'retention.logDays',
    ]);
    // 天数用整数输入而不是开关，前端据此渲染 number input
    expect(retentionGroup?.items.every((i) => i.type === 'int')).toBe(true);

    const values = dictionaryValues(groups);
    expect(values['retention.deletedPackageDays']).toBe(30);
    expect(values['retention.logDays']).toBe(180);
  });

  it('非法天数被拒绝：负数与超过 10 年的值都不落库', async () => {
    await request(ctx.baseUrl)
      .put('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .send({ values: { 'retention.deletedPackageDays': -1 } })
      .expect(400);

    await request(ctx.baseUrl)
      .put('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .send({ values: { 'retention.logDays': 3651 } })
      .expect(400);

    // 校验失败不应改动当前生效值
    expect(getConfig().retention.deletedPackageDays).toBe(30);
    expect(getConfig().retention.logDays).toBe(180);
  });

  it('0 表示不自动清理：保存后本轮清理直接跳过', async () => {
    await request(ctx.baseUrl)
      .put('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .send({ values: { 'retention.deletedPackageDays': 0 } })
      .expect(200);
    expect(getConfig().retention.deletedPackageDays).toBe(0);

    const versionId = await publishNpm(ctx, 'retention-off', '1.0.0');
    await request(ctx.baseUrl)
      .delete(`/api/v1/packages/versions/${versionId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    backdateDeletedAt(ctx.dataDir, versionId, '2020-01-01T00:00:00.000Z');

    const result = await retention.purgeDeletedPackages();
    expect(result.retentionDays).toBe(0);
    expect(result.purgedVersions).toBe(0);

    // 记录仍在，可继续恢复
    const restored = await request(ctx.baseUrl)
      .post(`/api/v1/packages/versions/${versionId}/restore`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(restored.body.data.versionId).toBe(versionId);

    // 复原默认值，避免影响后续用例
    await request(ctx.baseUrl)
      .put('/api/v1/dictionary')
      .auth(ADMIN.username, ADMIN.password)
      .send({ values: { 'retention.deletedPackageDays': 30 } })
      .expect(200);
  });

  it('超过保留期的软删除版本被硬删除：版本、包壳、对象文件与扫描记录一并回收', async () => {
    const name = 'retention-expired';
    const versionId = await publishNpm(ctx, name, '1.0.0');

    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/packages/detail?ecosystem=npm&name=${name}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const sha256 = (detail.body.data.versions as Array<{ id: string; sha256: string }>)[0].sha256;
    const objectPath = path.join(ctx.dataDir, 'objects', sha256.slice(0, 2), sha256);
    await expect(fsp.stat(objectPath)).resolves.toBeTruthy();

    await request(ctx.baseUrl)
      .delete(`/api/v1/packages/versions/${versionId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    backdateDeletedAt(ctx.dataDir, versionId, '2020-01-01T00:00:00.000Z');

    const result = await retention.purgeDeletedPackages();
    expect(result.retentionDays).toBe(30);
    expect(result.purgedVersions).toBe(1);
    expect(result.purgedPackages).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);

    // 版本记录消失：恢复入口已失效（404 而不是 409「未被删除」）
    await request(ctx.baseUrl)
      .post(`/api/v1/packages/versions/${versionId}/restore`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(404);

    // 包壳被回收：列表里不再出现该包
    const list = await request(ctx.baseUrl)
      .get('/api/v1/packages?page=1&pageSize=10&includeDeleted=1')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const names = (list.body.data.items as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain(name);

    // 对象文件被释放
    await expect(fsp.stat(objectPath)).rejects.toThrow();
  });

  it('保留期内的软删除版本不受影响，同包其它版本仍可下载', async () => {
    const publish = async (version: string): Promise<string> => {
      const tarball = await makeNpmTarball('retention-shared', version, { description: '同包多版本' });
      await request(ctx.baseUrl)
        .put('/npm/retention-shared')
        .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
        .send({
          _id: 'retention-shared',
          name: 'retention-shared',
          'dist-tags': { latest: version },
          versions: { [version]: { name: 'retention-shared', version, dist: {} } },
          _attachments: { [`retention-shared-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length } },
        })
        .expect(201);
      const detail = await request(ctx.baseUrl)
        .get('/api/v1/packages/detail?ecosystem=npm&name=retention-shared')
        .auth(ADMIN.username, ADMIN.password)
        .expect(200);
      return (detail.body.data.versions as Array<{ id: string; version: string }>).find((v) => v.version === version)!.id;
    };

    const keepId = await publish('1.0.0');
    const oldId = await publish('2.0.0');

    await request(ctx.baseUrl)
      .delete(`/api/v1/packages/versions/${oldId}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    // 刚删除，仍在 30 天保留期内
    const recent = await retention.purgeDeletedPackages();
    expect(recent.purgedVersions).toBe(0);

    // 超期后才真正回收，且包壳因为还有存活版本而保留
    backdateDeletedAt(ctx.dataDir, oldId, '2020-01-01T00:00:00.000Z');
    const purged = await retention.purgeDeletedPackages();
    expect(purged.purgedVersions).toBe(1);
    expect(purged.purgedPackages).toBe(0);

    await request(ctx.baseUrl)
      .get('/npm/retention-shared/-/retention-shared-1.0.0.tgz')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(keepId).toBeTruthy();
  });

  it('日志清理只删超期日志文件，不动目录里的其它文件', async () => {
    const dir = getConfig().log.dir;
    await fsp.mkdir(dir, { recursive: true });
    const expired = path.join(dir, 'app-2020-01-01.log');
    const rotated = path.join(dir, 'app-2020-01-02.log.1');
    const fresh = path.join(dir, 'app-fresh.log');
    const keep = path.join(dir, 'README.txt');
    await Promise.all([
      fsp.writeFile(expired, 'old\n'),
      fsp.writeFile(rotated, 'rotated\n'),
      fsp.writeFile(fresh, 'new\n'),
      fsp.writeFile(keep, 'not a log\n'),
    ]);
    const old = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all([fsp.utimes(expired, old, old), fsp.utimes(rotated, old, old)]);

    const result = await retention.purgeLogFiles();
    expect(result.retentionDays).toBe(180);
    expect(result.deleted).toBe(2);
    expect(result.sample.sort()).toEqual(['app-2020-01-01.log', 'app-2020-01-02.log.1']);

    await expect(fsp.stat(expired)).rejects.toThrow();
    await expect(fsp.stat(rotated)).rejects.toThrow();
    await expect(fsp.stat(fresh)).resolves.toBeTruthy();
    await expect(fsp.stat(keep)).resolves.toBeTruthy();
  });
});

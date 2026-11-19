import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { resetConfigCache } from '../src/config/config';

/** 跑外部 node 脚本并捕获退出码（promisify 版不支持 reject:false，退出码场景需要自行包装） */
function execNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, (err, stdout, stderr) => {
      resolve({ code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0, stdout, stderr });
    });
  });
}

/**
 * 批次 3（C-04 / RV-26 / RV-31）验收用例：
 * - 扫描记录保留期清理：dry-run 预览、apply 执行、每版本保留最新一条
 * - 报告下载落审计事件
 * - 审计转储脚本：全量快照、哈希链校验、篡改检出
 */
describe('扫描保留期清理与审计转储（e2e）', () => {
  let ctx: TestContext;
  let db: DatabaseSync | null = null;
  let dumpDir: string;

  beforeAll(async () => {
    process.env.SECURITY_SCAN_RETENTION_DAYS = '30';
    resetConfigCache();
    ctx = await createTestApp('retention-audit');
    dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-audit-dump-'));
  });

  afterAll(async () => {
    db?.close();
    await ctx.close();
    fs.rmSync(dumpDir, { recursive: true, force: true });
    delete process.env.SECURITY_SCAN_RETENTION_DAYS;
    resetConfigCache();
  });

  function openDb(): DatabaseSync {
    if (!db) {
      db = new DatabaseSync(path.join(ctx.dataDir, 'platform.db'));
      db.exec('PRAGMA busy_timeout=5000;');
    }
    return db;
  }

  it('扫描保留期清理：dry-run 预览后 apply 执行，每版本保留最新一条（RV-26）', async () => {
    const pkg = 'e2e-retention-lib';
    const tarball = await makeNpmTarball(pkg, '1.0.0');
    await request(ctx.baseUrl)
      .put(`/npm/${pkg}`)
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: pkg,
        versions: { '1.0.0': { version: '1.0.0' } },
        _attachments: { [`${pkg}-1.0.0.tgz`]: { data: tarball.toString('base64') } },
      })
      .expect(201);

    // 造数据：把上传扫描改为 40 天前（超 30 天保留期），并补一条该版本的"最新"扫描
    const conn = openDb();
    const scan = conn
      .prepare('SELECT id, package_version_id FROM security_scans WHERE package_name = ? ORDER BY created_at DESC LIMIT 1')
      .get(pkg) as { id: string; package_version_id: string };
    expect(scan).toBeTruthy();
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    conn.prepare('UPDATE security_scans SET created_at = ? WHERE id = ?').run(staleDate, scan.id);
    conn
      .prepare(
        `INSERT INTO security_scans (id, ecosystem, package_name, package_version, package_version_id, filename, sha256,
          size_bytes, trigger, verdict, risk_score, disposition, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `retention-new-${scan.id}`,
        'npm',
        pkg,
        '1.0.0',
        scan.package_version_id,
        `${pkg}-1.0.0.tgz`,
        'deadbeef',
        0,
        'upload',
        'CLEAN',
        0,
        'ALLOW',
        new Date().toISOString(),
      );

    // dry-run：只预览不删除
    const dryRun = await request(ctx.baseUrl)
      .post('/api/v1/security/maintenance/purge-scans')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(201);
    expect(dryRun.body.data.applied).toBe(false);
    expect(dryRun.body.data.scanCount).toBe(1);
    expect(dryRun.body.data.ids).toContain(scan.id);

    // apply：旧记录删除，版本最新扫描保留
    const applied = await request(ctx.baseUrl)
      .post('/api/v1/security/maintenance/purge-scans')
      .auth(ADMIN.username, ADMIN.password)
      .send({ apply: true })
      .expect(201);
    expect(applied.body.data.applied).toBe(true);
    expect(applied.body.data.scanCount).toBe(1);

    const remains = conn.prepare('SELECT COUNT(*) AS c FROM security_scans WHERE id = ?').get(scan.id) as { c: number };
    expect(Number(remains.c)).toBe(0);
    const kept = conn
      .prepare('SELECT COUNT(*) AS c FROM security_scans WHERE package_version_id = ?')
      .get(scan.package_version_id) as { c: number };
    expect(Number(kept.c)).toBe(1);
  });

  it('报告下载落审计事件（RV-31）', async () => {
    // 独立造数：发布新包产生真实扫描记录（用例 1 的原始扫描已被保留期清理删除）
    const pkg = 'e2e-report-audit-lib';
    const tarball = await makeNpmTarball(pkg, '1.0.0');
    await request(ctx.baseUrl)
      .put(`/npm/${pkg}`)
      .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
      .send({
        name: pkg,
        versions: { '1.0.0': { version: '1.0.0' } },
        _attachments: { [`${pkg}-1.0.0.tgz`]: { data: tarball.toString('base64') } },
      })
      .expect(201);

    const conn = openDb();
    const scan = conn
      .prepare('SELECT id FROM security_scans WHERE package_name = ? ORDER BY created_at DESC LIMIT 1')
      .get(pkg) as { id: string };
    expect(scan).toBeTruthy();

    await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scan.id}/report?format=json`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);

    const auditRow = conn
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'security.report.download' AND resource_id = ?")
      .get(scan.id) as { c: number };
    expect(Number(auditRow.c)).toBe(1);
  });

  it('审计转储脚本：全量快照 + 哈希链校验通过（C-04）', async () => {
    const dbPath = path.join(ctx.dataDir, 'platform.db');
    const { stdout, code } = await execNode([
      path.join(process.cwd(), 'scripts', 'audit-dump.mjs'),
      '--db',
      dbPath,
      '--out',
      dumpDir,
      '--retention',
      '365',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('哈希链校验通过');

    const files = fs.readdirSync(dumpDir).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = fs.readFileSync(path.join(dumpDir, files[0]), 'utf8').trim().split('\n');
    const conn = openDb();
    const total = conn.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number };
    expect(lines.length).toBe(Number(total.c));
    expect(Number(total.c)).toBeGreaterThan(0);

    // 幂等：同日重跑覆盖而不是堆积文件
    await execNode([path.join(process.cwd(), 'scripts', 'audit-dump.mjs'), '--db', dbPath, '--out', dumpDir]);
    expect(fs.readdirSync(dumpDir).filter((name) => name.endsWith('.jsonl')).length).toBe(1);
  });

  it('审计转储脚本：篡改审计行后哈希链校验失败并产出取证文件（C-04）', async () => {
    // 复制一份库文件做篡改演练，不污染真实测试库
    const tamperedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-audit-tamper-'));
    try {
      const src = path.join(ctx.dataDir, 'platform.db');
      const dst = path.join(tamperedDir, 'platform.db');
      fs.copyFileSync(src, dst);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
      }
      const tampered = new DatabaseSync(dst);
      tampered.exec("UPDATE audit_logs SET action = 'forged.action' WHERE id = (SELECT MIN(id) FROM audit_logs)");
      tampered.close();

      const result = await execNode([
        path.join(process.cwd(), 'scripts', 'audit-dump.mjs'),
        '--db',
        dst,
        '--out',
        dumpDir,
        '--retention',
        '365',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('哈希链校验失败');
      expect(fs.readdirSync(dumpDir).some((name) => name.includes('.BROKEN.jsonl'))).toBe(true);

      // 清理取证文件，避免影响后续断言
      for (const name of fs.readdirSync(dumpDir)) {
        if (name.includes('.BROKEN.jsonl')) fs.rmSync(path.join(dumpDir, name));
      }
    } finally {
      fs.rmSync(tamperedDir, { recursive: true, force: true });
    }
  });

  it('审计转储脚本：保留期低于 180 天底线时拒绝执行（C-04）', async () => {
    const result = await execNode([
      path.join(process.cwd(), 'scripts', 'audit-dump.mjs'),
      '--out',
      dumpDir,
      '--retention',
      '90',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('不得低于 180');
  });
});

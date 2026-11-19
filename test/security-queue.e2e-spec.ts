import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball, sha256 } from './fixtures';
import { DatabaseService } from '../src/db/database.service';
import { SecurityService } from '../src/security/security.service';

/** 直接落一条排队态任务，模拟进程重启前留下的记录 */
function insertQueuedJob(
  db: DatabaseService,
  params: { name: string; version: string; sha: string; sizeBytes: number; trigger?: string },
): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO security_scan_jobs
     (id, idempotency_key, status, ecosystem, package_name, package_version, filename, sha256, size_bytes,
      source, trigger, trace_id, actor_id, signature, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    `upload:npm:${params.name}@${params.version}:${params.sha}`,
    'PENDING',
    'npm',
    params.name,
    params.version,
    `${params.name}-${params.version}.tgz`,
    params.sha,
    params.sizeBytes,
    'npm-cli',
    params.trigger ?? 'upload',
    null,
    null,
    null,
    new Date().toISOString(),
  );
  return id;
}

describe('扫描队列持久化（e2e）', () => {
  let ctx: TestContext;
  let db: DatabaseService;
  let security: SecurityService;

  beforeAll(async () => {
    ctx = await createTestApp('security-queue');
    db = ctx.app.get(DatabaseService);
    security = ctx.app.get(SecurityService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('相同包并发提交只产生一个扫描任务与一个 scanId', async () => {
    const tarball = await makeNpmTarball('e2e-queue-dup', '1.0.0');
    const input = {
      ecosystem: 'npm' as const,
      name: 'e2e-queue-dup',
      version: '1.0.0',
      filename: 'e2e-queue-dup-1.0.0.tgz',
      sha256: sha256(tarball),
      sizeBytes: tarball.length,
      source: 'npm-cli',
      trigger: 'upload' as const,
      buffer: tarball,
    };

    const [first, second] = await Promise.all([
      security.scanAndGate({ ...input, buffer: Buffer.from(tarball) }),
      security.scanAndGate({ ...input, buffer: Buffer.from(tarball) }),
    ]);

    expect(second.scanId).toBe(first.scanId);
    const jobs = db.all<{ status: string; scan_id: string }>(
      'SELECT status, scan_id FROM security_scan_jobs WHERE sha256 = ?',
      input.sha256,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('COMPLETED');
    expect(jobs[0].scan_id).toBe(first.scanId);
  });

  it('重启恢复：中断任务从对象存储重扫并补写扫描记录', async () => {
    const tarball = await makeNpmTarball('e2e-queue-recover', '1.0.0');
    const sha = sha256(tarball);
    const objectPath = path.join(ctx.dataDir, 'objects', sha.slice(0, 2), sha);
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    fs.writeFileSync(objectPath, tarball);

    const jobId = insertQueuedJob(db, {
      name: 'e2e-queue-recover',
      version: '1.0.0',
      sha,
      sizeBytes: tarball.length,
    });

    await security.recoverPendingJobs();

    const job = db.get<{ status: string; scan_id: string | null; attempts: number }>(
      'SELECT status, scan_id, attempts FROM security_scan_jobs WHERE id = ?',
      jobId,
    );
    expect(job?.status).toBe('COMPLETED');
    expect(job?.attempts).toBe(1);

    const scan = db.get<{ package_name: string; package_version_id: string | null }>(
      'SELECT package_name, package_version_id FROM security_scans WHERE id = ?',
      job?.scan_id,
    );
    expect(scan?.package_name).toBe('e2e-queue-recover');
    // 恢复只补扫描留档，不补写版本记录，避免绕过上传事务
    expect(scan?.package_version_id).toBeNull();
  });

  it('对象文件缺失时任务置为 FAILED 且不影响服务', async () => {
    const missingSha = 'f'.repeat(64);
    const jobId = insertQueuedJob(db, {
      name: 'e2e-queue-missing',
      version: '1.0.0',
      sha: missingSha,
      sizeBytes: 128,
    });

    await security.recoverPendingJobs();

    const job = db.get<{ status: string; error: string | null; scan_id: string | null }>(
      'SELECT status, error, scan_id FROM security_scan_jobs WHERE id = ?',
      jobId,
    );
    expect(job?.status).toBe('FAILED');
    expect(job?.error).toContain('对象文件不可读');
    expect(job?.scan_id).toBeNull();

    await request(ctx.baseUrl).get('/api/v1/health').auth(ADMIN.username, ADMIN.password).expect(200);
  });
});

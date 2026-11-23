import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resetConfigCache } from '../../src/config/config';
import { DatabaseService } from '../../src/db/database.service';

/**
 * 直接构造历史口径的库：同包同时存在 1.0 与 1.0.0，normalized_version 为旧值。
 * 验证启动迁移后保留创建最早的一条、其余软删除，且重复启动幂等。
 */
describe('PyPI 版本键存量迁移', () => {
  let tmp: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-pep440-mig-'));
    savedEnv = {};
    for (const key of ['DATA_DIR', 'DB_PATH', 'NODE_ENV']) {
      savedEnv[key] = process.env[key];
    }
    process.env.DATA_DIR = tmp;
    process.env.NODE_ENV = 'test';
    delete process.env.DB_PATH;
    resetConfigCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedLegacy(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE packages (
        id TEXT PRIMARY KEY, ecosystem TEXT NOT NULL, normalized_name TEXT NOT NULL,
        display_name TEXT NOT NULL, scope TEXT, status TEXT NOT NULL DEFAULT 'active', dist_tags TEXT
      );
      CREATE TABLE package_versions (
        id TEXT PRIMARY KEY, package_id TEXT NOT NULL, version TEXT NOT NULL,
        normalized_version TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, storage_key TEXT NOT NULL, metadata TEXT, compatibility TEXT,
        status TEXT NOT NULL DEFAULT 'active', uploader_id TEXT, source TEXT NOT NULL,
        signature TEXT, created_at TEXT NOT NULL, deleted_at TEXT,
        UNIQUE(package_id, normalized_version)
      );
      INSERT INTO packages (id, ecosystem, normalized_name, display_name, status)
        VALUES ('p1', 'pypi', 'demo', 'demo', 'active');
      INSERT INTO package_versions
        (id, package_id, version, normalized_version, filename, sha256, size_bytes, storage_key, source, created_at)
      VALUES
        ('older', 'p1', '1.0.0', '1.0.0', 'demo-1.0.0-py3-none-any.whl', 'a', 1, 'k1', 'cli', '2025-01-01T00:00:00.000Z'),
        ('newer', 'p1', 'v1.0', '1.0', 'demo-v1.0-py3-none-any.whl', 'b', 1, 'k2', 'cli', '2025-02-01T00:00:00.000Z');
    `);
    db.close();
  }

  function read(dbPath: string): { id: string; normalized_version: string; status: string; deleted_at: string | null }[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT id, normalized_version, status, deleted_at FROM package_versions ORDER BY id')
      .all() as { id: string; normalized_version: string; status: string; deleted_at: string | null }[];
    db.close();
    return rows;
  }

  it('等价重复版本在启动时收敛为一条，重复启动幂等', () => {
    const dbPath = path.join(tmp, 'platform.db');
    seedLegacy(dbPath);

    const first = new DatabaseService();
    first.onModuleInit();
    first.onModuleDestroy();
    const afterFirst = read(dbPath);

    expect(afterFirst).toHaveLength(2);
    const older = afterFirst.find((r) => r.id === 'older')!;
    const newer = afterFirst.find((r) => r.id === 'newer')!;
    expect(older.normalized_version).not.toBe('1.0.0');
    expect(older.status).toBe('active');
    expect(older.deleted_at).toBeNull();
    expect(newer.status).toBe('deleted');
    expect(newer.deleted_at).not.toBeNull();

    const second = new DatabaseService();
    second.onModuleInit();
    second.onModuleDestroy();
    expect(read(dbPath)).toEqual(afterFirst);
  });
});

import { createTestApp, type TestContext } from './app-factory';
import { DatabaseService } from '../src/db/database.service';

/**
 * 三进程共享同一个 SQLite 库，busy_timeout 决定写锁冲突时等多久才报 SQLITE_BUSY。
 * 历史上 onModuleInit 设了 10s，但 SCHEMA 里又写了一次 5s，把稳态值改小了；
 * 这里锁住最终生效值，避免再被 schema 覆盖。
 */
describe('数据库连接参数（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('db-settings');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('busy_timeout 稳态为 10000ms', () => {
    const db = ctx.app.get(DatabaseService);
    const row = db.get<Record<string, number>>('PRAGMA busy_timeout');
    expect(Object.values(row ?? {})[0]).toBe(10_000);
  });

  it('WAL 与外键约束处于开启状态', () => {
    const db = ctx.app.get(DatabaseService);
    const journal = db.get<Record<string, string>>('PRAGMA journal_mode');
    expect(String(Object.values(journal ?? {})[0]).toLowerCase()).toBe('wal');
    const fk = db.get<Record<string, number>>('PRAGMA foreign_keys');
    expect(Number(Object.values(fk ?? {})[0])).toBe(1);
  });
});

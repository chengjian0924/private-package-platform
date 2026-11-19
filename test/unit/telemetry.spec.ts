import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '../../src/db/database.service';
import { TelemetryService } from '../../src/telemetry/telemetry.service';
import { resetConfigCache } from '../../src/config/config';

/** 遥测埋点：事件写入与倒序读取（此前该模块无任何测试覆盖） */
describe('遥测埋点（单元）', () => {
  let db: DatabaseService;
  let telemetry: TelemetryService;
  let dataDir: string;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-telemetry-unit-'));
    process.env.DATA_DIR = dataDir;
    resetConfigCache();
    db = new DatabaseService();
    // 脱离 Nest 容器时手动触发生命周期（建库与迁移都在 onModuleInit 内）
    db.onModuleInit();
    telemetry = new TelemetryService(db);
  });

  afterAll(() => {
    db.onModuleDestroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    resetConfigCache();
  });

  it('record 写入事件并携带 schema 版本与发生时间', () => {
    telemetry.record('unit.event', { count: 3, label: 'x' }, 'trace-unit-1');

    const rows = db.all<{ event_name: string; schema_version: string; payload: string; trace_id: string | null }>(
      "SELECT event_name, schema_version, payload, trace_id FROM telemetry_events WHERE trace_id = 'trace-unit-1'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].event_name).toBe('unit.event');
    expect(rows[0].schema_version).toBe('1.0');
    expect(JSON.parse(rows[0].payload)).toEqual({ count: 3, label: 'x' });
  });

  it('payload 为空对象兜底，traceId 缺省写 null', () => {
    telemetry.record('unit.event.empty', {});
    const rows = db.all<{ payload: string; trace_id: string | null }>(
      "SELECT payload, trace_id FROM telemetry_events WHERE event_name = 'unit.event.empty'",
    );
    expect(JSON.parse(rows[0].payload)).toEqual({});
    expect(rows[0].trace_id).toBeNull();
  });

  it('连续写入保持行序递增（按 id 倒序即最新在前）', () => {
    for (let i = 0; i < 5; i += 1) telemetry.record(`unit.event.seq.${i}`, { seq: i });
    const rows = db.all<{ event_name: string }>(
      'SELECT event_name FROM telemetry_events WHERE event_name LIKE \'unit.event.seq.%\' ORDER BY id DESC',
    );
    expect(rows.length).toBe(5);
    // 最新写入的事件在最前
    expect(rows[0].event_name).toBe('unit.event.seq.4');
  });
});

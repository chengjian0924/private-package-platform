#!/usr/bin/env node
/**
 * 审计日志转储脚本（C-04，上线前必须项）：
 * 从 SQLite 全量导出审计日志为 JSONL 快照，写入独立只读存储目录（AUDIT_DUMP_DIR），
 * 导出前重算哈希链校验完整性（与 src/audit/audit.service.ts 的写入侧算法保持一致）。
 *
 * 用法：node scripts/audit-dump.mjs [--db <platform.db 路径>] [--out <转储目录>] [--retention <天数>]
 * 环境变量：AUDIT_DUMP_DIR（转储目录，必填）/ DATA_DIR（默认 data，用于推导 db 路径）
 *           AUDIT_RETENTION_DAYS（转储文件留存天数，默认 365；等保底线 180，低于 180 拒绝执行）
 *
 * crontab 示例（每日 02:00 全量快照，当日重复执行幂等覆盖）：
 *   0 2 * * * cd /opt/yuanjian && node scripts/audit-dump.mjs >> logs/audit-dump.log 2>&1
 *
 * 退出码：0 成功；1 哈希链校验失败（文件仍写出供取证，后缀 .BROKEN）；2 参数/环境错误。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const dbPath = argOf('db') ?? process.env.AUDIT_DB ?? path.join(process.env.DATA_DIR ?? 'data', 'platform.db');
const outDir = argOf('out') ?? process.env.AUDIT_DUMP_DIR;
const retentionDays = Number(argOf('retention') ?? process.env.AUDIT_RETENTION_DAYS ?? 365);

if (!outDir) {
  console.error('[audit-dump] 缺少转储目录：设置 AUDIT_DUMP_DIR 环境变量或传 --out <dir>');
  process.exit(2);
}
if (!Number.isFinite(retentionDays) || retentionDays < 180) {
  // 等保要求审计留存 ≥180 天，转储侧守住底线
  console.error('[audit-dump] AUDIT_RETENTION_DAYS 不得低于 180 天（等保审计留存底线）');
  process.exit(2);
}

// 哈希链写入侧算法（audit.service.ts）：字段顺序与空值语义必须逐字对齐，否则校验必然失败
function computeHash(fields) {
  return createHash('sha256').update(fields.join('|')).digest('hex');
}

let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  console.error(`[audit-dump] 无法打开数据库 ${dbPath}: ${err.message}`);
  process.exit(2);
}
// 只读防线：本脚本绝不写业务库
db.exec('PRAGMA query_only = ON');

const rows = db
  .prepare(
    `SELECT id, trace_id, actor_id, actor_token_hash, action, resource_type, resource_id, result,
            ip, user_agent, detail, prev_hash, hash, created_at
     FROM audit_logs ORDER BY id ASC`,
  )
  .all();

let prevHash = 'genesis';
let brokenAt = null;
for (const row of rows) {
  const expected = computeHash([
    prevHash,
    row.trace_id ?? '',
    row.actor_id ?? '',
    row.actor_token_hash ?? '',
    row.action,
    row.result,
    row.resource_id ?? '',
    row.detail ?? '',
    row.created_at,
  ]);
  if (row.prev_hash !== prevHash || row.hash !== expected) {
    brokenAt = row.id;
    break;
  }
  prevHash = row.hash;
}
db.close();

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const suffix = brokenAt === null ? '' : '.BROKEN';
const outFile = path.join(outDir, `audit-logs-${today}${suffix}.jsonl`);

await mkdir(outDir, { recursive: true });
// 当日重跑幂等：先移除旧快照（含正常态与 BROKEN 态）再全量重写
await rm(outFile, { force: true });
await rm(path.join(outDir, `audit-logs-${today}.jsonl`), { force: true });
await rm(path.join(outDir, `audit-logs-${today}.BROKEN.jsonl`), { force: true });
await writeFile(outFile, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
// 只读防篡改：文件置 0444；次日重跑时上面的 rm 负责移除后重写
await chmod(outFile, 0o444);

// 转储目录内旧快照按保留期回收（默认 365 天，≥ 等保底线 180 天）
let cleaned = 0;
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const name of await readdir(outDir)) {
  const m = name.match(/^audit-logs-(\d{8})(?:\.BROKEN)?\.jsonl$/);
  if (!m) continue;
  const ts = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T00:00:00Z`);
  if (Number.isFinite(ts) && ts < cutoff) {
    await rm(path.join(outDir, name), { force: true });
    cleaned += 1;
  }
}

if (brokenAt !== null) {
  console.error(
    `[audit-dump] 哈希链校验失败：第 ${brokenAt} 行与链上前序不匹配，已写出取证文件 ${outFile}，请立即排查审计篡改风险`,
  );
  process.exit(1);
}

console.log(
  `[audit-dump] 完成：共 ${rows.length} 条审计记录，哈希链校验通过，快照 ${outFile}，清理过期转储 ${cleaned} 个`,
);

#!/usr/bin/env node
/**
 * OSV 漏洞库同步脚本：把 OSV 官方导出（npm / PyPI）转成本平台的漏洞库导入格式，可选直接打到
 * POST /api/v1/security/advisories/import。
 *
 * 为什么需要转换：OSV 记录是「一个漏洞 + 若干受影响的包 + 版本区间事件（introduced/fixed）」，
 * 而平台表 `vulnerability_advisories` 是「一行一个包的一个区间」，且区间用比较符表达
 * （npm 走 semver，pypi 走 PEP 440），两者格式不兼容，不能直接灌。
 *
 * 用法：
 *   node scripts/osv-sync.mjs                                # 转 npm + pypi，写到 data/vulndb
 *   node scripts/osv-sync.mjs --ecosystems pypi
 *   node scripts/osv-sync.mjs --out /tmp/vulndb --chunk-mb 20
 *   node scripts/osv-sync.mjs --upload http://127.0.0.1:3000 --username admin --password '***'
 *
 * 参数：
 *   --ecosystems npm,pypi   要同步的生态（默认两个都做）
 *   --out <dir>             输出目录（默认 data/vulndb），转换结果按分片写 <eco>-001.json
 *   --cache <dir>           压缩包缓存目录（默认 <out>/.cache），已存在则直接复用
 *   --chunk-mb <n>          单个分片上限（默认 20，平台导入接口硬上限 50MB）
 *   --max-records <n>       每个生态只处理前 n 条，便于快速试跑
 *   --refresh               忽略缓存重新下载
 *   --keep-extracted        保留解压目录（默认用完即删，npm 解开约 400MB）
 *   --upload <baseUrl>      转换后逐分片调用导入接口
 *   --username/--password   登录换取会话（也可用 --cookie 直接贴 Cookie 头）
 *   --dry-run               只下载与转换，不写文件
 *
 * 退出码：0 成功；1 上传有失败分片；2 参数/下载错误。
 */
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const has = (name) => args.includes(`--${name}`);

const ECOSYSTEMS = {
  npm: { dir: 'npm', osv: 'npm' },
  pypi: { dir: 'PyPI', osv: 'PyPI' },
};

const wanted = (argOf('ecosystems') ?? 'npm,pypi')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const outDir = path.resolve(argOf('out') ?? 'data/vulndb');
const cacheDir = path.resolve(argOf('cache') ?? path.join(outDir, '.cache'));
const chunkBytes = Math.max(1, Number(argOf('chunk-mb') ?? 20)) * 1024 * 1024;
const maxRecords = Number(argOf('max-records') ?? 0) || 0;
const uploadBase = argOf('upload');
const dryRun = has('dry-run');

for (const eco of wanted) {
  if (!ECOSYSTEMS[eco]) {
    console.error(`[osv-sync] 不支持的生态 ${eco}，可选：${Object.keys(ECOSYSTEMS).join(' / ')}`);
    process.exit(2);
  }
}

// ---------- 转换 ----------

const SEVERITY_MAP = { low: 'low', moderate: 'medium', medium: 'medium', high: 'high', critical: 'critical' };

/** 由 OSV 的 introduced/fixed/last_affected 事件序列拼出比较符区间（多段用 || 分隔） */
function eventsToSpec(events, eco) {
  const sep = eco === 'pypi' ? ',' : ' ';
  const pieces = [];
  const fixes = [];
  let lower = null;

  for (const ev of events) {
    if (ev.introduced !== undefined) {
      // introduced=0 表示「从最初版本起」，无下界；写成 >=0 在 npm semver 里是非法区间
      lower = ev.introduced && String(ev.introduced) !== '0' ? String(ev.introduced) : null;
    } else if (ev.fixed !== undefined) {
      const upper = `<${ev.fixed}`;
      pieces.push(lower ? `>=${lower}${sep}${upper}` : upper);
      fixes.push(String(ev.fixed));
      lower = null;
    } else if (ev.last_affected !== undefined) {
      const upper = `<=${ev.last_affected}`;
      pieces.push(lower ? `>=${lower}${sep}${upper}` : upper);
      lower = null;
    }
  }
  // 只有下界没有上界：至今未修复，任何 >=lower 的版本都算命中
  if (lower) pieces.push(`>=${lower}`);
  return { spec: pieces.join(' || '), fixes };
}

function pickSeverity(record, affected) {
  const fromDb =
    SEVERITY_MAP[String(affected?.database_specific?.severity ?? record.database_specific?.severity ?? '').toLowerCase()];
  if (fromDb) return { severity: fromDb, cvss: null };

  for (const item of record.severity ?? []) {
    const score = String(item?.score ?? '').trim();
    // 少数数据源直接给数字分数；CVSS 向量不在服务端解析，留给默认级别
    if (/^\d+(\.\d+)?$/.test(score)) {
      const value = Number(score);
      const severity = value >= 9 ? 'critical' : value >= 7 ? 'high' : value >= 4 ? 'medium' : 'low';
      return { severity, cvss: value };
    }
  }
  return { severity: null, cvss: null };
}

/** 与平台 compareLoose 同口径的粗比较，只用来在一组修复点里取最大值 */
function compareVersion(a, b) {
  const parse = (raw) => (String(raw).trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/)?.[1] ?? '').split('.').map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function sourceOf(id) {
  const prefix = String(id).split('-')[0].toUpperCase();
  return ['GHSA', 'CVE', 'PYSEC', 'OSV', 'CNVD'].includes(prefix) ? prefix : 'OSV';
}

/** 一条 OSV 记录 → 若干行平台漏洞条目（同包的多段区间合并成一行） */
function toRows(record, eco) {
  if (record?.withdrawn) return { rows: [], reason: 'withdrawn' };
  const advisoryId = String(record.id ?? '').trim();
  if (!advisoryId) return { rows: [], reason: 'no-id' };

  const byPackage = new Map();
  for (const affected of record.affected ?? []) {
    const pkgEco = String(affected?.package?.ecosystem ?? '');
    if (pkgEco.toLowerCase() !== ECOSYSTEMS[eco].osv.toLowerCase()) continue;
    const name = String(affected?.package?.name ?? '').trim();
    if (!name) continue;

    const bucket = byPackage.get(name.toLowerCase()) ?? { name, specs: [], fixes: [] };
    for (const range of affected.ranges ?? []) {
      if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue; // GIT 区间是提交哈希，平台没法用
      const { spec, fixes } = eventsToSpec(range.events ?? [], eco);
      if (spec && !bucket.specs.includes(spec)) bucket.specs.push(spec);
      for (const version of fixes) if (!bucket.fixes.includes(version)) bucket.fixes.push(version);
    }
    if (affected.versions?.length && bucket.specs.length === 0) {
      // 没有可用区间时退回版本清单，上限 60 个避免单行过长
      const specs = affected.versions.slice(0, 60).map((v) => `==${v}`);
      bucket.specs.push(specs.join(' || '));
    }
    byPackage.set(name.toLowerCase(), bucket);
  }
  if (byPackage.size === 0) return { rows: [], reason: 'no-package' };

  const { severity, cvss } = pickSeverity(record, [...(record.affected ?? [])][0]);
  const references = (record.references ?? [])
    .map((ref) => String(ref?.url ?? '').trim())
    .filter(Boolean)
    .slice(0, 20);

  const rows = [];
  for (const bucket of byPackage.values()) {
    rows.push({
      source: sourceOf(advisoryId),
      advisoryId,
      ecosystem: eco,
      packageName: bucket.name,
      affectedRange: bucket.specs.join(' || ') || '*',
      severity,
      cvss,
      title: record.summary || advisoryId,
      description: record.summary || null,
      fixedVersion: bucket.fixes.length
        ? bucket.fixes.reduce((top, item) => (compareVersion(item, top) > 0 ? item : top))
        : null,
      references,
      publishedAt: record.published ?? null,
    });
  }
  return { rows, reason: null };
}

// ---------- 下载 ----------

async function download(eco) {
  const target = path.join(cacheDir, `${eco}-all.zip`);
  if (!has('refresh')) {
    const info = await stat(target).catch(() => null);
    if (info?.size > 0) {
      console.log(`[osv-sync] ${eco}: 复用缓存 ${target}（${(info.size / 1048576).toFixed(1)} MB）`);
      return target;
    }
  }
  const url = `https://storage.googleapis.com/osv-vulnerabilities/${ECOSYSTEMS[eco].dir}/all.zip`;
  console.log(`[osv-sync] ${eco}: 下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  await rm(target, { force: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
  const info = await stat(target);
  console.log(`[osv-sync] ${eco}: 完成 ${(info.size / 1048576).toFixed(1)} MB`);
  return target;
}

// ---------- 分片写出 ----------

function makeWriter(eco) {
  let index = 0;
  let buffer = [];
  let bytes = 2;
  const files = [];

  async function flush() {
    if (buffer.length === 0) return;
    index += 1;
    const file = path.join(outDir, `${eco}-${String(index).padStart(3, '0')}.json`);
    const payload = JSON.stringify({ advisories: buffer });
    if (!dryRun) await writeFile(file, payload);
    files.push({ file, count: buffer.length, bytes: payload.length });
    console.log(`[osv-sync] ${eco}: 写出 ${path.basename(file)}（${buffer.length} 条，${(payload.length / 1048576).toFixed(1)} MB）`);
    buffer = [];
    bytes = 2;
  }

  return {
    async push(row) {
      const size = JSON.stringify(row).length + 1;
      if (bytes + size > chunkBytes && buffer.length > 0) await flush();
      buffer.push(row);
      bytes += size;
    },
    async close() {
      await flush();
      return files;
    },
  };
}

// ---------- 上传 ----------

async function login() {
  const username = argOf('username');
  const password = argOf('password');
  if (!username || !password) return argOf('cookie');
  const res = await fetch(new URL('/api/v1/auth/login', uploadBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) throw new Error(`登录失败：${body.message || res.status}`);
  if (body.data?.mustChangePassword) {
    throw new Error('该账号仍需修改初始密码，请先完成改密再导入漏洞库');
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  const sid = cookies.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
  if (!sid) throw new Error('登录成功但未拿到会话 Cookie');
  return sid;
}

async function upload(file, cookie) {
  const payload = await readFile(file, 'utf8');
  const res = await fetch(new URL('/api/v1/security/advisories/import', uploadBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: payload,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) throw new Error(body.message || `HTTP ${res.status}`);
  return body.data ?? {};
}

// ---------- 解压 ----------

/**
 * 逐条产出 OSV 记录。优先用系统 unzip 解到临时目录再逐个读文件：
 * npm 全量有 23 万个条目、adm-zip 光建索引就要 2GB 堆，直接 OOM。
 * 没有 unzip 时退回 adm-zip（只适合 PyPI 量级）。
 */
async function* iterateRecords(eco, zipPath) {
  const dir = path.join(cacheDir, `extracted-${eco}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', dir], { stdio: 'inherit' });
  if (unzip.error?.code === 'ENOENT') {
    console.warn(`[osv-sync] 未找到 unzip，退回 adm-zip 读取（大库可能内存不足）：${eco}`);
    await rm(dir, { recursive: true, force: true });
    const entries = new AdmZip(zipPath).getEntries();
    for (const entry of entries) {
      if (entry.isDirectory || !entry.entryName.endsWith('.json')) continue;
      yield { name: entry.entryName, text: () => entry.getData().toString('utf8') };
    }
    return;
  }
  if (unzip.status !== 0) throw new Error(`unzip 解压失败，退出码 ${unzip.status}`);

  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  console.log(`[osv-sync] ${eco}: 解压 ${names.length} 个条目到 ${dir}`);
  for (const name of names) {
    const file = path.join(dir, name);
    yield { name, text: () => readFile(file, 'utf8') };
  }
}

// ---------- 主流程 ----------

await mkdir(outDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

let cookie = null;
if (uploadBase && !dryRun) {
  cookie = argOf('cookie') ?? (await login());
  if (!cookie) throw new Error('缺少 --cookie，或提供 --username/--password');
}

let hasFailure = false;
const summary = [];

for (const eco of wanted) {
  const zipPath = await download(eco);

  const writer = makeWriter(eco);
  const seen = new Set();
  const skipped = { withdrawn: 0, 'no-package': 0, 'no-id': 0, duplicate: 0 };
  let processed = 0;

  for await (const entry of iterateRecords(eco, zipPath)) {
    if (maxRecords > 0 && processed >= maxRecords) break;
    processed += 1;
    let record;
    try {
      record = JSON.parse(await entry.text());
    } catch {
      continue;
    }
    const { rows, reason } = toRows(record, eco);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    for (const row of rows) {
      const key = `${row.advisoryId}|${row.packageName.toLowerCase()}|${row.affectedRange}`;
      if (seen.has(key)) {
        skipped.duplicate += 1;
        continue;
      }
      seen.add(key);
      await writer.push(row);
    }
  }

  const files = await writer.close();
  // 解压目录只在本轮用一次，npm 解开近 400MB，默认用完就删
  if (!has('keep-extracted')) {
    await rm(path.join(cacheDir, `extracted-${eco}`), { recursive: true, force: true });
  }
  const total = files.reduce((sum, item) => sum + item.count, 0);
  console.log(
    `[osv-sync] ${eco}: 读取 ${processed} 条记录 → 生成 ${total} 行，分 ${files.length} 片；` +
      `跳过 撤回 ${skipped.withdrawn} / 无目标生态包 ${skipped['no-package']} / 缺编号 ${skipped['no-id']} / 重复 ${skipped.duplicate}`,
  );

  if (cookie) {
    let imported = 0;
    let updated = 0;
    let failed = 0;
    for (const item of files) {
      try {
        const result = await upload(item.file, cookie);
        imported += Number(result.imported ?? 0);
        updated += Number(result.updated ?? 0);
        const errors = result.errors ?? [];
        console.log(
          `[osv-sync] ${eco}/${path.basename(item.file)}: 新增 ${result.imported ?? 0}，更新 ${result.updated ?? 0}，` +
            `跳过 ${result.skipped ?? 0}${errors.length ? `，示例错误 ${errors[0]}` : ''}`,
        );
        if (result.skipped > 0 && imported + updated === 0) failed += 1;
      } catch (err) {
        failed += 1;
        hasFailure = true;
        console.error(`[osv-sync] ${eco}/${path.basename(item.file)}: 导入失败 ${err.message}`);
      }
    }
    console.log(`[osv-sync] ${eco}: 导入汇总 新增 ${imported} / 更新 ${updated} / 失败分片 ${failed}`);
    summary.push({ eco, total, imported, updated, failed });
  } else {
    summary.push({ eco, total, files: files.map((item) => item.file) });
  }
}

console.log('[osv-sync] 完成：', JSON.stringify(summary));
process.exit(hasFailure ? 1 : 0);

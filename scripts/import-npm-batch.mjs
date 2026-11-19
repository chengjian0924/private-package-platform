#!/usr/bin/env node
/**
 * 源鉴 · 离线 npm 包批量导入脚本（零外部 CLI，仅用项目已有 adm-zip）
 *
 * 用途：把 dsh 离线插件包（双层 zip，内层含 tarballs/*.tgz + registry.json）
 * 里的全部 tgz，按 npm publish 协议逐个导入源鉴。清单取自 registry.json.artifacts，
 * 它给出每个 tgz 文件名 → {name, version, sha256, bytes, source}，无需逐个解包读 package.json。
 *
 * 为什么不用官方 npm publish：
 *   1) tgz 文件名是 sha256 而非 <name>-<version>.tgz，npm CLI 无法直接发；
 *   2) 每个包的 package.json 带 publishConfig.registry=npmjs.org，npm CLI 会按它推送到公网；
 *   3) 本脚本直接构造 publish body 发往指定源鉴 URL，publishConfig 完全不参与，
 *      且 integrity/shasum 原样透传（已校验与 tgz 内容一致），不会触发 PKG_INTEGRITY_MISMATCH。
 *
 * 用法：
 *   node scripts/import-npm-batch.mjs \
 *     --zip /Users/kong/Downloads/njcb-offline-plugins-win-x64.zip \
 *     --base http://<host>:3000 --username admin --token "$YJ_TOKEN" \
 *     --batch-size 20 --concurrency 4 --dry-run
 *
 * 参数：
 *   --zip <path>        离线插件包（双层 zip），与 --dir 二选一
 *   --dir <path>        已解压的内层目录（含 tarballs/ 与 registry.json），与 --zip 二选一
 *   --base <url>        源鉴根地址，默认 http://127.0.0.1:3000
 *   --username <u>      源鉴用户名，默认取 YJ_USERNAME
 *   --token <t>         API Token（yj_...），默认取 YJ_TOKEN；Username/Password 也接受
 *   --batch-size <n>    每批包数，默认 20；0 表示不分批一次性全部
 *   --concurrency <n>   批内并发，默认 4
 *   --only-targets      只导入 plugins.txt 列出的插件包（跳过其依赖之外的包；谨慎使用，通常全导）
 *   --limit <n>         最多导入 n 个包（调试用，0=不限）
 *   --timeout <ms>      单请求超时，默认 120000
 *   --retry <n>         单包失败重试次数，默认 3（409 已存在不重试，直接视为成功）
 *   --retry-delay <ms>  重试基础退避毫秒，默认 1000（指数退避）
 *   --batch-delay <ms>  批间停顿毫秒，默认 500
 *   --state <path>      断点状态文件，默认 <zip/dir 同级>/.import-npm-state.json
 *   --reset             忽略状态文件，从头重跑
 *   --dry-run           只做解析与校验，不发送请求
 *   --fail-fast         首个失败即停止（默认继续处理完当前批）
 *
 * 退出码：0=全部成功或跳过；1=存在失败；2=参数/环境错误
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (out[key] === true || typeof out[key] === 'string') {
      // 布尔开关重复出现不覆盖
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = args['dry-run'] === true;
const reset = args.reset === true;
const onlyTargets = args['only-targets'] === true;
const failFast = args['fail-fast'] === true;

function fail(msg, code = 2) {
  console.error('ERROR:', msg);
  process.exit(code);
}

function numArg(key, def) {
  if (args[key] === undefined || args[key] === true) return def;
  const n = Number(args[key]);
  if (!Number.isFinite(n) || n < 0) fail(`--${key} 必须是非负数，收到 ${args[key]}`);
  return n;
}

const zipPath = args.zip && args.zip !== true ? path.resolve(args.zip) : null;
const dirPath = args.dir && args.dir !== true ? path.resolve(args.dir) : null;
if (!zipPath && !dirPath) fail('必须提供 --zip 或 --dir');
if (zipPath && dirPath) fail('--zip 与 --dir 只能二选一');
if (zipPath && !fs.existsSync(zipPath)) fail(`zip 不存在: ${zipPath}`);
if (dirPath && !fs.existsSync(dirPath)) fail(`目录不存在: ${dirPath}`);

const BASE = String(args.base && args.base !== true ? args.base : 'http://127.0.0.1:3000').replace(/\/$/, '');
const USERNAME = String(args.username && args.username !== true ? args.username : process.env.YJ_USERNAME || '');
const TOKEN = String(args.token && args.token !== true ? args.token : process.env.YJ_TOKEN || '');
if (!dryRun && (!USERNAME || !TOKEN)) fail('需要 --username 与 --token（或 YJ_USERNAME / YJ_TOKEN 环境变量）；仅 dry-run 可省略');

const BATCH_SIZE = numArg('batch-size', 20);
const CONCURRENCY = Math.max(1, numArg('concurrency', 4));
const LIMIT = numArg('limit', 0);
const TIMEOUT = numArg('timeout', 120000);
const RETRY = numArg('retry', 3);
const RETRY_DELAY = numArg('retry-delay', 1000);
const BATCH_DELAY = numArg('batch-delay', 500);

const MB = 1024 * 1024;
// 与源鉴 defaults 对齐：单文件业务上限 200MB；超限包会被服务端 UPLOAD_FILE_TOO_LARGE 拒绝
const WARN_BYTES = 200 * MB;

// ---------- 准备解压目录 ----------
let STAGING = null;
let OWNED_STAGING = false;

function locateInner(root) {
  const registry = path.join(root, 'registry.json');
  const tarballs = path.join(root, 'tarballs');
  if (fs.existsSync(registry) && fs.existsSync(tarballs)) return root;
  return null;
}

async function prepareDir() {
  if (dirPath) {
    const found = locateInner(dirPath);
    if (!found) fail(`--dir 下未找到 registry.json 与 tarballs/: ${dirPath}`);
    STAGING = found;
    return;
  }
  // 双层 zip：外层只有 1 个内层 zip + SHA256.txt；也可能直接给的就是内层 zip
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const innerZipEntry = entries.find((e) => /\.zip$/i.test(e.entryName));
  STAGING = await fsp.mkdtemp(path.join(os.tmpdir(), 'yj-npm-import-'));
  OWNED_STAGING = true;
  process.on('exit', () => {
    if (OWNED_STAGING && STAGING) {
      try { fs.rmSync(STAGING, { recursive: true, force: true }); } catch { /* 退出时尽力清理 */ }
    }
  });

  if (innerZipEntry) {
    console.log(`[unpack] 外层含内层 zip: ${innerZipEntry.entryName}`);
    const innerBuf = innerZipEntry.getData();
    const inner = new AdmZip(innerBuf);
    const found = locateInnerFromZip(inner);
    if (!found) fail('内层 zip 中未找到 registry.json 与 tarballs/');
    inner.extractAllTo(STAGING, true);
  } else {
    zip.extractAllTo(STAGING, true);
  }
  // 有些包把内容放在一层子目录里，向下找一级
  const found = locateInner(STAGING);
  if (!found) fail(`解压后未找到 registry.json 与 tarballs/: ${STAGING}`);
  STAGING = found;
}

function locateInnerFromZip(zip) {
  const names = zip.getEntries().map((e) => e.entryName);
  const has = (n) => names.some((x) => x === n || x.endsWith('/' + n));
  return has('registry.json') && names.some((x) => /(^|\/)tarballs\/.+\.tgz$/.test(x));
}

// ---------- 读取清单 ----------
const digest = (buf, alg) => crypto.createHash(alg).update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildTasks() {
  const registry = JSON.parse(await fsp.readFile(path.join(STAGING, 'registry.json'), 'utf8'));
  const artifacts = registry.artifacts || {};
  const packages = registry.packages || {};
  const files = Object.keys(artifacts);
  if (!files.length) fail('registry.json 里没有 artifacts 条目');

  let targetSet = null;
  if (onlyTargets) {
    const txt = await fsp.readFile(path.join(STAGING, 'plugins.txt'), 'utf8');
    targetSet = new Set(txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const at = s.lastIndexOf('@');
      return at > 0 ? s.slice(0, at) : s;
    }));
    console.log(`[filter] 仅导入 plugins.txt 的 ${targetSet.size} 个包`);
  }

  const tasks = [];
  let missingMeta = 0;
  for (const file of files) {
    const a = artifacts[file];
    if (!a || !a.name || !a.version) continue;
    if (targetSet && !targetSet.has(a.name)) continue;
    const meta = packages[a.name]?.versions?.[a.version];
    if (!meta) { missingMeta++; continue; }
    const tgzPath = path.join(STAGING, 'tarballs', path.basename(file));
    tasks.push({
      id: `${a.name}@${a.version}`,
      name: a.name,
      version: a.version,
      file: path.basename(file),
      tgzPath,
      bytes: a.bytes,
      sha256: a.sha256,
      meta,
    });
  }
  if (missingMeta) console.warn(`[warn] ${missingMeta} 个 tgz 在 registry.json.packages 中无对应版本元数据，已跳过`);

  // 小包优先，失败不会拖垮整批；同大小按包名稳定排序
  tasks.sort((x, y) => x.bytes - y.bytes || x.id.localeCompare(y.id));
  if (LIMIT > 0) tasks.splice(LIMIT);
  return { tasks, total: files.length };
}

// ---------- 状态文件（断点续传） ----------
let stateFile = null;
let state = { startedAt: null, updatedAt: null, results: {} };

async function initState(baseDir) {
  stateFile = args.state && args.state !== true
    ? path.resolve(args.state)
    : path.join(path.dirname(baseDir), '.import-npm-state.json');
  if (!reset && fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      if (parsed && typeof parsed.results === 'object') state = parsed;
      else console.warn('[warn] 状态文件格式异常，忽略');
    } catch (e) {
      console.warn(`[warn] 状态文件读取失败，忽略: ${e.message}`);
    }
  }
  if (reset) state = { startedAt: null, updatedAt: null, results: {} };
  state.startedAt = state.startedAt || new Date().toISOString();
}

// 并发worker会同时写状态文件：用 promise 链串行化，避免相互覆盖。
// 直接覆写而非 tmp+rename：rename 在部分受限文件系统（含沙箱 shim）会失败，
// 且状态文件只是进度缓存，最坏情况丢一次写入，下次可从服务端 409 幂等恢复。
let stateQueue = Promise.resolve();
function persistState() {
  state.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(state, null, 2);
  stateQueue = stateQueue.then(() => fsp.writeFile(stateFile, snapshot)).catch((e) => {
    console.warn(`[warn] 状态文件写入失败（不影响导入）: ${e.message}`);
  });
  return stateQueue;
}

// ---------- 发布 ----------
function buildBody(task, data) {
  const basename = task.name.split('/').pop();
  const attachmentKey = `${basename}-${task.version}.tgz`;
  // 清掉 publishConfig（源鉴不读，但避免任何意外）；其余元数据原样透传
  const versionMeta = { ...task.meta };
  delete versionMeta.publishConfig;
  return {
    name: task.name,
    'dist-tags': { latest: task.version },
    versions: { [task.version]: versionMeta },
    _attachments: {
      [attachmentKey]: { data, length: data.length },
    },
  };
}

async function publishOne(task) {
  const tgz = await fsp.readFile(task.tgzPath);
  const sha = digest(tgz, 'sha256');
  if (sha !== task.sha256) {
    return { ok: false, status: 'local-hash-mismatch', error: `本地文件 sha256=${sha} 与清单声明 ${task.sha256} 不一致`, retryable: false };
  }
  if (tgz.length > WARN_BYTES) {
    console.warn(`[big] ${task.id} 体积 ${(tgz.length / MB).toFixed(1)}MB 超过默认业务上限 ${WARN_BYTES / MB}MB，若字典未调大将被拒绝`);
  }
  const body = buildBody(task, tgz.toString('base64'));
  const auth = Buffer.from(`${USERNAME}:${TOKEN}`).toString('base64');
  const url = `${BASE}/npm/${encodeURIComponent(task.name).replace(/%2F/gi, '/')}`;

  // 限流等待与普通错误重试分开计数：429 是暂时状态，等够就重试，不应耗尽错误重试预算。
  // 源鉴默认 writeMax=60/分钟，并发导入 541 个包必然撞限流。
  const MAX_429 = numArg('max-429', 20);
  let attempt = 0;
  let throttled = 0;
  while (attempt <= RETRY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${auth}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok || res.status === 201) return { ok: true, status: res.status };
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        detail = j.error ? `${j.error} ${JSON.stringify(j.details || {}).slice(0, 300)}` : text.slice(0, 500);
      } catch { /* 非 JSON 响应原样截断 */ }
      // 409 已存在（含源鉴 PKG_VERSION_DUPLICATE）视为幂等成功
      if (res.status === 409 || /DUPLICATE|已存在/.test(detail)) {
        return { ok: true, status: 'duplicate', skipped: true };
      }
      if (res.status === 429) {
        throttled++;
        if (throttled > MAX_429) {
          return { ok: false, status: 429, error: `连续限流超过 ${MAX_429} 次：${detail}`, retryable: false };
        }
        const raw = res.headers.get('retry-after');
        const seconds = raw && Number.isFinite(Number(raw)) ? Math.max(1, Number(raw)) : 30;
        console.log(`  [429] ${task.id} 限流，等待 ${seconds}s（第 ${throttled}/${MAX_429} 次）`);
        await sleep(seconds * 1000 + 500);
        continue; // 不递增 attempt：限流不消耗错误重试预算
      }
      const nonRetryable = res.status < 500;
      return { ok: false, status: res.status, error: detail, retryable: !nonRetryable };
    } catch (err) {
      clearTimeout(timer);
      const msg = err.name === 'AbortError' ? `请求超时 ${TIMEOUT}ms` : String(err.message || err);
      if (attempt >= RETRY) return { ok: false, status: 'network', error: msg, retryable: false };
    }
    if (attempt < RETRY) await sleep(RETRY_DELAY * Math.pow(2, attempt));
    attempt++;
  }
  return { ok: false, status: 'exhausted', error: '未知错误', retryable: false };
}

async function runBatch(tasks, batchIndex, totalBatches, counters) {
  console.log(`\n[batch ${batchIndex}/${totalBatches}] ${tasks.length} 个包，并发 ${CONCURRENCY}`);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      const task = tasks[i];
      if (state.results[task.file]?.ok) {
        counters.skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`  [dry] ${task.id} (${(task.bytes / MB).toFixed(2)}MB) → ${task.file}`);
        counters.dry++;
        continue;
      }
      let result;
      try {
        result = await publishOne(task);
      } catch (err) {
        result = { ok: false, status: 'exception', error: String(err.message || err), retryable: false };
      }
      state.results[task.file] = {
        ...result,
        id: task.id,
        at: new Date().toISOString(),
        attempts: (state.results[task.file]?.attempts || 0) + 1,
      };
      await persistState();
      if (result.ok) {
        if (result.skipped) counters.duplicate++; else counters.ok++;
        console.log(`  OK   ${task.id}${result.skipped ? ' (已存在)' : ''}`);
      } else {
        counters.failed++;
        console.error(`  FAIL ${task.id} [${result.status}] ${result.error}`);
        if (failFast) throw new Error('fail-fast: 停止');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
}

// ---------- 主流程 ----------
(async () => {
  console.log('=== 源鉴 · npm 离线包批量导入 ===');
  console.log(`base=${BASE} dry-run=${dryRun} batch=${BATCH_SIZE} concurrency=${CONCURRENCY}`);

  await prepareDir();
  const { tasks, total } = await buildTasks();
  console.log(`[scan] 清单 ${total} 个 tgz，计划导入 ${tasks.length} 个${tasks.length < total ? '（已按 --limit/--only-targets 过滤）' : ''}`);

  // 预检文件是否齐全
  const missing = tasks.filter((t) => !fs.existsSync(t.tgzPath));
  if (missing.length) {
    console.error(`[precheck] ${missing.length} 个 tgz 文件缺失，例如: ${missing.slice(0, 3).map((t) => t.file).join(', ')}`);
    if (!dryRun) fail('文件缺失，终止');
  }

  await initState(zipPath || dirPath);
  const counters = { ok: 0, duplicate: 0, skipped: 0, failed: 0, dry: 0 };
  const batches = BATCH_SIZE > 0
    ? Array.from({ length: Math.ceil(tasks.length / BATCH_SIZE) }, (_, i) => tasks.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE))
    : [tasks];

  let stopped = false;
  try {
    for (let i = 0; i < batches.length; i++) {
      await runBatch(batches[i], i + 1, batches.length, counters);
      if (i < batches.length - 1 && BATCH_DELAY > 0) await sleep(BATCH_DELAY);
    }
  } catch (err) {
    if (/fail-fast/.test(err.message)) stopped = true;
    else throw err;
  }

  console.log('\n=== 汇总 ===');
  console.log(`清单总数=${total} 本次计划=${tasks.length}`);
  if (dryRun) {
    console.log(`dry-run 模拟=${counters.dry}（未发送任何请求）`);
  } else {
    console.log(`成功=${counters.ok} 已存在=${counters.duplicate} 状态跳过=${counters.skipped} 失败=${counters.failed}`);
    const failedList = Object.entries(state.results).filter(([, v]) => !v.ok);
    if (failedList.length) {
      const report = path.join(path.dirname(stateFile), '.import-npm-failures.json');
      await fsp.writeFile(report, JSON.stringify(failedList.map(([file, v]) => ({ file, ...v })), null, 2));
      console.log(`失败清单: ${report}`);
    }
    console.log(`状态文件: ${stateFile}${stopped ? '（fail-fast 提前停止）' : ''}`);
  }
  if (counters.failed > 0) process.exit(1);
})().catch((err) => {
  console.error('FATAL:', err.stack || err.message || err);
  process.exit(1);
});

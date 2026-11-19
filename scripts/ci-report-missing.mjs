#!/usr/bin/env node
/**
 * 源鉴 · 缺包上报脚本（给调用方 CI 用，零依赖，Node 18+ 可直接运行）
 *
 * 做法：先读本项目声明的依赖清单，逐个向私有源探测；只把「源里没有」或
 * 「源里没有满足版本」的包上报到 /api/v1/dependency-reports。
 * 不做全量上传，避免缺失表被已存在的包淹没。
 *
 * 用法：
 *   node ci-report-missing.mjs --base https://yuanjian.corp.internal \
 *     --token "$YJ_TOKEN" --project "$CI_PROJECT_PATH"
 *
 * 常用参数：
 *   --npm <file>        package.json 路径，默认 ./package.json（存在才读）
 *   --pypi <file>       requirements.txt 路径，默认 ./requirements.txt（存在才读）
 *   --input <file>      直接给缺口清单（构建失败时解析出来的），格式见 docs/MISSING_REPORT_CI.md
 *   --include-dev       连 devDependencies 一起比对（默认不含）
 *   --strict-versions   版本不满足也算缺口（默认开启；--name-only 关闭）
 *   --name-only         只判包是否存在，不比对版本
 *   --dry-run           只打印差集，不上报
 *   --strict            CI 门禁模式：发现缺口时退出码 2
 *   --soft              上报失败或探测失败都只警告不阻断（默认退出 1，避免静默丢数据）
 *   --concurrency <n>   探测并发，默认 6
 *
 * 环境变量兜底：YJ_BASE_URL / YJ_TOKEN / YJ_PROJECT
 * 退出码：0 正常；1 硬失败（参数/网络/鉴权）；2 有缺口且 --strict
 */

import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const base = trimSlash(args.base || process.env.YJ_BASE_URL || '');
const token = args.token || process.env.YJ_TOKEN || '';
const project = args.project || process.env.YJ_PROJECT || 'unknown';
const concurrency = Math.max(1, Math.min(16, Number(args.concurrency || 6)));

if (!base) fail('缺少 --base（或 YJ_BASE_URL），例如 https://yuanjian.corp.internal');
if (!args['dry-run'] && !token) fail('缺少 --token（或 YJ_TOKEN）：需要一个 developer 及以上账号的访问令牌');

const checkVersions = !args['name-only'];

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

async function main() {
  const declared = [];
  const sources = [];

  for (const eco of ['npm', 'pypi']) {
    const file = args[eco] ?? (eco === 'npm' ? 'package.json' : 'requirements.txt');
    if (!file || !fs.existsSync(file)) continue;
    const deps = eco === 'npm' ? readPackageJson(file, args['include-dev']) : readRequirements(file);
    declared.push(...deps.map((d) => ({ ...d, ecosystem: eco })));
    sources.push(`${eco}:${file}(${deps.length})`);
  }

  for (const input of toArray(args.input)) {
    const extra = readGapInput(input);
    declared.push(...extra);
    sources.push(`input:${input}(${extra.length})`);
  }

  if (declared.length === 0) {
    console.log('未读到任何依赖声明，跳过上报。用 --npm / --pypi / --input 指定来源。');
    return;
  }

  const byEco = groupBy(declared, (d) => d.ecosystem);
  const gaps = [];
  const skipped = [];

  for (const [eco, deps] of Object.entries(byEco)) {
    const unique = dedupe(deps);
    const probed = await mapLimit(unique, concurrency, (dep) => probe(eco, dep));
    for (const item of probed) {
      if (item.skip) skipped.push(item);
      else if (item.gap) gaps.push(item);
    }
  }

  printSummary(declared, sources, gaps, skipped);

  if (args['dry-run']) {
    console.log('\n--dry-run：未上报。');
    finish(gaps, skipped);
    return;
  }

  if (gaps.length === 0) {
    finish(gaps, skipped);
    return;
  }

  const payloadEco = groupBy(gaps, (g) => g.ecosystem);
  let created = 0;
  let updated = 0;

  for (const [eco, items] of Object.entries(payloadEco)) {
    for (const chunk of chunks(items, 200)) {
      const body = {
        projectId: project,
        ecosystem: eco,
        dependencies: chunk.map((g) => ({ name: g.name, versionSpec: g.versionSpec })),
      };
      try {
        const res = await postJson(`${base}/api/v1/dependency-reports`, body);
        created += Number(res?.created || 0);
        updated += Number(res?.updated || 0);
      } catch (err) {
        if (args.soft) {
          console.warn(`上报失败（已忽略）：${err.message}`);
        } else {
          throw new Error(`上报失败：${err.message}`);
        }
      }
    }
  }

  console.log(`已上报：新增 ${created} 条，累加 ${updated} 条（项目 ${project}）`);
  finish(gaps, skipped);
}

/** 收尾：探测失败的依赖必须让 CI 看见，否则「0 缺口」是假象 */
function finish(gaps, skipped) {
  if (skipped.length > 0) {
    console.error(`\n[警告] ${skipped.length} 个依赖探测失败，本次缺口清单不完整：`);
    for (const s of skipped) {
      console.error(`  [${s.ecosystem}] ${s.name.padEnd(34)} ${s.reason}`);
    }
    if (!args.soft) {
      console.error('如确认可忽略（例如私有源临时抖动），加 --soft 降级为警告。');
      process.exit(1);
    }
  }
  if (gaps.length > 0 && args.strict) process.exit(2);
}

/** 探测单个依赖在私有源里的可用性 */
async function probe(ecosystem, dep) {
  const result = { ...dep, gap: false, reason: '', available: [] };
  const url =
    ecosystem === 'npm'
      ? `${base}/npm/${encodeURIComponent(dep.name)}`
      : `${base}/pypi/simple/${encodeURIComponent(dep.name.replace(/\//g, '-'))}/`;

  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch (err) {
    result.reason = `探测失败：${err.message}`;
    result.skip = true;
    return result;
  }

  if (res.status === 404) {
    result.gap = true;
    result.reason = '私有源无此包';
    return result;
  }
  if (!res.ok) {
    // 5xx / 401 等不当作缺包，避免把平台故障写成一堆假需求
    result.reason = `探测异常 HTTP ${res.status}`;
    result.skip = true;
    return result;
  }

  const text = await res.text();
  result.available = ecosystem === 'npm' ? npmVersions(text) : pypiVersions(text);

  if (result.available.length === 0) {
    result.gap = true;
    result.reason = '私有源无可用版本';
    return result;
  }
  if (checkVersions && dep.versionSpec && dep.versionSpec !== '*') {
    const ok = result.available.some((v) => satisfies(v, dep.versionSpec));
    if (!ok) {
      result.gap = true;
      result.reason = `无匹配版本（源内 ${result.available.length} 个，最高 ${highest(result.available)}）`;
    }
  }
  return result;
}

function npmVersions(text) {
  try {
    const doc = JSON.parse(text);
    return Object.keys(doc.versions || {});
  } catch {
    return [];
  }
}

/** PyPI 简单索引页只给文件名，取文件名里的版本号 */
function pypiVersions(html) {
  const out = new Set();
  for (const m of html.matchAll(/>([^<>]+\.(?:whl|tar\.gz|zip))</g)) {
    const v = versionFromFilename(m[1]);
    if (v) out.add(v);
  }
  return Array.from(out);
}

/** numpy-2.5.5-cp315-cp315t-win_arm64.whl → 2.5.5；取第一个以数字开头的分段 */
function versionFromFilename(file) {
  const stem = file.replace(/\.(whl|tar\.gz|zip|tar\.bz2)$/i, '');
  return stem.split('-').find((seg) => /^\d/.test(seg)) || null;
}

function readPackageJson(file, includeDev) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`读取 ${file} 失败：${err.message}`);
  }
  const blocks = ['dependencies', 'optionalDependencies'];
  if (includeDev) blocks.push('devDependencies');
  const deps = [];
  for (const block of blocks) {
    for (const [name, spec] of Object.entries(pkg[block] || {})) {
      if (!isRegistrySpec(spec)) continue;
      deps.push({ name, versionSpec: String(spec).trim() || '*' });
    }
  }
  return deps;
}

/** file: / link: / workspace: / git+ / http 等非registry来源直接跳过 */
function isRegistrySpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return true;
  return !/^(file:|link:|workspace:|portal:|git\+|git:|https?:|\.{0,2}\/)/.test(s);
}

function readRequirements(file) {
  const deps = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('-')) continue;
    // 去掉环境标记与 extras：requests[socks]>=2.31 ; python_version > "3.8"
    const noMarker = line.split(';')[0].trim();
    const m = noMarker.match(/^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    const spec = (m[3] || '').trim();
    deps.push({ name, versionSpec: spec || '*' });
  }
  return deps;
}

function readGapInput(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`读取 ${file} 失败：${err.message}`);
  }
  const blocks = Array.isArray(data) ? data : [data];
  const out = [];
  for (const block of blocks) {
    const eco = block.ecosystem === 'pypi' ? 'pypi' : 'npm';
    for (const dep of block.dependencies || []) {
      const name = typeof dep === 'string' ? dep : dep.name;
      if (!name) continue;
      out.push({ ecosystem: eco, name, versionSpec: (dep && dep.versionSpec) || '*' });
    }
  }
  return out;
}

function printSummary(declared, sources, gaps, skipped) {
  console.log(`源鉴缺包上报 · 项目 ${project} · ${base}`);
  console.log(`依赖来源：${sources.join('，')}`);
  console.log(`声明依赖 ${declared.length} 个，命中缺口 ${gaps.length} 个${skipped.length ? `，探测失败 ${skipped.length} 个` : ''}`);
  if (gaps.length === 0) {
    console.log('私有源已覆盖全部声明依赖，无需上报。');
    return;
  }
  console.log('');
  for (const g of gaps) {
    const spec = (g.versionSpec || '*').padEnd(14);
    console.log(`  [${g.ecosystem}] ${g.name.padEnd(34)} ${spec} ${g.reason}`);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (res.status === 403) {
    throw new Error('权限不足：上报需要 import:run（developer 及以上账号的令牌）');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      msg += ` ${parsed.code || ''} ${parsed.message || ''}`.trimEnd();
    } catch {
      msg += ` ${text.slice(0, 120)}`;
    }
    throw new Error(msg);
  }
  const parsed = JSON.parse(text);
  return parsed && parsed.data ? parsed.data : parsed;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function groupBy(list, pick) {
  const out = {};
  for (const item of list) {
    const key = pick(item);
    (out[key] = out[key] || []).push(item);
  }
  return out;
}

function dedupe(list) {
  const seen = new Map();
  for (const item of list) {
    const key = `${item.name}@${item.versionSpec}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await fn(list[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function highest(versions) {
  return versions.reduce((best, v) => (compare(v, best) > 0 ? v : best), versions[0]);
}

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

function compare(a, b) {
  const pa = parseVersion(a) || [0, 0, 0];
  const pb = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * npm 版本区间判定（只覆盖常见写法：^ ~ >= <= > < = 精确 * x 与空格并列）。
 * 遇到无法解析的写法按「满足」处理——宁可漏报，也不要把噪音塞进缺失表。
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return true;
  const spec = String(range).trim();
  if (!spec || spec === '*' || spec === 'x' || spec === 'latest') return true;

  return spec.split('||').some((part) => {
    const comparators = part.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((c) => satisfiesOne(v, c));
  });
}

function satisfiesOne(v, raw) {
  const token = raw.trim();
  if (!token || token === '*' || token === 'x' || token === 'X') return true;

  // PyPI 常见写法：==2.2.0 / != / ~=2.2
  if (token.startsWith('==')) {
    const base = parseVersion(token.slice(2));
    return base ? cmpArr(v, base) === 0 : true;
  }
  if (token.startsWith('!=')) return true;
  if (token.startsWith('~=')) {
    const base = parseVersion(token.slice(2));
    if (!base) return true;
    const upper = [base[0], base[1] + 1, 0];
    return cmpArr(v, base) >= 0 && cmpArr(v, upper) < 0;
  }

  const tilde = token.match(/^~>?\s*(.+)$/);
  if (tilde) {
    const base = parseVersion(tilde[1]);
    if (!base) return true;
    const upper = [base[0], base[1] + 1, 0];
    return cmpArr(v, base) >= 0 && cmpArr(v, upper) < 0;
  }

  const caret = token.match(/^\^(.+)$/);
  if (caret) {
    const base = parseVersion(caret[1]);
    if (!base) return true;
    let upper;
    if (base[0] > 0) upper = [base[0] + 1, 0, 0];
    else if (base[1] > 0) upper = [0, base[1] + 1, 0];
    else upper = [0, 0, base[2] + 1];
    return cmpArr(v, base) >= 0 && cmpArr(v, upper) < 0;
  }

  const op = token.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (op) {
    const base = parseVersion(op[2]);
    if (!base) return true;
    const c = cmpArr(v, base);
    switch (op[1]) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }

  // 1.2.x / 1.x 这类
  if (/^[0-9]+(\.[0-9]+)?\.[xX*]$|^[0-9]+\.?[xX*]$/.test(token)) {
    const nums = token.split('.').filter((n) => /^\d+$/.test(n)).map(Number);
    return nums.every((n, i) => v[i] === n);
  }

  const exact = parseVersion(token);
  if (exact) return cmpArr(v, exact) === 0;

  return true;
}

function cmpArr(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function fail(message) {
  console.error(`[源鉴缺包上报] ${message}`);
  process.exit(1);
}

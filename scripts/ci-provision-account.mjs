#!/usr/bin/env node
/**
 * 源鉴 · 按项目开通 CI 机器账号（管理员执行一次，零依赖，Node 18+）
 *
 * 为什么需要它：缺包上报接口要 import:run 权限，CI 必须用 developer 及以上令牌。
 * 若几十个仓库共用一个人的令牌，审计里全是同一个 actor，事后无法判断是哪个项目报的。
 * 这里给每个仓库建一个独立机器账号（不可口令登录），并签一个以仓库命名的令牌，
 * 审计日志按令牌名即可直接筛出该项目。
 *
 * 用法：
 *   node ci-provision-account.mjs --base https://yuanjian.corp.internal \
 *     --admin-user admin --admin-password '***' --project group/repo
 *
 * 常用参数：
 *   --base <url>           平台地址，默认取 YJ_BASE_URL 或 http://127.0.0.1:3000
 *   --admin-user <name>    管理员账号，默认取 YJ_ADMIN_USER
 *   --admin-password <pwd> 管理员口令，默认取 YJ_ADMIN_PASSWORD（更推荐用环境变量，避免进 shell 历史）
 *   --project <path>       仓库路径（如 group/repo），用作 projectId 与令牌命名依据
 *   --username <name>      直接指定机器账号名（默认 ci-<project 归一化>）
 *   --token-name <name>    直接指定令牌名（默认与账号同名）
 *   --role <role>          机器账号角色，默认 developer（上报缺包需要 import:run）
 *   --json                 以 JSON 输出结果，便于自动化
 *   --write <file>         把 YJ_* 变量写入指定文件（0600 权限），例如 .env.ci
 *
 * 退出码：0 成功；1 参数/鉴权/网络/冲突
 */

import fs from 'node:fs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const base = trimSlash(args.base || process.env.YJ_BASE_URL || 'http://127.0.0.1:3000');
const adminUser = args['admin-user'] || process.env.YJ_ADMIN_USER || '';
const adminPassword = args['admin-password'] || process.env.YJ_ADMIN_PASSWORD || '';
const project = String(args.project || process.env.YJ_PROJECT || '').trim();
const role = String(args.role || 'developer');

if (!adminUser) fail('缺少 --admin-user（或 YJ_ADMIN_USER）');
if (!adminPassword) fail('缺少 --admin-password（或 YJ_ADMIN_PASSWORD）');
if (!project) fail('缺少 --project，例如 --project group/repo');
if (!['reader', 'developer'].includes(role)) fail('--role 只能是 reader 或 developer（管理员账号不可新建）');

const desiredUsername = args.username || defaultUsername(project);
const tokenName = String(args['token-name'] || desiredUsername).slice(0, 80);

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

async function main() {
  log(`平台 ${base}`);
  const cookie = await login();
  log(`管理员 ${adminUser} 登录成功`);

  const account = await ensureAccount(cookie);
  log(`机器账号 ${account.username}（${account.role} / ${account.accountType}）${account.created ? '已创建' : '已存在'}`);

  const issued = await issueToken(cookie, account.id);
  log(`令牌 ${issued.name} 已签发`);

  const payload = {
    baseUrl: base,
    project,
    username: account.username,
    accountType: account.accountType,
    role: account.role,
    created: account.created,
    tokenName: issued.name,
    token: issued.token,
  };

  if (args.write) {
    const file = String(args.write);
    const body =
      `# 源鉴 CI 凭据 · 项目 ${project} · 生成于 ${new Date().toISOString()}\n` +
      `YJ_BASE_URL=${base}\n` +
      `YJ_TOKEN=${issued.token}\n` +
      `YJ_PROJECT=${project}\n`;
    fs.writeFileSync(file, body, { mode: 0o600 });
    log(`已写入 ${file}（0600，请立即导入 CI 密文变量后删除）`);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('');
  console.log('把下面三行写入 CI 的密文变量（令牌只显示这一次）：');
  console.log('');
  console.log(`YJ_BASE_URL=${base}`);
  console.log(`YJ_TOKEN=${issued.token}`);
  console.log(`YJ_PROJECT=${project}`);
  console.log('');
  console.log('审计日志按令牌名筛选即可定位到该项目：');
  console.log(`  GET ${base}/api/v1/audit-logs?tokenName=${encodeURIComponent(issued.name)}`);
  if (!account.created) {
    console.log('');
    console.log('注意：本次是为已有账号签发新令牌，该账号此前签发的令牌仍然有效；如需作废请到控制台吊销。');
  }
}

async function login() {
  const res = await request('POST', '/api/v1/auth/login', {
    body: { username: adminUser, password: adminPassword },
  });
  if (res.status === 401) fail('管理员账号或口令错误');
  if (res.status === 423) fail('管理员账号已被临时锁定，请稍后重试或按运维手册解锁');
  if (res.status === 403) {
    const code = res.json?.code || unwrap(res.json)?.code || '';
    if (String(code).includes('PASSWORD_CHANGE_REQUIRED') || String(res.text).includes('PASSWORD_CHANGE_REQUIRED')) {
      fail('该管理员仍是初始口令，请先在控制台登录并完成首次改密，再执行本脚本');
    }
  }
  if (!res.ok) fail(`登录失败：HTTP ${res.status} ${res.text.slice(0, 160)}`);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const sid = cookies.map((item) => String(item).split(';')[0]).find((item) => item.startsWith('yj_sid='));
  if (!sid) fail('登录成功但未取到会话 Cookie，请确认平台版本与地址');
  return sid;
}

async function ensureAccount(cookie) {
  const list = await request('GET', '/api/v1/users', { cookie });
  if (list.status === 403) {
    if (list.text.includes('PASSWORD_CHANGE_REQUIRED')) {
      fail('该管理员仍是初始口令，请先在控制台登录并完成首次改密，再执行本脚本');
    }
    fail('当前账号不是管理员，无法创建机器账号');
  }
  if (!list.ok) fail(`读取账号列表失败：HTTP ${list.status} ${list.text.slice(0, 160)}`);
  const items = unwrap(list.json)?.items || [];
  const existing = items.find((item) => item.username === desiredUsername);

  if (existing) {
    if (existing.accountType !== 'service') {
      fail(
        `账号 ${desiredUsername} 已存在但不是机器账号。请改用 --username 指定其他名字，` +
          '或先在控制台确认该账号用途，避免把人员账号变成 CI 身份',
      );
    }
    if (existing.status !== 'active') fail(`机器账号 ${desiredUsername} 已被禁用，请先在控制台启用`);
    return { ...existing, created: false };
  }

  const res = await request('POST', '/api/v1/users', {
    cookie,
    body: {
      username: desiredUsername,
      displayName: `CI · ${project}`,
      role,
      accountType: 'service',
    },
  });
  if (!res.ok) {
    const reason = unwrap(res.json)?.message || res.text.slice(0, 160);
    fail(`创建机器账号失败：HTTP ${res.status} ${reason}`);
  }
  return { ...unwrap(res.json).user, created: true };
}

async function issueToken(cookie, userId) {
  const res = await request('POST', `/api/v1/users/${encodeURIComponent(userId)}/tokens`, {
    cookie,
    body: { name: tokenName },
  });
  if (!res.ok) fail(`签发令牌失败：HTTP ${res.status} ${res.text.slice(0, 160)}`);
  const data = unwrap(res.json);
  if (!data?.token) fail('签发成功但响应中没有令牌明文，请检查服务端版本');
  return data;
}

async function request(method, path, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, headers: res.headers, text, json };
}

/** 服务端统一包一层 {code, message, data}，这里兼容裸对象 */
function unwrap(json) {
  if (json && typeof json === 'object' && 'data' in json && ('code' in json || 'message' in json)) return json.data;
  return json;
}

/** group/repo → ci-group-repo；服务端用户名限制 3-32 位、只允许字母数字点下划线短横线 */
function defaultUsername(raw) {
  const slug = String(raw)
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .toLowerCase();
  const body = slug || 'project';
  // 仓库名本身带 ci- 前缀时不再叠加，避免 ci-ci-xxx
  const name = body.startsWith('ci-') ? body : `ci-${body}`;
  if (name.length <= 32) return name;
  // 超长时保留可读前缀 + 短哈希，既满足长度限制又能区分同名截断的项目
  const hash = hash6(raw);
  return `${name.slice(0, 32 - 7)}-${hash}`;
}

function hash6(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
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

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function log(message) {
  console.error(`[源鉴开户] ${message}`);
}

function fail(message) {
  console.error(`[源鉴开户] ${message}`);
  process.exit(1);
}

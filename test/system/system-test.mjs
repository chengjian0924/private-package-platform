#!/usr/bin/env node
/**
 * 源鉴平台 · 系统测试（真实部署形态）
 *
 * 与 jest e2e（单进程 AppModule + supertest）不同，本脚本：
 *   1. 运行生产构建产物 dist/main.js（非 ts-jest 源码）
 *   2. 按 PROCESS_ROLE=console/npm/pypi 起三个独立操作系统进程
 *   3. 三进程共享同一 DATA_DIR（SQLite WAL + 动态端口），走真实 HTTP 端口
 *   4. 用原生 fetch 调用，验证跨进程数据流转、审计哈希链、令牌鉴权、优雅停机
 *
 * 覆盖系统级属性：单进程 e2e 无法验证的多进程协作。
 * 前置：先执行 npm run build。
 *
 * 用法：node test/system/system-test.mjs
 * 退出码：0 全部通过；1 有用例失败。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const INITIAL_ADMIN = { username: 'admin', password: 'admin123' };
const ADMIN = { username: 'admin', password: 'Sys-Test-Root-8kR3m' };

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  \u2718 ${msg}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('无法分配端口'))));
    });
  });
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function startProcess(role, env, logs) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => logs.push(`[${role}] ${b.toString()}`));
  child.stderr.on('data', (b) => logs.push(`[${role}:err] ${b.toString()}`));
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 8000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function http(baseUrl, method, urlPath, { basic, bearer, body, headers = {} } = {}) {
  const h = { ...headers };
  if (basic) h.Authorization = `Basic ${Buffer.from(`${basic.username}:${basic.password}`).toString('base64')}`;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** 构造真实 npm tarball（复用与 fixtures 一致的 tar 结构） */
async function makeNpmTarball(name, version) {
  const tar = await import('tar');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-sys-tar-'));
  const pkgDir = path.join(workDir, 'package');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version, engines: { node: '>=18' } }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');
  const chunks = [];
  const stream = tar.create({ gzip: true, cwd: workDir, portable: true }, ['package']);
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  fs.rmSync(workDir, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 独立校验审计哈希链（与 audit.service 写入侧同算法），返回 {ok, count, brokenAt} */
function verifyAuditChain(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id, trace_id, actor_id, actor_token_hash, action, result, resource_id, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id ASC').all();
  let prev = 'genesis';
  for (const row of rows) {
    const expected = sha256(
      [
        prev,
        row.trace_id ?? '',
        row.actor_id ?? '',
        row.actor_token_hash ?? '',
        row.action,
        row.result,
        row.resource_id ?? '',
        row.detail ?? '',
        row.created_at,
      ].join('|'),
    );
    if (row.prev_hash !== prev || row.hash !== expected) {
      db.close();
      return { ok: false, count: rows.length, brokenAt: row.id };
    }
    prev = row.hash;
  }
  db.close();
  return { ok: true, count: rows.length };
}

async function main() {
  console.log('=== 源鉴平台 · 系统测试（真实三进程部署形态）===\n');

  if (!fs.existsSync(path.join(ROOT, 'dist/main.js'))) {
    console.error('缺少 dist/main.js，请先执行 npm run build');
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yj-sys-data-'));
  const logs = [];
  const [consolePort, npmPort, pypiPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const consoleUrl = `http://127.0.0.1:${consolePort}`;
  const npmUrl = `http://127.0.0.1:${npmPort}`;
  const pypiUrl = `http://127.0.0.1:${pypiPort}`;

  const baseEnv = {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: consoleUrl,
    NPM_BASE_URL: npmUrl,
    PYPI_BASE_URL: pypiUrl,
    BOOTSTRAP_ADMIN_USERNAME: 'admin',
    LOG_FILE_ENABLED: 'false',
    SECURITY_RESCAN_INTERVAL_SEC: '0',
    BACKUP_HEARTBEAT_MS: '0',
  };

  const procs = [];
  try {
    // ---- 阶段 1：三进程启动 + 协议探活 ----
    console.log('[阶段1] 三进程启动与协议探活');
    procs.push(startProcess('console', { ...baseEnv, PORT: String(consolePort), PROCESS_ROLE: 'console' }, logs));
    procs.push(startProcess('npm', { ...baseEnv, PORT: String(npmPort), PROCESS_ROLE: 'npm' }, logs));
    procs.push(startProcess('pypi', { ...baseEnv, PORT: String(pypiPort), PROCESS_ROLE: 'pypi' }, logs));

    const ready = await Promise.all([
      waitFor(`${consoleUrl}/api/v1/health`),
      waitFor(`${npmUrl}/npm/-/ping`),
      waitFor(`${pypiUrl}/pypi/simple/`),
    ]);
    assert(ready.every(Boolean), 'console/npm/pypi 三进程均启动并响应协议探活');
    if (!ready.every(Boolean)) {
      console.error(logs.join('\n'));
      throw new Error('进程启动失败');
    }

    // 角色隔离：console 提供管理 API，npm/pypi 端口不提供控制台 API
    const consoleOnNpm = await http(npmUrl, 'GET', '/api/v1/packages');
    assert(consoleOnNpm.status === 404, 'console API 在 npm 进程端口不可用（角色隔离）');

    // ---- 阶段 2：跨进程认证（内置管理员改密在 console，令牌跨进程鉴权）----
    console.log('\n[阶段2] 跨进程认证与令牌');
    // health 返回 200 只代表 HTTP 已监听；内置管理员由 ensureBootstrapAdmin 在 listen 之后
    // 异步建立，探活通过时账号可能尚未就绪。用正确初始密码轮询登录直到成功（账号未建好时
    // 返回"用户不存在"且不计失败次数），消除首登断言的建号竞态。
    let login = null;
    for (let i = 0; i < 40; i++) {
      const attempt = await http(consoleUrl, 'POST', '/api/v1/auth/login', { body: INITIAL_ADMIN });
      if (attempt.status === 200) {
        login = attempt;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert(login !== null, '内置管理员账号在 console 进程就绪且首登成功');
    assert(login?.json?.data?.mustChangePassword === true, '内置管理员首登触发强制改密');

    const change = await http(consoleUrl, 'POST', '/api/v1/auth/change-password', {
      basic: { username: INITIAL_ADMIN.username, password: INITIAL_ADMIN.password },
      body: { oldPassword: INITIAL_ADMIN.password, newPassword: ADMIN.password, confirmPassword: ADMIN.password },
    });
    assert(change.status === 200, '跨进程改密成功，后续管理 API 用长期口令');

    const me = await http(consoleUrl, 'GET', '/api/v1/auth/me', { basic: ADMIN });
    assert(me.status === 200 && me.json?.data?.user?.username === 'admin', '改密后 console 进程鉴权通过');
    assert(!me.json?.data?.user?.mustChangePassword, '改密态已持久化');

    // console 创建令牌
    const tokenRes = await http(consoleUrl, 'POST', '/api/v1/auth/tokens', {
      basic: ADMIN,
      body: { name: 'sys-test-token' },
    });
    assert(tokenRes.status === 201 && String(tokenRes.json?.data?.token).startsWith('yj_'), 'console 进程创建 API 令牌');
    const token = tokenRes.json.data.token;

    // 令牌跨进程：npm 进程的 whoami 只认 Token（共享 DB 验证）
    const npmWhoami = await http(npmUrl, 'GET', '/npm/-/whoami', {
      basic: { username: 'admin', password: token },
    });
    assert(npmWhoami.status === 200 && npmWhoami.json?.username === 'admin', 'console 签发的令牌在 npm 进程可用（跨进程鉴权）');

    // ---- 阶段 3：跨进程数据流（npm 发布 → console 可见 → 删除/恢复 → registry 出口同步）----
    console.log('\n[阶段3] 跨进程数据流与状态同步');
    const pkg = 'sys-flow-lib';
    const tarball = await makeNpmTarball(pkg, '1.0.0');
    const publish = await http(npmUrl, 'PUT', `/npm/${pkg}`, {
      basic: { username: 'admin', password: token },
      body: {
        _id: pkg,
        name: pkg,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: pkg, version: '1.0.0', dist: {} } },
        _attachments: { [`${pkg}-1.0.0.tgz`]: { data: tarball.toString('base64'), length: tarball.length } },
      },
    });
    assert(publish.status === 201, 'npm 进程发布包成功（写入共享 DATA_DIR）');

    // console 进程能读到 npm 进程写入的包
    const detail = await http(consoleUrl, 'GET', `/api/v1/packages/detail?ecosystem=npm&name=${pkg}`, { basic: ADMIN });
    assert(detail.status === 200 && detail.json?.data?.versions?.[0]?.version === '1.0.0', 'npm 进程发布的包在 console 进程可见（跨进程数据共享）');
    const versionId = detail.json.data.versions[0].id;

    // npm 进程能下载 console 进程管理的包（对象存储共享）
    const download = await fetch(`${npmUrl}/npm/${pkg}/-/${pkg}-1.0.0.tgz`);
    const dlBuf = Buffer.from(await download.arrayBuffer());
    assert(download.status === 200 && dlBuf.length === tarball.length, 'npm 进程下载到与上传字节数一致的 tarball');

    // console 删除 → npm 出口同步不可见
    const del = await http(consoleUrl, 'DELETE', `/api/v1/packages/versions/${versionId}`, { basic: ADMIN });
    assert(del.status === 200, 'console 进程删除版本成功');
    const afterDel = await fetch(`${npmUrl}/npm/${pkg}/-/${pkg}-1.0.0.tgz`);
    assert(afterDel.status === 404, 'console 删除后 npm 进程出口同步 404（跨进程状态一致）');

    // console 恢复 → npm 出口同步恢复
    const restore = await http(consoleUrl, 'POST', `/api/v1/packages/versions/${versionId}/restore`, { basic: ADMIN });
    assert(restore.status === 201, 'console 进程恢复版本成功');
    const afterRestore = await fetch(`${npmUrl}/npm/${pkg}/-/${pkg}-1.0.0.tgz`);
    assert(afterRestore.status === 200, 'console 恢复后 npm 进程出口同步恢复（跨进程状态一致）');

    // ---- 阶段 4：跨进程审计哈希链完整性（并发写后校验）----
    console.log('\n[阶段4] 跨进程审计哈希链完整性');
    // 三进程并发产生审计：console 查询审计、npm 再发布一个包、pypi 索引探活
    const pkg2 = 'sys-audit-lib';
    const tarball2 = await makeNpmTarball(pkg2, '2.0.0');
    const [auditList, publish2] = await Promise.all([
      http(consoleUrl, 'GET', '/api/v1/audit-logs', { basic: ADMIN }),
      http(npmUrl, 'PUT', `/npm/${pkg2}`, {
        basic: { username: 'admin', password: token },
        body: {
          _id: pkg2,
          name: pkg2,
          'dist-tags': { latest: '2.0.0' },
          versions: { '2.0.0': { name: pkg2, version: '2.0.0', dist: {} } },
          _attachments: { [`${pkg2}-2.0.0.tgz`]: { data: tarball2.toString('base64'), length: tarball2.length } },
        },
      }),
    ]);
    assert(auditList.status === 200 && publish2.status === 201, '跨进程并发请求均成功（WAL 写入无冲突）');
    await new Promise((r) => setTimeout(r, 300));

    // 用 CommonJS require 访问 node:sqlite（ESM 下 createRequire）
    globalThis.require = (await import('node:module')).createRequire(import.meta.url);
    const chain = verifyAuditChain(path.join(dataDir, 'platform.db'));
    assert(chain.ok && chain.count > 0, `审计哈希链在多进程写入后完整（${chain.count} 条${chain.ok ? '' : `，断点 id=${chain.brokenAt}`}）`);

    // ---- 阶段 5：优雅停机（真实 SIGTERM）----
    // 注意：Nest 的 enableShutdownHooks 在排空完成后会主动 process.kill(pid, SIGTERM)
    // 重新发信号（见 @nestjs/core/nest-application-context.js cleanup），因此子进程
    // 以 signal=SIGTERM、code=null 退出（shell 下观察为 143），这是框架刻意设计，
    // 不是异常终止。断言应验证「排空发生 + 及时退出 + 由 SIGTERM 触发」，而非 code===0。
    console.log('\n[阶段5] 优雅停机');
    const npmProc = procs[1];
    const stopAt = Date.now();
    npmProc.kill('SIGTERM');
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      npmProc.once('exit', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal, ms: Date.now() - stopAt });
      });
    });
    const stoppedPromptly = exited && exited.ms < 8000;
    const drained = logs.some((l) => l.includes('[npm:err]') === false && l.includes('[npm]') && l.includes('开始排空在途请求'));
    assert(stoppedPromptly, `npm 进程收到 SIGTERM 后及时退出（${exited?.ms}ms）`);
    assert(exited?.signal === 'SIGTERM' || exited?.code === 143, `退出由 SIGTERM 触发（signal=${exited?.signal}, code=${exited?.code}，Nest shutdown hook 标准行为）`);
    assert(drained, '停机前执行了在途请求排空日志');

    // 停机后端口不再服务
    const afterStop = await fetch(`${npmUrl}/npm/-/ping`).catch(() => null);
    assert(!afterStop || !afterStop.ok, '停机后 npm 端口停止服务');
  } catch (err) {
    failed++;
    failures.push(`脚本异常: ${err.message}`);
    console.error('\n脚本异常:', err.stack);
    console.error('\n=== 进程日志尾部 ===\n' + logs.slice(-40).join('\n'));
  } finally {
    await Promise.all(procs.map(stopProcess));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n=== 系统测试结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('全部通过。');
}

main();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { getConfig, resetConfigCache } from '../src/config/config';
import { AuthService, type Role } from '../src/auth/auth.service';

export interface TestContext {
  app: NestExpressApplication;
  baseUrl: string;
  port: number;
  dataDir: string;
  /** 各种子账号的 npm API Token（按用户名索引）：npm 路由的 Basic 只认 Token，与真实 npm CLI 行为一致 */
  npmTokens: Record<string, string>;
  close: () => Promise<void>;
}

/** 取空闲端口，避免与其他本地进程或并行测试文件冲突 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法获取空闲端口'))));
    });
  });
}

// 长期测试口令均满足生产强度（≥8 位、不含用户名、无常见弱口令片段）
// 注意 admin 的口令不能含 "admin"（用户名与弱口令片段双重命中，会被强度校验拒绝）
export const ADMIN = { username: 'admin', password: 'Console-Root-2kR5m' };
export const DEVELOPER = { username: 'developer', password: 'Console-Dev-8wT4n' };
export const READER = { username: 'reader', password: 'Console-Read-6yB2q' };

/**
 * 建号并换成长期口令：内置管理员建的号带 must_change_password=1，
 * 不换口令的话 Basic/会话请求会被守卫拦成 403，所有用例都得先走改密流程。
 * 同时为每个种子账号预建一个 npm API Token（npm 路由的 Basic 只认 Token）。
 */
async function seedAccounts(app: NestExpressApplication): Promise<Record<string, string>> {
  const auth = app.get(AuthService);
  const initialAdminPassword = getConfig().auth.initialPasswordAdmin;

  const admin = auth.listUsers().find((u) => u.username === ADMIN.username);
  if (!admin) throw new Error('内置管理员建号失败');
  await auth.changePassword({ userId: admin.id, oldPassword: initialAdminPassword, newPassword: ADMIN.password });

  const npmTokens: Record<string, string> = {};
  npmTokens[ADMIN.username] = auth.createApiToken(admin.id, 'e2e-seed-admin').token;

  const secondary: { account: { username: string; password: string }; role: Role }[] = [
    { account: DEVELOPER, role: 'developer' },
    { account: READER, role: 'reader' },
  ];
  for (const { account, role } of secondary) {
    const created = await auth.createUser({ username: account.username, role });
    await auth.changePassword({
      userId: created.user.id,
      oldPassword: created.initialPassword ?? undefined,
      newPassword: account.password,
    });
    npmTokens[account.username] = auth.createApiToken(created.user.id, `e2e-seed-${account.username}`).token;
  }
  return npmTokens;
}

export interface TestAppOptions {
  /** 跳过种子账号初始化：用于验证内置管理员首登强制改密（内置密码 admin123 保持不变） */
  skipSeed?: boolean;
  /** 额外环境变量（如 SESSION_COOKIE_SECURE / SESSION_MAX_PER_USER），在 resetConfigCache 前注入 */
  env?: Record<string, string | undefined>;
}

/**
 * 每个用例文件使用独立数据目录 + 独立端口启动真实 HTTP 服务，
 * 保证 CLI 协议（npm / twine Basic 认证）与强制改密守卫可被完整验证。
 */
export async function createTestApp(name: string, options: TestAppOptions = {}): Promise<TestContext> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // 允许把 e2e 数据目录重定向到可写位置（受限沙箱/CI 下项目目录可能只读）
  const dataRoot = process.env.E2E_DATA_ROOT
    ? path.resolve(process.env.E2E_DATA_ROOT)
    : path.resolve(process.cwd(), 'data');
  const dataDir = path.join(dataRoot, `e2e-${name}`);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  process.env.PORT = String(port);
  process.env.PUBLIC_BASE_URL = baseUrl;
  // ensureBootstrapAdmin 读该变量建内置管理员账号，须在 resetConfigCache 前设置
  process.env.BOOTSTRAP_ADMIN_USERNAME = ADMIN.username;
  process.env.DATA_DIR = dataDir;
  // 用例级环境变量：先记录原值，close 时还原，避免污染同进程内其它用例文件
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.listen(port, '127.0.0.1');
  // 与生产首启一致：用户表为空时按固定初始密码创建内置管理员（skipSeed 时保持强制改密态）
  await app.get(AuthService).ensureBootstrapAdmin();
  const npmTokens = options.skipSeed ? {} : await seedAccounts(app);

  return {
    app,
    baseUrl,
    port,
    dataDir,
    npmTokens,
    close: async () => {
      await app.close();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfigCache();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

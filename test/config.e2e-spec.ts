import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertProductionReady,
  getConfig,
  productionConfigProblems,
  resetConfigCache,
} from '../src/config/config';

// 与 app-factory 保持一致：受限环境下可把临时目录重定向到可写位置
const DATA_ROOT = process.env.E2E_DATA_ROOT
  ? path.resolve(process.env.E2E_DATA_ROOT)
  : path.resolve(process.cwd(), 'data');
const DATA_DIR = path.join(DATA_ROOT, 'e2e-config-guard');
const BLOCKER = path.join(DATA_ROOT, 'e2e-config-blocker');

// 生产基线：固定初始密码不参与强度校验，靠 must_change_password 强制首登改密兜底

const MANAGED = [
  'NODE_ENV',
  'PUBLIC_BASE_URL',
  'NPM_BASE_URL',
  'PYPI_BASE_URL',
  'ALLOW_INSECURE_BASE_URL',
  'DATA_DIR',
  'BIND_HOST',
  'DEPLOY_MODE',
  'METRICS_TOKEN',
  'BOOTSTRAP_ADMIN_USERNAME',
  'INITIAL_PASSWORD_ADMIN',
  'INITIAL_PASSWORD_USER',
] as const;

describe('A1 生产配置护栏', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of MANAGED) saved[key] = process.env[key];
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://yuanjian.corp.internal',
      ALLOW_INSECURE_BASE_URL: 'false',
      DEPLOY_MODE: 'direct',
      DATA_DIR,
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
    });
    delete process.env.INITIAL_PASSWORD_ADMIN;
    delete process.env.INITIAL_PASSWORD_USER;
    delete process.env.NPM_BASE_URL;
    delete process.env.PYPI_BASE_URL;
    resetConfigCache();
  });

  afterEach(() => {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  });

  afterAll(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(BLOCKER, { force: true });
  });

  it('合规的生产配置不产生任何问题', () => {
    expect(productionConfigProblems(getConfig())).toEqual([]);
    expect(() => assertProductionReady()).not.toThrow();
  });

  it('内置管理员与新账号使用固定初始密码，生产护栏不因弱口令拒绝', () => {
    const cfg = getConfig();
    expect(cfg.auth.initialPasswordAdmin).toBe('admin123');
    expect(cfg.auth.initialPasswordUser).toBe('123123123');
    // 固定弱口令靠首登强制改密兜底，不能当成配置错误拒绝启动
    expect(productionConfigProblems(cfg)).toEqual([]);
    expect(() => assertProductionReady()).not.toThrow();
  });

  it('固定初始密码支持环境变量覆盖', () => {
    process.env.INITIAL_PASSWORD_ADMIN = 'Init-Admin-2026';
    process.env.INITIAL_PASSWORD_USER = 'Init-User-2026';
    resetConfigCache();

    expect(getConfig().auth.initialPasswordAdmin).toBe('Init-Admin-2026');
    expect(getConfig().auth.initialPasswordUser).toBe('Init-User-2026');
    expect(productionConfigProblems(getConfig())).toEqual([]);
  });

  it('密码最小长度默认 8 位', () => {
    delete process.env.PASSWORD_MIN_LENGTH;
    resetConfigCache();
    expect(getConfig().auth.passwordMinLength).toBe(8);
  });

  it('直连 HTTP 必须显式开启豁免', () => {
    process.env.PUBLIC_BASE_URL = 'http://10.0.0.8:3000';
    resetConfigCache();

    expect(productionConfigProblems(getConfig()).join('\n')).toContain('ALLOW_INSECURE_BASE_URL');
  });

  it('registry 基址未设置时回落 PUBLIC_BASE_URL，设置后独立生效', () => {
    // 未设置：与控制台同址（单进程部署的默认形态）
    let cfg = getConfig();
    expect(cfg.npmBaseUrl).toBe(cfg.publicBaseUrl);
    expect(cfg.pypiBaseUrl).toBe(cfg.publicBaseUrl);

    // 显式设置：多进程分端口部署形态，且尾斜杠会被规整掉
    Object.assign(process.env, {
      NPM_BASE_URL: 'https://npm.corp.internal/',
      PYPI_BASE_URL: 'https://pypi.corp.internal/',
    });
    resetConfigCache();
    cfg = getConfig();
    expect(cfg.npmBaseUrl).toBe('https://npm.corp.internal');
    expect(cfg.pypiBaseUrl).toBe('https://pypi.corp.internal');
  });

  it('registry 基址同样受生产 HTTPS 护栏约束', () => {
    Object.assign(process.env, {
      NPM_BASE_URL: 'http://10.0.0.9:3001',
      PYPI_BASE_URL: 'http://10.0.0.9:3002',
    });
    resetConfigCache();

    const problems = productionConfigProblems(getConfig()).join('\n');
    expect(problems).toContain('NPM_BASE_URL');
    expect(problems).toContain('PYPI_BASE_URL');
  });

  it('显式豁免后允许 HTTP 基址', () => {
    Object.assign(process.env, {
      PUBLIC_BASE_URL: 'http://10.0.0.8:3000',
      ALLOW_INSECURE_BASE_URL: 'true',
    });
    resetConfigCache();

    expect(getConfig().allowInsecureBaseUrl).toBe(true);
    expect(productionConfigProblems(getConfig())).toEqual([]);
  });

  it('非生产环境不触发护栏，开发配置可宽松', () => {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });
    resetConfigCache();

    expect(productionConfigProblems(getConfig())).toEqual([]);
    expect(() => assertProductionReady()).not.toThrow();
  });

  it('DATA_DIR 不可用时给出明确原因', () => {
    fs.writeFileSync(BLOCKER, 'blocker');
    process.env.DATA_DIR = BLOCKER;
    resetConfigCache();

    expect(productionConfigProblems(getConfig()).join('\n')).toContain('DATA_DIR');
  });

  it('A4：BIND_HOST 默认全网卡，显式设置后收敛监听地址', () => {
    // 未设置时保持 0.0.0.0，兼容直连部署形态
    delete process.env.BIND_HOST;
    resetConfigCache();
    expect(getConfig().bindHost).toBe('0.0.0.0');

    // 走 Nginx 网关的生产环境收敛到回环地址，杜绝绕过网关直连
    process.env.BIND_HOST = '127.0.0.1';
    resetConfigCache();
    expect(getConfig().bindHost).toBe('127.0.0.1');

    // 空白值视为未设置，避免静默监听失败
    process.env.BIND_HOST = '   ';
    resetConfigCache();
    expect(getConfig().bindHost).toBe('0.0.0.0');
  });

  it('冲突3：direct 形态允许 0.0.0.0，gateway 形态强制回环监听', () => {
    // 当前生产形态：http 明文直连 + 宿主端口映射（8860/8861/8862 → 3000）。
    // 默认 direct 不能因为 BIND_HOST 拒绝启动，否则端口映射全部失效、服务不可达。
    process.env.DEPLOY_MODE = 'direct';
    process.env.BIND_HOST = '0.0.0.0';
    resetConfigCache();
    expect(productionConfigProblems(getConfig())).toEqual([]);

    // 切到网关形态后仍监听全网卡，后端端口可绕过网关 TLS/ACL，必须拦下
    process.env.DEPLOY_MODE = 'gateway';
    resetConfigCache();
    expect(productionConfigProblems(getConfig()).join('\n')).toContain('BIND_HOST');

    process.env.BIND_HOST = '127.0.0.1';
    resetConfigCache();
    expect(productionConfigProblems(getConfig())).toEqual([]);
  });

  it('DEPLOY_MODE 取值非法时 fail-fast，不静默退化为直连', () => {
    process.env.DEPLOY_MODE = 'gatewat';
    resetConfigCache();
    expect(() => getConfig()).toThrow('DEPLOY_MODE');
  });
});

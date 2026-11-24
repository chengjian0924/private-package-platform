import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, productionConfigProblems, resetConfigCache } from '../../src/config/config';

/**
 * ALLOW_INSECURE_BASE_URL 的入口粒度：
 * - true/false 保持历史布尔语义（全部放行 / 全部拒绝）；
 * - 支持 console,npm,pypi 子集：内网 registry 走 http、控制台走网关 TLS 的混合部署；
 * - 拼错的入口直接抛错，避免「以为放行了其实没生效」；
 * - 生产护栏按入口判定，不再一处豁免把三个入口一起放行。
 */
const DATA_ROOT = process.env.E2E_DATA_ROOT
  ? path.resolve(process.env.E2E_DATA_ROOT)
  : path.resolve(process.cwd(), 'data');
const DATA_DIR = path.join(DATA_ROOT, 'unit-insecure-scope');

const MANAGED = ['NODE_ENV', 'PUBLIC_BASE_URL', 'NPM_BASE_URL', 'PYPI_BASE_URL', 'ALLOW_INSECURE_BASE_URL', 'DATA_DIR'];

describe('明文 HTTP 豁免的入口粒度', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of MANAGED) saved[key] = process.env[key];
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  afterAll(() => {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.DATA_DIR = DATA_DIR;
    process.env.PUBLIC_BASE_URL = 'https://console.corp.internal';
    process.env.NPM_BASE_URL = 'http://npm.corp.internal:8861';
    process.env.PYPI_BASE_URL = 'https://pypi.corp.internal';
    delete process.env.ALLOW_INSECURE_BASE_URL;
    resetConfigCache();
  });

  it('只豁免 npm 时，控制台与 pypi 仍要求 https', () => {
    process.env.PUBLIC_BASE_URL = 'http://console.corp.internal:8860';
    process.env.PYPI_BASE_URL = 'http://pypi.corp.internal:8862';
    process.env.ALLOW_INSECURE_BASE_URL = 'npm';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.insecureBaseTargets).toEqual(['npm']);
    expect(cfg.allowInsecureBaseUrl).toBe(true);
    const problems = productionConfigProblems(cfg).join('\n');
    // registry 通了，但控制台与 pypi 的明文入口不能被「一处豁免」顺带放行
    expect(problems).not.toContain('NPM_BASE_URL');
    expect(problems).toContain('PUBLIC_BASE_URL');
    expect(problems).toContain('PYPI_BASE_URL');
    expect(problems).toContain('ALLOW_INSECURE_BASE_URL=console');
  });

  it('未豁免时，http 的 npm 基址被拦下，并提示按入口设置', () => {
    delete process.env.ALLOW_INSECURE_BASE_URL;
    resetConfigCache();
    const problems = productionConfigProblems(getConfig()).join('\n');
    expect(problems).toContain('NPM_BASE_URL');
    expect(problems).toContain('ALLOW_INSECURE_BASE_URL=npm');
  });

  it('true 等价于三个入口全部放行（历史语义不变）', () => {
    process.env.NPM_BASE_URL = 'http://npm.corp.internal:8861';
    process.env.PYPI_BASE_URL = 'http://pypi.corp.internal:8862';
    process.env.ALLOW_INSECURE_BASE_URL = 'true';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.insecureBaseTargets).toEqual(['console', 'npm', 'pypi']);
    expect(productionConfigProblems(cfg)).toEqual([]);
  });

  it('逗号组合支持别名且去重', () => {
    process.env.ALLOW_INSECURE_BASE_URL = 'npm, pip ,npm';
    resetConfigCache();
    expect(getConfig().insecureBaseTargets).toEqual(['npm', 'pypi']);
  });

  it('拼错的入口直接报错，不静默忽略', () => {
    process.env.ALLOW_INSECURE_BASE_URL = 'nmp';
    resetConfigCache();
    expect(() => getConfig()).toThrow(/ALLOW_INSECURE_BASE_URL/);
  });

  it('SESSION_COOKIE_SECURE 取值非法时报错', () => {
    process.env.SESSION_COOKIE_SECURE = 'sometimes';
    resetConfigCache();
    expect(() => getConfig()).toThrow(/SESSION_COOKIE_SECURE/);
    delete process.env.SESSION_COOKIE_SECURE;
    resetConfigCache();
  });
});

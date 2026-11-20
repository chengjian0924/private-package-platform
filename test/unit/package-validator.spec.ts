import {
  compatiblePythonFromTags,
  pythonTagToVersion,
  validateNpmPackage,
  validatePypiPackage,
} from '../../src/packages/package-validator';
import { makeNpmTarball } from '../fixtures';

/** 构造最小 buffer；这里只测标识/标签/版本校验，不做安全扫描，内容用占位即可 */
const BUF = Buffer.from('PK\x03\x04' + 'x'.repeat(64));

function validate(overrides: Partial<Parameters<typeof validatePypiPackage>[0]> = {}) {
  return validatePypiPackage({
    buffer: BUF,
    filename: 'demo-1.0.0-py3-none-any.whl',
    name: 'demo',
    version: '1.0.0',
    existsInRegistry: false,
    targets: {},
    ...overrides,
  });
}

describe('通用 PyPI 仓库：版本识别与兼容性不再阻断入库', () => {
  it.each([
    ['cp38', '3.8'], ['cp39', '3.9'], ['cp310', '3.10'], ['cp311', '3.11'],
    ['cp312', '3.12'], ['cp313', '3.13'], ['cp314', '3.14'], ['cp315', '3.15'],
  ])('%s wheel 与目标版本不一致仍判 valid（仅告警）', (tag, py) => {
    const out = validate({
      filename: `demo-1.0.0-${tag}-${tag}-manylinux_2_17_x86_64.whl`,
      targets: { python: '3.11.9' },
    });
    expect(out.status).toBe('valid');
    expect(out.issues.filter((i) => i.code === 'PKG_RUNTIME_INCOMPATIBLE').every((i) => i.severity === 'warning')).toBe(true);
    expect(out.compatibility.compatiblePython).toContain(py);
  });

  it('py3-none-any 通用 wheel 不产生版本不兼容告警', () => {
    const out = validate({ targets: { python: '3.11.9' } });
    expect(out.status).toBe('valid');
    expect(out.issues.some((i) => i.code === 'PKG_RUNTIME_INCOMPATIBLE')).toBe(false);
  });

  it('requires_python 不满足目标只告警不拦截', () => {
    const out = validate({ requiresPython: '>=3.15', targets: { python: '3.11.9' } });
    expect(out.status).toBe('valid');
    expect(out.issues.some((i) => i.code === 'PKG_RUNTIME_INCOMPATIBLE' && i.severity === 'warning')).toBe(true);
  });

  it('真实完整性错误仍拦截：sha256 不符', () => {
    const out = validate({ declaredSha256: 'deadbeef' });
    expect(out.status).toBe('invalid');
    expect(out.issues.map((i) => i.code)).toContain('PKG_INTEGRITY_MISMATCH');
  });

  it('真实完整性错误仍拦截：非法文件名', () => {
    const out = validate({ filename: 'not-a-package.txt' });
    expect(out.status).toBe('invalid');
    expect(out.issues.map((i) => i.code)).toContain('PKG_TARBALL_INVALID');
  });

  it('真实完整性错误仍拦截：非 PEP 440 版本', () => {
    const out = validate({ version: 'not-a-version' });
    expect(out.status).toBe('invalid');
    expect(out.issues.map((i) => i.code)).toContain('PKG_VERSION_INVALID');
  });

  it('重复版本仍拦截', () => {
    const out = validate({ existsInRegistry: true });
    expect(out.status).toBe('invalid');
    expect(out.issues.map((i) => i.code)).toContain('PKG_VERSION_DUPLICATE');
  });
});

describe('通用 npm 仓库：运行时目标不兼容仅告警不阻断', () => {
  it('engines.node 与目标 Node 不一致仍判 valid（仅 warning）', async () => {
    const tarball = await makeNpmTarball('unit-runtime-lib', '1.0.0', { engines: { node: '>=99' } });
    const out = await validateNpmPackage({
      buffer: tarball,
      name: 'unit-runtime-lib',
      version: '1.0.0',
      existsInRegistry: false,
      targets: { node: '20.11.0' },
    });
    expect(out.status).toBe('valid');
    expect(out.issues.some((i) => i.code === 'PKG_RUNTIME_INCOMPATIBLE' && i.severity === 'warning')).toBe(true);
    // 元数据仍需透传，供下游 npm 按客户端环境判断
    expect(out.metadata.engines).toEqual({ node: '>=99' });
  });

  it('os / cpu 与目标不一致同样只告警', async () => {
    const tarball = await makeNpmTarball('unit-runtime-os', '1.0.0', { os: ['darwin'], cpu: ['arm64'] });
    const out = await validateNpmPackage({
      buffer: tarball,
      name: 'unit-runtime-os',
      version: '1.0.0',
      existsInRegistry: false,
      targets: { node: '20.11.0', os: 'linux', arch: 'x64' },
    });
    expect(out.status).toBe('valid');
    expect(out.issues.filter((i) => i.code === 'PKG_RUNTIME_INCOMPATIBLE').every((i) => i.severity === 'warning')).toBe(true);
  });
});

describe('npm 入库阶段不校验跨包依赖兼容性', () => {
  it('依赖不在源里、或已有版本不满足区间，均判 valid 且不产生 PKG_DEP_* 问题', async () => {
    const tarball = await makeNpmTarball('unit-dep-lib', '1.0.0', {
      engines: { node: '>=18' },
      dependencies: { 'totally-missing-dep': '^9.0.0' },
      optionalDependencies: { 'another-missing-dep': '~2.0.0' },
      peerDependencies: { 'peer-missing-dep': '>=3.0.0' },
    });
    const out = await validateNpmPackage({
      buffer: tarball,
      name: 'unit-dep-lib',
      version: '1.0.0',
      existsInRegistry: false,
      targets: { node: '22.23.5' },
    });

    expect(out.status).toBe('valid');
    expect(out.issues.some((i) => i.code.startsWith('PKG_DEP_'))).toBe(false);
    // 依赖声明仍需原样透传，交给下游客户端安装时自行解析
    expect(out.metadata.dependencies).toEqual({ 'totally-missing-dep': '^9.0.0' });
    expect(out.metadata.peerDependencies).toEqual({ 'peer-missing-dep': '>=3.0.0' });
  });

  it('真实结构错误仍拦截（版本号非法）', async () => {
    const tarball = await makeNpmTarball('unit-dep-lib', '1.0.0', { engines: { node: '>=18' } });
    const out = await validateNpmPackage({
      buffer: tarball,
      name: 'unit-dep-lib',
      version: 'not-a-version',
      existsInRegistry: false,
      targets: { node: '22.23.5' },
    });
    expect(out.status).toBe('invalid');
    expect(out.issues.map((i) => i.code)).toContain('PKG_VERSION_INVALID');
  });
});

describe('PEP 425 版本标签解析', () => {
  it.each([
    ['cp38', { major: 3, minor: 8 }],
    ['cp39', { major: 3, minor: 9 }],
    ['cp310', { major: 3, minor: 10 }],
    ['cp311', { major: 3, minor: 11 }],
    ['cp312', { major: 3, minor: 12 }],
    ['cp315', { major: 3, minor: 15 }],
    ['py3', { major: 3, minor: -1 }],
    ['py311', { major: 3, minor: 11 }],
    ['py2', { major: 2, minor: -1 }],
  ])('%s 解析为 %j', (tag, expected) => {
    expect(pythonTagToVersion(tag)).toEqual(expected);
  });

  it('从多标签推导兼容版本集合并去重排序', () => {
    expect(compatiblePythonFromTags(['cp311', 'cp312', 'py3'])).toEqual(['3.11', '3.12', '3.x']);
  });
});

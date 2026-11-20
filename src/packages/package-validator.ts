import { Readable } from 'node:stream';
import * as semver from 'semver';
import * as tar from 'tar';
import { digestOf } from '../common/http.util';
import { isNpmManifestPath, pickNpmMetadata } from './npm-metadata';
import type { Ecosystem } from './packages.service';
import { isValidName, normalizeName } from './packages.service';

export interface RuntimeTargets {
  node?: string;
  python?: string;
  os?: string;
  arch?: string;
  libc?: string;
}

export interface CheckIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationOutcome {
  status: 'valid' | 'invalid';
  issues: CheckIssue[];
  metadata: Record<string, unknown>;
  compatibility: Record<string, unknown>;
  digests: { sha256: string; shasum: string; integrity: string };
  size: number;
}

export interface NpmValidateInput {
  buffer: Buffer;
  name: string;
  version: string;
  declaredSha256?: string;
  existsInRegistry: boolean;
  targets: RuntimeTargets;
}

export interface PypiValidateInput {
  buffer: Buffer;
  filename: string;
  name: string;
  version: string;
  declaredSha256?: string;
  existsInRegistry: boolean;
  targets: RuntimeTargets;
  requiresPython?: string;
}

// ---------- PEP 440 轻量实现（MVP 仅支持常用比较符） ----------

function versionTuple(raw: string): number[] {
  const match = raw.trim().match(/^(\d+(?:\.\d+)*)/);
  return match ? match[1].split('.').map((n) => Number(n)) : [];
}

function compareTuples(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** 判断 Python 版本是否满足 requires_python 表达式，如 ">=3.9,<4" */
export function satisfiesPython(requires: string | undefined, target: string | undefined): boolean {
  if (!requires || !target) return true;
  const targetTuple = versionTuple(target);
  if (targetTuple.length === 0) return true;

  for (const rawClause of requires.split(',')) {
    const clause = rawClause.trim();
    if (!clause) continue;
    const match = clause.match(/^(>=|<=|==|!=|~=|>|<)\s*([0-9][0-9A-Za-z.*+!-]*)$/);
    if (!match) continue;
    const op = match[1];
    const rawVersion = match[2];

    if (op === '==' && rawVersion.endsWith('.*')) {
      const prefix = versionTuple(rawVersion.slice(0, -2));
      if (compareTuples(targetTuple.slice(0, prefix.length), prefix) !== 0) return false;
      continue;
    }
    const cmp = compareTuples(targetTuple, versionTuple(rawVersion));
    switch (op) {
      case '>=':
        if (cmp < 0) return false;
        break;
      case '<=':
        if (cmp > 0) return false;
        break;
      case '>':
        if (cmp <= 0) return false;
        break;
      case '<':
        if (cmp >= 0) return false;
        break;
      case '==':
        if (cmp !== 0) return false;
        break;
      case '!=':
        if (cmp === 0) return false;
        break;
      case '~=': {
        // ~=3.9 等价于 >=3.9 且 <4（对两段版本）
        const base = versionTuple(rawVersion);
        if (cmp < 0) return false;
        if (compareTuples(targetTuple.slice(0, 1), [base[0] + 1]) >= 0) return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

const PEP440 = /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?(\+[0-9a-z.]+)?$/i;

export function isValidPypiVersion(version: string): boolean {
  return PEP440.test(version.trim());
}

// ---------- npm tarball ----------

interface NpmManifest {
  name?: string;
  version?: string;
  description?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  [key: string]: unknown;
}

export async function readNpmPackageManifest(buffer: Buffer): Promise<NpmManifest> {
  // 用对象持有引用，避免闭包内赋值被 TS 收窄为 never
  const holder: { data: Buffer | null; depth: number } = { data: null, depth: Number.MAX_SAFE_INTEGER };

  const parser = tar.t({
    onentry: (entry) => {
      const entryPath = entry.path.replace(/^\.\//, '');
      // 兼容非标准布局：<包名>/package.json（如离线 @types 包）
      const depth = entryPath.split('/').filter(Boolean).length;
      if (isNpmManifestPath(entryPath) && depth < holder.depth) {
        holder.depth = depth;
        const chunks: Buffer[] = [];
        let size = 0;
        entry.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 2 * 1024 * 1024) chunks.push(chunk);
        });
        entry.on('end', () => {
          holder.data = Buffer.concat(chunks);
        });
      } else {
        entry.resume();
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    Readable.from(buffer).pipe(parser);
  });

  if (!holder.data) throw new Error('tarball 中未找到 package.json');
  return JSON.parse(holder.data.toString('utf8')) as NpmManifest;
}

export async function validateNpmPackage(input: NpmValidateInput): Promise<ValidationOutcome> {
  const issues: CheckIssue[] = [];
  const digests = digestOf(input.buffer);

  // S1 文件完整性
  let manifest: NpmManifest;
  try {
    manifest = await readNpmPackageManifest(input.buffer);
  } catch (err) {
    issues.push({ code: 'PKG_TARBALL_INVALID', severity: 'error', message: `包文件解析失败：${(err as Error).message}` });
    return { status: 'invalid', issues, metadata: {}, compatibility: {}, digests, size: input.buffer.length };
  }

  if (input.declaredSha256 && input.declaredSha256.toLowerCase() !== digests.sha256) {
    issues.push({
      code: 'PKG_INTEGRITY_MISMATCH',
      severity: 'error',
      message: `文件 sha256 与清单声明不一致（实际 ${digests.sha256.slice(0, 12)}…）`,
    });
  }
  if (!manifest.name || normalizeName('npm', manifest.name) !== normalizeName('npm', input.name)) {
    issues.push({
      code: 'PKG_METADATA_MISMATCH',
      severity: 'error',
      message: `包内 name=${manifest.name ?? '缺失'} 与清单 ${input.name} 不一致`,
    });
  }
  if (manifest.version !== input.version) {
    issues.push({
      code: 'PKG_METADATA_MISMATCH',
      severity: 'error',
      message: `包内 version=${manifest.version ?? '缺失'} 与清单 ${input.version} 不一致`,
    });
  }

  // S2 版本号合法性
  if (!semver.valid(input.version)) {
    issues.push({ code: 'PKG_VERSION_INVALID', severity: 'error', message: `版本号 ${input.version} 不符合 SemVer` });
  }
  if (!isValidName('npm', input.name)) {
    issues.push({ code: 'PKG_NAME_INVALID', severity: 'error', message: `包名 ${input.name} 不合法` });
  }

  // S3 重复版本
  if (input.existsInRegistry) {
    issues.push({ code: 'PKG_VERSION_DUPLICATE', severity: 'error', message: '该版本已存在于私有源' });
  }

  // S4 跨包依赖兼容性：刻意不做判定。
  // 私有源只负责存储，依赖声明按白名单原样透传到 packument，由下游 npm/pip 客户端
  // 在安装时按自身需求解析版本。入库时拿「当前已入库的版本集合」去比对依赖区间，
  // 会把「依赖包还没导全」误判成消费方不兼容，并导致该包在 partial 提交时被跳过。
  // 缺失依赖以真实 404 请求为准（MissingService.reportRegistryMiss），不由导入侧推测。

  // S5 运行时兼容性「提示」：通用源不做版本准入拦截（与 PyPI 侧设计一致）。
  //
  // 设计依据：本平台是通用 npm 仓库，必须同时容纳面向不同 Node 版本 / OS / CPU 的包。
  // engines.node / os / cpu 是给「客户端」npm 在安装时按自身环境判断用的元数据，不是
  // 仓库端的准入条件。若用单一 DEFAULT_NODE_TARGET 精确匹配并拒绝不匹配包，下游既无法
  // 自行选择版本，也会让面向其他运行时的包进不了库。故一律降级为 warning：完整保留
  // 信息，由 npm 在拉取端决策，仓库只保证包本身完整、标识一致、版本合法、无重复。
  const engines = manifest.engines || {};
  const nodeRange = engines.node;
  if (!nodeRange) {
    issues.push({ code: 'PKG_RUNTIME_INCOMPATIBLE', severity: 'warning', message: '包未声明 engines.node，无法确认 Node 兼容性' });
  } else if (input.targets.node && !semver.satisfies(input.targets.node, nodeRange, { includePrerelease: true })) {
    issues.push({
      code: 'PKG_RUNTIME_INCOMPATIBLE',
      severity: 'warning',
      message: `engines.node=${nodeRange} 与默认目标 Node ${input.targets.node} 不一致；已收录，npm 将按客户端环境判断`,
    });
  }

  if (manifest.os?.length && input.targets.os && !manifest.os.includes(input.targets.os)) {
    issues.push({
      code: 'PKG_RUNTIME_INCOMPATIBLE',
      severity: 'warning',
      message: `包限定 os=${manifest.os.join(',')}，与目标 ${input.targets.os} 不一致；已收录，npm 将按客户端环境判断`,
    });
  }
  if (manifest.cpu?.length && input.targets.arch && !manifest.cpu.includes(input.targets.arch)) {
    issues.push({
      code: 'PKG_RUNTIME_INCOMPATIBLE',
      severity: 'warning',
      message: `包限定 cpu=${manifest.cpu.join(',')}，与目标 ${input.targets.arch} 不一致；已收录，npm 将按客户端环境判断`,
    });
  }

  return {
    status: issues.some((i) => i.severity === 'error') ? 'invalid' : 'valid',
    issues,
    metadata: {
      ...pickNpmMetadata(manifest as Record<string, unknown>),
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || '',
      engines: manifest.engines || null,
      dependencies: manifest.dependencies || null,
    },
    compatibility: {
      engines: manifest.engines || null,
      targets: input.targets,
    },
    digests,
    size: input.buffer.length,
  };
}

// ---------- PyPI ----------

export interface WheelInfo {
  name: string;
  version: string;
  pythonTags: string[];
  abiTags: string[];
  platformTags: string[];
}

export function parseWheelFilename(filename: string): WheelInfo | null {
  if (!/\.whl$/i.test(filename)) return null;
  const parts = filename.replace(/\.whl$/i, '').split('-');
  if (parts.length < 5) return null;
  const platformTags = parts[parts.length - 1].split('.');
  const abiTags = parts[parts.length - 2].split('.');
  const pythonTags = parts[parts.length - 3].split('.');
  const rest = parts.slice(0, parts.length - 3);
  const name = rest[0];
  const version = rest[1];
  return { name, version, pythonTags, abiTags, platformTags };
}

export function parseSdistFilename(filename: string): { name: string; version: string } | null {
  const match = filename.match(/^(.+)-([^-/]+)\.(tar\.gz|zip|tar\.bz2)$/i);
  if (!match) return null;
  return { name: match[1], version: match[2] };
}

/**
 * 把 PEP 425 python 标签解析为「主版本.次版本」。
 * - cp311 / py311 → 3.11；cp310 → 3.10；cp39 → 3.9（均支持两位 minor）
 * - py3 / py2 是跨次版本通配，分别展开为 3.x / 2.x（以 -1 表示 any minor）
 * - cp3 / py3 等仅有主版本的标签同样按通配处理
 * 返回 null 表示无法识别的标签（不影响入库，仅不参与兼容集合）。
 */
export function pythonTagToVersion(tag: string): { major: number; minor: number } | null {
  const cp = tag.match(/^cp(\d)(\d+)$/);
  if (cp) return { major: Number(cp[1]), minor: Number(cp[2]) };
  const py = tag.match(/^py(\d)(\d+)$/);
  if (py) return { major: Number(py[1]), minor: Number(py[2]) };
  if (/^py[23]$/.test(tag) || /^cp[23]$/.test(tag)) {
    return { major: Number(tag[2]), minor: -1 };
  }
  return null;
}

/** 由 wheel 的 python 标签推导其面向的 Python 版本集合，供索引与元数据展示使用 */
export function compatiblePythonFromTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const v = pythonTagToVersion(tag);
    if (!v) continue;
    out.add(v.minor < 0 ? `${v.major}.x` : `${v.major}.${v.minor}`);
  }
  return [...out].sort();
}

/**
 * 判断 wheel 标签是否与「指定的单一目标版本」匹配。
 * 通用仓库不再用它做准入，仅在给出显式目标时用于生成 warning 文案。
 */
function pythonTagMatches(tag: string, target: string): boolean {
  const v = pythonTagToVersion(tag);
  if (!v) return false;
  const targetTuple = versionTuple(target);
  if (targetTuple.length < 2) return true;
  if (v.major !== targetTuple[0]) return false;
  return v.minor < 0 || v.minor === targetTuple[1];
}

function platformMatches(platformTag: string, targets: RuntimeTargets): boolean {
  if (platformTag === 'any') return true;
  if (!targets.os) return true;
  const os = targets.os.toLowerCase();
  const tag = platformTag.toLowerCase();

  if (tag.includes('linux') && !(os.includes('linux') || os.includes('manylinux'))) return false;
  if (tag.includes('macosx') && !(os.includes('darwin') || os.includes('mac'))) return false;
  if (tag.includes('win') && !(os.includes('win'))) return false;

  if (targets.arch) {
    const arch = targets.arch.toLowerCase();
    if (tag.includes('x86_64') || tag.includes('amd64')) {
      if (!(arch === 'x64' || arch === 'x86_64')) return false;
    }
    if (tag.includes('aarch64') || tag.includes('arm64')) {
      if (!(arch === 'arm64' || arch === 'aarch64')) return false;
    }
  }
  return true;
}

export function validatePypiPackage(input: PypiValidateInput): ValidationOutcome {
  const issues: CheckIssue[] = [];
  const digests = digestOf(input.buffer);

  // S1 文件完整性
  if (input.declaredSha256 && input.declaredSha256.toLowerCase() !== digests.sha256) {
    issues.push({
      code: 'PKG_INTEGRITY_MISMATCH',
      severity: 'error',
      message: `文件 sha256 与声明不一致（实际 ${digests.sha256.slice(0, 12)}…）`,
    });
  }

  const wheel = parseWheelFilename(input.filename);
  const sdist = parseSdistFilename(input.filename);
  if (!wheel && !sdist) {
    issues.push({ code: 'PKG_TARBALL_INVALID', severity: 'error', message: '文件名不是合法的 wheel 或 sdist' });
    return { status: 'invalid', issues, metadata: {}, compatibility: {}, digests, size: input.buffer.length };
  }
  const parsed = wheel ?? sdist!;
  if (normalizeName('pypi', parsed.name) !== normalizeName('pypi', input.name)) {
    issues.push({
      code: 'PKG_METADATA_MISMATCH',
      severity: 'error',
      message: `文件名中的包名 ${parsed.name} 与清单 ${input.name} 不一致`,
    });
  }
  if (parsed.version !== input.version) {
    issues.push({
      code: 'PKG_METADATA_MISMATCH',
      severity: 'error',
      message: `文件名中的版本 ${parsed.version} 与清单 ${input.version} 不一致`,
    });
  }

  // S2 版本号合法性
  if (!isValidPypiVersion(input.version)) {
    issues.push({ code: 'PKG_VERSION_INVALID', severity: 'error', message: `版本号 ${input.version} 不符合 PEP 440` });
  }
  if (!isValidName('pypi', input.name)) {
    issues.push({ code: 'PKG_NAME_INVALID', severity: 'error', message: `包名 ${input.name} 不合法` });
  }

  // S3 重复版本
  if (input.existsInRegistry) {
    issues.push({ code: 'PKG_VERSION_DUPLICATE', severity: 'error', message: '该版本已存在于私有源' });
  }

  // S5 运行时兼容性「提示」：通用仓库不做版本准入拦截。
  //
  // 设计依据：本平台定位是通用 PyPI 仓库，必须同时容纳面向不同 Python 版本/ABI/平台的
  // wheel。PEP 425 的 wheel 标签（python/abi/platform）与 requires_python 是给「客户端」
  // pip 在安装时按自身环境挑选用的元数据，不是仓库端的准入条件。若在入库时用单一
  // DEFAULT_PYTHON_TARGET 精确匹配并拒绝不匹配包，会导致 cp310/cp311/cp312/... 的 wheel
  // 无法入库，用户也就无法按自身需求拉取。故这里一律降级为 warning：完整保留信息，
  // 由 pip 在拉取端决策，仓库只保证包本身完整、标识一致、版本合法、无重复。
  if (input.requiresPython && !satisfiesPython(input.requiresPython, input.targets.python)) {
    issues.push({
      code: 'PKG_RUNTIME_INCOMPATIBLE',
      severity: 'warning',
      message: `requires_python=${input.requiresPython} 与默认目标 Python ${input.targets.python || '未设置'} 不一致；已收录，pip 将按客户端环境判断`,
    });
  }
  if (wheel && input.targets.python) {
    const matched = wheel.pythonTags.some((tag) => pythonTagMatches(tag, input.targets.python!));
    if (!matched) {
      issues.push({
        code: 'PKG_RUNTIME_INCOMPATIBLE',
        severity: 'warning',
        message: `wheel 标签 ${wheel.pythonTags.join('.')} 与默认目标 Python ${input.targets.python} 不一致；已收录，pip 将按客户端环境挑选兼容 wheel`,
      });
    }
    const platformOk = wheel.platformTags.every((tag) => platformMatches(tag, input.targets));
    if (!platformOk) {
      issues.push({
        code: 'PKG_RUNTIME_INCOMPATIBLE',
        severity: 'warning',
        message: `wheel 平台标签 ${wheel.platformTags.join('.')} 与默认目标 ${input.targets.os || '任意'}/${input.targets.arch || '任意'} 不一致；已收录，pip 将按客户端环境挑选`,
      });
    }
  }

  return {
    status: issues.some((i) => i.severity === 'error') ? 'invalid' : 'valid',
    issues,
    metadata: {
      name: input.name,
      version: input.version,
      filename: input.filename,
      requiresPython: input.requiresPython ?? null,
      kind: wheel ? 'wheel' : 'sdist',
      pythonTags: wheel?.pythonTags ?? null,
      abiTags: wheel?.abiTags ?? null,
      platformTags: wheel?.platformTags ?? null,
    },
    compatibility: {
      requiresPython: input.requiresPython ?? null,
      wheelTags: wheel ? { python: wheel.pythonTags, abi: wheel.abiTags, platform: wheel.platformTags } : null,
      targets: input.targets,
      // 标记该包面向的 Python 版本集合（由 wheel 标签推导），供索引层与客户端参考
      compatiblePython: wheel ? compatiblePythonFromTags(wheel.pythonTags) : [],
    },
    digests,
    size: input.buffer.length,
  };
}

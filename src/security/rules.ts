import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import type { SecurityConfig } from '../config/config';
import type { DependencyRef, Dimension, SecurityFinding, Severity, SignatureStatus } from './types';

export interface ArchiveEntry {
  path: string;
  size: number;
  /** Unix 权限位，来自 tar header 或 zip external attr */
  mode: number;
  /** 仅文本类文件保留内容，二进制文件为 null */
  text: string | null;
  /** 仅嵌套归档保留原始字节，用于递归扫描 */
  data?: Buffer;
}

export interface ArchiveInfo {
  format: 'npm' | 'wheel' | 'sdist' | 'unknown';
  entries: ArchiveEntry[];
  manifest: Record<string, unknown> | null;
  dependencies: DependencyRef[];
  truncated: boolean;
  parseError?: string;
  /** 压缩比异常或声明体积超限的条目，交由完整性维度直接拒绝 */
  bombEntries?: { path: string; size: number; compressedSize: number }[];
}

export interface StaticScanResult {
  findings: SecurityFinding[];
  metadata: Record<string, unknown>;
  signature: SignatureStatus;
  archive: ArchiveInfo;
}

const TEXT_LIMIT = 256 * 1024;
const LOCK_TEXT_LIMIT = 2 * 1024 * 1024;
const MAX_FINDINGS_PER_DIMENSION = 40;
/** 依赖清单上限，避免超大 lockfile 拖垮扫描与报告体积 */
const MAX_DEPENDENCY_REFS = 500;

/** lockfile 通常较大，需要更高读取上限才能拿到完整依赖树 */
const LOCK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|poetry\.lock|Pipfile\.lock)$/i;

function textLimitFor(path: string): number {
  return LOCK_FILE.test(path) ? LOCK_TEXT_LIMIT : TEXT_LIMIT;
}

const TEXT_EXT =
  /\.(js|mjs|cjs|jsx|ts|tsx|py|pyw|sh|bash|zsh|fish|ps1|bat|cmd|rb|pl|php|lua|r|go|java|kt|scala|cs|sql|json|txt|md|cfg|ini|conf|yml|yaml|toml|xml|gyp|gradle|pth|service|rules|lock)$/i;
const SPECIAL_FILE =
  /(^|\/)(package\.json|package-lock\.json|setup\.py|setup\.cfg|pyproject\.toml|Makefile|Dockerfile|docker-compose\.ya?ml|\.npmrc|\.pypirc|\.env(\.[\w-]+)?|requirements[\w.-]*\.txt|METADATA|entry_points\.txt|RECORD|PKG-INFO)$/i;
const BINARY_EXT = /\.(exe|dll|so(\.\d+)*|dylib|bin|class|jar|war|node|wasm|png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|avi|mov|woff2?|ttf|otf|eot)$/i;
const NESTED_ARCHIVE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz|7z|rar)$/i;
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|pyw|sh|bash|zsh|ps1|bat|cmd|rb|pl|php|lua)$/i;

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isTextEntry(path: string, buffer: Buffer): boolean {
  if (buffer.indexOf(0) !== -1) return false;
  if (BINARY_EXT.test(path)) return false;
  if (TEXT_EXT.test(path) || SPECIAL_FILE.test(path)) return true;
  // 无扩展名的安装脚本（postinstall / install / preinstall）按文本处理
  return !/\./.test(path.split('/').pop() || '');
}

function locateLine(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function maskEvidence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-2)}`;
}

export { maskEvidence };

function finding(
  dimension: Dimension,
  ruleId: string,
  severity: Exclude<Severity, 'none'>,
  title: string,
  detail: string,
  remediation: string,
  location?: string,
  evidence?: string,
): SecurityFinding {
  return { dimension, ruleId, severity, title, detail, remediation, location, evidence };
}

// ---------- 归档解析 ----------

async function readTarEntries(
  buffer: Buffer,
  cfg: SecurityConfig,
): Promise<{
  entries: ArchiveEntry[];
  truncated: boolean;
  error?: string;
  bombEntries?: { path: string; size: number; compressedSize: number }[];
}> {
  const entries: ArchiveEntry[] = [];
  let truncated = false;
  let totalText = 0;
  let totalNested = 0;

  const parser = tar.t({
    onentry: (entry) => {
      if (entry.type === 'Directory') {
        entry.resume();
        return;
      }
      if (entries.length >= cfg.maxScanEntries) {
        truncated = true;
        entry.resume();
        return;
      }
      const path = normalizePath(entry.path);
      const size = typeof entry.size === 'number' ? entry.size : 0;
      const mode = typeof entry.mode === 'number' ? entry.mode : 0;
      const isNested = NESTED_ARCHIVE.test(path);
      const chunks: Buffer[] = [];
      let read = 0;
      let text: string | null = null;
      // 嵌套归档需要在预算内保留完整字节，否则递归扫描无从下手
      const nestedChunks: Buffer[] = [];
      let nestedBytes = 0;

      entry.on('data', (chunk: Buffer) => {
        read += chunk.length;
        if (isNested) {
          if (nestedBytes + chunk.length <= cfg.maxNestedArchiveBytes && totalNested + chunk.length <= cfg.maxScanTotalBytes) {
            nestedChunks.push(Buffer.from(chunk));
            nestedBytes += chunk.length;
          }
          return;
        }
        if (read <= textLimitFor(path) && totalText < cfg.maxScanTotalBytes) chunks.push(Buffer.from(chunk));
      });
      entry.on('end', () => {
        if (isNested) {
          totalNested += nestedBytes;
          const complete = nestedBytes === size;
          entries.push({ path, size, mode, text: null, data: complete && nestedBytes > 0 ? Buffer.concat(nestedChunks) : undefined });
          return;
        }
        const head = Buffer.concat(chunks);
        if (head.length > 0 && (TEXT_EXT.test(path) || SPECIAL_FILE.test(path) || !BINARY_EXT.test(path))) {
          if (isTextEntry(path, head)) {
            totalText += head.length;
            text = head.toString('utf8');
          }
        }
        entries.push({ path, size, mode, text });
      });
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      parser.on('error', reject);
      parser.on('end', resolve);
      Readable.from(buffer).pipe(parser);
    });
    return { entries, truncated };
  } catch (err) {
    return { entries, truncated, error: (err as Error).message };
  }
}

function readZipEntries(
  buffer: Buffer,
  cfg: SecurityConfig,
): {
  entries: ArchiveEntry[];
  truncated: boolean;
  error?: string;
  bombEntries: { path: string; size: number; compressedSize: number }[];
} {
  const entries: ArchiveEntry[] = [];
  const bombEntries: { path: string; size: number; compressedSize: number }[] = [];
  let truncated = false;
  let totalText = 0;
  try {
    const zip = new AdmZip(buffer);
    const all = zip.getEntries();
    for (const item of all) {
      if (item.isDirectory) continue;
      if (entries.length >= cfg.maxScanEntries) {
        truncated = true;
        break;
      }
      const path = normalizePath(item.entryName);
      const size = Number(item.header?.size ?? 0);
      const compressedSize = Number(item.header?.compressedSize ?? buffer.length);
      // zip 的 unix 权限位存放在 external attr 高 16 位
      const mode = item.header?.attr ? (item.header.attr >>> 16) & 0xffff : 0;

      // 声明体积超限或压缩比异常时不再 fetch 解压内容，避免 getData 触发大块内存分配
      const bomb =
        size > cfg.maxScanFileBytes ||
        (compressedSize > 0 && size > 1024 * 1024 && size / compressedSize > cfg.maxCompressionRatio);
      let text: string | null = null;
      let data: Buffer | undefined;
      if (bomb) {
        bombEntries.push({ path, size, compressedSize });
      } else if (NESTED_ARCHIVE.test(path)) {
        if (size > 0 && size <= cfg.maxNestedArchiveBytes) {
          try {
            const nested = item.getData();
            if (nested.length <= cfg.maxNestedArchiveBytes) data = nested;
          } catch {
            data = undefined;
          }
        }
      } else if (size <= textLimitFor(path) && totalText < cfg.maxScanTotalBytes) {
        try {
          const content = item.getData();
          if (content.length > 0 && isTextEntry(path, content)) {
            totalText += content.length;
            text = content.toString('utf8');
          }
        } catch {
          text = null;
        }
      }
      entries.push({ path, size, mode, text, data });
    }
    return { entries, truncated, bombEntries };
  } catch (err) {
    return { entries, truncated, error: (err as Error).message, bombEntries };
  }
}

/** 从 package-lock / npm-shrinkwrap 提取实际安装版本，避免仅凭宽泛声明误判漏洞 */
function npmLockVersions(files: { path: string; text: string }[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const file = files.find((item) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/i.test(item.path));
  if (!file) return resolved;

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(file.text) as Record<string, unknown>;
  } catch {
    return resolved;
  }

  const put = (name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') return;
    const key = name.trim();
    if (!key || resolved.has(key)) return;
    resolved.set(key, version.trim());
  };

  // lockfile v2/v3：packages 的 key 形如 node_modules/lodash，嵌套依赖取最后一段
  const packages = json.packages;
  if (packages && typeof packages === 'object') {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      const match = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      const name = match ? match[1] : key;
      const record = value as Record<string, unknown>;
      if (name) put(name, record?.version);
    }
  }

  // lockfile v1：dependencies 递归
  const walk = (deps: unknown) => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      const record = value as Record<string, unknown>;
      put(name, record?.version);
      walk(record?.dependencies);
    }
  };
  walk(json.dependencies);
  return resolved;
}

function parseNpmDependencies(
  manifest: Record<string, unknown> | null,
  files: { path: string; text: string }[],
): DependencyRef[] {
  if (!manifest) return [];
  const resolved = npmLockVersions(files);
  const refs: DependencyRef[] = [];
  const pick = (key: string, kind: DependencyRef['kind']) => {
    const deps = manifest[key];
    if (!deps || typeof deps !== 'object') return;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range === 'string') {
        refs.push({ name, range, kind, resolvedVersion: resolved.get(name) });
      }
    }
  };
  pick('dependencies', 'runtime');
  pick('optionalDependencies', 'optional');
  pick('peerDependencies', 'peer');
  return refs;
}

function normalizePyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** lockfile 中未直接声明的依赖，按传递依赖纳入漏洞比对与 SBOM */
function npmLockDependencies(
  manifest: Record<string, unknown> | null,
  files: { path: string; text: string }[],
): DependencyRef[] {
  const resolved = npmLockVersions(files);
  if (resolved.size === 0) return [];
  const declared = new Set<string>();
  if (manifest) {
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const deps = manifest[key];
      if (deps && typeof deps === 'object') {
        for (const name of Object.keys(deps as Record<string, unknown>)) declared.add(name);
      }
    }
  }
  const refs: DependencyRef[] = [];
  for (const [name, version] of resolved) {
    if (declared.has(name)) continue;
    refs.push({ name, range: version, kind: 'runtime', resolvedVersion: version, transitive: true });
    if (refs.length >= MAX_DEPENDENCY_REFS) break;
  }
  return refs;
}

function pythonLockDependencies(
  direct: DependencyRef[],
  files: { path: string; text: string }[],
): DependencyRef[] {
  const resolved = pythonLockVersions(files);
  if (resolved.size === 0) return [];
  const declared = new Set(direct.map((ref) => ref.name));
  const refs: DependencyRef[] = [];
  for (const [name, version] of resolved) {
    if (declared.has(name)) continue;
    refs.push({ name, range: version, kind: 'python', resolvedVersion: version, transitive: true });
    if (refs.length >= MAX_DEPENDENCY_REFS) break;
  }
  return refs;
}

/** 从 poetry.lock / Pipfile.lock 提取解析后的依赖版本 */
function pythonLockVersions(files: { path: string; text: string }[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const put = (name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') return;
    const key = normalizePyName(name);
    const value = version.trim().replace(/^==/, '');
    if (!key || !value || resolved.has(key)) return;
    resolved.set(key, value);
  };

  const pipfile = files.find((item) => /(^|\/)Pipfile\.lock$/i.test(item.path));
  if (pipfile) {
    try {
      const json = JSON.parse(pipfile.text) as Record<string, unknown>;
      for (const section of ['default', 'develop']) {
        const deps = json[section];
        if (!deps || typeof deps !== 'object') continue;
        for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
          put(name, (value as Record<string, unknown>)?.version);
        }
      }
    } catch {
      // 解析失败时退化为未解析版本，仅做提示
    }
  }

  const poetry = files.find((item) => /(^|\/)poetry\.lock$/i.test(item.path));
  if (poetry) {
    for (const block of poetry.text.split(/\[\[package\]\]/).slice(1)) {
      const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
      const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
      put(name, version);
    }
  }
  return resolved;
}

/** 解析 Python 依赖声明：METADATA 的 Requires-Dist 或 pyproject 的 dependencies 数组 */
function parsePythonDependencies(files: { path: string; text: string }[]): DependencyRef[] {
  const refs: DependencyRef[] = [];
  const push = (spec: string) => {
    const clean = spec.split(';')[0].trim();
    const match = clean.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\]\s*)?(.*)$/);
    if (!match) return;
    refs.push({ name: normalizePyName(match[1]), range: match[2].trim() || '*', kind: 'python' });
  };
  for (const file of files) {
    if (/(^|\/)METADATA$/i.test(file.path) || /(^|\/)PKG-INFO$/i.test(file.path)) {
      for (const line of file.text.split('\n')) {
        const match = line.match(/^Requires-Dist:\s*(.+)$/i);
        if (match) push(match[1]);
      }
    }
    if (/(^|\/)(pyproject\.toml|setup\.cfg)$/i.test(file.path)) {
      const block = file.text.match(/(?:dependencies\s*=\s*\[|install_requires\s*=\s*\[)([\s\S]*?)\]/i);
      if (block) {
        for (const quoted of block[1].matchAll(/['"]([^'"]+)['"]/g)) push(quoted[1]);
      }
    }
  }
  const resolved = pythonLockVersions(files);
  return refs.map((ref) => ({ ...ref, resolvedVersion: resolved.get(ref.name) }));
}

export async function inspectArchive(
  buffer: Buffer,
  ecosystem: 'npm' | 'pypi',
  filename: string,
  cfg: SecurityConfig,
): Promise<ArchiveInfo> {
  const lower = filename.toLowerCase();
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;

  let format: ArchiveInfo['format'] = 'unknown';
  if (ecosystem === 'npm') format = 'npm';
  else if (lower.endsWith('.whl') || lower.endsWith('.zip')) format = 'wheel';
  else if (/\.(tar\.gz|tgz)$/.test(lower)) format = 'sdist';

  let parsed: {
    entries: ArchiveEntry[];
    truncated: boolean;
    error?: string;
    bombEntries?: { path: string; size: number; compressedSize: number }[];
  };
  if (isZip && format !== 'npm') {
    parsed = readZipEntries(buffer, cfg);
  } else if (isGzip || format === 'npm' || format === 'sdist') {
    parsed = await readTarEntries(buffer, cfg);
  } else if (isZip) {
    parsed = readZipEntries(buffer, cfg);
  } else {
    parsed = { entries: [], truncated: false, error: '无法识别的归档格式' };
  }

  const entries = parsed.entries;
  let manifest: Record<string, unknown> | null = null;
  if (ecosystem === 'npm') {
    const pkgEntry = entries.find((e) => e.path === 'package/package.json') ?? entries.find((e) => e.path === 'package.json');
    if (pkgEntry?.text) {
      try {
        manifest = JSON.parse(pkgEntry.text) as Record<string, unknown>;
      } catch {
        manifest = null;
      }
    }
  }

  const textFiles = entries.filter((e) => e.text !== null).map((e) => ({ path: e.path, text: e.text as string }));
  // 直接依赖 + lockfile 传递依赖；传递依赖同样参与漏洞比对并写入 SBOM
  const direct = ecosystem === 'npm' ? parseNpmDependencies(manifest, textFiles) : parsePythonDependencies(textFiles);
  const transitive =
    ecosystem === 'npm' ? npmLockDependencies(manifest, textFiles) : pythonLockDependencies(direct, textFiles);
  const limitedDependencies = [...direct, ...transitive].slice(0, MAX_DEPENDENCY_REFS);

  return {
    format,
    entries,
    manifest,
    dependencies: limitedDependencies,
    truncated: parsed.truncated,
    parseError: parsed.error,
    bombEntries: parsed.bombEntries,
  };
}

/**
 * 解析包内嵌套归档：按魔数/扩展名判断格式，不复用外层 ecosystem，
 * 避免把 zip 当 tar 解导致「嵌套内容永远解析失败」的漏扫。
 */
async function inspectNestedArchive(buffer: Buffer, path: string, cfg: SecurityConfig): Promise<ArchiveInfo> {
  const lower = path.toLowerCase();
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const looksTar = /\.(tar\.gz|tgz|tar|tar\.bz2|tar\.xz)$/.test(lower);

  const parsed = isZip
    ? readZipEntries(buffer, cfg)
    : isGzip || looksTar
      ? await readTarEntries(buffer, cfg)
      : { entries: [], truncated: false, error: '嵌套归档格式无法识别', bombEntries: [] };

  return {
    format: 'unknown',
    entries: parsed.entries,
    manifest: null,
    dependencies: [],
    truncated: parsed.truncated,
    parseError: parsed.error,
    bombEntries: parsed.bombEntries,
  };
}

// ---------- 签名校验 ----------

export function verifySignature(
  buffer: Buffer,
  signatureB64: string | undefined,
  cfg: SecurityConfig,
): { status: SignatureStatus; finding?: SecurityFinding } {
  if (!signatureB64) {
    if (!cfg.requireSignature) return { status: 'unsigned' };
    return {
      status: 'invalid',
      finding: finding(
        'integrity',
        'INT-SIG-001',
        'high',
        '缺少必要签名',
        '当前环境要求上传包必须携带签名，但未提供签名文件',
        '使用受信私钥对包文件签名后重新上传',
      ),
    };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    signature = Buffer.alloc(0);
  }
  if (signature.length === 0) {
    return {
      status: 'invalid',
      finding: finding('integrity', 'INT-SIG-002', 'critical', '签名格式非法', '签名内容无法按 base64 解码', '重新生成签名后上传'),
    };
  }

  if (cfg.trustedKeys.length === 0) {
    return {
      status: 'invalid',
      finding: finding(
        'integrity',
        'INT-SIG-003',
        'high',
        '未配置可信公钥',
        '包携带签名，但平台未配置可信公钥，无法完成验签',
        '由管理员在 SECURITY_TRUSTED_KEYS 中配置可信公钥后重新校验',
      ),
    };
  }

  for (const trusted of cfg.trustedKeys) {
    try {
      const key = crypto.createPublicKey(trusted.pem);
      const ok =
        key.asymmetricKeyType === 'ed25519'
          ? crypto.verify(null, buffer, key, signature)
          : crypto.verify('sha256', buffer, key, signature);
      if (ok) return { status: 'verified' };
    } catch {
      continue;
    }
  }

  return {
    status: 'invalid',
    finding: finding(
      'integrity',
      'INT-SIG-004',
      'critical',
      '签名校验失败',
      '包文件与签名不匹配，或签名私钥不在可信列表中，文件可能被篡改',
      '确认包来源与签名私钥，重新签名后上传',
    ),
  };
}

// ---------- 完整性 ----------

function integrityFindings(
  archive: ArchiveInfo,
  input: { filename: string; sha256: string; buffer: Buffer },
  cfg: SecurityConfig,
  signatureFinding?: SecurityFinding,
): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const lower = input.filename.toLowerCase();
  const isGzip = input.buffer.length > 2 && input.buffer[0] === 0x1f && input.buffer[1] === 0x8b;
  const isZip = input.buffer.length > 3 && input.buffer[0] === 0x50 && input.buffer[1] === 0x4b;

  if (input.buffer.length === 0) {
    out.push(
      finding('integrity', 'INT-001', 'critical', '空文件', '上传内容长度为 0，无法作为包文件使用', '重新打包并上传'),
    );
    return out;
  }

  const expectZip = lower.endsWith('.whl') || lower.endsWith('.zip');
  const expectGzip = lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
  if ((expectZip && !isZip) || (expectGzip && !isGzip)) {
    out.push(
      finding(
        'integrity',
        'INT-002',
        'critical',
        '文件头与扩展名不符',
        `文件扩展名为 ${lower.split('.').slice(-2).join('.')}，但内容魔数不匹配，疑似伪装文件`,
        '确认文件真实类型后重新打包',
      ),
    );
  }

  if (archive.parseError) {
    out.push(
      finding(
        'integrity',
        'INT-003',
        'critical',
        '包结构损坏',
        `归档解析失败：${archive.parseError}`,
        '重新打包，确保归档可被标准解压工具打开',
      ),
    );
    return out;
  }

  if (archive.format === 'unknown') {
    out.push(
      finding('integrity', 'INT-004', 'high', '无法识别的包格式', '文件不是受支持的 tar.gz / whl / zip 结构', '按 npm 或 PyPI 规范重新打包'),
    );
  }

  const hasManifest =
    archive.format === 'npm'
      ? Boolean(archive.manifest)
      : archive.entries.some((e) => /(^|\/)(METADATA|PKG-INFO)$/i.test(e.path));
  if (!hasManifest) {
    out.push(
      finding(
        'integrity',
        'INT-005',
        'high',
        '缺少包元数据',
        archive.format === 'npm' ? '归档中未找到 package/package.json' : '归档中未找到 METADATA / PKG-INFO',
        '补齐包元数据后重新打包',
      ),
    );
  }

  const traversal = archive.entries.filter(
    (e) => e.path.startsWith('/') || e.path.split('/').some((seg) => seg === '..') || /^[A-Za-z]:\//.test(e.path),
  );
  if (traversal.length > 0) {
    out.push(
      finding(
        'integrity',
        'INT-006',
        'critical',
        '存在路径穿越条目',
        `归档包含 ${traversal.length} 个绝对路径或 ../ 条目，解压时可能覆盖系统文件`,
        '移除异常路径条目后重新打包',
        traversal[0].path,
      ),
    );
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of archive.entries) {
    if (seen.has(entry.path)) duplicates.add(entry.path);
    seen.add(entry.path);
  }
  if (duplicates.size > 0) {
    out.push(
      finding(
        'integrity',
        'INT-007',
        'medium',
        '存在重复条目',
        `归档包含 ${duplicates.size} 个同名条目，解压结果依赖工具实现，存在被覆盖风险`,
        '保证归档内条目唯一后重新打包',
        Array.from(duplicates)[0],
      ),
    );
  }

  const nested = archive.entries.filter((e) => NESTED_ARCHIVE.test(e.path));
  if (nested.length > 0) {
    out.push(
      finding(
        'integrity',
        'INT-008',
        'medium',
        '包内嵌套压缩文件',
        `发现 ${nested.length} 个嵌套归档文件，可能用于隐藏二进制或绕过扫描；已按配置递归展开校验`,
        '移除不必要的嵌套归档，或提供清单说明用途',
        nested[0].path,
      ),
    );
  }

  // 声明解压总量远超压缩包体积，且突破扫描预算，按压缩炸弹直接拒绝
  const declaredBytes = archive.entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
  const bombEntries = archive.bombEntries || [];
  if (bombEntries.length > 0) {
    const worst = bombEntries[0];
    out.push(
      finding(
        'integrity',
        'INT-011',
        'critical',
        '疑似压缩炸弹',
        `${bombEntries.length} 个条目声明解压后体积异常：${worst.path} 解压 ${worst.size} 字节 / 压缩 ${worst.compressedSize} 字节`,
        '重新打包，避免超高压缩比文件；确需大文件请拆分为独立制品',
        worst.path,
      ),
    );
  } else if (
    input.buffer.length > 0 &&
    declaredBytes > cfg.maxScanTotalBytes &&
    declaredBytes / input.buffer.length > cfg.maxCompressionRatio
  ) {
    out.push(
      finding(
        'integrity',
        'INT-011',
        'critical',
        '疑似压缩炸弹',
        `归档声明解压总量 ${declaredBytes} 字节，为压缩包体积的 ${Math.round(declaredBytes / input.buffer.length)} 倍，超过阈值 ${cfg.maxCompressionRatio}`,
        '重新打包，避免超高压缩比文件；确需大文件请拆分为独立制品',
      ),
    );
  }

  if (archive.truncated) {
    out.push(
      finding(
        'integrity',
        'INT-009',
        'medium',
        '归档条目超出扫描上限',
        `条目数超过 ${cfg.maxScanEntries}，后续条目未被静态扫描`,
        '精简包内容，避免包含大量无关文件',
      ),
    );
  }

  if (input.buffer.length > cfg.maxScanFileBytes) {
    out.push(
      finding(
        'integrity',
        'INT-010',
        'critical',
        '文件超出扫描上限',
        `文件大小 ${input.buffer.length} 字节，超过单文件扫描上限 ${cfg.maxScanFileBytes}，无法完成深度校验`,
        '拆分或精简包文件后重新上传',
      ),
    );
  }

  if (signatureFinding) out.push(signatureFinding);
  return out;
}

// ---------- 文本规则引擎 ----------

interface PatternRule {
  id: string;
  severity: Exclude<Severity, 'none'>;
  title: string;
  pattern: RegExp;
  detail: string;
  remediation: string;
  /** 仅对指定文件生效 */
  files?: RegExp;
  mask?: boolean;
  /** 命中后先做占位符过滤，避免示例值误报 */
  skipPlaceholder?: boolean;
}

const PLACEHOLDER = /your[_-]?|example|placeholder|change[_-]?me|dummy|sample|xxxx|<\s*\w+\s*>|\$\{|\{\{|redacted|none|null/i;

function runPatternRules(
  dimension: Dimension,
  rules: PatternRule[],
  file: { path: string; text: string },
): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  for (const rule of rules) {
    if (rule.files && !rule.files.test(file.path)) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let match: RegExpExecArray | null;
    let hits = 0;
    while ((match = re.exec(file.text)) !== null && hits < 3) {
      if (match[0] === '') {
        re.lastIndex++;
        continue;
      }
      hits++;
      const line = locateLine(file.text, match.index);
      const lineText = file.text.split('\n')[line - 1] || '';
      if (rule.skipPlaceholder && PLACEHOLDER.test(lineText)) continue;
      out.push(
        finding(
          dimension,
          rule.id,
          rule.severity,
          rule.title,
          rule.detail,
          rule.remediation,
          `${file.path}:${line}`,
          // 默认对所有命中片段脱敏：报告会外发，原始代码片段可能含凭据/内网地址
          maskEvidence(match[0]),
        ),
      );
    }
  }
  return out;
}

const MALWARE_RULES: PatternRule[] = [
  {
    id: 'MAL-001',
    severity: 'critical',
    title: '反弹 Shell 特征',
    pattern: /\/dev\/tcp\/|\bbash\s+-i\s+>&|\bnc\s+-e\s+|\bncat\s+-e\s+|socat\s+[^\n]*exec/i,
    detail: '代码包含建立反向命令通道的常见写法，通常用于远程控制主机',
    remediation: '删除相关代码；确属业务需要请拆分并说明网络用途',
  },
  {
    id: 'MAL-002',
    severity: 'critical',
    title: '编码载荷动态执行',
    pattern: /(eval|new\s+Function)\s*\(\s*(atob|Buffer\.from)\s*\(|exec\s*\(\s*(base64\.b64decode|codecs\.decode)\s*\(/i,
    detail: '先解码再执行代码，是混淆木马的典型手法',
    remediation: '移除动态解码执行逻辑，改为可审计的显式代码',
  },
  {
    id: 'MAL-003',
    severity: 'high',
    title: '混淆字符串执行',
    pattern: /eval\s*\(\s*['"][A-Za-z0-9+/=]{120,}['"]\s*\)/,
    detail: 'eval 直接执行超长编码字符串，无法审阅真实逻辑',
    remediation: '改为明文实现并移除混淆代码',
  },
  {
    id: 'MAL-004',
    severity: 'critical',
    title: '挖矿程序特征',
    pattern: /stratum\+(tcp|ssl):\/\/|xmrig|minerd|coinhive|cryptonight/i,
    detail: '代码包含加密货币挖矿协议或矿工程序特征',
    remediation: '删除挖矿相关代码并排查供应链来源',
  },
  {
    id: 'MAL-005',
    severity: 'high',
    title: '下载后直接执行',
    pattern: /(curl|wget)[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    detail: '从网络下载脚本并直接交给 shell 执行，内容无法事先审计',
    remediation: '改为下载后校验摘要再执行，或移除外联脚本',
  },
  {
    id: 'MAL-006',
    severity: 'critical',
    title: '破坏性文件删除',
    pattern: /rm\s+-rf\s+(\/|~|\$HOME)(\s|$)|shutil\.rmtree\(\s*['"]\/['"]/i,
    detail: '包含删除根目录或用户目录的命令，运行即造成不可逆破坏',
    remediation: '删除破坏性命令，限制删除范围到包内临时目录',
  },
  {
    id: 'MAL-007',
    severity: 'high',
    title: '读取凭据文件',
    pattern: /\.ssh\/id_(rsa|ed25519)|\.aws\/credentials|\.npmrc|\.pypirc|\.docker\/config\.json|\.kube\/config/i,
    detail: '代码访问开发者凭据文件，存在凭据窃取风险',
    remediation: '移除对凭据文件的读取；凭据应通过运行环境注入',
  },
  {
    id: 'MAL-008',
    severity: 'high',
    title: '动态库注入',
    pattern: /LD_PRELOAD|\/etc\/ld\.so\.preload|\bptrace\s*\(/,
    detail: '包含动态库预加载或进程调试注入特征',
    remediation: '移除注入逻辑，使用官方扩展机制',
  },
  {
    id: 'MAL-009',
    severity: 'high',
    title: '安装期提权操作',
    pattern: /\b(chmod\s+[0-7]*7[0-7]{2}|chown\s+root|setcap\s+|visudo|sudoers)/i,
    detail: '安装期尝试修改权限或提权，可能导致权限溢出',
    remediation: '安装脚本不得修改系统权限，改为文档说明手工步骤',
  },
  {
    id: 'MAL-010',
    severity: 'medium',
    title: '远程模块加载',
    pattern: /require\s*\(\s*['"]https?:\/\/|import\s*\(\s*['"]https?:\/\//i,
    detail: '直接从网络加载模块，运行时内容不可控',
    remediation: '改为本地依赖并锁定版本',
  },
  {
    id: 'MAL-011',
    severity: 'medium',
    title: '持久化驻留',
    pattern: /crontab\s+-|\/etc\/cron|\/etc\/systemd\/system|schtasks\s+\/create|systemctl\s+enable/i,
    detail: '包含计划任务或系统服务注册，可能在卸载后继续驻留',
    remediation: '移除持久化逻辑；如需服务请通过部署流程管理',
  },
  {
    id: 'MAL-012',
    severity: 'high',
    title: '键盘记录 / 截屏',
    pattern: /keylog|GetAsyncKeyState|pynput\.keyboard|pyautogui\.screenshot/i,
    detail: '包含键盘记录或屏幕采集特征',
    remediation: '删除相关代码并上报安全团队',
  },
];

const SECRET_RULES: PatternRule[] = [
  {
    id: 'SEC-001',
    severity: 'critical',
    title: '私钥文件泄漏',
    pattern: /-----BEGIN (RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/,
    detail: '包内包含私钥内容，任何拿到包的人都可冒充身份',
    remediation: '立即吊销该密钥并从包中移除，改用环境变量或密钥托管',
    mask: true,
  },
  {
    id: 'SEC-002',
    severity: 'critical',
    title: '云访问密钥',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    detail: '命中 AWS Access Key 格式，可能导致云资源被接管',
    remediation: '吊销密钥并从包内移除，改用临时凭证',
    mask: true,
  },
  {
    id: 'SEC-003',
    severity: 'critical',
    title: '代码托管平台令牌',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    detail: '命中 GitHub / GitLab / Slack 令牌格式',
    remediation: '吊销令牌并改用 CI 注入的短期凭证',
    mask: true,
  },
  {
    id: 'SEC-004',
    severity: 'critical',
    title: '仓库认证令牌硬编码',
    pattern: /\/\/[^\s:'"]+:\/:_authToken\s*=|^\s*password\s*=\s*\S+/im,
    detail: '.npmrc / .pypirc 中的认证信息被打包上传',
    remediation: '从包中移除认证配置，改为本地 ~/.npmrc 或 CI 注入',
    mask: true,
    skipPlaceholder: true,
  },
  {
    id: 'SEC-005',
    severity: 'high',
    title: '硬编码密码',
    pattern: /(password|passwd|pwd|secret)\s*[:=]\s*['"][^'"]{6,}['"]/i,
    detail: '源码中出现疑似真实密码的赋值',
    remediation: '改为环境变量或配置中心读取，并轮换已泄漏密码',
    mask: true,
    skipPlaceholder: true,
  },
  {
    id: 'SEC-006',
    severity: 'high',
    title: '硬编码 API Key',
    pattern: /(api[_-]?key|apikey|access[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    detail: '源码中出现疑似真实 API Key 的赋值',
    remediation: '改为环境变量或密钥服务读取，并轮换已泄漏密钥',
    mask: true,
    skipPlaceholder: true,
  },
  {
    id: 'SEC-007',
    severity: 'medium',
    title: 'JWT 令牌泄漏',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    detail: '包内包含 JWT，可能携带可用身份信息',
    remediation: '移除令牌，改用运行时签发',
    mask: true,
  },
  {
    id: 'SEC-008',
    severity: 'medium',
    title: '连接串包含明文密码',
    pattern: /\b(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/i,
    detail: '数据库或消息队列连接串中包含明文口令',
    remediation: '改为环境变量注入完整连接串，并轮换口令',
    mask: true,
  },
  {
    id: 'SEC-009',
    severity: 'low',
    title: '疑似个人隐私数据',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)|\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    detail: '命中中国大陆手机号或身份证号格式，可能包含个人信息',
    remediation: '移除真实个人信息；测试数据请使用脱敏样本',
    mask: true,
  },
  {
    id: 'SEC-010',
    severity: 'low',
    title: '内网地址泄漏',
    pattern: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
    detail: '包内硬编码内网 IP，泄漏内部网络拓扑',
    remediation: '改为域名或配置项，避免硬编码内网地址',
    mask: true,
  },
];

// ---------- 权限风险 ----------

const INSTALL_SCRIPT = /^(preinstall|install|postinstall|prepare|preprepare)$/;

function permissionFindings(archive: ArchiveInfo, cfg: SecurityConfig): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const manifest = archive.manifest || {};

  const scripts = (manifest.scripts || {}) as Record<string, unknown>;
  const installScripts = Object.keys(scripts).filter((key) => INSTALL_SCRIPT.test(key));
  if (installScripts.length > 0) {
    out.push(
      finding(
        'permission',
        'PERM-001',
        'medium',
        '声明了安装期脚本',
        `包在安装时会执行脚本：${installScripts.join(', ')}`,
        '确认脚本内容可信；非必要请移除安装期脚本',
        'package.json',
      ),
    );
    const risky = installScripts.find((key) => {
      const value = String(scripts[key] || '');
      return /(curl|wget|node\s+-e|bash|sh\s+-c|powershell|eval|chmod|chown)/i.test(value);
    });
    if (risky) {
      out.push(
        finding(
          'permission',
          'PERM-002',
          'high',
          '安装期脚本执行外部命令',
          `script ${risky} 中包含网络下载或命令执行，安装即触发`,
          '移除安装期外部命令，或提供可审计的替代方案',
          `package.json#scripts.${risky}`,
        ),
      );
    }
  }

  const setuid = archive.entries.filter((e) => e.mode > 0 && (e.mode & 0o6000) !== 0);
  if (setuid.length > 0) {
    out.push(
      finding(
        'permission',
        'PERM-003',
        'high',
        '归档内含 setuid/setgid 文件',
        `${setuid.length} 个条目带有 setuid/setgid 权限位，执行后可能获得更高权限`,
        '移除特殊权限位后重新打包',
        setuid[0].path,
      ),
    );
  }

  const worldWritable = archive.entries.filter((e) => e.mode > 0 && (e.mode & 0o002) !== 0 && (e.mode & 0o111) !== 0);
  if (worldWritable.length > 0) {
    out.push(
      finding(
        'permission',
        'PERM-004',
        'medium',
        '可执行文件权限过宽',
        `${worldWritable.length} 个可执行条目对所有用户可写，存在被替换风险`,
        '收敛文件权限后重新打包',
        worldWritable[0].path,
      ),
    );
  }

  const pth = archive.entries.filter((e) => /\.pth$/i.test(e.path));
  if (pth.length > 0) {
    out.push(
      finding(
        'permission',
        'PERM-005',
        'high',
        '包含 .pth 自动加载文件',
        '.pth 会在 Python 启动时自动执行其中的 import 语句，常被用于持久化后门',
        '移除 .pth 文件，改用具名入口或显式初始化',
        pth[0].path,
      ),
    );
  }

  const setup = archive.entries.find((e) => /(^|\/)setup\.py$/i.test(e.path) && e.text);
  if (setup?.text && /(cmdclass|install_requires\s*=\s*\[|os\.system|subprocess\.(run|call|check_output))/i.test(setup.text)) {
    out.push(
      finding(
        'permission',
        'PERM-006',
        'medium',
        'setup.py 含安装期自定义逻辑',
        'setup.py 中出现命令执行或自定义安装类，构建/安装阶段会执行任意代码',
        '改用 pyproject.toml 声明式构建，移除安装期命令执行',
        setup.path,
      ),
    );
  }

  const docker = archive.entries.filter(
    (e) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|[\w-]*deployment\.ya?ml)$/i.test(e.path) && e.text,
  );
  for (const file of docker) {
    const text = file.text as string;
    if (/privileged\s*:\s*true|hostNetwork\s*:\s*true|hostPath|runAsUser\s*:\s*0|CAP_SYS_ADMIN/i.test(text)) {
      out.push(
        finding(
          'permission',
          'PERM-007',
          'high',
          '容器配置声明高权限',
          '容器清单包含 privileged / hostPath / hostNetwork / root 运行等高权限配置',
          '按最小权限原则收敛容器配置',
          file.path,
        ),
      );
    }
  }

  const bin = manifest.bin;
  if (bin) {
    out.push(
      finding(
        'permission',
        'PERM-008',
        'low',
        '声明了可执行入口',
        '包向全局 PATH 注册可执行命令，请确认命令行为符合预期',
        '确认入口脚本内容；非必要不注册全局命令',
        'package.json#bin',
      ),
    );
  }

  const restrictedOs = manifest.os;
  const restrictedCpu = manifest.cpu;
  if (Array.isArray(restrictedOs) || Array.isArray(restrictedCpu)) {
    out.push(
      finding(
        'permission',
        'PERM-009',
        'low',
        '声明了平台限制',
        `包限定运行平台 os=${JSON.stringify(restrictedOs || null)} cpu=${JSON.stringify(restrictedCpu || null)}`,
        '确认与目标部署环境一致',
        'package.json',
      ),
    );
  }

  if (archive.truncated) {
    out.push(
      finding(
        'permission',
        'PERM-010',
        'low',
        '权限检查未覆盖全部条目',
        `条目数超过上限 ${cfg.maxScanEntries}，后续条目未检查权限位`,
        '精简包内容后重新上传',
      ),
    );
  }

  return out;
}

// ---------- 行为风险 ----------

const HOST_ALLOWLIST =
  /(^|\.)(localhost|local|internal|corp|intra|test|example\.com|npmjs\.org|npmjs\.com|yarnpkg\.com|pypi\.org|python\.org|nodejs\.org|github\.com|githubusercontent\.com|apache\.org|openssl\.org)$/i;
const PRIVATE_HOST = /^(127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/;

function behaviorFindings(archive: ArchiveInfo): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const codeFiles = archive.entries.filter((e) => e.text && CODE_EXT.test(e.path));

  for (const file of codeFiles) {
    const text = file.text as string;

    const hasEgress = /(fetch\s*\(|axios\.|https?\.request|requests\.(get|post|put)|urllib\.request|http\.client|net\.connect|socket\.socket)/i.test(text);
    const hasEnvRead = /process\.env|os\.environ|os\.getenv/i.test(text);
    const hasSensitiveRead = /(readFileSync|readFile|open)\s*\([^)]*(\.env|\.ssh|\.aws|credentials|id_rsa|\.npmrc|\.pypirc)/i.test(text);
    const hasDynamicExec = /(eval\s*\(|new\s+Function\s*\(|exec\s*\(|execSync\s*\(|subprocess\.(run|call|Popen)|child_process)/i.test(text);
    const hasRemoteFetch = /(fetch\s*\(|axios\.|requests\.(get|post)|urllib\.request|http\.get)/i.test(text);

    // BEH-001 降级为 low：env 读取 + 网络请求是大型开源库（如 numpy/scipy）的
    // 常见组合（测试夹具、文档示例、遥测），关键词共现不足以判定凭据窃取。
    // 真正的凭据外泄由 BEH-002（读敏感文件+外发，critical）覆盖，保留强制拦截。
    if (hasEnvRead && hasEgress) {
      out.push(
        finding(
          'behavior',
          'BEH-001',
          'low',
          '读取环境变量并外发',
          '同一文件中同时出现环境变量读取与网络请求，可能窃取运行时凭据；大型开源库中多为误报，仅供复核参考',
          '确认网络请求目标与数据范围；禁止上传环境变量内容',
          file.path,
        ),
      );
    }

    if (hasSensitiveRead && hasEgress) {
      out.push(
        finding(
          'behavior',
          'BEH-002',
          'critical',
          '读取敏感文件并外发',
          '同一文件中读取凭据文件并发起网络请求，符合数据窃取特征',
          '删除相关逻辑并上报安全团队',
          file.path,
        ),
      );
    }

    if (hasRemoteFetch && hasDynamicExec && /(fetch|axios|requests)[\s\S]{0,400}(eval|exec|Function)/i.test(text)) {
      out.push(
        finding(
          'behavior',
          'BEH-003',
          'critical',
          '远程下载并执行',
          '代码从网络获取内容后动态执行，攻击者可随时替换载荷',
          '禁止远程代码执行，改为签名分发的本地依赖',
          file.path,
        ),
      );
    }

    // BEH-004 降级为 low：写入关键词（open(...,'w')）与路径关键词（/usr/local、.npmrc）
    // 分处代码注释、构建脚本、文档字符串中即会命中，官方大包误报率高。
    // 保留提示供人工复核，不再单独触发隔离。
    if (/(writeFileSync|writeFile|appendFile|open\s*\([^)]*['"](w|a))/.test(text) &&
        /(\/etc\/|~\/\.ssh|\/root\/|\.npmrc|\.pypirc|pip\.conf|\/usr\/local\/bin)/i.test(text)) {
      out.push(
        finding(
          'behavior',
          'BEH-004',
          'low',
          '写入系统或配置路径',
          '代码向系统目录或包管理器配置写入内容，可能篡改运行环境；关键词共现可能误报，仅供复核参考',
          '限制写入范围到包内目录或临时目录',
          file.path,
        ),
      );
    }

    if (/(require\s*\(\s*[A-Za-z_$]|import_module\s*\(\s*[A-Za-z_]|__import__\s*\()/i.test(text) &&
        /(atob|base64|Buffer\.from|decode)/i.test(text)) {
      out.push(
        finding(
          'behavior',
          'BEH-005',
          'medium',
          '动态模块加载',
          '按变量或解码结果动态加载模块，可能绕过静态审查',
          '改为静态 import/require，便于审计',
          file.path,
        ),
      );
    }

    const hosts = Array.from(text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)).map((m) => m[1].toLowerCase());
    const undeclared = Array.from(new Set(hosts)).filter((host) => !HOST_ALLOWLIST.test(host) && !PRIVATE_HOST.test(host));
    // BEH-006 降级为 low：文档字符串、参考文献 URL 普遍命中，medium 会在
    // 大型库上累积大量 finding 抬高风险分。仅作外联清单提示。
    if (undeclared.length > 0) {
      out.push(
        finding(
          'behavior',
          'BEH-006',
          'low',
          '存在未声明的外部网络外联',
          `代码中出现非白名单外部域名：${undeclared.slice(0, 5).join(', ')}（多为文档引用，仅供复核）`,
          '在包说明中声明外联用途，或改为可配置地址',
          file.path,
        ),
      );
    }

    if (/(net\.connect|socket\.socket|SOCK_STREAM|dgram\.createSocket)/i.test(text) && !hasEgress) {
      out.push(
        finding(
          'behavior',
          'BEH-007',
          'medium',
          '使用底层网络套接字',
          '代码直接创建 TCP/UDP 套接字，可能用于隧道或绕过网络审计',
          '改为受控的 HTTP 客户端并声明用途',
          file.path,
        ),
      );
    }
  }

  // 安装期脚本 + 网络请求：安装动作即产生外联
  const scripts = (archive.manifest?.scripts || {}) as Record<string, unknown>;
  const installScripts = Object.keys(scripts).filter((key) => INSTALL_SCRIPT.test(key));
  const installText = installScripts.map((key) => String(scripts[key] || '')).join('\n');
  if (installText && /(curl|wget|node\s+-e|http|https|nc\s)/i.test(installText)) {
    out.push(
      finding(
        'behavior',
        'BEH-008',
        'high',
        '安装期脚本发起网络请求',
        `安装脚本 ${installScripts.join(', ')} 中包含网络访问，安装动作会产生未声明外联`,
        '移除安装期网络请求，改为运行时按需拉取',
        'package.json#scripts',
      ),
    );
  }

  const binaries = archive.entries.filter((e) => /\.(exe|dll|so(\.\d+)*|dylib|bin|node|wasm|class|jar)$/i.test(e.path));
  if (binaries.length > 0) {
    out.push(
      finding(
        'behavior',
        'BEH-009',
        'high',
        '包内含原生可执行文件',
        `包含 ${binaries.length} 个二进制文件，静态规则无法审计其行为`,
        '提供源码包；确需二进制请附带来源与校验信息，并走人工复核',
        binaries[0].path,
      ),
    );
  }

  return out;
}

// ---------- 嵌套归档递归扫描 ----------
/**
 * 递归展开包内嵌套归档：以往只标记不展开，把恶意脚本打进 payload.zip 即可绕过全部规则。
 * 无法展开（层级/体积/解析失败）时统一提升为 high，交由隔离复核而非静默放行。
 */
async function nestedArchiveFindings(
  archive: ArchiveInfo,
  cfg: SecurityConfig,
  depth: number,
  budget: { bytes: number },
  prefix: string,
): Promise<SecurityFinding[]> {
  const out: SecurityFinding[] = [];
  for (const entry of archive.entries) {
    if (!NESTED_ARCHIVE.test(entry.path)) continue;
    const label = `${prefix}${entry.path}`;
    if (!entry.data) {
      out.push(
        finding(
          'integrity',
          'INT-012',
          'high',
          '嵌套归档无法展开扫描',
          `${label} 的体积超过单条目上限 ${cfg.maxNestedArchiveBytes} 字节或读取不完整，内部内容未校验`,
          '移除不必要的嵌套归档；确需保留请拆分为独立制品后单独上传',
          label,
        ),
      );
      continue;
    }
    if (depth <= 0) {
      out.push(
        finding(
          'integrity',
          'INT-012',
          'high',
          '嵌套归档层级超出扫描上限',
          `${label} 已超过 ${cfg.maxNestedDepth} 层嵌套限制，内部内容未校验`,
          '减少嵌套层级，或拆分为独立制品后单独上传',
          label,
        ),
      );
      continue;
    }
    if (entry.data.length > budget.bytes) {
      out.push(
        finding(
          'integrity',
          'INT-012',
          'high',
          '嵌套归档超出扫描预算',
          `${label} 需要 ${entry.data.length} 字节，剩余扫描预算不足，内部内容未校验`,
          '精简包内归档体积后重新上传',
          label,
        ),
      );
      continue;
    }
    budget.bytes -= entry.data.length;
    const info = await inspectNestedArchive(entry.data, entry.path, cfg);
    if (info.parseError) {
      out.push(
        finding(
          'integrity',
          'INT-012',
          'high',
          '嵌套归档解析失败',
          `${label} 无法按 zip/tar 解析：${info.parseError}，内部内容未校验`,
          '确认嵌套归档格式，或移除后重新打包',
          label,
        ),
      );
      continue;
    }
    if ((info.bombEntries || []).length > 0) {
      out.push(
        finding(
          'integrity',
          'INT-011',
          'critical',
          '嵌套归档疑似压缩炸弹',
          `${label} 内含超高压缩比条目，已终止解压`,
          '重新打包，避免超高压缩比文件',
          label,
        ),
      );
      continue;
    }

    for (const file of info.entries) {
      if (!file.text) continue;
      const nestedPath = `${label}!/${file.path}`;
      out.push(...runPatternRules('malware', MALWARE_RULES, { path: nestedPath, text: file.text }));
      out.push(...runPatternRules('secret', SECRET_RULES, { path: nestedPath, text: file.text }));
    }
    out.push(...permissionFindings(info, cfg).map((item) => ({ ...item, location: `${label}!/${item.location || ''}` })));
    out.push(...behaviorFindings(info).map((item) => ({ ...item, location: `${label}!/${item.location || ''}` })));
    out.push(...(await nestedArchiveFindings(info, cfg, depth - 1, budget, `${label}!/`)));
  }
  return out;
}

// ---------- 汇总入口 ----------

/** 规则包版本：扫描记录与报告引用，规则内容变更时必须递增 */
export const RULE_PACK_VERSION = '2026.11.1';

/** 当前启用的匹配规则数量，写入规则包快照供审计比对 */
export function rulePackInfo(): { version: string; ruleCount: number } {
  return { version: RULE_PACK_VERSION, ruleCount: MALWARE_RULES.length + SECRET_RULES.length };
}

function capFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const byDimension = new Map<Dimension, SecurityFinding[]>();
  for (const item of findings) {
    const list = byDimension.get(item.dimension) || [];
    list.push(item);
    byDimension.set(item.dimension, list);
  }
  const out: SecurityFinding[] = [];
  for (const [dimension, list] of byDimension) {
    out.push(...list.slice(0, MAX_FINDINGS_PER_DIMENSION));
    if (list.length > MAX_FINDINGS_PER_DIMENSION) {
      out.push(
        finding(
          dimension,
          'RULE-TRUNCATED',
          'low',
          '命中数量过多已截断',
          `该维度共命中 ${list.length} 条，报告仅保留前 ${MAX_FINDINGS_PER_DIMENSION} 条`,
          '优先修复高风险项，必要时拆分包后重新扫描',
        ),
      );
    }
  }
  return out;
}

/** 纯静态六维扫描（漏洞维度由 VulnService 单独补充） */
export async function runStaticScan(
  input: { ecosystem: 'npm' | 'pypi'; filename: string; sha256: string; buffer: Buffer },
  cfg: SecurityConfig,
  signature?: string,
): Promise<StaticScanResult> {
  const sig = verifySignature(input.buffer, signature, cfg);
  const archive = await inspectArchive(input.buffer, input.ecosystem, input.filename, cfg);
  const findings: SecurityFinding[] = integrityFindings(archive, input, cfg, sig.finding);

  for (const file of archive.entries) {
    if (!file.text) continue;
    findings.push(...runPatternRules('malware', MALWARE_RULES, { path: file.path, text: file.text }));
    findings.push(...runPatternRules('secret', SECRET_RULES, { path: file.path, text: file.text }));
  }

  findings.push(...permissionFindings(archive, cfg));
  findings.push(...behaviorFindings(archive));
  // 嵌套归档递归展开，预算从总扫描字节中扣除
  findings.push(
    ...(await nestedArchiveFindings(archive, cfg, cfg.maxNestedDepth, { bytes: cfg.maxScanTotalBytes }, '')),
  );

  const metadata: Record<string, unknown> = {
    format: archive.format,
    fileCount: archive.entries.length,
    truncated: archive.truncated,
    topLevelFiles: archive.entries.slice(0, 20).map((e) => e.path),
    manifestName: archive.manifest?.name ?? null,
    manifestVersion: archive.manifest?.version ?? null,
    dependencyCount: archive.dependencies.length,
    dependencies: archive.dependencies.slice(0, 200),
    hasInstallScript: Object.keys((archive.manifest?.scripts || {}) as Record<string, unknown>).some((key) =>
      INSTALL_SCRIPT.test(key),
    ),
    parseError: archive.parseError ?? null,
  };

  return { findings: capFindings(findings), metadata, signature: sig.status, archive };
}

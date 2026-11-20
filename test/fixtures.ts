import AdmZip from 'adm-zip';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';

export interface NpmManifestExtra {
  description?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  bin?: string | Record<string, string>;
  main?: string;
  module?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  dsh?: Record<string, unknown>;
  license?: string;
  repository?: string | Record<string, string>;
  homepage?: string;
  keywords?: string[];
}

/** 构造真实 npm tarball（package/package.json + 指定文件），用于上传/校验用例 */
export async function makeNpmTarball(
  name: string,
  version: string,
  extra: NpmManifestExtra = {},
  files: Record<string, string | Buffer> = {},
  rootDir = 'package',
): Promise<Buffer> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-fixture-'));
  const pkgDir = path.join(workDir, rootDir);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, ...extra }, null, 2),
  );
  const entries = Object.keys(files).length > 0 ? files : { 'index.js': 'module.exports = 1;\n' };
  for (const [relative, content] of Object.entries(entries)) {
    const target = path.join(pkgDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const stream = tar.create({ gzip: true, cwd: workDir, portable: true }, [rootDir]);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  fs.rmSync(workDir, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 把多个文件打包成 zip（含子目录），用于压缩包上传用例 */
export function makeZip(files: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
  return zip.toBuffer();
}

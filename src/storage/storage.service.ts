import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getConfig } from '../config/config';
import { digestOf, randomToken, sha256Hex } from '../common/http.util';
import { DiskGuardService } from '../common/disk-guard.service';

export interface StoredObject {
  sha256: string;
  size: number;
  key: string;
  path: string;
  shasum: string;
  integrity: string;
}

/**
 * 内容寻址存储：objects/<sha256 前 2 位>/<sha256>。
 * 写入流程为 临时文件 → fsync → 原子 rename，避免半截文件被引用。
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  private tmpDir = '';
  private objectDir = '';

  constructor(private readonly disk: DiskGuardService) {}

  async onModuleInit(): Promise<void> {
    const cfg = getConfig();
    this.tmpDir = cfg.tmpDir;
    this.objectDir = cfg.objectDir;
    await Promise.all([
      fsp.mkdir(cfg.objectDir, { recursive: true }),
      fsp.mkdir(cfg.metaDir, { recursive: true }),
      fsp.mkdir(cfg.batchDir, { recursive: true }),
      fsp.mkdir(cfg.tmpDir, { recursive: true }),
    ]);
    this.logger.log(`对象存储目录: ${cfg.objectDir}`);
  }

  async putObject(buf: Buffer): Promise<StoredObject> {
    const digests = digestOf(buf);
    return this.persist(buf.length, digests, (tmpFile) => fsp.writeFile(tmpFile, buf));
  }

  /**
   * 由磁盘文件直接入库：哈希与拷贝全程流式，避免大包整块驻留内存（B1）。
   * 调用方负责临时文件的清理。
   */
  async putObjectFromFile(srcPath: string): Promise<StoredObject> {
    const size = (await fsp.stat(srcPath)).size;
    const digests = await streamDigests(srcPath);
    return this.persist(size, digests, (tmpFile) => fsp.copyFile(srcPath, tmpFile));
  }

  private async persist(
    size: number,
    digests: { sha256: string; shasum: string; integrity: string },
    write: (tmpFile: string) => Promise<void>,
  ): Promise<StoredObject> {
    this.disk.assertWritable();
    const key = `objects/${digests.sha256.slice(0, 2)}/${digests.sha256}`;
    const absPath = path.join(getConfig().dataDir, key);
    const exists = await fsp
      .stat(absPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (exists) {
      // 内容寻址去重：同一 sha256 已存在就不再重写，但必须刷新 mtime。
      // 孤儿清扫按「无引用 且 mtime 早于宽限期」判定；对象复用时若 mtime 还是
      // 很久以前创建的时间，它会在本次上传拿到底层文件、DB 尚未提交的窗口里
      // 被扫走，导致入库成功但文件已不存在。utimes 失败不影响上传。
      const now = new Date();
      await fsp.utimes(absPath, now, now).catch(() => undefined);
    } else {
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      const tmpFile = path.join(this.tmpDir, `upload-${randomToken(8)}`);
      try {
        await write(tmpFile);
        // fsync 后再 rename，确保崩溃时不会留下内容不完整的对象文件
        const handle = await fsp.open(tmpFile, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (err) {
        await fsp.rm(tmpFile, { force: true }).catch(() => undefined);
        throw err;
      }
      await fsp.rename(tmpFile, absPath);
    }

    return { ...digests, size, key, path: absPath };
  }

  /** 保存清单/报告等元数据文件，返回相对 key */
  async putMeta(prefix: string, content: Buffer | string): Promise<string> {
    this.disk.assertWritable();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const key = `meta/${prefix}-${sha256Hex(buf).slice(0, 16)}.json`;
    const absPath = path.join(getConfig().dataDir, key);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, buf);
    return key;
  }

  async readMeta(key: string): Promise<Buffer> {
    return fsp.readFile(path.join(getConfig().dataDir, key));
  }

  async saveBatchFile(batchId: string, filename: string, buf: Buffer): Promise<string> {
    this.disk.assertWritable();
    const relative = this.batchRelative(batchId, filename);
    const absPath = path.join(getConfig().dataDir, relative);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, buf);
    return relative;
  }

  /** 由磁盘临时文件保存批次包，流式复制，避免把整包读进内存 */
  async saveBatchFileFromPath(batchId: string, filename: string, srcPath: string): Promise<string> {
    this.disk.assertWritable();
    const relative = this.batchRelative(batchId, filename);
    const absPath = path.join(getConfig().dataDir, relative);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.copyFile(srcPath, absPath);
    return relative;
  }

  private batchRelative(batchId: string, filename: string): string {
    const safe = path.basename(filename).replace(/[^\w.@+-]/g, '_');
    return path.join('batches', batchId, 'files', safe);
  }

  absolutePath(relativeKey: string): string {
    const base = path.resolve(getConfig().dataDir);
    const abs = path.resolve(base, relativeKey);
    // 按路径段判定越界，不用字符串前缀：兄弟目录同名前缀（data / data-evil）会骗过 startsWith。
    // rel === '' 表示 relativeKey 指向根目录本身，保持原有放行行为。
    const rel = path.relative(base, abs);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error('非法存储路径');
    }
    return abs;
  }

  async readObject(sha256: string): Promise<Buffer> {
    return fsp.readFile(path.join(this.objectDir, sha256.slice(0, 2), sha256));
  }

  /**
   * 硬删除内容寻址对象；返回是否真的删掉了一个文件。
   * 内容按 sha256 去重，同一对象可能被多个版本引用，调用方必须先确认无人引用。
   */
  async deleteObject(sha256: string): Promise<boolean> {
    const absPath = path.join(this.objectDir, sha256.slice(0, 2), sha256);
    try {
      await fsp.unlink(absPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  existsSync(absPath: string): boolean {
    return fs.existsSync(absPath);
  }
}

/** 流式哈希：大文件入库时避免一次性读入内存 */
async function streamDigests(
  filePath: string,
): Promise<{ sha256: string; shasum: string; integrity: string }> {
  const h256 = createHash('sha256');
  const h1 = createHash('sha1');
  const h512 = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) {
    const buf = chunk as Buffer;
    h256.update(buf);
    h1.update(buf);
    h512.update(buf);
  }
  return {
    sha256: h256.digest('hex'),
    shasum: h1.digest('hex'),
    integrity: `sha512-${h512.digest('base64')}`,
  };
}

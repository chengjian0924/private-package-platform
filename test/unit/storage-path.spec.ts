import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StorageService } from '../../src/storage/storage.service';
import { DiskGuardService } from '../../src/common/disk-guard.service';
import { resetConfigCache } from '../../src/config/config';

/** 内容寻址存储：相对 key 防穿越、批次文件名清洗、去重与硬删除 */
describe('存储路径与对象读写（单元）', () => {
  let dir: string;
  let storage: StorageService;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    originalDataDir = process.env.DATA_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanjian-storage-unit-'));
    process.env.DATA_DIR = dir;
    resetConfigCache();
    storage = new StorageService({ assertWritable: () => undefined } as DiskGuardService);
    await storage.onModuleInit();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    resetConfigCache();
  });

  describe('absolutePath 合法路径', () => {
    it('解析普通相对 key 到 DATA_DIR 内', () => {
      expect(storage.absolutePath('objects/ab/abcdef')).toBe(path.resolve(dir, 'objects/ab/abcdef'));
      expect(storage.absolutePath('meta/report-1.json')).toBe(path.resolve(dir, 'meta/report-1.json'));
    });

    it('空 key 与 . 指向根目录本身，保持原有放行行为', () => {
      expect(storage.absolutePath('')).toBe(path.resolve(dir));
      expect(storage.absolutePath('.')).toBe(path.resolve(dir));
    });

    it('带前导 ./ 与深层嵌套 key 正常解析', () => {
      expect(storage.absolutePath('./objects/aa/bb/cc')).toBe(path.resolve(dir, 'objects/aa/bb/cc'));
      expect(storage.absolutePath('objects/aa/../aa/bb')).toBe(path.resolve(dir, 'objects/aa/bb'));
    });
  });

  describe('absolutePath 非法输入（F-01 回归）', () => {
    it('拒绝 ../ 穿越到 DATA_DIR 父级', () => {
      expect(() => storage.absolutePath('../outside-secret')).toThrow('非法存储路径');
      expect(() => storage.absolutePath('objects/../../escape')).toThrow('非法存储路径');
    });

    it('F-01 回归：拒绝与 DATA_DIR 同前缀的兄弟目录（startsWith 前缀混淆）', () => {
      const sibling = `../${path.basename(dir)}-evil/secret.txt`;
      expect(() => storage.absolutePath(sibling)).toThrow('非法存储路径');
      expect(() => storage.absolutePath(`../../${path.basename(dir)}-x/inner`)).toThrow('非法存储路径');
    });

    it('F-01 回归：拒绝恰好等于前缀的字符串兄弟目录', () => {
      // 形如 /tmp/base 与 /tmp/base2，旧实现 abs.startsWith(base) 会误放行 base2
      const sibling = `../${path.basename(dir)}2/secret.txt`;
      expect(() => storage.absolutePath(sibling)).toThrow('非法存储路径');
    });

    it('拒绝绝对路径输入', () => {
      expect(() => storage.absolutePath('/etc/passwd')).toThrow('非法存储路径');
      expect(() => storage.absolutePath(path.join(dir, '..', 'outside'))).toThrow('非法存储路径');
    });

    it('拒绝穿出后多层再绕回的复杂路径', () => {
      expect(() => storage.absolutePath('a/../../../etc')).toThrow('非法存储路径');
      expect(() => storage.absolutePath('objects/aa/../../../../escape')).toThrow('非法存储路径');
    });

    it('拒绝以 .. 开头但指向同级同名前缀目录的伪装 key', () => {
      // 校验基于解析后的真实路径段，而非字符串是否含 ..
      expect(() => storage.absolutePath('../')).toThrow('非法存储路径');
      expect(() => storage.absolutePath('../..')).toThrow('非法存储路径');
    });
  });

  describe('putObject 内容寻址', () => {
    it('按 sha256 前两位分目录，内容相同只存一份', async () => {
      const buf = Buffer.from('deterministic-content');
      const first = await storage.putObject(buf);
      const second = await storage.putObject(Buffer.from('deterministic-content'));
      expect(first.key).toBe(`objects/${first.sha256.slice(0, 2)}/${first.sha256}`);
      expect(second.key).toBe(first.key);
      expect(fs.existsSync(path.join(dir, first.key))).toBe(true);
      expect(await storage.readObject(first.sha256)).toEqual(buf);
    });

    it('空 Buffer 也能入库，产出合法摘要与 key', async () => {
      const obj = await storage.putObject(Buffer.alloc(0));
      expect(obj.size).toBe(0);
      expect(obj.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(obj.key).toBe(`objects/${obj.sha256.slice(0, 2)}/${obj.sha256}`);
      expect(await storage.readObject(obj.sha256)).toEqual(Buffer.alloc(0));
    });

    it('较大的写入内容完整回读（流式分界之外的常规上限）', async () => {
      const buf = Buffer.alloc(128 * 1024, 0xab);
      const obj = await storage.putObject(buf);
      expect(obj.size).toBe(buf.length);
      expect(await storage.readObject(obj.sha256)).toEqual(buf);
    });

    it('putMeta 对字符串与 Buffer 内容产出稳定 key 并可回读', async () => {
      const key1 = await storage.putMeta('report', 'hello');
      const key2 = await storage.putMeta('report', Buffer.from('hello'));
      expect(key1).toMatch(/^meta\/report-[0-9a-f]{16}\.json$/);
      expect(key1).toBe(key2);
      expect((await storage.readMeta(key1)).toString()).toBe('hello');
    });
  });

  describe('deleteObject', () => {
    it('删除存在对象返回 true，重复删除返回 false', async () => {
      const obj = await storage.putObject(Buffer.from('to-be-deleted'));
      expect(await storage.deleteObject(obj.sha256)).toBe(true);
      expect(await storage.deleteObject(obj.sha256)).toBe(false);
    });

    it('删除不存在的 sha256 返回 false 不抛错', async () => {
      expect(await storage.deleteObject('f'.repeat(64))).toBe(false);
    });
  });

  describe('saveBatchFile 文件名清洗', () => {
    it('剥离路径与危险字符', async () => {
      const rel = await storage.saveBatchFile('batch-1', '../../evil<script>|name.txt', Buffer.from('x'));
      expect(rel).toBe(path.join('batches', 'batch-1', 'files', 'evil_script__name.txt'));
      expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    });

    it('保留安全字符（点、@、+、-、下划线）', async () => {
      const rel = await storage.saveBatchFile('b2', 'lodash-4.17.21@beta+build_1.tgz', Buffer.from('x'));
      expect(rel).toBe(path.join('batches', 'b2', 'files', 'lodash-4.17.21@beta+build_1.tgz'));
    });

    it('绝对路径文件名只取 basename，无法越出批次目录', async () => {
      const rel = await storage.saveBatchFile('b3', '/etc/passwd', Buffer.from('x'));
      expect(rel).toBe(path.join('batches', 'b3', 'files', 'passwd'));
      expect(path.resolve(dir, rel).startsWith(path.resolve(dir, 'batches', 'b3'))).toBe(true);
    });

    it('空文件名得到安全占位（basename 为空时不抛出目录创建错误）', async () => {
      const rel = await storage.saveBatchFile('b4', '', Buffer.from('x'));
      expect(rel).toBe(path.join('batches', 'b4', 'files', ''));
      expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    });
  });
});

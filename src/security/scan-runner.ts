import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SecurityConfig } from '../config/config';
import { runStaticScan } from './rules';
import type { DependencyRef, SecurityFinding, SignatureStatus } from './types';

/**
 * 扫描调度（A-03）：生产走 worker_threads，把 CPU 密集解析移出主线程，
 * 避免大包扫描阻塞事件循环导致健康检查超时被判死。
 * ts-jest 直接跑源码时没有编译产物，自动回退为主线程执行，保证测试不经构建也能跑。
 */

export interface ScanInputForWorker {
  ecosystem: 'npm' | 'pypi';
  filename: string;
  sha256: string;
  buffer: Buffer;
}

export interface ScanResultSubset {
  findings: SecurityFinding[];
  metadata: Record<string, unknown>;
  signature: SignatureStatus;
  dependencies: DependencyRef[];
  /** 是否在独立线程执行，用于日志与排障 */
  offThread: boolean;
}

interface WorkerMessage {
  ok: boolean;
  findings?: SecurityFinding[];
  metadata?: Record<string, unknown>;
  signature?: SignatureStatus;
  dependencies?: DependencyRef[];
  error?: string;
}

function resolveWorkerPath(): string | null {
  // __dirname 在 dist/security 下指向编译产物；不存在说明是 ts-jest 运行源码
  const candidate = path.join(__dirname, 'scan.worker.js');
  return fs.existsSync(candidate) ? candidate : null;
}

async function runInline(
  input: ScanInputForWorker,
  cfg: SecurityConfig,
  signature?: string,
): Promise<ScanResultSubset> {
  const result = await runStaticScan(input, cfg, signature);
  return {
    findings: result.findings,
    metadata: result.metadata,
    signature: result.signature,
    dependencies: result.archive.dependencies,
    offThread: false,
  };
}

export async function runScan(
  input: ScanInputForWorker,
  cfg: SecurityConfig,
  signature?: string,
): Promise<ScanResultSubset> {
  const workerPath = resolveWorkerPath();
  if (!workerPath) return runInline(input, cfg, signature);

  // 只有独占的 ArrayBuffer 才能安全转移；否则转移会连带 detach 整个缓冲池
  const canTransfer =
    input.buffer.byteLength > 0 &&
    input.buffer.byteOffset === 0 &&
    input.buffer.byteLength === input.buffer.buffer.byteLength &&
    !(input.buffer.buffer as { shared?: boolean }).shared;

  return new Promise<ScanResultSubset>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        ecosystem: input.ecosystem,
        filename: input.filename,
        sha256: input.sha256,
        buffer: input.buffer,
        cfg,
        signature,
      },
      transferList: canTransfer ? [input.buffer.buffer as ArrayBuffer] : [],
      // 给扫描线程单独设堆上限：畸形包即使解析爆炸，也只打挂 worker，不拖垮主进程
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });

    // 与主线程 withTimeout 同源的兜底：超时直接终止线程，避免 CPU 一直空转
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`扫描线程超时（>${cfg.scanTimeoutMs}ms）`));
    }, cfg.scanTimeoutMs);
    timer.unref();

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    worker.once('message', (message: WorkerMessage) => {
      if (!message.ok) {
        finish(() => reject(new Error(message.error || '扫描线程执行失败')));
        return;
      }
      finish(() =>
        resolve({
          findings: message.findings ?? [],
          metadata: message.metadata ?? {},
          signature: message.signature ?? 'unsigned',
          dependencies: message.dependencies ?? [],
          offThread: true,
        }),
      );
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`扫描线程异常退出（code=${code}）`)));
    });
  });
}

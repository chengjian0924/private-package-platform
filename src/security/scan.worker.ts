import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import type { SecurityConfig } from '../config/config';
import { runStaticScan } from './rules';
import type { DependencyRef, SecurityFinding, SignatureStatus } from './types';

/**
 * 扫描工作线程（A-03）：只做 CPU 密集的静态扫描，不触碰数据库。
 * 返回结果刻意裁剪：archive.entries 里带正文（单文件最大 256KB），整包回传会把内存翻倍。
 */

interface WorkerPayload {
  ecosystem: 'npm' | 'pypi';
  filename: string;
  sha256: string;
  buffer: Uint8Array;
  cfg: SecurityConfig;
  signature?: string;
}

interface WorkerResult {
  ok: true;
  findings: SecurityFinding[];
  metadata: Record<string, unknown>;
  signature: SignatureStatus;
  dependencies: DependencyRef[];
}

async function main(): Promise<void> {
  const payload = workerData as WorkerPayload;
  // transferList 转移过来的是 ArrayBuffer 视图，重新包成 Buffer 才能复用原有解析逻辑
  const buffer = Buffer.from(payload.buffer.buffer, payload.buffer.byteOffset, payload.buffer.byteLength);
  const result = await runStaticScan(
    {
      ecosystem: payload.ecosystem,
      filename: payload.filename,
      sha256: payload.sha256,
      buffer,
    },
    payload.cfg,
    payload.signature,
  );
  const message: WorkerResult = {
    ok: true,
    findings: result.findings,
    metadata: result.metadata,
    signature: result.signature,
    dependencies: result.archive.dependencies,
  };
  parentPort?.postMessage(message);
}

main().catch((err) => {
  parentPort?.postMessage({ ok: false, error: (err as Error)?.message || String(err) });
});

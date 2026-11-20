#!/usr/bin/env node
/**
 * 回填已入库 npm 包的安装元数据（含 dsh 组合包声明）。
 *
 * 背景：源鉴早期入库只保存 description/engines/dependencies/dist，
 * 丢掉了 package.json 里的 dsh、peerDependencies、os、cpu、bin 等字段，
 * 导致 DeepSeek Harness 认为包「没有声明组合包」，也会影响 npm 的依赖解析。
 * 本脚本从对象存储中的 tarball 重新读取白名单字段并合并回
 * package_versions.metadata，无需重新导入包。
 *
 * 用法（在服务停止或维护窗口执行）：
 *   node scripts/backfill-npm-dsh.mjs --data-dir /var/lib/yuanjian/data
 *   node scripts/backfill-npm-dsh.mjs --data-dir ./data/dev --dry-run
 *   node scripts/backfill-npm-dsh.mjs --data-dir ./data/dev --force
 *
 * --dry-run 只统计不写库；--force 用 tarball 的值覆盖已有白名单字段。
 * 脚本名沿用 dsh 时期的名字，实际回填 src/packages/npm-metadata.ts 的整套白名单。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pickNpmMetadata } from '../dist/packages/npm-metadata.js';
import { readNpmPackageManifest } from '../dist/packages/package-validator.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');

function option(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const dataDir = path.resolve(option('--data-dir', process.env.DATA_DIR || './data/dev'));
const dbFile = path.join(dataDir, 'platform.db');

async function main() {
  try {
    await fs.access(dbFile);
  } catch {
    throw new Error(`数据库不存在：${dbFile}（检查 --data-dir 或 DATA_DIR）`);
  }

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000');
  const rows = db
    .prepare(
      `SELECT v.id, v.storage_key, v.metadata, p.display_name
         FROM package_versions v
         JOIN packages p ON p.id = v.package_id
        WHERE p.ecosystem = 'npm' AND v.status = 'active'`,
    )
    .all();

  let updated = 0;
  let unchanged = 0;
  let withDsh = 0;
  let missingFile = 0;
  let failed = 0;

  for (const row of rows) {
    let meta = {};
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      meta = {};
    }

    const file = path.resolve(dataDir, row.storage_key);
    const relative = path.relative(dataDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      failed += 1;
      console.error(`跳过非法存储路径：${row.storage_key}`);
      continue;
    }

    let manifest;
    try {
      const buffer = await fs.readFile(file);
      manifest = await readNpmPackageManifest(buffer);
    } catch (err) {
      missingFile += 1;
      console.error(`读取失败 ${row.display_name}: ${err.message}`);
      continue;
    }

    const picked = pickNpmMetadata(manifest);
    if (picked.dsh) withDsh += 1;
    const missing = Object.keys(picked).filter((key) => meta[key] === undefined);
    if (!force && missing.length === 0) {
      unchanged += 1;
      continue;
    }

    try {
      if (!dryRun) {
        // 保留已有 metadata 与 dist 等计算字段，只补齐/覆盖白名单字段
        const next = { ...meta, ...picked };
        db.prepare('UPDATE package_versions SET metadata = ? WHERE id = ?').run(JSON.stringify(next), row.id);
      }
      updated += 1;
    } catch (err) {
      failed += 1;
      console.error(`写库失败 ${row.display_name}: ${err.message}`);
    }
  }

  db.close();
  console.log(
    JSON.stringify(
      { total: rows.length, updated, unchanged, withDsh, missingFile, failed, dryRun, dataDir },
      null,
      2,
    ),
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(2);
});

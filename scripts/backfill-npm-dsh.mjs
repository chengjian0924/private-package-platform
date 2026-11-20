#!/usr/bin/env node
/**
 * 回填已入库 npm 包的 dsh 组合包声明。
 *
 * 背景：源鉴早期入库只保存 description/engines/dependencies/dist，
 * 丢掉了原包 package.json 里的 dsh 字段，导致 DeepSeek Harness 通过
 * packument 判断时认为「没有声明组合包」。本脚本从对象存储中的 tarball
 * 重新读取 dsh 字段并写回 package_versions.metadata，无需重新导入包。
 *
 * 用法（在服务停止或维护窗口执行）：
 *   node scripts/backfill-npm-dsh.mjs --data-dir /var/lib/yuanjian/data
 *   node scripts/backfill-npm-dsh.mjs --data-dir ./data/dev --dry-run
 *   node scripts/backfill-npm-dsh.mjs --data-dir ./data/dev --force
 *
 * --dry-run 只统计不写库；--force 连已有 dsh 字段的版本也用 tarball 覆盖。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  let already = 0;
  let noDeclaration = 0;
  let missingFile = 0;
  let failed = 0;

  for (const row of rows) {
    let meta = {};
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      meta = {};
    }
    if (!force && meta.dsh !== undefined) {
      already += 1;
      continue;
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
    if (!manifest.dsh) {
      noDeclaration += 1;
      continue;
    }

    try {
      if (!dryRun) {
        const next = { ...meta, dsh: manifest.dsh };
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
      { total: rows.length, updated, already, noDeclaration, missingFile, failed, dryRun, dataDir },
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

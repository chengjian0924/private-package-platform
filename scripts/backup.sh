#!/usr/bin/env bash
# 在线一致性备份：SQLite 走 .backup（Backup API），对象/元数据按目录快照。
# 用法: DATA_DIR=./data/prod BACKUP_ROOT=./backups ./scripts/backup.sh [--prune]
set -euo pipefail

DATA_DIR="${DATA_DIR:-./data/prod}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

PRUNE=0
if [[ "${1:-}" == "--prune" ]]; then
  PRUNE=1
fi

DB="$DATA_DIR/platform.db"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

command -v sqlite3 >/dev/null 2>&1 || {
  echo "缺少 sqlite3 CLI：请先在目标机安装 sqlite3（在线备份依赖其 .backup 命令）" >&2
  exit 2
}
[[ -f "$DB" ]] || {
  echo "未找到数据库文件: ${DB}（请确认 DATA_DIR 指向运行中的数据目录）" >&2
  exit 2
}

TS="$(date +%Y%m%dT%H%M%S)"
WORK="$BACKUP_ROOT/.work-$TS"
ARCHIVE="$BACKUP_ROOT/yuanjian-$TS.tar.gz"

mkdir -p "$BACKUP_ROOT" "$WORK"
trap 'rm -rf "$WORK"' EXIT

# 1) 一致性快照：直接 cp platform.db 会拷到 WAL 未合并的状态，恢复后可能丢事务或损坏
sqlite3 "$DB" ".timeout 5000" ".backup '$WORK/platform.db'"

# 备份库从源继承了 WAL 标记，切回 DELETE 并清掉旁路文件，保证归档内是单个自包含库
sqlite3 "$WORK/platform.db" 'PRAGMA journal_mode=DELETE;' >/dev/null
rm -f "$WORK/platform.db-wal" "$WORK/platform.db-shm"

INTEGRITY="$(sqlite3 "$WORK/platform.db" 'PRAGMA integrity_check;')"
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "备份库完整性校验失败: $INTEGRITY" >&2
  exit 3
fi

# 2) 对象与元数据：内容寻址且不可变，全量复制即可；隔离区含恶意样本，不纳入常规备份
# 用 cp -a 而非 rsync：镜像基于 bookworm-slim 未装 rsync，cp -a 属于 coreutils 已内置，
# 同样保留权限/时间戳/符号链接，且这里 WORK 是新建空目录，没有增量复制需求。
for dir in objects meta batches; do
  if [[ -d "$DATA_DIR/$dir" ]]; then
    mkdir -p "$WORK/$dir"
    cp -a "$DATA_DIR/$dir/." "$WORK/$dir/"
  fi
done

# 3) 清单：恢复前据此核对来源、完整性与规模
{
  echo "created_at=$TS"
  echo "data_dir=$(cd "$DATA_DIR" && pwd)"
  echo "db_sha256=$(sha256 "$WORK/platform.db")"
  echo "db_integrity=$INTEGRITY"
  echo "objects=$(find "$WORK/objects" -type f 2>/dev/null | wc -l | tr -d ' ')"
  echo "versions=$(sqlite3 "$WORK/platform.db" 'SELECT COUNT(*) FROM package_versions;' 2>/dev/null || echo 0)"
  echo "quarantine=excluded"
} >"$WORK/MANIFEST.txt"

tar -czf "$ARCHIVE" -C "$WORK" .
sha256 "$ARCHIVE" >"$ARCHIVE.sha256"

if [[ $PRUNE -eq 1 ]]; then
  find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'yuanjian-*.tar.gz' -o -name 'yuanjian-*.tar.gz.sha256' \) \
    -mtime +"$RETAIN_DAYS" -print -delete
fi

echo "备份完成: $ARCHIVE"
echo "校验和: $(cut -d' ' -f1 "$ARCHIVE.sha256")"
echo "清单: created_at=$TS versions=$(sqlite3 "$WORK/platform.db" 'SELECT COUNT(*) FROM package_versions;' 2>/dev/null || echo 0)"

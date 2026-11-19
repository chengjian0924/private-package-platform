#!/usr/bin/env bash
# 从备份归档恢复：先校验校验和与库完整性，再替换数据目录。
# 用法: ./scripts/restore.sh <yuanjian-时间戳.tar.gz> <目标 DATA_DIR> [--force]
# 说明: 目标目录非空时必须加 --force；旧目录会被改名保留，脚本不做删除。
set -euo pipefail

ARCHIVE="${1:-}"
TARGET="${2:-}"
FORCE=0
if [[ "${3:-}" == "--force" ]]; then
  FORCE=1
fi

if [[ -z "$ARCHIVE" || -z "$TARGET" ]]; then
  echo "用法: $0 <yuanjian-时间戳.tar.gz> <目标 DATA_DIR> [--force]" >&2
  exit 2
fi
[[ -f "$ARCHIVE" ]] || {
  echo "归档不存在: $ARCHIVE" >&2
  exit 2
}
[[ -f "$ARCHIVE.sha256" ]] || {
  echo "缺少校验和文件: $ARCHIVE.sha256（无法确认归档完整性，拒绝恢复）" >&2
  exit 2
}
command -v sqlite3 >/dev/null 2>&1 || {
  echo "缺少 sqlite3 CLI，无法执行完整性校验" >&2
  exit 2
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

EXPECTED="$(awk '{print $1}' "$ARCHIVE.sha256")"
ACTUAL="$(sha256 "$ARCHIVE")"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "校验和不匹配，归档可能损坏或被篡改：expected=$EXPECTED actual=$ACTUAL" >&2
  exit 3
fi

TS="$(date +%Y%m%dT%H%M%S)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/yuanjian-restore-$TS.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

tar -xzf "$ARCHIVE" -C "$WORK"
[[ -f "$WORK/platform.db" ]] || {
  echo "归档内缺少 platform.db，不是有效的平台备份" >&2
  exit 3
}

INTEGRITY="$(sqlite3 "$WORK/platform.db" 'PRAGMA integrity_check;')"
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "备份库完整性校验失败: ${INTEGRITY}，拒绝恢复" >&2
  exit 3
fi

# 非空目标默认拒绝，避免误覆盖生产数据；旧数据只改名不删除
PRESERVED=""
if [[ -d "$TARGET" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  if [[ $FORCE -ne 1 ]]; then
    echo "目标目录非空: ${TARGET}；确认覆盖请加 --force（旧目录将改名为 ${TARGET}.pre-restore-${TS}）" >&2
    exit 4
  fi
  PRESERVED="$TARGET.pre-restore-$TS"
  mv "$TARGET" "$PRESERVED"
  echo "旧数据已保留至: $PRESERVED"
fi

mkdir -p "$TARGET"
mv "$WORK/platform.db" "$TARGET/platform.db"
for dir in objects meta batches; do
  if [[ -d "$WORK/$dir" ]]; then
    mkdir -p "$TARGET/$dir"
    cp -a "$WORK/$dir/." "$TARGET/$dir/"
  fi
done
mkdir -p "$TARGET/tmp" "$TARGET/quarantine"
# 隔离区可能含恶意样本，恢复后限制为仅属主可访问
chmod 700 "$TARGET/quarantine" 2>/dev/null || true

cat "$WORK/MANIFEST.txt" 2>/dev/null || true

cat <<EOF

恢复完成: $TARGET
后续步骤:
  1) 用目标环境的 .env.production 启动服务（MOCK_IDP_ENABLED=false）
  2) curl -s http://127.0.0.1:<PORT>/api/v1/health 确认 status=ok 且 packages 数量与清单一致
  3) 随机抽一个包执行下载，校验响应头 X-Package-Security 与文件大小
EOF

if [[ -n "$PRESERVED" ]]; then
  echo "  4) 验收通过后再清理保留目录（当前未删除）: $PRESERVED"
else
  echo "  4) 验收通过后再将该数据目录纳入常规备份"
fi

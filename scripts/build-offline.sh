#!/usr/bin/env bash
# 离线交付构建（在可联网的构建机执行）。
# 产物：应用源码包 + npm 离线缓存包（可审计/可复现）+ 预装 node_modules 兜底包。
# 用法: ./scripts/build-offline.sh   （OUT=./dist-offline 可覆盖输出目录）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="${OUT:-$ROOT/dist-offline}"
CACHE="$OUT/npm-cache"
STAGE="$OUT/.stage-$(date +%Y%m%dT%H%M%S)"
VERSION="$(node -p "require('./package.json').version")"
STAMP="$(date +%Y%m%d)"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

for bin in node npm rsync tar; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "缺少命令: ${bin}" >&2
    exit 2
  }
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 5 ) ]]; then
  echo "构建机 Node 版本过低（当前 $(node -v)），要求 ≥ 22.5" >&2
  exit 2
fi

mkdir -p "$CACHE" "$STAGE"

echo "==> 1/4 安装依赖并填充离线缓存（独立 cache，不影响本机环境）"
npm ci --cache "$CACHE" --no-audit --no-fund
npm cache verify --cache "$CACHE" >/dev/null 2>&1 || true

echo "==> 2/4 类型检查与构建"
npm run typecheck
npm run build

echo "==> 3/4 打包应用源码"
rsync -a \
  --exclude node_modules --exclude data --exclude dist --exclude dist-offline \
  --exclude backups --exclude .git \
  "$ROOT/" "$STAGE/app/"
tar -czf "$STAGE/yuanjian-app-${VERSION}-${STAMP}.tar.gz" -C "$STAGE/app" .

echo "==> 4/4 打包离线缓存与预装依赖"
tar -czf "$STAGE/yuanjian-npm-cache-${VERSION}-${STAMP}.tar.gz" -C "$CACHE" .
tar -czf "$STAGE/yuanjian-node_modules-${VERSION}-${STAMP}.tar.gz" -C "$ROOT" node_modules

{
  echo "version=${VERSION}"
  echo "built_at=${STAMP}"
  echo "node=$(node -v)"
  echo "npm=$(npm -v)"
  echo "note=目标机 npm 主版本需与构建机一致，否则离线缓存可能不兼容"
} >"$STAGE/MANIFEST.txt"

for file in "$STAGE"/*.tar.gz; do
  sha256 "$file" >"$file.sha256"
done

# 以 "<hash>  <filename>" 形式汇总，目标机可直接用 sha256sum/shasum -c 校验
( cd "$STAGE" && for file in *.tar.gz; do sha256 "$file" | awk -v f="$file" '{print $1"  "f}'; done ) \
  >"$STAGE/MANIFEST.sha256"

mv "$STAGE"/* "$OUT"/
rmdir "$STAGE"

echo
echo "离线交付产物: $OUT"
for file in "$OUT"/*.tar.gz; do
  echo "  $(basename "$file")  $(du -h "$file" | awk '{print $1}')"
done
echo
echo "下一步: 将上述文件拷贝到目标机，执行"
echo "  ./scripts/install-offline.sh <交付目录> <安装根目录>"

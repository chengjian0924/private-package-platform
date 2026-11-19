#!/usr/bin/env bash
# 离线安装（在内网目标机执行）：校验产物 → 解包 → 从本地缓存安装依赖 → 构建。
# 用法: ./scripts/install-offline.sh <交付目录> <安装根目录> [--force] [--with-test] [--fallback-node-modules]
# 目录约定: <安装根目录>/app 为应用目录，<安装根目录>/npm-cache 为离线缓存。
set -euo pipefail

ARTIFACT_DIR="${1:-}"
INSTALL_ROOT="${2:-}"
FORCE=0
WITH_TEST=0
FALLBACK=0
for arg in "${@:3}"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --with-test) WITH_TEST=1 ;;
    --fallback-node-modules) FALLBACK=1 ;;
    *)
      echo "未知参数: ${arg}" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ARTIFACT_DIR" || -z "$INSTALL_ROOT" ]]; then
  echo "用法: $0 <交付目录> <安装根目录> [--force] [--with-test] [--fallback-node-modules]" >&2
  exit 2
fi
[[ -d "$ARTIFACT_DIR" ]] || {
  echo "交付目录不存在: ${ARTIFACT_DIR}" >&2
  exit 2
}
[[ -f "$ARTIFACT_DIR/MANIFEST.sha256" ]] || {
  echo "缺少 MANIFEST.sha256，无法确认产物完整性，拒绝安装" >&2
  exit 2
}

for bin in node npm tar; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "缺少命令: ${bin}（目标机需预装 Node.js ≥22.5 与 npm）" >&2
    exit 2
  }
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 5 ) ]]; then
  echo "Node 版本过低（当前 $(node -v)），要求 ≥ 22.5" >&2
  exit 2
fi

echo "==> 1/5 校验产物完整性"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$ARTIFACT_DIR" && sha256sum -c MANIFEST.sha256 )
else
  ( cd "$ARTIFACT_DIR" && shasum -a 256 -c MANIFEST.sha256 )
fi

APP_ARCHIVE="$(ls "$ARTIFACT_DIR"/yuanjian-app-*.tar.gz 2>/dev/null | head -1 || true)"
CACHE_ARCHIVE="$(ls "$ARTIFACT_DIR"/yuanjian-npm-cache-*.tar.gz 2>/dev/null | head -1 || true)"
MODULES_ARCHIVE="$(ls "$ARTIFACT_DIR"/yuanjian-node_modules-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "$APP_ARCHIVE" ]] || {
  echo "交付目录内缺少 yuanjian-app-*.tar.gz" >&2
  exit 2
}

echo "==> 2/5 准备目录"
APP_DIR="$INSTALL_ROOT/app"
CACHE_DIR="$INSTALL_ROOT/npm-cache"
if [[ -d "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  if [[ $FORCE -ne 1 ]]; then
    echo "应用目录非空: ${APP_DIR}；确认覆盖请加 --force（旧目录将改名保留）" >&2
    exit 4
  fi
  PRESERVED="$APP_DIR.pre-install-$(date +%Y%m%dT%H%M%S)"
  mv "$APP_DIR" "$PRESERVED"
  echo "旧应用目录已保留至: ${PRESERVED}"
fi
mkdir -p "$INSTALL_ROOT" "$APP_DIR" "$CACHE_DIR"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/yuanjian-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "==> 3/5 解包应用与离线缓存"
tar -xzf "$APP_ARCHIVE" -C "$APP_DIR"
if [[ -n "$CACHE_ARCHIVE" ]]; then
  tar -xzf "$CACHE_ARCHIVE" -C "$CACHE_DIR"
fi

echo "==> 4/5 安装依赖（优先离线缓存）"
INSTALLED=0
if [[ -n "$CACHE_ARCHIVE" ]]; then
  if ( cd "$APP_DIR" && npm ci --offline --cache "$CACHE_DIR" --ignore-scripts --no-audit --no-fund ); then
    INSTALLED=1
  else
    echo "离线缓存安装失败（常见原因：npm 主版本与构建机不一致、缓存缺包）" >&2
  fi
fi

if [[ $INSTALLED -eq 0 ]]; then
  if [[ -n "$MODULES_ARCHIVE" ]]; then
    if [[ $FALLBACK -ne 1 ]]; then
      echo "检测到预装依赖包但未指定 --fallback-node-modules，拒绝静默回退" >&2
      exit 5
    fi
    echo "回退到预装 node_modules"
    tar -xzf "$MODULES_ARCHIVE" -C "$APP_DIR"
    INSTALLED=1
  else
    echo "无可用依赖来源：既无法从缓存安装，也没有预装依赖包" >&2
    exit 5
  fi
fi

echo "==> 5/5 构建与验证"
( cd "$APP_DIR" && npm run build )
if [[ $WITH_TEST -eq 1 ]]; then
  ( cd "$APP_DIR" && npm test )
fi

cat <<EOF

安装完成: ${APP_DIR}
后续步骤:
  1) 复制并修改生产配置（MOCK_IDP_ENABLED=false，PUBLIC_BASE_URL 为 https 网关地址）
  2) 启动: node --env-file=.env.production dist/main.js
  3) 验证: curl -s http://127.0.0.1:<PORT>/api/v1/health
EOF

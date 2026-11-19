#!/usr/bin/env bash
# 双架构容器镜像统一入口。
# 用法: ./scripts/docker-build.sh <arm64|amd64> <build|up|save|inspect> [额外参数]
#
# 架构目录: docker/arm64/ 与 docker/amd64/，各自含 Dockerfile + docker-compose.yml。
# 镜像 tag 带架构后缀（yuanjian:arm64 / yuanjian:amd64），可在同一台机器共存不冲突。
# 构建上下文固定为项目根目录（Dockerfile 的 COPY 路径相对根目录）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ARCH="${1:-}"
ACTION="${2:-}"
shift 2 2>/dev/null || true

usage() {
  cat <<'EOF'
用法: ./scripts/docker-build.sh <arm64|amd64> <动作> [参数]

架构:
  arm64   aarch64 目标机（docker/arm64/）
  amd64   x86_64  目标机（docker/amd64/）

动作:
  build    构建镜像（可追加 docker build 参数，如 --no-cache）
  up       docker compose up -d --build（可追加 compose 参数，如 --profile gateway）
  down     停止并删除容器与网络，保留数据卷
  save     导出镜像为 tar.gz 到 dist-offline/images/
  inspect  打印镜像架构，确认与所选架构一致

示例:
  ./scripts/docker-build.sh arm64 build --no-cache
  ./scripts/docker-build.sh amd64 up
  ./scripts/docker-build.sh amd64 save
EOF
}

case "$ARCH" in
  arm64) PLATFORM="linux/arm64"; TAG="yuanjian:arm64" ;;
  amd64) PLATFORM="linux/amd64"; TAG="yuanjian:amd64" ;;
  *) echo "未知架构: ${ARCH:-<空>}" >&2; usage >&2; exit 2 ;;
esac

DOCKERFILE="docker/${ARCH}/Dockerfile"
COMPOSE="docker/${ARCH}/docker-compose.yml"
[[ -f "$ROOT/$DOCKERFILE" ]] || { echo "缺少 $DOCKERFILE" >&2; exit 2; }
[[ -f "$ROOT/$COMPOSE" ]] || { echo "缺少 $COMPOSE" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "未找到 docker 命令" >&2; exit 2; }

case "$ACTION" in
  build)
    echo "==> 构建 $PLATFORM 镜像 $TAG（上下文: $ROOT）"
    DOCKER_BUILDKIT=0 docker build --platform "$PLATFORM" -f "$DOCKERFILE" -t "$TAG" "$ROOT" "$@"
    ;;
  up)
    echo "==> 启动 $PLATFORM 编排（compose: $COMPOSE）"
    docker compose -f "$COMPOSE" up -d --build "$@"
    ;;
  down)
    echo "==> 停止 $PLATFORM 编排（保留数据卷）"
    docker compose -f "$COMPOSE" down "$@"
    ;;
  save)
    OUT="$ROOT/dist-offline/images"
    mkdir -p "$OUT"
    FILE="$OUT/yuanjian-${ARCH}.tar"
    echo "==> 导出 $TAG 到 $FILE"
    docker save "$TAG" -o "$FILE"
    gzip -f "$FILE"
    echo "完成: ${FILE}.gz"
    ;;
  inspect)
    echo "==> $TAG 架构:"
    docker image inspect "$TAG" --format 'ID={{.Id}} OS={{.Os}} Arch={{.Architecture}}' 2>&1
    ;;
  *)
    echo "未知动作: ${ACTION:-<空>}" >&2
    usage >&2
    exit 2
    ;;
esac

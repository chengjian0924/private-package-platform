# 源鉴 · 内网依赖安全治理平台 容器镜像（amd64 / x86_64）
# 两阶段构建：编译阶段装全量依赖，运行阶段只保留生产依赖
# 基础镜像要求 Node >= 22.5（node:sqlite 内置模块），与 package.json engines 一致
#
# 构建上下文必须是项目根目录（本 Dockerfile 的 COPY 路径均相对于根目录）：
#   docker build -f docker/amd64/Dockerfile --platform linux/amd64 -t yuanjian:amd64 .
# 同目录 docker-compose.yml 已封装 context / dockerfile，常规用法见 docker/README.md。
#
# buildx 自动注入这两个参数；用 BUILDPLATFORM 跑构建工具、TARGETPLATFORM 取目标基础镜像。
# 本机即 amd64 时无需 QEMU；在 arm64 构建机上交叉构建需 binfmt/QEMU。
ARG TARGETPLATFORM=linux/amd64
ARG BUILDPLATFORM

# ---------- 阶段 1：编译 ----------
FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# ---------- 阶段 2：运行 ----------
FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/var/lib/yuanjian/data \
    QUARANTINE_DIR=/var/lib/yuanjian/quarantine \
    LOG_FILE_ENABLED=false \
    LOG_FORMAT=json

WORKDIR /app

# sqlite3 CLI：供 docker exec 运行 scripts/backup.sh / restore.sh 做一致性快照与完整性校验
# 应用本身用 node:sqlite 内置模块，不依赖该 CLI；仅运维脚本需要
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ ./dist/
COPY public/ ./public/
COPY scripts/ ./scripts/

# 非 root 运行；数据与隔离卷目录预建并归属该用户，避免 named volume 首次挂载时权限错位
RUN groupadd -g 10001 yuanjian \
 && useradd -u 10001 -g yuanjian -M -d /var/lib/yuanjian -s /usr/sbin/nologin yuanjian \
 && mkdir -p /var/lib/yuanjian/data /var/lib/yuanjian/quarantine \
 && chown -R yuanjian:yuanjian /var/lib/yuanjian \
 && chmod 700 /var/lib/yuanjian/quarantine
USER yuanjian

EXPOSE 3000
STOPSIGNAL SIGTERM

# 三个角色都挂载了 HealthController（CoreModule），统一探针端点
# 用 Node 内置 fetch，不依赖 curl，镜像保持精简
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

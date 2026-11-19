# 容器镜像配置（双架构）

本目录集中管理两种 CPU 架构的 Docker 构建与编排配置，两者完全独立、互不覆盖。

## 目录结构

```
docker/
├── README.md              # 本说明
├── arm64/                 # aarch64 / linux-arm64
│   ├── Dockerfile
│   └── docker-compose.yml
└── amd64/                 # x86_64 / linux-amd64
    ├── Dockerfile
    └── docker-compose.yml
```

项目根目录的 `.dockerignore` 由两种架构**共用**，不能移动到本目录下：Docker 只从构建上下文根目录读取该文件，而本项目的构建上下文固定为项目根（Dockerfile 的 `COPY package.json`、`COPY src/` 等均相对根目录解析）。

## 架构对照

| 项 | arm64 | amd64 |
|---|---|---|
| 目标平台 | `linux/arm64` | `linux/amd64` |
| 配置目录 | `docker/arm64/` | `docker/amd64/` |
| 镜像 tag | `yuanjian:arm64` | `yuanjian:amd64` |
| Compose 中的 nginx | `linux/arm64` | `linux/amd64` |
| 适配目标机 | ARM 服务器、Apple Silicon | 常规 x86 服务器 |

两份配置除架构标识与镜像 tag 外完全一致：三角色拆分（console/npm/pypi）、相同端口映射、相同卷与健康检查、预留的 gateway profile。tag 带架构后缀是为了让两个镜像能在同一台机器共存，切换架构时不会互相覆盖。

## 统一入口脚本

所有操作推荐通过 `scripts/docker-build.sh` 执行，脚本会校验架构、选对 Dockerfile 与 compose，并把构建上下文固定到项目根：

```bash
# 构建（可追加任意 docker build 参数）
./scripts/docker-build.sh arm64 build --no-cache
./scripts/docker-build.sh amd64 build

# 启动编排（可追加 compose 参数，如 --profile gateway）
./scripts/docker-build.sh amd64 up

# 导出镜像（产出 dist-offline/images/yuanjian-<arch>.tar.gz）
./scripts/docker-build.sh arm64 save
./scripts/docker-build.sh amd64 save

# 核验镜像架构
./scripts/docker-build.sh arm64 inspect
```

`inspect` 应输出与目标一致的 `Arch=arm64` 或 `Arch=amd64`。两个架构的离线镜像均已实际导出（`dist-offline/images/`，MANIFEST.sha256 登记双架构校验和）；amd64 镜像在 Apple Silicon 上经 buildx + Rosetta 交叉构建并冒烟验证通过。

跨架构构建由脚本统一走 buildx（经典构建器无法解析跨平台 manifest list），buildx 状态目录默认重定向到 `/tmp/yj-buildx`，规避 `~/.docker/buildx` 写入受限的宿主；如需自定义，设置 `BUILDX_CONFIG` 环境变量即可。

## 直接用 Docker 命令

若不使用脚本，注意 `-f` 与构建上下文的组合，以及 compose 的相对路径基准：

```bash
# 在项目根目录执行，最后的 . 是构建上下文，不能省略或改成 docker/ 目录
docker build -f docker/arm64/Dockerfile --platform linux/arm64 -t yuanjian:arm64 .
docker build -f docker/amd64/Dockerfile --platform linux/amd64 -t yuanjian:amd64 .

# compose 在自身目录执行时，其相对路径（../../deploy/...）才成立
docker compose -f docker/arm64/docker-compose.yml up -d --build
docker compose -f docker/amd64/docker-compose.yml up -d --build
```

跨架构构建（在 x86 机器上构建 arm64，或在 ARM 机器上构建 amd64）需要 buildx + binfmt/QEMU；构建参数 `TARGETPLATFORM` / `BUILDPLATFORM` 会由 buildx 自动注入，Dockerfile 已按此设计。

## 部署前置

两种架构共用同一份生产配置：

```bash
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
# 按样例注释填写必改项，尤其是 METRICS_TOKEN 需用 openssl rand -hex 32 生成
```

详细部署步骤见 `docs/CONTAINER_DEPLOYMENT.md`（通用）与 `docs/OFFLINE_DEPLOY_CONTAINER.md`（离线交付）。

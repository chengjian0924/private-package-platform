# 源鉴 · 容器化部署手册（三角色拆分 + HTTP 直连）

## 1. 适用范围与形态

| 项 | 本方案取值 |
| --- | --- |
| 进程形态 | console / npm / pypi 三容器拆分，后台任务只在 console 跑一次 |
| 对外入口 | 三端口直连，无网关：控制台 `:3000`、npm `:3001`、pypi `:3002` |
| 网关 | `deploy/nginx-container.conf` 已预留但**默认不启用**（compose 的 `gateway` profile） |
| TLS | HTTP 直连，显式 `ALLOW_INSECURE_BASE_URL=true`，启动日志会打印明文风险告警 |
| 运维调度 | 宿主 cron 调用临时容器执行 `backup.sh` / `audit-dump.mjs` |
| 数据 | 两个本地 named volume；**仅支持单主机**，SQLite WAL 不能跨 NFS/多主机 |

与 systemd 形态（`docs/DEPLOYMENT.md`）的差异见第 8 节。已有的 system 测试（`npm run test:system`）验证过同等三进程直连形态的业务行为，容器化只是换了启动与隔离方式。

### 1.1 三个容器各自的作用

| 容器 | `PROCESS_ROLE` | 职责 | 为什么单独拆出 |
| --- | --- | --- | --- |
| `yuanjian-console` | `console` | Web 控制台、登录鉴权、批量导入、包管理、审计、安全复核；**唯一**运行后台任务（定期复检、隔离区销毁、扫描恢复、 retention、备份调度）的进程 | 后台任务必须全平台单实例，多跑会重复执行；也避免 registry 进程并发建号撞唯一约束 |
| `yuanjian-npm` | `npm` | 只承载 `/npm/*` 协议入口：packument 查询、tarball 下载、`npm publish` | 高频下载流量与控制台管理流量隔离，互不影响；packument 里的 tarball 地址由 `NPM_BASE_URL` 决定 |
| `yuanjian-pypi` | `pypi` | 只承载 `/pypi/*` 协议入口：simple 索引、包下载、twine 上传 | 同上；索引展示地址由 `PYPI_BASE_URL` 决定 |

三者跑的是**同一个镜像**，仅靠 `PROCESS_ROLE` 环境变量切换装配的模块（`resolveAppModule`）：`console` 挂 `ConsoleModule`，`npm` 挂 `NpmModule`，`pypi` 挂 `PypiModule`。三角色都通过 `CoreModule` 挂载 `HealthController` 与 `MetricsController`，因此每个容器都能用 `/api/v1/health` 探活。

### 1.2 相互依赖关系

```
console  ──(service_healthy)──▶  npm
         └──(service_healthy)──▶  pypi
nginx(gateway profile) ──▶ console + npm + pypi
```

- `npm` / `pypi` 都 `depends_on: console: condition: service_healthy`：等控制台健康后才启动，降低首次并发建库时的 SQLite 锁竞争（历史缺陷 S-01 的容器层防御）。
- `nginx` 仅在 `--profile gateway` 启动时才拉起，依赖三个应用全部健康；直连形态下完全不参与。
- 三者**无业务调用依赖**：npm/pypi 不通过 HTTP 调 console，而是共享同一个 SQLite 库和数据目录交换数据。因此它们必须挂同一组卷、且只能在同一台主机上。

### 1.3 端口与数据卷

| 端口 | 所属 | 用途 |
| --- | --- | --- |
| `3000:3000` | console | Web 控制台 + 管理 API + `/api/v1/health`；浏览器和用户操作入口 |
| `3001:3000` | npm | npm registry 协议，客户端配 `registry=http://<host>:3001/npm/` |
| `3002:3000` | pypi | PyPI 协议，pip/twine 配 `-i http://<host>:3002/pypi/simple/` |
| `80` / `443` | nginx（预留） | 仅网关模式启用：80 跳转 443，443 终止 TLS 后按路径分流 |

> 容器内三个进程监听的都是 **3000**（`PORT=3000`），宿主机映射到 3000/3001/3002。改宿主端口只需改 compose 的 `ports` 左侧，同时同步 `.env.production` 里的三个基址。

| 卷 | 容器内路径 | 用途 | 关键点 |
| --- | --- | --- | --- |
| `yuanjian_data` | `/var/lib/yuanjian/data` | `platform.db`（SQLite WAL）、`objects/`（包文件按 sha256 分目录）、`batches/`（导入批次）、`tmp/`、备份目录 | 三容器共享；**必须本地卷**，禁止 NFS/跨主机；备份走 `sqlite3 .backup` 而非拷文件 |
| `yuanjian_quarantine` | `/var/lib/yuanjian/quarantine` | 高危/可疑样本隔离区，目录 0700 | 与业务数据**分卷**是有意设计：恶意样本不随常规备份扩散；启动会自动修正权限 |

卷名前缀 `yuanjian_` 来自 compose 的 `name: yuanjian`。两个卷都由镜像内 uid 10001 的 `yuanjian` 用户持有，宿主 cron 的临时容器用 `-u 10001:10001` 挂载。

## 2. 前置条件

- Docker Engine ≥ 24 且 Compose v2 插件可用（`docker compose version`）。
- **支持两种目标架构**：`linux/arm64`（aarch64，配置在 `docker/arm64/`）与 `linux/amd64`（x86_64，配置在 `docker/amd64/`）。两套配置完全对称、互不覆盖；各自的 compose 已为所有服务声明对应 `platform`，镜像 tag 分别为 `yuanjian:arm64` 与 `yuanjian:amd64`。选择依据见 `docker/README.md`。
- 构建机可访问 npm registry 拉取基础镜像与依赖；运行机可断网，用 `docker save/load` 传入镜像。
- 宿主机开放 3000/3001/3002 三个内网端口；按内网安全策略限制来源网段。
- 磁盘：数据卷预留空间不低于业务预期；隔离样本单独卷，便于排除出常规备份。

架构兼容性已核对：`node:22-bookworm-slim` 与 `nginx:1.27-alpine` 均提供 arm64 / amd64 变体；应用运行时依赖（NestJS、adm-zip、exceljs、tar、semver、rxjs 等）全是纯 JS，无 `node-gyp` 原生编译模块；数据库走 Node 22 内置的 `node:sqlite`，不依赖架构特定的二进制。`fsevents` 仅 macOS 生效，Linux 构建时会被 npm 跳过。

**在目标机上直接构建（推荐，无需 QEMU）**——把 `ARCH` 换成 `arm64` 或 `amd64`：

```bash
./scripts/docker-build.sh "$ARCH" build --no-cache
./scripts/docker-build.sh "$ARCH" up
```

等价的 compose 写法（在对应架构目录执行）：

```bash
cd docker/arm64   # 或 docker/amd64
docker compose build --no-cache && docker compose up -d
```

**在异构构建机上交叉构建**：

```bash
docker buildx create --use --name multiarch      # 首次；需 QEMU 支持非本机架构
# 以 x86 构建机产出 arm64 镜像为例（上下文必须是项目根，最后的 . 不能省）
docker buildx build --platform linux/arm64 \
  -f docker/arm64/Dockerfile -t yuanjian:arm64 --load .
./scripts/docker-build.sh arm64 save
# 目标机：docker load -i dist-offline/images/yuanjian-arm64.tar.gz && 启动对应 compose
```

> 注意：直接在 compose 目录执行 `docker compose build` 时，会按该目录的 `platform` 构建，在异构机器上同样需要 QEMU。若报 `exec format error`，先启用 binfmt/QEMU。校验镜像架构：`./scripts/docker-build.sh "$ARCH" inspect`，输出应与所选架构一致。

## 3. 首次配置

**只改 5 个值，然后 `up -d`**；其余配置项已按生产默认值预置，不用碰。

```bash
cd /opt/yuanjian
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
vi deploy/.env.production        # 只改下面「必改 5 项」
docker compose up -d
```

必改 5 项：

| 变量 | 要求 |
| --- | --- |
| `PUBLIC_BASE_URL` | `http://<内网可达地址>:3000`，**不要写 `127.0.0.1`**（那是容器回环） |
| `NPM_BASE_URL` | `http://<同一地址>:3001`——漏配会让 packument 的 tarball 指回控制台端口，安装 404 |
| `PYPI_BASE_URL` | `http://<同一地址>:3002`——漏配会让 simple 索引下载地址错误 |
| `INITIAL_PASSWORD_ADMIN` | 一次性强口令，≥12 位且不含用户名；**首次改密后从文件删除该行** |
| `INITIAL_PASSWORD_USER` | 普通账号一次性初始口令，同上 |

其余**无需修改**、已预置：`METRICS_TOKEN`（随机 64 位 hex，**不要清空**，作用与轮换见 `docs/OFFLINE_DEPLOY_CONTAINER.md` 第 3.1 节）、`ALLOW_INSECURE_BASE_URL=true`、`DEFAULT_NODE_TARGET=22.23.5` / `DEFAULT_PYTHON_TARGET=3.11.9`、数据目录及安全/限流/日志参数。备份目录与 cron 属上线后可选运维，不配置不影响启动（见第 6 节）。

> 初始口令以代码为准：容器只需 `INITIAL_PASSWORD_ADMIN`（管理员）和 `INITIAL_PASSWORD_USER`（普通账号）。不配置时回落到固定默认值，首登强制改密；用户表非空后这些变量不再生效，应删掉并重建容器。

## 4. 构建与启动

把 `ARCH` 设为 `arm64` 或 `amd64`（对应 `docker/<ARCH>/`）：

```bash
./scripts/docker-build.sh "$ARCH" build --no-cache   # 首次或镜像有变更时
./scripts/docker-build.sh "$ARCH" up                 # 后台启动全部默认服务
```

三个服务的健康检查应变为 `healthy`（探针为 `GET /api/v1/health`，三个角色都挂载了该控制器）。`npm`/`pypi` 通过 `depends_on` 等 `console` 健康后才启动，降低首次并发建库时的锁竞争。

首次启动确认日志出现 `角色=console`、`内置管理员` 建号成功，以及三个对外地址与 `.env.production` 一致。

### 4.1 常用命令速查

以下命令均在所选架构目录（`docker/arm64/` 或 `docker/amd64/`）执行，或用 `-f docker/<ARCH>/docker-compose.yml` 从项目根调用。脚本入口 `./scripts/docker-build.sh <ARCH> up` 可替代 `up -d --build`。

**启动 / 重建**

```bash
docker compose up -d                              # 启动（镜像已存在时）
docker compose up -d --build                      # 改了代码或 Dockerfile 后重建并启动
docker compose up -d console                      # 只启动单个服务
docker compose --profile gateway up -d            # 连预留的 nginx 网关一起启动
```

**状态检查**

```bash
docker compose ps                                 # 各服务状态与端口映射
docker compose ps -a                              # 含已退出的容器（排查重启循环）
docker compose top                                # 容器内进程
docker compose exec console node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(console.log)"   # 应用级健康详情
docker stats --no-stream                          # 实时 CPU/内存占用
```

**日志查看**

```bash
docker compose logs -f                            # 跟踪全部服务
docker compose logs -f console                    # 跟踪单个服务
docker compose logs --tail=200 npm                # 末尾 200 行
docker compose logs --since=30m pypi              # 最近 30 分钟
docker compose logs -f --timestamps console       # 带时间戳
```

**重启 / 停止 / 清理**

```bash
docker compose restart console                    # 重启单个服务（保留容器与卷）
docker compose restart                            # 重启全部服务
docker compose stop                               # 停止但不删除容器（发 SIGTERM，走优雅排空）
docker compose start                              # 启动已停止的容器
docker compose down                               # 停止并删除容器与网络，保留 named volume
docker compose down -v                            # 连同数据卷一起删除（危险：数据不可恢复）
```

> **不要用 `docker kill` 或 `docker compose kill` 做常规停机**：会跳过 A-07 优雅排空。`stop`/`down` 发 SIGTERM，应用有 25s 宽限 + 35s 看门狗，compose 的 `stop_grace_period: 40s` 与之对齐。
>
> `down` 只删容器不删卷，升级与回滚可安全执行；只有确认要彻底重置数据才用 `down -v`，执行前必须先按第 6 节备份。

## 5. 验收清单

```bash
HOST=yuanjian.example.internal   # 换成真实内网地址

# 1) 三端口健康
for p in 3000 3001 3002; do curl -fsS "http://$HOST:$p/api/v1/health" | head -c 200; echo; done

# 2) npm 协议入口
npm config set registry "http://$HOST:3001/npm/"
npm view <已入库包名> version

# 3) pypi 协议入口
pip index versions <已入库包名> -i "http://$HOST:3002/pypi/simple/"

# 4) 控制台首登：浏览器打开 http://$HOST:3000/，用初始管理员登录并强制改密
# 5) 改密后从 .env.production 删除 INITIAL_PASSWORD_ADMIN，再 docker compose up -d 重建容器
```

跨容器链路验收（导入→入库→registry 下载→审计）可复用 `test/integration-flows.e2e-spec.ts` 的调用顺序，把 `baseUrl` 换成上述直连地址；或在容器内执行一次性 HTTP 校验。

优雅停机验收：

```bash
time docker stop yuanjian-npm     # 应在 40s 内退出；日志出现「收到 SIGTERM，开始优雅停机」
docker compose up -d yuanjian-npm
```

> Nest 排空完成后会主动重发 SIGTERM，进程退出码为 143（shell 视角）。compose 已设 `restart: unless-stopped` 与 `stop_grace_period: 40s`，这是预期行为，不是崩溃。

## 6. 备份、恢复与审计转储（可选，部署阶段可整节跳过）

> **不配置不影响 `docker compose up -d`，也不影响业务运行。** 这是上线后的运维任务，需要备份时按本节一次性配置即可。

镜像内已装 `sqlite3` CLI，运维脚本通过临时容器执行；宿主只需 cron 调度，不必安装 Node 或 sqlite3。备份卷挂到宿主目录，权限需允许 uid 10001 写入。

**备份目录地址（宿主路径，需自行创建）** —— 不在 compose 的 `volumes` 声明中，由 cron 用 `-v` 绑定，compose 不会自动创建：

| 用途 | 宿主目录（地址） | 容器内挂载点 | 产物 |
| --- | --- | --- | --- |
| 一致性备份归档 | `/srv/yuanjian-backups` | `/backups` | `yuanjian-<时间戳>.tar.gz` 及 `.sha256` |
| 审计日志转储 | `/srv/yuanjian-audit-dump` | `/dump` | `*.jsonl` 快照（0444 只读） |
| cron 运行日志 | `/var/log/yuanjian-backup.log`、`/var/log/yuanjian-audit-dump.log` | — | 脚本输出 |
| 业务数据卷 | named volume `yuanjian_data` | `/var/lib/yuanjian/data` | `platform.db`、`objects/` 等 |

```bash
sudo mkdir -p /srv/yuanjian-backups /srv/yuanjian-audit-dump
sudo chown 10001:10001 /srv/yuanjian-backups /srv/yuanjian-audit-dump
```

crontab（`sudo crontab -e`）。下例按 arm64 部署写（镜像 `yuanjian:arm64`）；amd64 机器把镜像名改为 `yuanjian:amd64`，其余不变：

```cron
# 每日 02:10 一致性备份，保留 14 天
10 2 * * * cd /opt/yuanjian && docker run --rm -v yuanjian_data:/var/lib/yuanjian/data -v /srv/yuanjian-backups:/backups -e DATA_DIR=/var/lib/yuanjian/data -e BACKUP_ROOT=/backups -u 10001:10001 yuanjian:arm64 /app/scripts/backup.sh --prune >> /var/log/yuanjian-backup.log 2>&1

# 每日 02:20 审计日志转储（留存 ≥180 天，哈希链校验失败时退出码 1 并产出 .BROKEN 文件）
20 2 * * * cd /opt/yuanjian && docker run --rm -v yuanjian_data:/var/lib/yuanjian/data -v /srv/yuanjian-audit-dump:/dump -e DATA_DIR=/var/lib/yuanjian/data -e AUDIT_DUMP_DIR=/dump -e AUDIT_RETENTION_DAYS=365 -u 10001:10001 yuanjian:arm64 node /app/scripts/audit-dump.mjs >> /var/log/yuanjian-audit-dump.log 2>&1
```

> 临时容器镜像必须与目标机架构一致，否则会报 `exec format error`。卷名带项目前缀：compose 文件声明 `name: yuanjian`，因此 `data` 卷在 Docker 中的全名是 `yuanjian_data`。

> **成功哨兵必配**：cron 退出码易被忽略，须每天检查是否有新归档，缺失即告警。旧脚本曾因镜像缺 `rsync` 静默失败、零归档却无人察觉（已修复为 `cp -a`）：
> ```bash
> test -n "$(find /srv/yuanjian-backups -name 'yuanjian-*.tar.gz' -mtime -1 -print -quit)" \
>   && echo "backup OK" || echo "ALERT: 24h 内无新备份归档"
> ```
> 备份与数据在同机，须每日把归档 `scp`/`rsync` 到另一台机器或对象存储（等保留存 ≥180 天），否则主机故障会同时失去数据和备份。

手动恢复（**先停机**，避免恢复过程中有写入）：

```bash
./scripts/docker-build.sh "$ARCH" down     # 或 docker compose down（在架构目录执行）
docker run --rm \
  -v yuanjian_data:/var/lib/yuanjian/data \
  -v /srv/yuanjian-backups:/backups:ro \
  -u 10001:10001 \
  yuanjian:"$ARCH" \
  /app/scripts/restore.sh /backups/yuanjian-<时间戳>.tar.gz /var/lib/yuanjian/data --force
./scripts/docker-build.sh "$ARCH" up
```

恢复后校验：健康端点 200、审计转储退出码 0、抽查 3 个包的下载哈希与库内记录一致。

## 7. 切换到网关模式（可选，当前不启用）

1. 把内网 CA 签发的证书放到 `deploy/certs/`（`yuanjian.example.internal.crt` / `.key`），并在 `deploy/nginx-container.conf` 中确认 `server_name` 与证书路径一致。
2. 修改 `deploy/.env.production`：三个基址改为 `https://<网关域名>`（不带端口），**删除** `ALLOW_INSECURE_BASE_URL=true`。
3. 修改所选架构的 `docker/<ARCH>/docker-compose.yml`：把三个应用的 `ports` 改为仅本机可见，例如 `127.0.0.1:3000:3000`（网关容器通过内部网络访问 `console:3000`，不依赖宿主映射）。
4. 启动：

```bash
./scripts/docker-build.sh "$ARCH" up --profile gateway
```

网关按 `/npm/`、`/pypi/`、其余路径分流；`/metrics` 返回 404，Prometheus 应在容器内直连 `console:3000/metrics` 并带 `METRICS_TOKEN`。

## 8. 与 systemd 形态的差异

| 项 | systemd（`docs/DEPLOYMENT.md`） | 容器（本方案） |
| --- | --- | --- |
| 配置位置 | `/opt/yuanjian/.env.production` | `deploy/.env.production` |
| 初始密码变量 | 沿用既有 `.env.production` 配置 | `INITIAL_PASSWORD_ADMIN` / `INITIAL_PASSWORD_USER` |
| `BIND_HOST` | 网关形态 `127.0.0.1` | `0.0.0.0`（隔离由容器网络负责） |
| 端口 | 按角色默认 3000/3001/3002 | 容器内统一 3000，宿主映射 3000/3001/3002 |
| 日志 | journald | `docker logs` / 日志驱动采集 stdout |
| 自愈 | `Restart=always` | `restart: unless-stopped` |
| 备份 | 宿主脚本直连数据目录 | 宿主 cron 调临时容器挂卷执行 |
| 沙箱加固 | systemd 的 `ProtectSystem` 等 | 非 root uid 10001 +只读代码层（镜像）+ 独立卷 |

## 9. 升级与回滚

```bash
# 升级前必做备份（见第 6 节）
./scripts/docker-build.sh "$ARCH" down
# 替换镜像：重新构建，或 docker load 新版镜像后改 compose 的 image tag
./scripts/docker-build.sh "$ARCH" build --no-cache
./scripts/docker-build.sh "$ARCH" up
for p in 3000 3001 3002; do curl -fsS "http://$HOST:$p/api/v1/health" >/dev/null && echo "$p ok"; done
```

回滚：停服 → 切回旧镜像（tag 或重新 load）→ 若涉及数据库结构变更，先按第 6 节恢复升级前备份 → 启动。**禁止用 `docker kill` 常规停服**，会跳过 A-07 优雅排空。

## 10. 排障

| 现象 | 排查方向 |
| --- | --- |
| 容器反复重启、日志有「生产环境配置校验未通过」 | 三基址是否 http 且未设 `ALLOW_INSECURE_BASE_URL=true`；Node ≥22.5；数据目录可写 |
| 客户端安装 404、tarball 地址指向控制台 | `NPM_BASE_URL` / `PYPI_BASE_URL` 漏配或端口写错；查健康端点的 `endpoints` 字段 |
| 健康检查一直 starting/unhealthy | `BIND_HOST` 是否被改成 `127.0.0.1`；`start_period` 40s 是否足够（首次建库较慢） |
| 启动时 `database is locked` | 确认所有卷是本机本地卷、没有挂 NFS；确认只有一个 compose 项目操作同一数据卷 |
| 日志出现明文 HTTP 告警 | 已设 `ALLOW_INSECURE_BASE_URL=true`，属预期风险提示；若网络隔离不到位，按第 7 节切网关 |
| 退出码 143 被误判为崩溃 | 用 `unless-stopped`，不要用 `restart: on-failure` |

## 11. 已知边界

- 单主机部署：SQLite WAL 跨主机文件锁不可靠，不支持 swarm/K8s 多副本共享同一卷。
- HTTP 直连：登录态与令牌在内网明文传输，依赖网络隔离；切网关模式可消除该风险。
- 网关配置预留但未验收：当前交付只保证直连形态；启用网关前需按第 7 节重新走一遍验收清单。
- 双架构兼容性基于静态核对：两种基础镜像 tag 均有对应变体、依赖无原生编译、平台已显式锁定。arm64 镜像曾在本机实测构建成功（本机即 arm64）；amd64 镜像**未在 x86 Docker daemon 上实机 build/run**，目标机首次部署按第 4 节执行，并用 `./scripts/docker-build.sh "$ARCH" inspect` 确认输出与目标一致。
- 异构交叉构建依赖 binfmt/QEMU，未在两套架构互交叉的方向上实机验证；静态校验已覆盖 compose 语法、`platform` 声明、脚本参数与运行时关键项。

# 源鉴 · 内网离线容器化部署手册（双架构 / Compose 2.10.2）

## 0. 适用范围与已验证环境

下表是 **arm64 实测**记录。amd64 镜像已实际构建（2026-11-19，在 Apple Silicon 构建机上经 buildx + Rosetta 交叉构建）并通过容器冒烟验证（容器 healthy、health 端点正常）；尚未在真实 x86 目标机上部署过，目标机首次部署按第 4 节执行即可。两种架构的 compose 命令均可用 `./scripts/docker-build.sh <ARCH>` 统一入口执行。

| 项 | 本次实测值 |
| --- | --- |
| 目标架构 | `linux/arm64`（aarch64）与 `linux/amd64`（x86_64），离线包双架构齐备 |
| Docker Engine | 29.7.2（要求 ≥ 24） |
| Docker Compose | **2.10.2**（已在本地用该版本二进制实测全流程） |
| 应用镜像 | `yuanjian:arm64`（90 MB gzip）/ `yuanjian:amd64`（91 MB gzip），均为单架构镜像 |
| 进程形态 | console / npm / pypi 三容器拆分，HTTP 三端口直连 |
| 网关 | `deploy/nginx-container.conf` 预留但**默认不启用**（无证书时启动会失败，属预期） |

### 0.1 目标服务器前置条件

| 类别 | 要求 |
| --- | --- |
| **必须已装** | Docker Engine ≥ 24、Docker Compose 2.10.2（或兼容的 v2）、与目标镜像一致的 CPU 架构（arm64 或 amd64） |
| 宿主工具 | `sha256sum`、`tar`（校验归档，系统自带）；备份用的 `cron`/`crontab` **仅可选运维需要**，见第 6 节 |
| **无需安装** | **Node.js、Python、npm、数据库服务、sqlite3 CLI** |

原因：Node 运行时（含内置 `node:sqlite`）、生产依赖、编译产物 `dist/`、运维脚本与 `sqlite3` CLI **全部固化在应用镜像内**（`yuanjian:arm64` 或 `yuanjian:amd64`），容器启动、健康检查、备份转储都在容器内执行，宿主不参与任何运行时。Python 在运行期完全不被调用——项目里出现的 `python` 只是 PyPI 包的 `requires_python`、wheel 标签等**兼容性元数据**，由 JS 字符串解析处理，不需要解释器。

> 只有 `deploy/yuanjian.service` 的**裸机 systemd 部署**才需要宿主安装 Node ≥ 22.5（`ExecStart=/usr/bin/node`）；本离线容器方案不走该路径，因此服务器不装 Node / Python 不影响部署与运行。

离线交付包位于项目 `dist-offline/`（归档名带架构后缀）：

```
dist-offline/
├── MANIFEST.sha256                    # SHA-256 校验和（双架构归档一并登记）
└── images/
    ├── yuanjian-arm64.tar.gz          # arm64 应用镜像（gzip 压缩）
    └── yuanjian-amd64.tar.gz          # amd64 应用镜像（gzip 压缩）
```

> `docker load` 原生支持 gzip 压缩归档，无需先解压。目标机只需拷贝**与本机架构一致**的那一个归档，另一个可留在构建机。

> 网关镜像 `nginx:1.27-alpine` 未纳入离线包，因为当前不启用。若后续要切网关模式，需在联网机上按目标架构 `docker pull --platform <架构> nginx:1.27-alpine` 后同样 `docker save` 导出并传入。

## 1. 传输与校验

把项目目录（含 `dist-offline/`、`docker/<ARCH>/`、`deploy/`）整体拷到目标机。在目标机校验归档完整性（MANIFEST 登记了两个架构的归档，本机架构那条输出 OK 即可，另一条因文件未拷贝会提示 No such file，忽略）：

```bash
cd /opt/yuanjian/dist-offline
sha256sum -c MANIFEST.sha256
# 预期输出（arm64 目标机示例）：images/yuanjian-arm64.tar.gz: OK
```

校验失败说明传输损坏，**禁止继续部署**。

> 上线后要启用备份时，用 `deploy/backup-control.sh`（随 `deploy/` 目录一并交付，一键装 cron + 字典总闸 + 状态记录，用法见第 6 节）。脚本默认用 `yuanjian:arm64` 镜像；amd64 机器需显式设 `YJ_ARCH=amd64`（或直接 `YJ_IMAGE=yuanjian:amd64`），否则会因架构不符报 `exec format error`。该脚本不进镜像、不参与 `docker compose up -d`，故离线归档与 MANIFEST 不受影响。

## 2. 加载镜像

下例为 arm64；amd64 机器把归档名与 tag 换成 `amd64`：

```bash
docker load -i dist-offline/images/yuanjian-arm64.tar.gz
docker images yuanjian:arm64
# 确认 ARCH 与目标架构一致
docker image inspect yuanjian:arm64 --format '{{.Repository}}:{{.Tag}} {{.Architecture}}/{{.Os}}'
# 预期：yuanjian:arm64 arm64/linux（amd64 镜像则输出 amd64/linux）
```

## 3. 环境变量配置

**最简部署：只改 5 个值，然后 `up -d`。** 其余配置项已在模板中按生产默认值预置，不用碰；备份目录和 cron 属上线后可选运维，不配置不影响启动。

```bash
cd /opt/yuanjian
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
vi deploy/.env.production        # 只改下面「必改 5 项」
docker compose up -d
```

**必改 5 项**（模板中以 ★ 标注）：

| 变量 | 改成 | 不改的后果 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `http://<服务器内网IP>:8860` | 客户端拿不到正确地址；**不要写 `127.0.0.1`**（容器回环） |
| `NPM_BASE_URL` | `http://<同一IP>:8861` | packument 的 tarball 指回控制台，npm 安装 404 |
| `PYPI_BASE_URL` | `http://<同一IP>:8862` | simple 索引的下载地址错误 |
| `INITIAL_PASSWORD_ADMIN` | 一次性强口令，≥8 位且不含用户名 | 占位串无法登录；**首次改密后删除该行并重建容器** |
| `INITIAL_PASSWORD_USER` | 一次性初始口令 | 普通账号初始口令，同上 |

**已预置、无需修改**：

| 变量 | 预置值 | 说明 |
| --- | --- | --- |
| `METRICS_TOKEN` | 随机 64 位 hex | 见 3.1；**不要清空** |
| `ALLOW_INSECURE_BASE_URL` | `true` | HTTP 直连必须保留，否则生产护栏拒绝启动并打印明文告警 |
| `DEFAULT_NODE_TARGET` / `DEFAULT_PYTHON_TARGET` | `22.23.5` / `3.11.9` | 建议填具体版本号；仅用于兼容性提示，不影响入库（通用源，由客户端挑选包），见第 8 节 |
| `DATA_DIR` / `QUARANTINE_DIR` | 容器内绝对路径 | 已对应 compose 的 named volume，勿改 |
| 安全 / 限流 / 日志参数 | 生产默认值 | 均可在控制台「字典管理」运行时覆盖 |

> 初始口令生效变量只有 `INITIAL_PASSWORD_ADMIN` / `INITIAL_PASSWORD_USER` / `BOOTSTRAP_ADMIN_USERNAME`。生产护栏不校验初始口令强度（靠首登强制改密兜底），用户表非空后这些变量不再生效。

### 3.1 METRICS_TOKEN（已预置，无需配置）

模板已写入随机 64 位 hex 令牌，部署时**不用生成、不用填写**，`up -d` 直接生效。之所以预置而不留空：`GET /metrics` 以 Prometheus 文本格式输出约 25 项 `yj_*` 指标（请求量与延迟、扫描队列、漏洞库规模、隔离区、磁盘与时钟观测等），供 Prometheus 每 30s 抓取，配合 `docs/ALERT_RULES.md` 的告警规则使用——留空就等于把运行指标公开。

> 用固定预置值而非每次自动生成，是为了让 Prometheus 抓取配置保持稳定；轮换令牌后需同步更新抓取端。多套环境务必各自轮换，不要共用同一个值。

| 状态 | 行为 |
| --- | --- |
| **已设置**（模板默认状态） | 抓取须带 `Authorization: Bearer <METRICS_TOKEN>`，否则返回 401；比较使用 `timingSafeEqual` 定长比较，防止通过响应时间推断令牌 |
| **留空** | 该端点**匿名可读、无任何身份校验**（`MetricsController` 未挂登录守卫，全局仅有磁盘写保护守卫），等同于把运行指标公开 |

查看 / 轮换 / 验证（仅在需要接 Prometheus 或做安全加固时才做）：

```bash
# 查看当前令牌（从文件读取，不要打印到共享日志）
grep '^METRICS_TOKEN=' deploy/.env.production

# 轮换：多套环境务必各自执行
sed -i "s|^METRICS_TOKEN=.*|METRICS_TOKEN=$(openssl rand -hex 32)|" deploy/.env.production
docker compose up -d            # env_file 变化会触发容器重建，使新令牌生效

# 验证：带令牌应返回 yj_* 文本，不带令牌应返回 401
TOKEN=$(grep '^METRICS_TOKEN=' deploy/.env.production | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8860/metrics | head
```

Prometheus 抓取配置须与 `.env.production` 中的值一致：

```yaml
scrape_configs:
  - job_name: yuanjian
    scrape_interval: 30s
    static_configs:
      - targets: ['127.0.0.1:8860']
    authorization:
      credentials: "<METRICS_TOKEN>"
```

> HTTP 直连形态下 8860 端口对外可达，`/metrics` 也随之暴露：除令牌外还须用防火墙把 8860 收敛到 Prometheus / 研发网段。切到网关模式后 `deploy/nginx-container.conf` 会让 `/metrics` 返回 404，此时 Prometheus 应在容器内直连 `console:3000/metrics` 并携带令牌。

## 4. 启动与停止

以下命令用 `docker compose`（2.10.2），均在**所选架构目录**（`docker/arm64/` 或 `docker/amd64/`）执行；`./scripts/docker-build.sh <ARCH> up` 可替代 `up -d --build`。

**启动**

```bash
docker compose up -d
```

**状态检查**

```bash
docker compose ps                 # 三个服务应为 running (healthy)
docker compose ps -a              # 含已退出容器，排查重启循环
docker compose top                # 容器内进程
docker stats --no-stream          # CPU / 内存
# 2.10.2 注意：docker compose ps --format '{{.Name}}' 不支持 Go 模板（会报 parsing failed），
# 直接用不带 --format 的 ps，或用 docker port <容器名> 看端口映射。
```

**日志**

```bash
docker compose logs -f                    # 跟踪全部
docker compose logs -f console            # 单个服务
docker compose logs --tail=200 npm        # 末尾 200 行
docker compose logs --since=30m pypi      # 最近 30 分钟
```

**重启 / 停止 / 清理**

```bash
docker compose restart console            # 重启单个
docker compose restart                    # 重启全部
docker compose stop                       # 停止（发 SIGTERM，走优雅排空）
docker compose start                      # 启动已停止容器
docker compose down                       # 停并删容器/网络，保留数据卷
docker compose down -v                    # 连数据卷一起删（危险，先备份）
```

> 常规停机只用 `stop` / `down`，**不要用 `docker kill`**——会跳过优雅排空。compose 已设 `stop_grace_period: 40s`，与应用 25s 宽限 + 35s 硬超时对齐。

## 5. 验证步骤

### 5.1 容器与端口

```bash
docker compose ps
# 三服务均 running (healthy)
docker port yuanjian-console   # 3000/tcp -> 0.0.0.0:8860
docker port yuanjian-npm       # 3000/tcp -> 0.0.0.0:8861
docker port yuanjian-pypi      # 3000/tcp -> 0.0.0.0:8862
```

### 5.2 容器内健康检查（最可靠）

若宿主机已有其他服务占用 8860 端口，`curl 127.0.0.1:8860` 可能打到错误进程。**始终用容器内探活判定**：

```bash
for s in console npm pypi; do
  docker compose exec -T $s node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(d=>console.log('$s',r.status,d.data.status,d.data.env))" 2>/dev/null
done
```

健康响应应为 `status=ok`、`env=production`、`dataDir=/var/lib/yuanjian/data`。

### 5.3 三协议入口与跨容器互通

```bash
docker compose exec -T console node -e "fetch('http://127.0.0.1:3000/').then(r=>console.log('console / =>',r.status))"
docker compose exec -T npm node -e "fetch('http://127.0.0.1:3000/npm/-/ping').then(r=>console.log('npm ping =>',r.status))"
docker compose exec -T pypi node -e "fetch('http://127.0.0.1:3000/pypi/simple/').then(r=>console.log('pypi simple =>',r.status))"
docker compose exec -T pypi node -e "fetch('http://console:3000/api/v1/health').then(r=>console.log('pypi->console =>',r.status))"
# 四条都应输出 200
```

### 5.4 关键业务链路（实测 10/10 通过）

1. 浏览器打开 `http://<PUBLIC_BASE_URL>`，用初始管理员登录，首登强制改密。
2. 改密后从 `.env.production` 删除 `INITIAL_PASSWORD_ADMIN`，`docker compose up -d` 重建容器。
3. 控制台「批量导入」上传一个 npm tarball → 自动识别 → 校验 → 提交入库。
4. 客户端验证：

```bash
npm config set registry http://<NPM_BASE_URL>/npm/
npm view <刚导入的包名> version          # 应返回版本号
pip index versions <包名> -i http://<PYPI_BASE_URL>/pypi/simple/
```

5. 控制台查看审计日志，确认上述操作均已记录。

### 5.5 数据持久化

```bash
docker compose down
docker compose up -d
# 重新登录后：之前导入的包、改过的口令、审计日志都应仍在
```

## 6. 备份与审计转储（可选，部署阶段可整节跳过）

> **不配置不影响 `docker compose up -d`，也不影响业务运行。** 这是上线后的运维任务：不建目录、不装 cron，服务照常启动。需要备份时按本节一次性配置即可。

镜像内已装 `sqlite3` CLI，宿主 cron 调临时容器执行（脚本在镜像 `/app/scripts/`）。卷全名为 `yuanjian_data`。

**备份目录地址（宿主路径，需自行创建）** —— 以下目录**不在** compose 的 `volumes` 声明中，是 cron 用 `-v` 绑定的宿主目录，compose 不会自动创建，须先按下方命令建好并授权：

| 用途 | 宿主目录（地址） | 临时容器内挂载点 | 产物 |
| --- | --- | --- | --- |
| 一致性备份归档 | `/srv/yuanjian-backups` | `/backups` | `yuanjian-<时间戳>.tar.gz` 及同名 `.sha256` |
| 审计日志转储 | `/srv/yuanjian-audit-dump` | `/dump` | `*.jsonl` 快照（0444 只读） |
| cron 运行日志 | `/var/log/yuanjian-backup.log`、`/var/log/yuanjian-audit-dump.log` | — | 脚本 stdout/stderr |
| 业务数据卷 | Docker named volume `yuanjian_data` | `/var/lib/yuanjian/data` | `platform.db`、`objects/` 等 |

目录属主必须为 `10001:10001`（镜像内 `yuanjian` 用户），否则脚本无权写入。备份保留 `RETAIN_DAYS=14` 天（`backup.sh` 默认，加 `--prune` 才清理），审计转储 `AUDIT_RETENTION_DAYS=365` 天（低于 180 会被脚本拒绝，等保审计留存底线）。

```bash
sudo mkdir -p /srv/yuanjian-backups /srv/yuanjian-audit-dump
sudo chown 10001:10001 /srv/yuanjian-backups /srv/yuanjian-audit-dump
```

**整机备份推荐用一键脚本**（幂等装 cron + 字典总闸 + 状态/异常记录，详见 `docs/BACKUP_RESTORE.md` 第 2 节）：

```bash
sudo /opt/yuanjian/deploy/backup-control.sh enable    # 建目录授权、装 cron、立即验证一次
sudo /opt/yuanjian/deploy/backup-control.sh status    # 查状态 / cron / 字典开关 / 归档 / 异常
sudo /opt/yuanjian/deploy/backup-control.sh disable   # 停用（不动数据）
```

脚本会在每次备份前读字典 `backup.enabled`：设为 `false` 即跳过备份、已有归档保留；改回 `true` 自动恢复，无需改 cron。重复 `enable` 不会叠加 cron 条目。

等价的手工 crontab（审计转储无一键脚本，仍用手工行）。下例按 arm64 写；amd64 机器把 `yuanjian:arm64` 换成 `yuanjian:amd64`：

```cron
10 2 * * * cd /opt/yuanjian && docker run --rm -v yuanjian_data:/var/lib/yuanjian/data -v /srv/yuanjian-backups:/backups -e DATA_DIR=/var/lib/yuanjian/data -e BACKUP_ROOT=/backups -u 10001:10001 yuanjian:arm64 /app/scripts/backup.sh --prune >> /var/log/yuanjian-backup.log 2>&1
20 2 * * * cd /opt/yuanjian && docker run --rm -v yuanjian_data:/var/lib/yuanjian/data -v /srv/yuanjian-audit-dump:/dump -e DATA_DIR=/var/lib/yuanjian/data -e AUDIT_DUMP_DIR=/dump -e AUDIT_RETENTION_DAYS=365 -u 10001:10001 yuanjian:arm64 node /app/scripts/audit-dump.mjs >> /var/log/yuanjian-audit-dump.log 2>&1
```

**必须配成功哨兵监控**：cron 退出码和日志容易被忽略。曾实测发现旧脚本因镜像缺 `rsync` 每天静默失败、零归档却无人察觉。用这条检查"今天有没有新归档"，缺失即告警（接入你的监控/钉钉/邮件）：

```bash
# 退出码 0 = 今日备份存在；1 = 缺失，需立即排查
test -n "$(find /srv/yuanjian-backups -name 'yuanjian-*.tar.gz' -mtime -1 -print -quit)" \
  && echo "backup OK" || echo "ALERT: 24h 内无新备份归档"
```

**备份与数据分机/分盘**：上面的 `/srv/yuanjian-backups` 与数据卷 `yuanjian_data` 在同一台机器，能防误删/逻辑损坏，但防不了主机硬件故障或机房灾难。生产环境须每日把归档 `scp`/`rsync` 到另一台机器或对象存储，保留期按等保要求 ≥180 天。

恢复前先 `docker compose down`，用 `restore.sh <归档> /var/lib/yuanjian/data --force`，再 `up -d`。

## 7. 升级与回滚

```bash
# 升级前备份
docker compose down
# 传入新版镜像：docker load -i <新归档>
docker compose up -d
docker compose ps    # 确认 healthy
```

回滚：停服 → `docker load` 旧版镜像 → 启动；涉及数据库变更时先用第 6 节备份恢复。

## 8. 常见问题处理

| 现象 | 原因与处理 |
| --- | --- |
| 只改了 5 项就 `up -d`，没建备份目录、没管 METRICS_TOKEN | **正常**。令牌已预置在模板中，备份属可选运维，两者都不影响启动。只有三个基址和初始口令必须按内网实际填写 |
| 容器反复重启，日志「生产环境配置校验未通过」 | 三个基址必须是 `http://`（或配 https 并移除豁免）；镜像内 Node ≥22.5（**由镜像提供，宿主无需安装**）；数据目录可写。查 `docker compose logs console` |
| 健康端点 `env=development` 或 `dataDir` 是宿主路径 | `curl 127.0.0.1:8860` 打到了宿主机残留进程。用第 5.2 节的容器内探活判定，别被误导 |
| npm 安装 404、tarball 地址指向控制台 | `NPM_BASE_URL` / `PYPI_BASE_URL` 漏配；查健康端点 `endpoints` 字段 |
| 包校验提示 `engines.node=... 与默认目标 Node ... 不一致` | **正常提示，不阻断入库**。平台为通用源，运行时元数据只告警，由 `npm` 按客户端环境挑选。写成 `>=18` 这类范围值会让提示文案失真（建议填具体版本号如 `22.23.5`），但不再导致无法入库 |
| 批次校验 valid=0 且无上述错误 | 查批次明细 `GET /api/v1/import-batches/<id>` 的 `reasonCodes`；重复版本是 `PKG_VERSION_DUPLICATE`，换包名重测 |
| `database is locked` | 卷必须是本地卷，禁止 NFS/跨主机；确认只有一个 compose 项目操作该卷 |
| `docker compose ps --format '{{.Name}}'` 报 `parsing failed` | Compose 2.10.2 不支持 Go 模板格式化，去掉 `--format` 或用 `docker port` |
| nginx 容器 `restarting`，日志 `cannot load certificate` | 预留网关缺证书，属预期。当前直连形态不需要它：`docker compose stop nginx && docker compose rm -f nginx`。要启用须先按 `docs/CONTAINER_DEPLOYMENT.md` 第 7 节放证书并切 https 基址 |
| 退出码 143 被监控判定为崩溃 | Nest 优雅停机后主动重发 SIGTERM，143 是预期；compose 已用 `unless-stopped` |
| 日志出现明文 HTTP 告警 | 已设 `ALLOW_INSECURE_BASE_URL=true` 的预期提示；若网络隔离不到位，切网关模式消除风险 |

## 9. 已知约束

- 单主机部署：SQLite WAL 跨主机文件锁不可靠，不支持 swarm/K8s 多副本共享同一卷。
- HTTP 直连：登录态与令牌明文传输，依赖内网隔离；切网关模式可消除。
- 网关配置未实机验收（缺证书场景已验证其行为符合预期）；启用前需重新走一遍第 5 节验证。
- 应用镜像构建时 `npm ci` 报告 10 个依赖漏洞（6 moderate / 4 high），来自间接依赖。不影响本次功能验证，但建议后续安排依赖升级评估。

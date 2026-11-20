# 生产部署手册（内网单机）

本文是**唯一权威的部署与运维入口**，整合离线交付、生产配置、systemd 托管、验收、备份恢复、监控告警与升级回滚。当前部署形态为**明文 HTTP 直连**（暂未取得内网 CA 证书；证书就位后按第 6 章切回 TLS 网关）。开发者本地运行见根目录 [README.md](../README.md)。

## 0. 适用范围与交付物

| 项 | 说明 |
| --- | --- |
| 适用形态 | 单机、单进程、SQLite + 本地磁盘；部门级内网私有源（≤300 开发者） |
| 目标系统 | Linux + systemd ≥ 245（Nginx ≥ 1.18 为可选，切回 TLS 网关时才需要） |
| 不适用 | 企业级 SLA / 等保三级 / 多实例高可用（需架构升级，见 `ARCHITECTURE_FITNESS.md` 第 8 章） |

代码仓内与本手册配套的交付物：

| 路径 | 用途 |
| --- | --- |
| `deploy/yuanjian.service` | systemd unit（自愈、沙箱、资源上限） |
| `deploy/nginx-yuanjian.conf` | Nginx 站点样例（**可选**，仅在切回 TLS 网关时使用） |
| `scripts/build-offline.sh` / `install-offline.sh` | 离线包构建与目标机安装 |
| `scripts/backup.sh` / `restore.sh` | 一致性备份与恢复 |
| `docs/OFFLINE_DELIVERY.md` | 离线产物结构与降级策略 |
| `docs/BACKUP_RESTORE.md` | 备份范围、RPO/RTO、演练步骤 |
| `docs/ALERT_RULES.md` | `/metrics` 抓取配置与 16 条告警规则 |
| `docs/USER_GUIDE.md` | 控制台与 npm / pip / twine 客户端接入 |

## 1. 目标环境与前置检查

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Node.js | ≥ 22.5，推荐 24 LTS | `node -v` |
| npm | ≥ 10，且主版本与构建机一致（离线缓存兼容） | `npm -v` |
| systemd | ≥ 245 | `systemctl --version` |
| Nginx | ≥ 1.18（需 `http2 on` 语法，1.25.1+；**可选**，切网关时才需要） | `nginx -v` |
| 时钟 | 已接入内网 NTP（会话与审计时间依赖可信时钟） | `timedatectl status` |
| 磁盘 | `/var/lib/yuanjian` 独立分区，预留 ≥ 3 倍首年包体量 | `df -h /var/lib/yuanjian` |
| 端口 | 3000 对研发网段可达；防火墙拒绝其他来源 | `ss -lntp` |
| 证书 | 当前直连形态不需要（切回 TLS 网关时需内网 CA 签发的 `yuanjian.<域名>` 证书与私钥） | — |

安全基线（本手册不含，由主机加固模板补齐）：磁盘加密（LUKS）用于静态数据保密性，主机防火墙仅放行研发网段访问 3000（**明文 HTTP 直连形态下网络隔离是唯一补偿控制，必须落实**），审计日志采集端接入。

## 2. 目录与账号

| 路径 | 用途 | 归属与权限 |
| --- | --- | --- |
| `/opt/yuanjian` | 代码、`dist/`、`node_modules/`、`public/`、`deploy/`、`docs/`、`.env.production` | `yuanjian:yuanjian`，运行期只读（`ProtectSystem=strict`） |
| `/var/lib/yuanjian/data` | `DATA_DIR`：`platform.db`、`objects/`、`tmp/`、`batches/` | `yuanjian:yuanjian` 可写 |
| `/var/lib/yuanjian/quarantine` | `QUARANTINE_DIR`：隔离样本（建议独立卷） | 目录 0700、文件 0600（启动自动修正） |
| `/etc/nginx/ssl` | 服务证书与私钥（**可选**，切回 TLS 网关时使用） | `root:root` 600 |

```bash
# 专用低权账号：无登录 shell，不可提权
sudo useradd --system --home /var/lib/yuanjian --shell /usr/sbin/nologin yuanjian
sudo mkdir -p /opt/yuanjian /var/lib/yuanjian/data /var/lib/yuanjian/quarantine
sudo chown -R yuanjian:yuanjian /var/lib/yuanjian
sudo chmod 700 /var/lib/yuanjian/quarantine
```

> 隔离区与业务数据**不同卷**是有意设计：恶意样本随常规备份扩散时，可单独排除该卷。

## 3. 离线安装

在可联网构建机出包，目标机断网安装：

```bash
# 构建机
./scripts/build-offline.sh           # 产物默认在 ./dist-offline
# 产物：yuanjian-app-<版本>-<日期>.tar.gz / yuanjian-npm-cache-... / yuanjian-node_modules-... / MANIFEST.sha256

# 目标机（先校验再安装）
sha256sum -c MANIFEST.sha256
./scripts/install-offline.sh /opt/yuanjian/delivery /opt/yuanjian
```

关键约束（详见 `docs/OFFLINE_DELIVERY.md`）：

- 缓存不可用时**拒绝自动降级**，必须显式加 `--fallback-node-modules`。
- 目录非空且未加 `--force` 时拒绝安装，不会静默覆盖；旧目录保留为 `app.pre-install-<时间戳>`。
- `npm ci --offline --ignore-scripts`，不执行依赖生命周期脚本。

## 4. 生产配置

```bash
sudo tee /opt/yuanjian/.env.production >/dev/null <<'EOF'
NODE_ENV=production
PORT=3000
# 直连形态监听所有网卡（可改为内网网卡 IP 更收敛）；切回 Nginx 网关后改回 127.0.0.1
BIND_HOST=0.0.0.0
PUBLIC_BASE_URL=http://yuanjian.example.internal
# 明文 HTTP 直连豁免：生产模式必须显式设置，否则启动护栏拒绝 http:// 基址
ALLOW_INSECURE_BASE_URL=true
DATA_DIR=/var/lib/yuanjian/data
QUARANTINE_DIR=/var/lib/yuanjian/quarantine
# 扫描记录/报告/埋点保留天数（RV-26）：超期自动清理但每个版本保留最近一次扫描；0 表示关闭
SECURITY_SCAN_RETENTION_DAYS=180

# 首次启动建号用的初始管理员（用户表非空后不再生效；建号成功后从该文件移除）
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<一次性强口令，≥8 位且不含用户名>

# 口令策略与失败锁定
PASSWORD_MIN_LENGTH=8
LOGIN_MAX_FAILURES=5
LOGIN_LOCK_MINUTES=15

METRICS_TOKEN=<随机值，≥32 字符>
LOG_LEVEL=info
LOG_FORMAT=json

# 时钟观测（可选）
# NTP_SERVER=ntp.example.internal
EOF
sudo chown yuanjian:yuanjian /opt/yuanjian/.env.production
sudo chmod 600 /opt/yuanjian/.env.production
```

**启动期强制护栏**（任一不满足即 `exit 1` 并打印全部问题，`NODE_ENV=production` 时生效）：

| 校验项 | 要求 |
| --- | --- |
| `BOOTSTRAP_ADMIN_PASSWORD` | 若配置则必须满足强度：≥ `PASSWORD_MIN_LENGTH` 位、不含用户名、非常见弱口令 |
| `PUBLIC_BASE_URL` | 必须 `https://`；当前直连形态需显式 `ALLOW_INSECURE_BASE_URL=true`，启动时打印明文告警 |
| Node.js | ≥ 22.5 |
| `DATA_DIR` | 可创建且可写 |
| `QUARANTINE_DIR` | 独立挂载时须存在且可写 |

全量环境变量（含扫描、磁盘水位、停机、限流、隔离区）见 [README 第 4.1 节](../README.md#41-环境变量)。

## 5. systemd 托管

```bash
sudo cp deploy/yuanjian.service /etc/systemd/system/yuanjian.service
sudo systemctl daemon-reload
sudo systemctl enable --now yuanjian
sudo systemctl status yuanjian                  # 应为 active (running)
journalctl -u yuanjian -n 50 --no-pager         # 应为单行 JSON 日志
curl -fsS http://127.0.0.1:3000/api/v1/health
```

unit 关键项与理由：

| 配置 | 值 | 理由 |
| --- | --- | --- |
| `Restart` / `RestartSec` | `always` / `3` | `kill -9`、OOM、未捕获异常后 3 秒自动拉起 |
| `StartLimitIntervalSec` / `Burst` | `120` / `10` | 连续崩溃 10 次进入 failed，避免 crash loop 打满 CPU |
| `KillSignal` / `TimeoutStopSec` | `SIGTERM` / `40s` | 触发应用内排空（宽限 25s + 看门狗 35s），40s 仅作 systemd 兜底 |
| `MemoryMax` | `1536M` | 高于 `YuanjianMemoryHigh` 1.2G 告警线，兜住扫描 worker 512MB 堆与大包发布峰值 |
| `LimitNOFILE` | `65536` | tarball 高频读写 + keepalive 长连接 |
| `ProtectSystem=strict` + `ReadWritePaths` | `/var/lib/yuanjian` | 运行期全盘只读，仅数据目录可写 |
| `CapabilityBoundingSet=` | 空 | 监听 3000 非特权端口，无需任何 capability |

> `ExecStart` 的 Node 路径按实际安装方式调整（NodeSource 为 `/usr/bin/node`，nvm 为 `~/.nvm/...`）。

## 6. Nginx TLS 网关（可选：证书就位后切回）

当前为**明文 HTTP 直连**形态（暂未取得内网 CA 证书）。本章保留为切回路径，内网 CA 证书签发后按以下步骤切换：

**步骤 1：安装网关配置**

```bash
# 证书放置 /etc/nginx/ssl/ 后执行
sudo cp deploy/nginx-yuanjian.conf /etc/nginx/conf.d/yuanjian.conf
# 替换 server_name 与证书路径为实际值
sudo nginx -t && sudo systemctl reload nginx

curl -fsSI https://yuanjian.example.internal/api/v1/health      # 200 + X-Trace-Id
curl -fsSI http://yuanjian.example.internal/ | head -1          # 301
```

**步骤 2：切换应用配置**（`.env.production`）：`PUBLIC_BASE_URL=https://…`、删除 `ALLOW_INSECURE_BASE_URL=true`、`BIND_HOST=127.0.0.1`。

**步骤 3：** `sudo systemctl restart yuanjian`，重跑第 7 章验收清单第 5/6/7 项（traceId、TLS/HSTS、200MB 上传，走 https 入口）。

**步骤 4：通知客户端** 地址由 `http://` 切为 `https://`（域名不变，仅 lockfile resolved 协议变化；npm 侧需重新 `npm login`）。

网关约定（切回后生效）：

- 唯一入口 `https://yuanjian.example.internal`，TLS 1.2/1.3 + HSTS 一年；80 仅跳转。
- `client_max_body_size 300m` 略高于应用 `MAX_NPM_PUBLISH_BYTES`（默认 288MB，容纳 200MB 包体的 base64 请求），网关只兜底不截断。
- `/metrics` 在网关返回 404：Prometheus 与应用同机，直连 `http://127.0.0.1:3000/metrics` 并带 `METRICS_TOKEN`。
- `X-Request-Id` 取 Nginx `$request_id`，应用复用为 traceId 并回发 `X-Trace-Id`，实现网关日志、应用日志、审计记录三方关联。
- `BIND_HOST=127.0.0.1` 让应用只接受网关流量，杜绝绕过限流与 TLS 直连。

> 直连形态下的对应行为：`X-Request-Id` 透传仍然可用（应用直接复用客户端携带的请求头）；`/metrics` 由 `METRICS_TOKEN` 鉴权保护，外部暴露面依赖防火墙把 3000 收敛到研发网段。

## 7. 首次验收清单

| # | 项 | 命令或判定 |
| --- | --- | --- |
| 1 | 进程自愈 | `PID=$(systemctl show -p MainPID --value yuanjian); sudo kill -9 "$PID"; sleep 5; systemctl is-active yuanjian` → `active` |
| 2 | 健康检查 | `curl -fsS http://127.0.0.1:3000/api/v1/health` → `status: ok`，`env` 为 `production` |
| 3 | 协议探活 | `/npm/-/ping` 返回 `{}`；`/pypi/simple/` 返回 200 |
| 4 | 认证链路 | 用初始管理员登录 → 强制改密 → 创建普通账号；退出后 `/api/v1/auth/me` 返回 401 + traceId |
| 5 | traceId 贯通 | `curl -fsSI -H 'X-Request-Id: e2e-verify-0001' http://yuanjian.example.internal/api/v1/health`，响应 `X-Trace-Id` 应为 `e2e-verify-0001`，并在审计 CSV 中可检索 |
| 6 | 网络隔离 | 从非授权网段（办公网/DMZ 等）访问 3000 应被防火墙拒绝；`ss -lntp` 确认监听地址与 `BIND_HOST` 一致 |
| 7 | 200MB 上传 | 经直连入口用 twine / npm publish 上传 200MB 包并确认入库（业务上限 `MAX_NPM_UPLOAD_BYTES` / `MAX_PYPI_UPLOAD_BYTES` 默认 200MB，可在字典管理调整；HTTP 天花板 288MB，网关 300m） |
| 8 | 指标抓取 | 本机 `curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics` → 22 项 `yj_*` |
| 9 | 淘汰样本隔离 | 上传含 critical 风险的样本 → 403 `SEC_BLOCKED`；含 high → 409 `SEC_QUARANTINED`，隔离目录权限 0700/0600 |
| 10 | 备份恢复演练 | 执行 `scripts/backup.sh`，在测试目录 `restore.sh` 还原后 `PRAGMA integrity_check` 为 `ok`（见 `docs/BACKUP_RESTORE.md`） |
| 11 | 漏洞库导入 | 控制台导入 CVE/CNVD/OSV 快照，`POST /api/v1/security/rescan` 返回统计 |
| 12 | 审计转储 | `scripts/audit-dump.mjs` 退出码 0 且哈希链校验通过，快照行数与库内 `COUNT(*)` 一致（见 8.1 节） |

验收完成后将结果写入上线记录（含每项的命令输出片段与时间）。

## 8. 备份与恢复

```bash
# 每日备份（cron 建议 02:30，先摘流或确认低峰）
sudo -u yuanjian DATA_DIR=/var/lib/yuanjian/data QUARANTINE_DIR=/var/lib/yuanjian/quarantine \
  /opt/yuanjian/scripts/backup.sh /var/backups/yuanjian
```

- 备份内容：SQLite 一致性快照（`sqlite3 .backup`，非直接拷贝）、`objects/`、批次元数据；**默认排除隔离区**。
- RPO = 备份间隔（建议 24h）；RTO ≈ 恢复脚本耗时 + 服务启动（分钟级）。
- 恢复后必须校验 `PRAGMA integrity_check = ok` 并抽查 3 个包的下载哈希。
- 异地/离线副本尚未自动化，需按主机备份策略另行落实。

### 8.1 审计日志转储（C-04，上线前必须项）

审计日志除库内哈希链外，必须每日转储到**独立只读存储**（独立挂载卷，与 `DATA_DIR` 物理隔离），留存 ≥180 天：

```bash
# 转储目录建议挂载为独立卷（如 /var/lib/yuanjian/audit-dump），并从应用可写路径中隔离
sudo -u yuanjian AUDIT_DUMP_DIR=/var/lib/yuanjian/audit-dump \
  node /opt/yuanjian/scripts/audit-dump.mjs

# crontab 示例（每日 02:10 全量快照，当日重复执行幂等覆盖）
10 2 * * * cd /opt/yuanjian && AUDIT_DUMP_DIR=/var/lib/yuanjian/audit-dump node scripts/audit-dump.mjs >> logs/audit-dump.log 2>&1
```

脚本行为（`scripts/audit-dump.mjs`）：

- 全量导出 `audit_logs` 为 `audit-logs-<日期>.jsonl`，写完置 `0444` 只读防篡改；
- 导出前重算哈希链：校验失败时文件名带 `.BROKEN` 后缀保留取证、退出码 1（应立即排查审计篡改风险）；
- `AUDIT_RETENTION_DAYS` 控制转储目录内旧快照清理，默认 365 天，**低于 180 天拒绝执行**（等保审计留存底线）；
- `--db` 可指定库路径（默认 `$DATA_DIR/platform.db`），`--out` 等价于 `AUDIT_DUMP_DIR`。

验收：跑一次脚本退出码 0、快照行数与 `SELECT COUNT(*) FROM audit_logs` 一致；篡改演练（在库副本上改一行审计）退出码 1 并产出 `.BROKEN` 文件。

## 9. 监控与告警

| 项 | 配置 |
| --- | --- |
| 抓取 | `http://127.0.0.1:3000/metrics`，`Authorization: Bearer <METRICS_TOKEN>`，间隔 30s；直连形态下 `/metrics` 随 3000 端口对外可达，依赖 `METRICS_TOKEN` 鉴权 + 防火墙仅放行研发网段 |
| 指标 | 22 项 `yj_*`：请求、扫描队列与耗时、隔离区规模、磁盘水位、NTP 偏移、进程重启 |
| 告警 | 16 条规则（含 `yuanjian-quarantine` 组），分级与排查路径见 `docs/ALERT_RULES.md` |
| 日志 | `journalctl -u yuanjian`（单行 JSON），由 journald/filebeat 采集，保留 ≥ 180 天 |
| 关键阈值 | 磁盘 85% 告警 / 95% 或剩余 <1GiB 只读降级（507）；RSS 1.2G 告警；时钟偏移 >1000ms |

## 10. 升级、回滚与停机摘流

**维护窗口标准动作（直连形态）**

1. **摘流（可选）**：直连形态无网关维护块。需严格摘流时，临时用防火墙拦截 3000 端口新连接（保留 established 连接让在途请求完成）；内网低峰窗口也可直接进入第 3 步。
2. **备份**：执行 `backup.sh`（升级前必做）。
3. **停机**：`sudo systemctl stop yuanjian`。SIGTERM 触发 A-07 优雅停机：在途请求排空（宽限 25s + 看门狗 35s），排空期间新请求收到 503 + `Retry-After: 5`；`journalctl -u yuanjian` 确认停机完成日志。
4. **替换**：`install-offline.sh <新交付目录> /opt/yuanjian --force`，旧目录保留为 `app.pre-install-<时间戳>`。
5. **启动**：`sudo systemctl start yuanjian`，轮询 `http://127.0.0.1:3000/api/v1/health` 为 200，回滚防火墙摘流规则。
6. **记录**：维护起止时间入值守记录（`YuanjianRestarted` 告警会计数，属预期）。

**回滚**：停服 → 将 `app.pre-install-<时间戳>` 改回 `app` → 启动；若涉及数据库变更，先按 `restore.sh` 回退到升级前备份。

> 禁止 `kill -9` 作为常规停服手段（A-07 排空不会执行）；仅当进程无响应且已摘流时使用。

## 11. 已知边界

- systemd 未启用 `SystemCallFilter`（低版本 glibc/内核兼容风险），由主机加固基线补齐。
- **明文 HTTP 直连**：会话 Cookie 无 Secure 属性，登录态与 API Token 在内网明文传输、可被嗅探；网络隔离（防火墙仅放行研发网段访问 3000）是唯一补偿控制，必须落实并在风险清单登记；证书就位后按第 6 章切回 TLS 网关。
- Nginx 默认缓冲请求体：200MB 上传先落 `client_body_temp` 再转发，需保证该分区约 1GB 余量（**仅切回网关后适用**）。
- 证书轮换与 Nginx 自身监控（`nginx_exporter`）不在交付范围（仅切回网关后相关）。
- 静态数据未做应用层加密，保密性依赖磁盘加密卷。
- 单点部署：进程/主机/磁盘任一故障即中断服务，RTO 取决于值守响应；`Restart=always` 只覆盖进程级故障。
- 审计日志已支持每日转储独立只读存储（8.1 节，C-04 已闭环）：库内哈希链可发现篡改；转储目录须挂载独立卷并纳入主机备份策略，**异地留存仍需按主机备份策略另行落实**。

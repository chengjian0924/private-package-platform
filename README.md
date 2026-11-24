# 源鉴 · 内网依赖安全治理平台（MVP）

> 项目代号：**源鉴**（YuanJian）——内网私有源如镜，依赖入库先经鉴。控制台标识为 `YJ`。

面向研发团队的内网 npm / PyPI 私有源与依赖包治理平台。MVP 只保留支撑核心价值的最小功能集合：**私有源发布与消费、管理员批量导入、缺失依赖自助补包、本地账号认证、审计追溯、上传包六维安全校验**，不包含证书签发、配额、审批流等非核心能力。

> 生产部署（systemd + Nginx + 离线安装 + 备份恢复 + 验收清单）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 0. 项目状态与文档索引

**当前状态（2026-11-16）**：A 批次（A1–A4、A-03~A-07）与 B 批次（B1–B6）全部完成，15 套件 / 83 用例全绿，架构复评 76.3 / 100（单机部门级「有条件满足」）。待目标 Linux 主机按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 第 7 节完成 A4 验收；未开始项为 C-04 审计转储与 C1–C4 架构升级。

| 文档 | 内容 |
| --- | --- |
| [YUANJIAN_PROJECT_HANDOFF.md](YUANJIAN_PROJECT_HANDOFF.md) | 进度存档：现状、已完成/待办、问题台账、关键决策、实现细节、历史对话 |
| [docs/源鉴设计方案-v1.0.md](docs/源鉴设计方案-v1.0.md) | 设计方案 v1.0（13 章）：接口字段表、6 个状态机、10 域错误码表 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 生产部署手册：离线安装、生产配置与启动护栏、systemd、Nginx TLS、验收清单、备份、监控、升级回滚 |
| [docs/ARCHITECTURE_FITNESS.md](docs/ARCHITECTURE_FITNESS.md) | 架构适配性评估：五维评分、问题台账、整改路线、上线风险清单 |
| [docs/DESIGN_REVIEW.md](docs/DESIGN_REVIEW.md) | 安全校验设计评审：34 项问题、复审门槛、回归清单 |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | 备份范围、RPO/RTO、脚本用法与验收标准 |
| [docs/MISSING_REPORT_CI.md](docs/MISSING_REPORT_CI.md) | 缺包上报接入 CI：零依赖脚本、差集探测、`gaps.json` 格式、GitLab/Jenkins 示例 |
| [docs/OFFLINE_DELIVERY.md](docs/OFFLINE_DELIVERY.md) | 离线交付三类产物、断网安装、降级策略 |
| [docs/ALERT_RULES.md](docs/ALERT_RULES.md) | Prometheus 抓取配置、22 项指标、16 条告警规则 |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Web 控制台与 npm / pip / twine 客户端使用指引 |

## 1. 技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5（推荐 24+） | 使用内置 `node:sqlite`，无原生编译依赖 |
| Web 框架 | NestJS 10 + Express | 成熟生态，模块化清晰，便于后续拆分 |
| 语言 | TypeScript 5.6（strict） | 编译期类型约束 |
| 持久化 | SQLite（WAL 模式） | 单机内网场景零运维，数据文件可备份 |
| 包文件存储 | 内容寻址文件存储 | `objects/<sha256前2位>/<sha256>`，写入采用临时文件 + fsync + 原子 rename |
| 认证 | 本地账号密码（scrypt）+ 会话 Cookie + API Token | 管理员唯一（首启创建，不可新建/提升/降级/禁用）、普通账号按角色建号、首登强制改密、失败锁定；无外部 IdP 依赖 |
| 前端 | 原生 HTML / CSS / JavaScript | 无前端构建链，降低部署与维护成本 |
| 测试 | Jest + ts-jest + Supertest | 端到端覆盖核心路径，真实 HTTP 服务验证 |

## 2. 目录结构

```
private-package-platform/
├── .env.development        # 开发环境配置（端口 3000，data/dev）
├── .env.test               # 测试环境配置（端口 3100，data/test）
├── public/                 # Web 控制台（index.html / styles.css / app.js）
├── deploy/                 # yuanjian.service / nginx-yuanjian.conf 部署样例
├── docs/                   # 部署与运维文档（DEPLOYMENT / ALERT_RULES / BACKUP_RESTORE / OFFLINE_DELIVERY / USER_GUIDE / MISSING_REPORT_CI / DESIGN_REVIEW）
├── scripts/                # audit-dump.mjs / osv-sync.mjs / ci-report-missing.mjs / ci-provision-account.mjs / backup.sh / restore.sh / build-offline.sh / install-offline.sh
├── src/
│   ├── auth/               # 本地账号口令、会话、API Token、用户管理、鉴权守卫
│   ├── packages/           # 包元数据、版本、清单与包文件校验（S1-S5）
│   ├── registry-npm/       # npm registry 协议（ping/whoami/login/publish/packument/tarball/search）
│   ├── registry-pypi/      # PyPI 协议（PEP 503 simple / twine 上传 / 下载）
│   ├── import/             # 批量导入批次、全量校验、入库、报告
│   ├── missing/            # 缺失依赖上报、去重、补包
│   ├── security/           # 上传包六维安全校验、分级处置、隔离区、漏洞库、定期复检、扫描 worker
│   ├── audit/              # 审计日志与 CSV 导出（哈希链）
│   ├── telemetry/          # 埋点事件（A4 裁剪后保留）
│   ├── certificates/       # A4 预留空模块
│   ├── storage/            # 内容寻址对象存储
│   ├── db/                 # SQLite 连接与表结构
│   ├── metrics/            # Prometheus 指标与 /metrics
│   └── common/             # 错误码、异常过滤器、响应信封、traceId、日志、安全头/限流、时钟
├── test/                   # e2e 测试（30 套件 196 用例）
├── package.json
├── jest.config.js
├── tsconfig.json
└── tsconfig.build.json
```

运行时数据目录（默认 `./data/<env>`）由程序自动创建，包含 `platform.db`、`objects/`、`tmp/`，**不随代码包分发**。

## 3. 环境要求

- Node.js ≥ 22.5（推荐 24+；22.x 需 `NODE_OPTIONS=--experimental-sqlite`）
- npm ≥ 10
- 无需 Docker、无需数据库服务、无需 Python 运行时

## 4. 安装与启动

```bash
cd private-package-platform
npm install       # 安装依赖（首次执行）
npm run build     # tsc 编译到 dist/

npm run start     # 开发环境：http://localhost:3000，数据目录 data/dev
npm run start:test# 测试环境：http://localhost:3100，数据目录 data/test（与开发完全隔离）
```

两套环境通过 `node --env-file` 加载各自配置文件，**端口、数据目录、会话有效期、初始管理员与口令策略全部独立**。

### 4.1 环境变量

基础与认证：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `test` | 运行环境标识 |
| `PORT` | `3000` | `3100` | 监听端口 |
| `DEPLOY_MODE` | `direct` | 同左 | 部署形态：`direct`（默认，端口直连）或 `gateway`（统一网关）。**只有** gateway 形态护栏才强制 `BIND_HOST=127.0.0.1`，直连形态保持 `0.0.0.0` 不会被拒绝启动。该值同时决定限流/审计/日志的来源 IP 口径：direct 忽略 `X-Forwarded-For` 只取 TCP 对端（客户端伪造头无效）；gateway 只取网关注入的 XFF 最后一跳，忽略可伪造的前缀 |
| `BIND_HOST` | `0.0.0.0` | 同左 | 监听地址；direct 形态保持 `0.0.0.0`（Docker 的 8860/8861/8862 → 3000 映射依赖），gateway 形态必须 `127.0.0.1`，IPv6-only 内网设 `::` |
| `DATA_DIR` | `./data/dev` | `./data/test` | SQLite 与包文件根目录 |
| `DICTIONARY_SYNC_INTERVAL_MS` | `1000` | `1000` | 字典覆盖层跨进程回读间隔（毫秒，0–60000，0 表示每次读取都回读）；三角色共享同一库，字典保存后其他进程在该间隔内自动同步，无需重启 |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | `http://localhost:3100` | 生成 tarball / 下载地址的基址 |
| `ALLOW_INSECURE_BASE_URL` | `false` | `false` | 显式豁免生产环境 `http://` 基址（A1）；当前生产为 HTTP 直连形态需设 `true`，切回 TLS 网关后必须改回 `false` |
| `SESSION_TTL_SEC` | `28800` | `7200` | 会话绝对有效期（秒） |
| `SESSION_IDLE_TTL_SEC` | `1800` | `900` | 会话空闲超时（秒） |
| `AUTH_CACHE_TTL_MS` | `5000` | `5000` | 鉴权决策缓存 TTL（毫秒）。缓存键含角色，角色变更即时生效，不再有 TTL 内的旧权限窗口 |
| `API_TOKEN_TTL_DAYS` | `90` | `90` | 新签发 API 令牌的默认有效期（天），`0` 表示不过期；创建/签发界面可选 30/60/90/180/365 天或永不过期，也可用 `expiresInDays` 单独指定，存量令牌不受影响 |
| `PASSWORD_MIN_LENGTH` | `8` | `8` | 口令最小长度（8–64）；生产环境在 `deploy/.env.production` 中同样设为 `8`；建号初始口令为 16 位随机串 |
| `LOGIN_MAX_FAILURES` | `5` | `5` | 连续失败达到该次数锁定账号 |
| `LOGIN_LOCK_MINUTES` | `15` | `15` | 锁定时长（分钟），到期自动解锁 |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | `admin` | 首启建号的管理员名；用户表非空时不生效 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 示例值 | 示例值 | 仅首启建号用；生产会校验强度（≥ `PASSWORD_MIN_LENGTH` 位、不含用户名、非弱口令），建号后必须移除 |

容量与入库：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `MAX_MANIFEST_BYTES` | `10485760` | 同左 | 清单文件大小上限 |
| `MAX_ITEMS` | `5000` | 同左 | 单批次条目上限 |
| `MAX_UPLOAD_BYTES` | `209715200` | 同左 | 批量导入单文件上限（不进字典） |
| `MAX_NPM_PUBLISH_BYTES` | `301989888` | 同左 | npm publish HTTP body 硬天花板（≈288MB，容纳 200MB 包体的 base64）；启动时固定，字典无法突破；切回网关时 `client_max_body_size` 需 ≥ 300m |
| `MAX_PYPI_PUBLISH_BYTES` | `301989888` | 同左 | twine 上传 multer 单文件硬天花板（≈288MB）；启动时固定，字典无法突破 |
| `MAX_NPM_UPLOAD_BYTES` | `209715200` | 同左 | npm 上传包业务上限（≈200MB）；**可在控制台「字典管理 → 上传包大小上限」运行时调整**，不得超过 HTTP 硬天花板 |
| `MAX_PYPI_UPLOAD_BYTES` | `209715200` | 同左 | PyPI 上传包业务上限（≈200MB）；同上可运行时调整 |
| `BATCH_DEFAULT_MODE` | `partial` | `partial` | 入库默认模式 |
| `DEFAULT_NODE_TARGET` | `20.11.0` | 同左 | CSV/requirements 未声明 targets 时的默认值；**仅用于兼容性提示**，`engines.node` / `os` / `cpu` 不匹配只告警、不拦截 |
| `DEFAULT_PYTHON_TARGET` | `3.11.9` | 同左 | 同上；**仅用于兼容性提示**，PyPI 为通用仓库，任意 Python 版本的 wheel 均可入库，该值不拦截包 |

两个目标版本都只影响提示文案，不改变入库判定。平台按通用源设计：npm / PyPI 均完整保留运行时元数据并透传给客户端，由 `npm` / `pip` 在拉取端按自身环境挑选包。

安全扫描：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `SECURITY_SCAN_ENABLED` | `true` | `true` | 漏洞扫描与校验总开关；关闭后上传 / 导入 / 复检全部跳过六维扫描直接入库。**可在控制台「字典管理」中运行时覆盖** |
| `SECURITY_BLOCK_SEVERITY` | `critical` | `critical` | 达到该等级直接拦截，包不入库 |
| `SECURITY_QUARANTINE_SEVERITY` | `high` | `high` | 达到该等级进入隔离区等待人工复核 |
| `SECURITY_REQUIRE_SIGNATURE` | `false` | `false` | 是否强制要求签名；`false` 时未签名标记 SKIPPED 不阻断 |
| `SECURITY_REQUIRE_ADVISORY_DB` | `false` | `false` | 漏洞库为空时是否强制阻断（默认降级为 WARN） |
| `SECURITY_TRUSTED_KEYS` | `[]` | `[]` | 可信公钥 JSON 数组，元素为 `{"keyId":"...","pem":"-----BEGIN PUBLIC KEY-----..."}` |
| `SECURITY_SCAN_CONCURRENCY` | `2` | 同左 | 扫描并发闸门 |
| `SECURITY_MAX_SCAN_QUEUE` | `50` | 同左 | 扫描排队上限，超出返回可重试错误 |
| `SECURITY_SCAN_TIMEOUT_MS` | `60000` | 同左 | 单次扫描超时，超时按 fail-closed 处理 |
| `SECURITY_ORPHAN_GRACE_HOURS` | `6` | 同左 | 孤儿对象回收宽限期（小时，最小 1，更小的值按 1 处理）。**与清扫间隔无关**：间隔决定多久检查一次，宽限期决定无引用对象最早能活多久，实际删除延迟为「宽限期 + 下一个扫描周期」。对象被复用时（同一 sha256 再次上传）会刷新 mtime，因此复用窗口同样受保护 |
| `SECURITY_ORPHAN_SWEEP_INTERVAL_MS` | `21600000` | 同左 | 孤儿对象自动清扫间隔（毫秒，默认 6 小时），`<=0` 关闭自动清扫、仅保留手动接口 |
| `SECURITY_BATCH_RETENTION_DAYS` | `7` | 同左 | 批量导入批次与临时文件保留天数 |
| `SECURITY_MAX_SCAN_FILE_BYTES` | `301989888` | 同左 | 单包可扫描大小上限（≈288MB，与上传硬天花板对齐；低于该值的大包会被 INT-010 拦截） |
| `SECURITY_MAX_SCAN_ENTRIES` | `5000` | 同左 | 单包可扫描条目上限，超出判定为可疑 |
| `SECURITY_MAX_SCAN_TOTAL_BYTES` | `33554432` | 同左 | 单包解压后可分析文本总字节上限 |
| `SECURITY_MAX_COMPRESSION_RATIO` | `100` | 同左 | 压缩比阈值，超限判定压缩炸弹 |
| `SECURITY_MAX_NESTED_ARCHIVE_BYTES` | `8388608` | 同左 | 嵌套归档单条解压字节上限 |
| `SECURITY_MAX_NESTED_DEPTH` | `2` | 同左 | 嵌套归档递归扫描深度 |
| `SECURITY_RESCAN_INTERVAL_SEC` | `86400` | `0` | 存量包定期复检间隔（秒），`<=0` 关闭定时任务 |
| `SECURITY_RESCAN_WINDOW_START` / `SECURITY_RESCAN_WINDOW_END` | `-1` / `-1` | 同左 | 复检低峰窗口起止小时（0–23），支持跨零点（如 `23`/`5`）；两者均为 `-1` 表示不限制（A-06） |
| `SECURITY_RESCAN_PAUSE_MS` | `200` | 同左 | 复检逐包间隔（毫秒），降低占空比，给在线请求让出扫描槽（A-06） |

磁盘、停机与隔离区：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `DISK_ALERT_PERCENT` | `85` | 同左 | `DATA_DIR` 已用百分比告警阈值（A-05） |
| `DISK_READONLY_PERCENT` | `95` | 同左 | 达到该已用百分比后进入只读，写接口返回 507（A-05） |
| `DISK_MIN_FREE_BYTES` | `1073741824` | 同左 | 可用空间低于该值时进入只读，避免大共享盘百分比失真（A-05） |
| `DISK_HYSTERESIS_PERCENT` | `2` | 同左 | 水位滞回带宽（百分点）：退出告警/只读需回落到阈值以下这么多，避免贴阈值抖动；须小于「只读 - 告警」 |
| `DISK_CHECK_INTERVAL_MS` | `60000` | 同左 | 磁盘水位采样间隔（毫秒） |
| `SHUTDOWN_GRACE_MS` | `25000` | 同左 | 优雅停机宽限期（毫秒）：等待在途请求完成，超时后交由硬超时退出（A-07） |
| `SHUTDOWN_HARD_TIMEOUT_MS` | `35000` | 同左 | 收到 `SIGTERM`/`SIGINT` 后的硬超时（毫秒），到时强制 `process.exit(1)`（A-07） |
| `QUARANTINE_DIR` | 空（默认 `DATA_DIR/quarantine`） | 同左 | 隔离区目录；建议指向独立挂载卷，避免恶意样本与业务数据同卷（B6） |
| `QUARANTINE_RETENTION_DAYS` | `30` | 同左 | 隔离样本保留天数，超期且未复核的会被自动销毁，需 ≥1（B6） |
| `QUARANTINE_PURGE_INTERVAL_MS` | `86400000` | 同左 | 超期销毁检查间隔（毫秒），`0` 关闭自动销毁（B6） |
| `SECURITY_SCAN_RETENTION_DAYS` | `180` | 同左 | 扫描记录/报告/埋点保留天数，超期自动清理但每版本保留最近一次扫描，`0` 关闭（RV-26）；手动触发 `POST /api/v1/security/maintenance/purge-scans` |

日志、指标与限流：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `debug` | `warn` | 日志级别；生产默认 `info`（B2） |
| `LOG_FORMAT` | `text` | `json` | 输出格式；生产默认 `json` 单行（B2） |
| `METRICS_TOKEN` | 空 | 空 | `/metrics` 抓取令牌；设置后须带 `Authorization: Bearer <token>`（定长比较防时序推断），**留空则该端点匿名可读、无身份校验**，生产必须设置（B3） |
| `RATE_LIMIT_ENABLED` | `true` | `false` | 限流总开关（B4）。**关闭限流只认这个开关**：`*_MAX` 填 0 或不合法会在启动时报错，不会被静默当成「不限流」。**可在控制台「字典管理」中运行时覆盖** |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 同左 | 限流窗口（毫秒），必须 ≥ 1。运行时改窗口后，下一次请求即按新窗口重新计数。**可在控制台「字典管理」中运行时覆盖** |
| `RATE_LIMIT_AUTH_MAX` | `10` | 同左 | 认证类路由窗口内上限，必须 ≥ 1。登录路径按尾斜杠归一化与 method 大小写归一处理，加 `/` 或小写 `post` 不能绕过此桶。**可在控制台「字典管理」中运行时覆盖** |
| `RATE_LIMIT_WRITE_MAX` | `60` | 同左 | 写类路由窗口内上限。**可在控制台「字典管理」中运行时覆盖** |
| `RATE_LIMIT_READ_MAX` | `600` | 同左 | 控制台 API 等读类路由窗口内上限；registry 协议请求不计入此桶。**可在控制台「字典管理」中运行时覆盖** |
| `RATE_LIMIT_REGISTRY_MAX` | `20000` | 同左 | `/npm/*`、`/pypi/*` 协议 GET/HEAD 的独立上限（npm 与 pypi 分开计数），避免 dshmarket / pip / npm 批量拉取触发 429。**可在控制台「字典管理」中运行时覆盖** |
| `LOG_FILE_ENABLED` | `true` | `false` | 是否把结构化日志额外按天落盘到 `LOG_DIR`（journald 采集的部署可关闭；关闭后日志清理空转） |
| `LOG_DIR` | `<DATA_DIR>/logs` | 同左 | 日志目录；清理任务只删该目录下的 `*.log` / `*.log.N` / `*.log.gz` |
| `LOG_RETENTION_DAYS` | `180` | `180` | 日志文件保留天数，默认半年，`0` 表示不自动清理。**可在控制台「字典管理」中运行时覆盖** |
| `DELETED_PACKAGE_RETENTION_DAYS` | `30` | `30` | 软删除版本的可恢复天数，超期未恢复则硬删除（记录 + 对象文件 + 扫描记录 + 空包壳），`0` 表示不自动清理。**可在控制台「字典管理」中运行时覆盖** |
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` | 同左 | 保留期清理的扫描间隔（毫秒），`<=0` 关闭定时任务（仍可手动调用服务） |
| `BACKUP_ENABLED` | `true` | `true` | 是否备份入库的包文件。**可在控制台「字典管理」中运行时覆盖**。关闭只停止后续备份，已生成的备份不删除 |
| `BACKUP_INTERVAL_MINUTES` | `60` | `60` | 备份增量同步间隔（分钟），取值 1–10080。**可在控制台「字典管理」中运行时覆盖** |
| `BACKUP_DIR` | `<DATA_DIR>/backups` | 同左 | 备份目录，目录结构与 `objects/` 同构（`<sha 前 2 位>/<sha256>`）；不能与 `objects/` 相同 |
| `BACKUP_HEARTBEAT_MS` | `60000` | `0` | 调度心跳（毫秒）：决定改完字典多久按新间隔执行；`<=0` 关闭调度（测试用） |
| `MISSING_AUTO_REPORT` | `true` | `true` | 下游拉取包失败（registry 404）时是否自动登记缺失依赖。**可在控制台「字典管理 → 缺包自动上报」中运行时覆盖**；关闭只停新增，已有记录保留，不影响显式上报接口 |

限流与 registry 交互约定：

- 所有响应都带 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` / `RateLimit-Policy`，被拒（429）时额外带 `Retry-After`，客户端可据此主动退避。
- `/npm`、`/pypi` 的 401 额外带 `WWW-Authenticate: Basic realm="yuanjian-registry"`，npm / twine 才会走标准凭据提示流程；控制台是 Cookie 会话，不下发该头以免弹浏览器原生登录框。
- PyPI simple 项目页对已知 `requires_python` 的构件输出 `data-requires-python`（PEP 503 可选属性），pip 在解析阶段即可过滤不兼容版本，不必先下载再拒绝。
- 「包存在但唯一版本被删除/隔离」时 packument 返回 404 `PKG_NO_AVAILABLE_VERSION`，与「包不存在」区分，不登记为缺失依赖。

时钟（B5 收敛后只保留 SNTP 观测）：

| 变量 | 开发环境 | 测试环境 | 说明 |
| --- | --- | --- | --- |
| `NTP_SERVER` | 空 | 同左 | SNTP 服务器地址；为空不采样 |
| `NTP_CHECK_INTERVAL_MS` | `300000` | 同左 | 时钟采样间隔（毫秒），需 ≥1000 |
| `NTP_MAX_OFFSET_MS` | `1000` | 同左 | 时钟偏移告警阈值（毫秒） |

## 5. 启动验证

```bash
# 健康检查：env/port/dataDir 应与所选环境一致
curl -s http://127.0.0.1:3000/api/v1/health

# npm 协议探活
curl -s http://127.0.0.1:3000/npm/-/ping        # 期望 {}

# PyPI simple 索引
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/pypi/simple/   # 期望 200

# 未登录访问应返回 401 + traceId
curl -s http://127.0.0.1:3000/api/v1/auth/me
```

浏览器打开 `http://localhost:3000/`，用 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 指定的初始管理员登录，系统会强制要求改密；改密后可看到「包管理 / 批量导入 / 缺失依赖 / 安全校验 / 审计日志 / 访问令牌 / 用户管理 / 字典管理 / 用户手册」九个视图。其余账号由管理员在「用户管理」中创建，初始密码只展示一次。侧栏按权限动态收敛：**审计日志、用户管理、字典管理仅管理员可见**；漏洞扫描关闭后，非管理员的安全校验入口自动隐藏，批量导入页也只保留上传卡并走「上传即基础校验 + 入库」快速通道。控制台通过 `GET /api/v1/features` 读取能力位并每分钟同步一次，无需刷新页面。

「字典管理」仅管理员可见（`config:manage` 权限），用于统一维护系统运行时配置：限流参数（开关 / 窗口 / 认证 / 读写上限）、漏洞扫描校验开关（扫描总开关 / 强制签名 / 漏洞库拦截）、保留清理策略（软删除包可恢复天数、日志文件保留天数，均默认 `30` / `180` 天，填 `0` 表示不自动清理）、包文件备份（启用开关、同步间隔）、缺包自动上报，以及**上传包大小上限**（npm / PyPI 分别设置，默认 200MB，用于放行大型离线插件包；控制台以 MB 为单位输入，系统内部按字节存储与校验；不得超过 env 的 HTTP 硬天花板）。保存后写入 `sys_dictionary` 表持久化并即时生效（业务模块经 `getConfig()` 读取 env 基线 + 字典覆盖的合并结果，无需重启）；三角色共享同一数据库，覆盖层按 `DICTIONARY_SYNC_INTERVAL_MS`（默认 1000ms）自动回读，控制台的变更会同步到 npm / pypi 进程，不需要逐容器重启。每次变更落审计日志（`config.dictionary.update`）。API：`GET/PUT /api/v1/dictionary`。

「用户手册」所有登录用户只读，管理员可在页面内点「编辑手册」修改章节内容并保存，普通用户下次进入即看到同一份内容。覆盖项按章节存 `user_manual` 表，未改过的章节用内置静态手册；「恢复默认」清空全部覆盖。写入时服务端按白名单清洗 HTML，脚本、事件属性与 `javascript:` 链接不会落库；每次保存写审计 `manual.content.update`。API：`GET/PUT /api/v1/manual/content`（PUT 需要 `config:manage`）。

保留期清理由控制台进程的 `RetentionScheduler` 每小时执行一轮（可用 `RETENTION_SWEEP_INTERVAL_MS` 调整）：软删除版本超期后连同对象文件、扫描记录及报告一起硬删除，包内版本被删光的包壳一并回收；日志清理只处理 `LOG_DIR` 下的日志文件，目录内其它文件不动。清理动作写审计（`retention.packages.purge`）。

包文件备份由 `BackupScheduler` 驱动（心跳 `BACKUP_HEARTBEAT_MS`，默认每分钟检查一次是否到了配置的间隔）：把 `objects/` 下的包对象**增量复制**到 `BACKUP_DIR`，目录结构与对象存储同构，因此备份文件可直接按 `<sha 前 2 位>/<sha256>` 找回。语义要点：

- **只增不删**。关闭开关或调整间隔都只影响后续行为，备份目录里的文件一个都不动；备份不参与保留期清理，源对象被硬删除后备份仍然保留（这是备份的意义）。
- **只备份被引用的对象**。上传中断留下的孤儿对象不进备份（备份只增不删，进去就永久占空间），由孤儿对象清扫（`SECURITY_ORPHAN_SWEEP_INTERVAL_MS`，默认 6 小时一轮）回收。
- **隔离区一并镜像**。隔离样本复制到 `BACKUP_DIR/quarantine/<scanId>/`，隔离区常挂在独立卷，源卷损坏时仍可恢复；该子树按目录结构原样复制，不与对象键（两位十六进制桶）冲突。
- **幂等**。每轮只补齐备份目录里缺失的对象，大小不一致的会被覆盖修复，重复执行安全。
- **窗口等于间隔**。备份在扫描轮次里完成，不是上传时同步复制；间隔 60 分钟意味着最坏情况下最近一小时入库的包还没进备份。对备份时效要求更高时把间隔调小。
- 备份动作写审计（`backup.objects.copy`），只在真正复制了文件时落一条。

```bash
# 登录并保存会话 Cookie
curl -s -c cookie.txt -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<初始管理员口令>"}'

# 首登必须改密：未改密时业务接口返回 403 AUTH_PASSWORD_CHANGE_REQUIRED
# 强制改密不需要原密码（账号本来就是用初始口令登进来的）
curl -s -b cookie.txt -X POST http://127.0.0.1:3000/api/v1/auth/change-password \
  -H 'Content-Type: application/json' \
  -d '{"newPassword":"<新口令>"}'
```

主动改密（`must_change_password=0`）仍必须带 `oldPassword`，缺失或错误返回 `400 SYS_VALIDATION`。

测试环境把端口换成 `3100` 重复上述命令即可；两套环境的数据互不影响。

## 6. 客户端接入

```bash
# npm
npm config set registry http://<host>:3000/npm/
npm login --registry http://<host>:3000/npm/
npm publish
npm install <package>

# pip
pip install --index-url http://<host>:3000/pypi/simple/ --trusted-host <host> <package>

# twine
twine upload --repository-url http://<host>:3000/pypi/ dist/*
```

令牌获取：控制台「访问令牌」页创建，或 `POST /api/v1/auth/tokens`；CLI 场景使用 Basic（`用户名:密码`）或 Bearer（`yj_...`）鉴权。

## 7. 安全校验

所有上传入口（npm publish、twine upload、批量导入、缺失依赖补包）在写入 `package_versions` **之前**统一经过 `SecurityService.scanAndGate()` 同步扫描；未通过校验的包不会进入私有源，也不会出现在索引、packument 或下载路径中。

### 7.1 六维校验规则

| 维度 | 校验内容 | 规则编号 |
| --- | --- | --- |
| 格式与完整性 | 空文件、扩展名与文件头不符、归档损坏、缺少元数据、路径穿越、重复条目、嵌套归档、超大包、签名校验 | `INT-001` ~ `INT-010`、`INT-SIG-001` ~ `004` |
| 恶意代码 | 反弹 Shell、编码载荷动态执行、混淆字符串、挖矿、下载即执行、破坏性删除、读取凭据、动态库注入、安装期提权、远程模块加载、持久化驻留、键盘记录 | `MAL-001` ~ `MAL-012` |
| 已知漏洞 | 包自身版本与依赖声明匹配本地 CVE / CNVD / OSV 漏洞库，按高/中/低危输出 | `VULN-<advisoryId>`、`VULN-DEP` |
| 权限风险 | 安装脚本、setuid/setgid、`.pth` 注入、`setup.py` 安装期逻辑、容器高权限、可执行文件等 | `PERM-001` ~ `PERM-010` |
| 敏感信息 | 私钥、云厂商密钥、平台令牌、仓库 authToken、硬编码口令、API Key、JWT、连接串、手机号/身份证、内网 IP | `SEC-001` ~ `SEC-010` |
| 行为风险 | 环境变量读取后外联、敏感文件读取后外联、远程下载执行、写系统路径、动态加载、未声明外联、底层 socket、安装期外联、原生二进制 | `BEH-001` ~ `BEH-009` |

证据在落库前统一脱敏（密钥只保留掩码），避免报告本身成为泄露渠道。

### 7.2 分级处置

| 最高风险 | 处置 | 系统行为 |
| --- | --- | --- |
| `critical` | `BLOCK` | 返回 403 `SEC_BLOCKED` 与 `scanId`，包不入库，未引用对象被清理 |
| `high` | `QUARANTINE` | 返回 409 `SEC_QUARANTINED`，文件写入隔离区目录，等待管理员复核 |
| `medium` | `WARN` | 允许入库，记录风险并在控制台告警 |
| `low` / 无风险 | `ALLOW` | 允许入库，生成合格校验记录与可下载报告 |

阈值由 `SECURITY_BLOCK_SEVERITY`、`SECURITY_QUARANTINE_SEVERITY` 配置。扫描器内部异常按 fail-closed 处理，返回 500 `SEC_SCAN_FAILED`，不会放行未经验证的包。

签名校验为可选能力：未提供签名时标记 `unsigned`（报告中注明 SKIPPED），不阻断；提供签名但没有匹配的可信公钥按 high 隔离，验签失败按 critical 拦截。

### 7.3 报告与审计

每次扫描写入 `security_scans` 与 `security_findings`，同时生成 JSON 报告存入对象存储。控制台「安全校验」页可查看六维结果、逐条风险详情与整改建议，并下载 JSON / CSV 报告；接口为：

- `GET /api/v1/security/overview`、`GET /api/v1/security/scans`、`GET /api/v1/security/scans/:id`
- `GET /api/v1/security/scans/:id/report?format=json|csv`
- `GET /api/v1/security/quarantine`、`POST /api/v1/security/quarantine/:id/release`、`DELETE /api/v1/security/quarantine/:id`
- `POST /api/v1/security/advisories/import`、`POST /api/v1/security/rescan`、`POST /api/v1/security/quarantine/purge`

所有动作写入审计日志：`security.scan.completed`、`security.scan.blocked`、`security.quarantine.release|delete|expire`、`security.rescan.changed|completed`、`security.advisory.import`，可按 traceId 回溯。

### 7.4 隔离区复核

管理员在控制台对隔离包执行「放行」或「废弃」：

- 上传期隔离：放行时重新写入对象存储并补录版本记录；废弃时清理隔离文件与未引用对象。
- 存量复检隔离：放行恢复 `active`，废弃软删除为 `deleted`。

B6 起隔离区独立加固：`QUARANTINE_DIR` 可指向独立挂载卷，目录权限 0700、文件 0600（启动时修正存量权限），超期未复核样本按 `QUARANTINE_RETENTION_DAYS` 自动销毁并写审计 `security.quarantine.expire`。

### 7.5 漏洞库与定期复检

漏洞库为本地离线快照，可在控制台导入或调用 `POST /api/v1/security/advisories/import`（JSON，支持顶层数组或 `{ "advisories": [...] }`）：

```json
{
  "advisories": [
    {
      "source": "CVE",
      "advisoryId": "CVE-2024-0001",
      "ecosystem": "npm",
      "packageName": "lodash",
      "affectedRange": "<4.17.21",
      "severity": "high",
      "title": "Prototype pollution",
      "references": ["https://example.invalid/CVE-2024-0001"],
      "fixedVersion": "4.17.21",
      "publishedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

npm 与 pypi 共用同一张 `vulnerability_advisories`，行内靠 `ecosystem` 列区分。**`ecosystem` 必填**，只接受 `npm` / `pypi` / `*`（`pip`、`python`、`any`、`all` 视为别名）；缺失或写成其它家族（如 `rubygems`）的条目会被跳过并在 `errors` 里给出原因——早期版本会把不认识的值静默折叠成 `*`，导致同名的 npm 与 pypi 包被同一条漏洞同时命中。`*` 表示跨生态条目，两个生态的扫描都会命中，控制台漏洞库列表里以「跨生态」标签标出。

单条记录按 `(source, advisory_id, ecosystem, package_name, affected_range)` 去重，同一 CVE 影响多个包就是多行。`GET /api/v1/security/overview` 与统计接口额外返回 `advisoriesByEcosystem: { npm, pypi, wildcard }`，用来判断某一侧是否根本没导入数据。

#### 漏洞数据从哪来

| 数据源 | 地址 | 说明 |
| --- | --- | --- |
| OSV.dev（推荐） | `https://storage.googleapis.com/osv-vulnerabilities/<生态>/all.zip` | `<生态>` 为 `npm` / `PyPI` 等。npm 全量约 211 MB（23 万条），PyPI 约 36 MB（2.7 万条）。聚合了 GHSA、PYSEC 与 CVE 别名，是唯一能同时覆盖两个生态、且带「包名 + 版本区间」的单一来源 |
| OSV 全库 | `https://storage.googleapis.com/osv-vulnerabilities/all.zip` | 含全部生态与已撤回记录，只想要 npm/PyPI 时没必要下 |
| OSV 增量 | `https://storage.googleapis.com/osv-vulnerabilities/<生态>/modified_id.csv` | 按修改时间倒序，用于日常增量同步 |
| OSV API | `POST https://api.osv.dev/v1/querybatch`、`GET https://api.osv.dev/v1/vulns/{id}` | 按包查询，适合只关心少数包时用 |
| GitHub Advisory Database | `https://github.com/github/advisory-database` | `advisories/github-reviewed/` 下按 `npm` / `pip` 分目录，OSV schema；OSV 导出已包含其内容 |
| PyPA Advisory Database | `https://github.com/pypa/advisory-database` | `vulns/<包名>/PYSEC-*.yaml`，OSV schema；同样已并入 OSV 导出 |
| NVD | `https://nvd.nist.gov/vuln/data-feeds` | CVE JSON 2.0。**不含包名与版本区间**，要自己做 CPE→包名映射，只适合补 CVSS 分值，别指望它直接做依赖匹配 |
| npm 官方审计接口 | `POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` | 在线接口，按「包名: [版本]」批量查，不是离线库 |

OSV 的原始格式与本平台的导入格式不同（OSV 是「一个漏洞 + 若干受影响包 + introduced/fixed 事件」，平台是「一行一个包的一个区间」），需要转换：

```bash
npm run vulndb:sync -- --out data/vulndb            # 下载 npm + PyPI，转成 data/vulndb/npm-001.json…
npm run vulndb:sync -- --ecosystems pypi --max-records 300   # 试跑一小批
npm run vulndb:sync -- --upload http://127.0.0.1:3000 --username admin --password '***'
```

脚本做四件事：下载（缓存在 `--cache` 目录，默认 `<out>/.cache`）、解压、转换、按 `--chunk-mb`（默认 20 MB）切片——导入接口单次上限 50 MB，npm 全量不分片一定超限。带 `--upload` 时逐片调用导入接口并按 `imported/updated/skipped` 汇总。

几个已知的取舍：只处理 `SEMVER` / `ECOSYSTEM` 两类区间，`GIT` 区间是提交哈希、平台用不了，直接丢弃；没有可用区间的条目退回 `versions[]` 生成 `==x.y.z` 列表（上限 60 个）；`severity` 取 GHSA 的 `database_specific.severity`（`MODERATE` 归为 `medium`），PYSEC 等没有分级的数据落库后按 `medium` 处理；同一条漏洞的多个区间合并成一行用 `||` 连接，`fixedVersion` 取其中最大的修复点，个别记录（如 OSV 里 `>=3.0.0` 无上界）会出现「建议升级到的版本仍在区间内」，属于源数据本身的形状问题。每次分片导入都会写一条 `advisory_snapshots`，报告绑定的是其中某一条。

`SECURITY_RESCAN_INTERVAL_SEC > 0` 时，进程内定时任务按间隔遍历全部 `active` 版本重扫；仅当结论或规则指纹变化才落新记录，命中隔离阈值的版本自动置为 `quarantined`。也可在控制台点击「立即全量复检」或调用 `POST /api/v1/security/rescan` 手动触发，结果包含扫描数、变化数、新增隔离数与错误列表。

A-06 起支持低峰窗口与逐包间隔：当前小时不在 `SECURITY_RESCAN_WINDOW_START`–`END`（半开区间，支持跨零点）内时直接跳过本次调度并记日志；窗口内每个包之间等待 `SECURITY_RESCAN_PAUSE_MS`，避免连续扫描长期占满扫描槽。手动触发不受窗口限制。

A-07 起优雅停机：`SIGTERM`/`SIGINT` 后新请求立即返回 503 `SYS_SHUTTING_DOWN`（附 `Connection: close` 与 `Retry-After: 5`），在途请求最多等待 `SHUTDOWN_GRACE_MS`，随后关闭数据库；超过 `SHUTDOWN_HARD_TIMEOUT_MS` 仍有关闭连接时强制退出。对象写入使用临时文件 + 原子 rename，停机不会产生半截包文件。

B5 收敛后已移除全部出站白名单、正向代理与自定义 CA 逻辑（不再需要访问外部 IdP），只保留 SNTP 时钟观测：配置 `NTP_SERVER` 后应用每 `NTP_CHECK_INTERVAL_MS` 采样一次时钟偏移，超阈值记 WARN，指标见 `yj_clock_*`。

```bash
# 时钟状态（未配置 NTP_SERVER 时 offsetMs / healthy 为 null）
curl -s http://127.0.0.1:3000/api/v1/health | jq '.data.clock'

# 指标核查：时钟偏移与健康标记
curl -s http://127.0.0.1:3000/metrics | grep 'yj_clock'
```

## 8. 测试

```bash
npm run typecheck   # 全量类型检查
npm test            # 14 个 e2e 套件（78 用例），真实启动 HTTP 服务
```

覆盖范围：

| 套件 | 核心场景 |
| --- | --- |
| `test/auth.e2e-spec.ts` | 健康检查、本地账号登录/会话/登出、防枚举与失败锁定、强制改密、Basic/Bearer、RBAC 越权、令牌创建与吊销、用户管理与管理员唯一（不可新建、提升、降级、禁用） |
| `test/security.e2e-spec.ts` | 恶意代码拦截、高危隔离与放行、敏感信息告警与 JSON/CSV 报告、有效/伪造签名、漏洞库导入与复检隔离、越权拒绝 |
| `test/registry.e2e-spec.ts` | npm ping/whoami/login/publish/packument/search/tarball、重复与非法版本、PyPI twine 上传/simple 索引/下载、非法文件名、未认证上传 |
| `test/import.e2e-spec.ts` | 清单解析预览、文件匹配、S1-S5 全量校验、partial 入库、strict 阻断、CSV 报告、缺少 targets、非法清单格式 |
| `test/admin.e2e-spec.ts` | 缺失依赖上报去重、补包入库与状态流转、重复补包冲突、审计检索与 CSV 导出、权限拒绝、404 错误码、静态控制台 |
| `test/missing-report.e2e-spec.ts` | 缺包自动上报：npm/pypi 404 静默登记、版本尽力解析、聚合命中、字典开关、显式上报过滤已入库包 |
| `test/security-rescan.e2e-spec.ts` | 复检签名、空库、strict 安全拦截、嵌套归档、CSV 注入 |
| `test/config.e2e-spec.ts` | 生产配置护栏、HTTP 基址豁免、`BIND_HOST` 收敛 |
| `test/dictionary.e2e-spec.ts` | 字典管理：分组视图与 env 基线、权限拒绝、保存校验不落库、限流参数保存后即时生效（429）、漏洞扫描开关控制发布拦截与复检、功能开关对普通用户可见、审计落库 |
| `test/retention.e2e-spec.ts` | 保留期清理：字典下发保留分组与默认值、非法天数拒绝、`0` 关闭清理、超期软删除版本连对象文件/空包壳一并硬删除、保留期内不动、日志清理只删超期日志文件 |
| `test/backup.e2e-spec.ts` | 包文件备份：默认开启并落到 `<DATA_DIR>/backups`、内容逐字节一致、重复执行幂等、关闭后不再备份且旧备份保留、重新开启补齐、间隔可覆盖且越界拒绝、孤儿对象不进备份、隔离区镜像到 `quarantine/` 子树、源对象被硬删后备份仍在 |
| `test/package-delete.e2e-spec.ts` | 版本级删除与恢复：reader 与同角色他人删不了、管理员可代删代恢复（审计标记 `deletedByAdmin` / `restoredByAdmin`）、删除后同包其它版本不受影响、已删除版本只对上传者与管理员可见（他人勾选「含已删除」也看不到、装不了）、删除后同版本重传被拒、保留期统计按角色隔离 |
| `test/http-security.e2e-spec.ts` | 安全响应头、限流、metrics token |
| `test/logger.e2e-spec.ts` | JSON 日志、traceId、凭据脱敏 |
| `test/security-queue.e2e-spec.ts` | 扫描任务幂等、重启恢复、对象缺失降级 |
| `test/disk-guard.e2e-spec.ts` | 磁盘阈值边界、只读拒绝写入、恢复放行 |
| `test/shutdown.e2e-spec.ts` | 排空等待在途请求、排空后 503、在途发布完成后读接口 503 |
| `test/rescan-pacing.e2e-spec.ts` | 复检窗口边界/跨零点、逐包间隔生效 |
| `test/security-quarantine.e2e-spec.ts` | 独立挂载生效、目录 0700/文件 0600、超期 dry-run 与销毁、审计落库、未超期不误删 |

每个套件使用独立端口与独立数据目录，运行结束自动清理，不污染开发数据。

## 9. 生产部署

按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 执行，包含目录与账号规划、离线安装、生产环境变量、systemd 托管、首次验收、备份恢复、监控告警、升级回滚与停机摘流。当前生产形态为**明文 HTTP 直连**（暂无内网 CA 证书，需 `ALLOW_INSECURE_BASE_URL=true` + 防火墙收敛 3000 端口到研发网段）；证书就位后按该手册第 6 章切回 Nginx TLS 网关。

快速自检三步：`node --version` ≥ 22.5 → `systemctl status yuanjian` 为 `active (running)` → `curl -fsS http://127.0.0.1:3000/api/v1/health` 返回 `status: ok`。

## 10. 统一约定

- 响应信封：`{ "code": 0, "message": "ok", "data": ..., "traceId": "..." }`；失败为 `{ "code": "PKG_XXX", "message": "...", "traceId": "...", "details": ... }`。
- registry 路径（`/npm/*`、`/pypi/*`）使用协议原生错误体：`{ "error": "CODE", "reason": "...", "traceId": "..." }`。
- 所有请求透传/生成 `x-request-id` 作为 traceId，审计日志、错误响应、健康检查均可关联。
- 审计日志按 `prev_hash → hash` 组成哈希链，敏感字段（密码、令牌、密钥）落库前脱敏。

## 11. MVP 边界

- 不含证书签发、包签名签发（仅支持使用 `SECURITY_TRUSTED_KEYS` 配置的公钥验签）与配额、审批流；`src/certificates/` 为 A4 裁剪后的预留空模块，埋点能力保留。
- 安全校验为静态规则 + 本地漏洞库快照，不内置杀毒引擎或动态沙箱；规则命中需结合人工复核，隔离区提供放行/废弃闭环。
- 单机 SQLite，适用于内网中小团队；多实例部署需替换为外部数据库与共享对象存储。
- 认证为本地账号体系（管理员唯一且首启创建、普通账号由管理员建号、首登强制改密、失败锁定），不提供 SSO/MFA；需要对接单位统一认证时需另行扩展。
- 注册表协议覆盖核心发布/安装路径，未实现 npm audit、dist-tags 增删、yank 等边缘能力。

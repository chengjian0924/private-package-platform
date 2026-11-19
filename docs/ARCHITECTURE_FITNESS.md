# 内网生产环境架构适配性评估报告

> **版本说明**：本文件为 2026-11-16 会话上下文重建版（原 Desktop 交付目录意外缺失，结构与结论按原报告还原，内容与已实施的整改状态一致）。原始逐字版本如仍需保留，请从备份介质恢复。

| 项目 | 内容 |
| --- | --- |
| 评估对象 | 源鉴 · 内网依赖安全治理平台（npm registry + PyPI index + 批量导入 + 六维安全校验） |
| 代码基线 | 原评估：P0 + P1 评审整改完成后的版本（6 套件 43 用例）；整改后：A1–A4 + A-03（扫描线程隔离）、A-04（扫描队列持久化）、A-05（磁盘水位保护）、A-06（复检错峰）、A-07（优雅停机）、B1–B6 已落地（15 套件 83 用例通过，`tsc` 全绿） |
| 评估方式 | 全量源码走查（30 个源文件）、配置项核对（60+ 环境变量）、依赖清单核对、构建与测试结果复核、部署文档比对、整改后实测复核 |
| 评估结论 | **单机部门级生产：有条件满足；企业级生产 / 等保三级 / 99.9% SLA：不满足**（A/B 批次全部完成，剩余条件见第 9、12 章） |
| 加权得分 | 原评估 59.7 / 100；**整改后复评 76.3 / 100**（网络 88、合规 77、可用性 70、运维 74、资源 72） |

---

## 0. 结论摘要

1. **无公网依赖**：全部源码与前端静态资源均无硬编码公网地址，无 CDN、无外部字体、无在线漏洞库拉取、埋点仅落本地库。认证为本地账号体系，进程无任何外部认证服务依赖；唯一可选出站是内网 SNTP 时钟采样。这是本架构在内网落地的最强项。
2. **单点部署是最大短板**：单进程 + 单机 SQLite（WAL）+ 本地磁盘对象存储 + 进程内定时任务，无冗余、无故障转移。进程/主机/磁盘任一故障即中断服务，RTO 依赖人工恢复，无法承诺 99.9% SLA。
3. **原 4 个硬阻断项已全部关闭**：生产配置护栏（A1）、一致性备份/恢复（A2）、离线交付物（A3）、进程托管与网关（A4，systemd + Nginx + TLS/HSTS）均已完成；单点与全内存上传（A-01/A-02）经 A2、B1、A4 的 `Restart=always` 自愈缓解，但**服务冗余仍缺失**。
4. **合规缺口集中在审计留存与传输/存储加密**：等保 2.0 三级的"安全审计""数据保密性"条款仍只能部分满足；"备份恢复"条款已由 A2 的一致性备份脚本与恢复演练文档补齐（尚缺异地/离线副本）。
5. **资源适配性良好但版本门槛明确**：运行时仅 7 个纯 JS 依赖、无原生编译、无外部数据库/Python/Docker 依赖，适合内网离线交付；但强制 Node ≥22.5 且 `node:sqlite` 属实验特性，现有 Node 18/20 基线不可用。
6. **可实施建议**：按第 8 章 A 批次（上线阻断）→ B 批次（上线前必做）→ C 批次（若要企业级 SLA 再启动）推进；若维持单机架构，须以第 9 章的风险接受条件作为准入边界。
7. **整改进展（2026-11-16）**：A1（生产配置护栏，含 HTTP 基址显式豁免与 bootstrap 弱口令校验）、A2（`sqlite3 .backup` 一致性备份与恢复）、A3（离线交付：缓存包 + 预装依赖包双产物）、A-03（扫描迁移到 `worker_threads`，独立 512MB 堆 + 零拷贝转移 + 超时终止）、A-04（扫描任务落库 + 幂等键 + 重启后台恢复）、A-05（磁盘水位采样 + 85% 告警 + 95% 只读降级 + 全局写拦截）、A-06（复检低峰窗口 + 逐包间隔）、A-07（排空在途请求 + 503 提前拒绝 + 硬超时看门狗）、A4（systemd 托管 + Nginx 网关 + TLS/HSTS + `BIND_HOST` 收敛监听 + 停机摘流流程）、B1（三个上传入口落盘 + npm publish 分块解码）、B2（结构化日志）、B3（`/metrics` + 告警规则样例）、B4（限流 + 安全响应头）、B5（SNTP 时钟偏移观测；OIDC 移除后出站白名单/代理/CA 自检一并删除）、B6（隔离区独立挂载 + 0700/0600 权限 + 30 天超期销毁 + 规模指标）、D-14（因单位无统一认证平台，移除 OIDC，改为本地账号密码 + 管理员建号 + 首登强制改密 + 失败锁定）均已完成并实测。A/B 批次至此全部完成。

---

## 1. 评估范围与依据

### 1.1 范围

- 源码：`src/` 全部模块（auth / packages / registry-npm / registry-pypi / import / missing / security / audit / telemetry / certificates / storage / db / common / metrics）
- 部署形态：单机单进程，SQLite + 本地磁盘对象存储
- 客户端：npm CLI、pip、twine、Web 控制台
- 评估维度：网络适配性、部署合规性（对照等保 2.0 三级）、高可用与稳定性、运维可实施性、资源适配性

### 1.2 关键事实基线

| 项 | 事实 |
| --- | --- |
| 进程模型 | 单 Node 进程，无集群/无子进程（扫描已由 A-03 移入 worker 线程） |
| 持久化 | SQLite（WAL，单连接），`node:sqlite` 实验特性 |
| 对象存储 | 本地文件系统，内容寻址 `objects/<sha256前2位>/<sha256>` |
| 登录态 | 本地账号 scrypt 口令校验 + 会话表 + HttpOnly/SameSite=Lax Cookie；API Token 仅存哈希 |
| 审计 | SQLite 单表 + `prev_hash → hash` 哈希链 |
| 定时任务 | 进程内 `setInterval` 定期复检（默认 86400s） |
| 出站依赖 | 无外部认证依赖；可选内网 SNTP（`NTP_SERVER`，不配置则不采样） |
| 运行时依赖 | 8 个纯 JS 包，无原生编译 |

---

## 2. 维度一：网络适配性

### 2.1 现状判定

| 项 | 现状 | 判定 |
| --- | --- | --- |
| 公网硬编码 | 源码与静态资源均无公网地址 | 满足 |
| 出站依赖 | 无外部认证/软件源依赖；无 CDN/字体/在线漏洞库/遥测 | 满足 |
| 正向代理 | 无跨安全域出站需求（D-14 移除 OIDC 后不再适用） | 不适用 |
| 内部 CA 证书 | 无外部 TLS 对端需要校验；网关证书由 Nginx 侧管理 | 不适用 |
| IPv6 内网 | A4 已支持 `BIND_HOST`（默认 `0.0.0.0`，可设 `::` 或具体 v6 地址） | 满足（配置项） |
| 大文件链路 | 上传已落盘（B1），单次发布时延 = 上传 + 扫描 | 部分满足 |

### 2.2 问题清单

| 编号 | 等级 | 问题 | 影响 | 整改方向 |
| --- | --- | --- | --- | --- |
| N-01 | 已关闭 | ~~Node 原生 `fetch` 不走系统代理~~；D-14 移除 OIDC 后进程无跨安全域出站，B5 的代理实现已随之删除 | 不适用 | 无 |
| N-02 | 已关闭 | ~~未提供自定义 CA 配置与校验~~；无外部 TLS 对端，B5 的 CA 自检已删除 | 不适用 | 无 |
| N-03 | 重要（✅ A4 已整改） | ~~只监听 IPv4~~ → 已支持 `BIND_HOST`（默认 `0.0.0.0`，可设 `::`） | ~~IPv6-only 或双栈强约束的内网无法接入~~ → IPv6-only 内网设 `BIND_HOST=::` 即可接入 | 已落地：`src/config/config.ts` + `src/main.ts`，默认值保持兼容；e2e 覆盖默认值与显式设置 |
| N-04 | 已关闭 | ~~`OIDC_ISSUER` 无出站白名单校验~~；OIDC 已移除，生产护栏改为校验 bootstrap 管理员口令强度 | 不适用 | 无 |
| N-05 | 一般 | 大文件上传 Node 默认 `requestTimeout` 5 分钟，无分片/续传 | 高延迟链路上 200MB 发布易超时失败，用户需整包重传 | 已改磁盘流式落盘（B1）；网关与 Node 超时对齐并文档化；超限返回可重试错误码 |
| N-06 | 建议 | 应用仅支持根路径部署，带前缀需网关 rewrite，未文档化 | 统一门户嵌入场景易配错静态资源与 tarball 地址 | 在部署手册补充 Nginx `sub_filter`/`proxy_pass` 改写样例 |

### 2.3 带宽与时延评估

- **下载路径**：`sendFile` 由内核直接发送，Node 事件循环不参与数据搬运，千兆内网单实例可跑满网卡，**无架构瓶颈**。
- **上传 + 发布路径**：接收（磁盘暂存）→ 六维扫描（worker 线程）→ 落盘；扫描并发 2，密集发布会排队。
- **结论**：适合局域网（≤1ms RTT）场景；跨广域/高延迟链路体验差，需按 N-05 整改。

---

## 3. 维度二：部署合规性（对照等保 2.0 三级要求）

### 3.1 条款映射

| 等保条款 | 现状 | 判定 |
| --- | --- | --- |
| 身份鉴别 | 本地账号 scrypt 口令校验（参数随哈希保存、定长比较、伪造哈希防枚举）+ 5 次失败锁定 15 分钟 + 会话 Cookie（HttpOnly/SameSite=Lax/HTTPS 时 Secure）+ API Token（仅存哈希）；MFA 需另行扩展 | 部分满足（无 MFA） |
| 访问控制 | RBAC 权限点完整，开发者仅可见自己的扫描记录，管理接口隔离 | 满足 |
| 安全审计 | 全量动作入审计表，`prev_hash → hash` 哈希链，traceId 贯通错误/审计/健康检查 | 部分满足（留存与防删除不足） |
| 入侵防范 | 六维静态扫描 + 分级处置 + fail-closed + 压缩炸弹/嵌套归档防护 + 限流 | 部分满足（无主机加固） |
| 数据完整性 | sha256 内容寻址、原子写入、审计哈希链 | 满足 |
| 数据保密性 | 应用层无 TLS（依赖网关/直连）、静态数据明文、安全响应头已补 | 不满足 |
| 备份恢复 | 已改为 `sqlite3 .backup` 一致性备份 + 恢复脚本与演练 | 部分满足（缺异地副本） |
| 个人信息保护 | 审计记录 IP/UA，无保留期与最小化策略 | 部分满足 |

### 3.2 问题清单

| 编号 | 等级 | 问题 | 影响 | 整改方向 |
| --- | --- | --- | --- | --- |
| C-01 | **严重**（✅ A1 + D-14 已关闭） | 原生产护栏缺失导致演示账号可在生产登录；现改为本地账号体系：内置演示账号随 OIDC 一并删除，生产启动校验 `BOOTSTRAP_ADMIN_PASSWORD` 强度（≥最小长度、不含用户名、非弱口令） | 直接违反身份鉴别要求，属可被利用的越权入口 | 已落地：`productionConfigProblems` + `assertProductionReady`；`test/config.e2e-spec.ts` 覆盖 |
| C-02 | 重要（✅ B4 已关闭） | 无登录/发布/下载限流，`SYS_RATE_LIMITED` 定义后从未使用 | 口令与令牌可被暴力尝试；单客户端可打满上传与扫描队列 | 引入限流（按 IP + 用户 + 路由），429 返回 `Retry-After` |
| C-03 | 重要 | 静态数据明文（SQLite + objects + quarantine），无磁盘/文件级加密要求 | 存储介质被带出或备份泄露即等同源码与凭据泄露 | 部署规范强制 LUKS/加密卷；或对 quarantine 与备份做加密 |
| C-04 | 重要 | 审计日志仅本地 SQLite，无防删除、无异地留存、无转储，留存期未定义 | 不满足"审计记录留存不少于六个月"与防篡改要求（哈希链只能事后发现，不能阻止删除） | 审计表只追加 + 定时转储到只读存储/日志服务器；定义 180 天留存与访问控制 |
| C-05 | 重要（◐ B4 已补响应头，TLS 未解决） | 无 HSTS/CSP/`X-Content-Type-Options`/`X-Frame-Options` 等安全响应头，无 TLS 应用内支持 | 依赖网关但无兜底，网关漏配即明文；控制台存在点击劫持与 XSS 放大面 | 增加安全响应头中间件；网关强制 HTTPS 与 HSTS |
| C-06 | 重要（✅ B6 已关闭，加密归档仍缺） | 隔离区原样落盘在 `DATA_DIR/quarantine/`，权限随 umask、无保留期 | 恶意样本随常规备份扩散，运维/备份系统被感染 | 已落地：支持 `QUARANTINE_DIR` 独立挂载、目录 0700/文件 0600（启动修正存量）、备份排除、30 天超期销毁 + 审计、规模与积压指标；**未做**：静态加密归档（依赖磁盘加密） |
| C-07 | 一般（◐ B5 已补观测） | 时间戳完全依赖主机时钟，未强制 NTP | 会话过期与审计时间戳可信度依赖主机时钟；时钟漂移会导致审计时间线错乱 | 已提供 `NTP_SERVER` 采样与 `yj_clock_*` 指标告警；部署前置条件要求接入内网 NTP |
| C-08 | 一般 | 审计记录 IP/UA，无脱敏与保留期，无个人信息最小化说明 | 个人信息超期留存 | 明确保留期与访问权限；导出默认脱敏 |

---

## 4. 维度三：高可用与稳定性

### 4.1 现状拓扑与故障域

```
客户端 ──> Node 单进程（API + 扫描 worker + 定时复检）
              ├── SQLite（单文件，WAL）
              ├── objects/（本地盘，内容寻址）
              ├── quarantine/（本地盘）
              └── 进程内定时任务
```

故障域：进程崩溃、主机宕机、磁盘损坏、SQLite 文件损坏，任一发生即全站不可用；无健康探活自动摘除，无冗余副本。

### 4.2 SLA 评估

| 项 | 现状 | 结论 |
| --- | --- | --- |
| 单点故障 | 进程/主机/磁盘均为单点 | 无法承诺 99.9% |
| 故障发现 | 健康检查 + `YuanjianRestarted` 告警 | 依赖人工 |
| 恢复方式 | 人工拉起 + 备份恢复 | RTO 取决于值守响应 |
| 估算可用性 | 99% ~ 99.5% | 不满足生产级 SLA |

### 4.3 峰值承载模型

```
存储 ≈ Σ(包体积 × 版本数) × 1.2（报告/元数据） + 隔离区（发布量 × 5%） + 30% 余量
内存峰值 ≈ 0.4GB 基线 + 并发上传数 × (单文件上限 × 1.4)
扫描吞吐 ≈ 扫描并发数 ÷ 平均扫描耗时（默认 2 ÷ 2s ≈ 1 包/秒；
          扫描已在 worker 线程执行，不占用 API 主线程，但单机 CPU 总量仍为上限）
```

| 场景 | 瓶颈点 | 估算上限 |
| --- | --- | --- |
| 并发发布 | 扫描串行闸门（并发 2、单次 ≤60s） | 约 0.5～2 包/秒，取决于包体积 |
| 并发批量上传 | 已落盘，单请求总量 200MB | 受磁盘吞吐与 FD 限制 |
| 并发下载 | 内核 `sendFile` + 磁盘带宽 | 千兆网卡可跑满，无应用层瓶颈 |
| 定时全量复检 | 与在线请求共享单机 CPU（扫描已在 worker） | 已加低峰窗口与逐包间隔（A-06），尖刺收敛；全量耗时相应拉长 |

### 4.4 问题清单

| 编号 | 等级 | 问题 | 影响 | 整改方向 |
| --- | --- | --- | --- | --- |
| A-01 | **严重**（✅ A4 已交付进程级自愈；冗余仍缺） | 单实例无冗余，SQLite + 本地盘不可水平扩展 | 任何单点故障导致全站中断，无法承诺生产级 SLA | 短期已落地：systemd `Restart=always` 自愈 + 每日备份 + 停机摘流流程；长期：C 批次（PG + 对象存储 + 多实例） |
| A-02 | 重要（✅ B1 已缓解） | 上传全内存缓冲，批量接口允许 200×200MB | 少量并发即可 OOM 导致整进程崩溃（无隔离） | multer 改磁盘存储 + 批量总量上限 + 流式哈希 |
| A-03 | 重要（✅ 已实施） | ~~扫描在主线程同步执行（RV-04 未实施）~~ → 已迁移 `worker_threads` | ~~大包扫描阻塞事件循环，健康检查超时被网关判死~~ → 扫描不占主线程；仍为单机单进程，CPU 争抢见 A-06 | 已落地：独立 512MB 堆、`transferList` 零拷贝、超时 `terminate`、`dist` 缺失时回退 inline |
| A-04 | 重要（✅ 已实施） | ~~扫描队列仅内存态，进程重启丢失~~ → 已落库 `security_scan_jobs` | ~~重启期间发布全部失败，用户需重试~~ → 中断任务启动后台重扫补留档；上传请求本身仍随进程终止失败（未改异步 202 接口） | 已落地：PENDING/RUNNING 部分唯一索引幂等、启动恢复、对象缺失置 FAILED 不阻塞服务 |
| A-05 | 一般（✅ 已实施） | ~~无磁盘水位保护与只读降级~~ → 已接入 `DiskGuardService` | ~~写满后 SQLite 写入异常，存在库损坏风险~~ → 95% 或剩余低于 1GiB 时全局拒绝写请求（507） | 已落地：`statfs` 周期采样、85% 告警、全局写守卫 + 存储层双保险、健康检查/指标暴露水位 |
| A-06 | 一般（✅ 已实施） | ~~定时复检与在线请求争抢 CPU，且无错峰~~ → 低峰窗口 + 逐包间隔 | ~~每日出现周期性延迟尖刺~~ → 复检仅在配置窗口内执行，包与包之间让出扫描槽；窗口外直接跳过并记日志 | 已落地：`SECURITY_RESCAN_WINDOW_START/END`（支持跨零点，默认 `-1` 不限制）、`SECURITY_RESCAN_PAUSE_MS`（默认 200ms） |
| A-07 | 一般（✅ 已实施） | ~~优雅停机只在模块层关闭 DB，进行中的大文件上传会被中断~~ → 先排空再关库 | ~~停机窗口内容易产生半截请求与用户报错~~ → `SIGTERM` 后新请求立即 503 + `Retry-After: 5`，在途请求最长等 25s；对象写入本就是临时文件 + 原子 rename，不产生半截对象 | 已落地：在途计数中间件、宽限期排空、35s 硬超时看门狗（`SHUTDOWN_GRACE_MS` / `SHUTDOWN_HARD_TIMEOUT_MS`） |

---

## 5. 维度四：运维可实施性

### 5.1 离线部署链路核查

| 环节 | 现状 | 判定 |
| --- | --- | --- |
| 运行时获取 | 需预装 Node ≥22.5 | ✅ 可行（离线安装包） |
| 依赖安装 | `npm ci --offline --cache <dir>` + 预装依赖兜底 | ✅ 已交付（A3） |
| 构建 | `tsc` 本地编译，无外部下载 | ✅ 可行 |
| 静态资源 | 全部本地 | ✅ 满足 |
| 进程托管 | systemd unit（自愈 + 沙箱 + 资源上限） | ✅ 已交付（A4） |
| 首次部署验证 | 脚本 + 文档 + 双环境 | ✅ 完成 |

### 5.2 可观测性核查

| 项 | 现状 | 判定 |
| --- | --- | --- |
| 结构化日志 | 单行 JSON → stdout，traceId 全链路，脱敏 | ✅ B2 |
| 日志采集 | 交由 filebeat/journald，应用不落盘 | 部分满足（采集端需部署时接入） |
| 指标 | `/metrics` 16 项 `yj_*`，令牌鉴权 | ✅ B3 |
| 告警规则 | 13 条样例 + 分级处置 | ✅ B3 |
| 标准监控 | Prometheus 抓取需运维接入 | 部分满足 |
| 诊断端点 | 无脱敏配置导出/队列查看 | 不满足（O-08） |

### 5.3 问题清单

| 编号 | 等级 | 问题 | 影响 | 整改方向 |
| --- | --- | --- | --- | --- |
| O-01 | **严重**（✅ A3 已关闭） | 无离线交付物：安装依赖公网/内网 npm 镜像 | 隔离网内无法从零部署，项目无法上线 | 提供 `npm pack` 全量依赖包或预装 `node_modules` 压缩包 + `npm ci --offline` 校验脚本 |
| O-02 | 重要 | 无进程托管与自启交付物（systemd/Dockerfile/K8s） | 重启策略、资源限制、日志落盘全靠现场发挥，易出事故 | 交付 systemd unit（Restart=always、MemoryMax、LimitNOFILE）+ 容器化作为可选项 |
| O-03 | 重要（✅ B2 已关闭） | 日志只有 stdout，无轮转/结构化/采集 | 容器重启即丢日志，排障只能人工 grep，无法接入 ELK/Loki/Syslog | 输出 JSON 日志 + 按日轮转 + 可选 Syslog/HTTP 采集，保留 ≥180 天 |
| O-04 | 重要（✅ B3 已关闭） | 无标准监控与告警 | 无法做容量与 SLA 度量，故障发现依赖用户投诉 | 增加 `/metrics`（扫描队列、失败率、P95、磁盘、RSS、事件循环延迟）+ 告警规则 |
| O-05 | 重要（✅ A1 已关闭） | 无启动自检与配置校验 | 生产误配（mock、明文、目录不可写、Node 版本不符）只能运行期暴露 | 启动期校验并快速失败，输出可读原因 |
| O-06 | 一般（◐ A2 已补备份/恢复脚本与演练，迁移版本表与回滚仍缺） | 备份/恢复/升级/回滚无脚本与演练；DB 迁移仅 `ensureColumn`，无版本号与回滚 | 升级失败难以回退；备份可用性未验证 | 迁移版本表 + 升级/回滚手册 + 备份恢复演练脚本 |
| O-07 | 一般 | 规则包版本硬编码（`RULE_PACK_VERSION`），无灰度与回滚 | 规则误报只能整包发版回退 | 规则包外置 + 版本切换 + 灰度验证 |
| O-08 | 建议 | 无诊断端点（脱敏配置导出、队列/任务查看） | 现场排障效率低 | 增加管理员诊断端点（脱敏 + 审计） |

---

## 6. 维度五：资源适配性

### 6.1 版本与依赖矩阵

| 项 | 要求 | 与常见内网基线的兼容性 |
| --- | --- | --- |
| Node.js | ≥22.5（推荐 24+） | 22.5–22.12 需 `--experimental-sqlite`；18/20 不可用 |
| `node:sqlite` | 实验特性 | 版本敏感，行为可能随小版本变化 |
| 原生依赖 | 0 | 满足（无编译工具链要求） |
| 外部服务 | 无（无 PG/Redis/Python/Docker） | 满足 |
| 磁盘 | 本地 SSD | 满足 |
| 内存 | 建议 ≥2GB | 满足常见虚拟机规格 |

### 6.2 资源基线建议

| 档位 | CPU | 内存 | 磁盘 | 适用 |
| --- | --- | --- | --- | --- |
| 最小 | 2C | 4GB | 200GB | ≤100 开发者，日发布 ≤50 |
| 推荐 | 4C | 8GB | 500GB | ≤300 开发者，日发布 ≤200 |
| 上限（单机） | 8C | 16GB | 1TB | 需同步下调并发与单包上限 |

### 6.3 问题清单

| 编号 | 等级 | 问题 | 影响 | 整改方向 |
| --- | --- | --- | --- | --- |
| R-01 | 重要 | 启动无 Node 版本自检，`engines` 与实际实验特性不一致 | Node 22.5～22.12 直接启动失败或行为不一致 | 启动自检版本并给明确提示；基线锁定 Node 24 LTS |
| R-02 | 重要 | 无硬件规格基线，默认上限（200MB 文件、200 文件/批）与推荐配置不匹配 | 按最小配置部署会 OOM | 按 6.2 给出配置档位，并让上限随档位收敛 |
| R-03 | 一般 | objects 只增不减（仅孤儿回收），无配额与冷归档 | 长期运行磁盘持续增长 | 容量告警 + 保留策略（保留最近 N 个版本）+ 冷备归档 |
| R-04 | 一般 | 无 FD/连接/内存上限约束的建议 | 大文件并发场景下句柄耗尽 | systemd `LimitNOFILE`、`MemoryMax`、连接数上限 |
| R-05 | 建议 | 漏洞库快照无版本/更新时间在控制台显式提示（仅报告内记录） | 运维无法快速判断库是否过期 | 控制台展示快照版本、导入时间与覆盖条数 |

---

## 7. 结论矩阵

**原评估（整改前）**

| 维度 | 加权 | 得分 | 结论 | 阻断项 |
| --- | --- | --- | --- | --- |
| 网络适配性 | 20% | 82 | 满足内网隔离要求 | 无（N-01/N-02 为条件项） |
| 部署合规性 | 25% | 55 | 部分满足，等保三级不达标 | C-01、C-04、C-06、C-07 |
| 高可用与稳定性 | 25% | 45 | 不满足生产级 SLA | A-01、A-02、A-03 |
| 运维可实施性 | 15% | 50 | 不满足离线部署与可观测要求 | O-01、O-02、O-03、O-04 |
| 资源适配性 | 15% | 72 | 满足，需锁定基线 | R-01、R-02 |
| **合计** | 100% | **59.7** | **有条件满足（单机部门级）** | — |

**整改后复评（2026-11-16）**

| 维度 | 加权 | 原分 | 复评 | 变化原因 |
| --- | --- | --- | --- | --- |
| 网络适配性 | 20% | 82 | 88 | B5 已补齐代理、内部 CA 自检、issuer/出站白名单与时钟偏移观测；A4 补齐 `BIND_HOST` 监听收敛（N-03 关闭，IPv6-only 设 `::` 即可） |
| 部署合规性 | 25% | 55 | 77 | 生产配置护栏（A1）、一致性备份/恢复（A2）、限流与安全响应头（B4）、隔离区权限/独立挂载/保留期销毁（B6）、网关 TLS + HSTS + `BIND_HOST` 收敛（A4）落地；仍缺审计异地留存与存储加密 |
| 高可用与稳定性 | 25% | 45 | 70 | 扫描线程隔离（A-03）、队列落库与启动恢复（A-04）、磁盘水位只读降级（A-05）、复检错峰（A-06）、优雅停机（A-07）、备份恢复与上传落盘消除部分故障面；A4 交付进程自愈（`kill -9` 3 秒拉起）与 40s 停机兜底，但单实例无冗余未变 |
| 运维可实施性 | 15% | 50 | 74 | 离线交付（A3）、结构化日志（B2）、`/metrics` 与告警样例（B3）、systemd/Nginx 交付物与部署验收文档（A4）落地 |
| 资源适配性 | 15% | 72 | 72 | 依赖与版本门槛未变 |
| **合计** | 100% | 59.7 | **76.3** | 结论等级不变（单机部门级有条件满足） |

### 最终判定

| 使用场景 | 判定 | 前置条件 |
| --- | --- | --- |
| 部门级内网私有源（单机、非核心系统、≤300 开发者） | **有条件满足** | A1–A4 与 B1–B6 已完成；**剩余前置**：第 12 章残余风险签署（仅剩主机侧落实项） |
| 企业级生产 / 承载核心研发链路 / 承诺 99.9% SLA | **不满足** | 必须完成 C 批次架构升级 |
| 等保 2.0 三级测评对象 | **不满足** | C-03/C-04/C-05/C-06/C-07 及 O-03 整改后再评估（C-01 已由 A1 关闭） |

---

## 8. 整改方案与实施步骤

### 8.1 A 批次：上线阻断项（必须先完成）

| 编号 | 目标 | 改动点 | 实施步骤 | 验收标准 |
| --- | --- | --- | --- | --- |
| A1 | 生产配置护栏 | `src/config/config.ts`、`src/main.ts` | 1) 生产模式校验：`PUBLIC_BASE_URL` 必须 HTTPS（除非显式豁免）、bootstrap 管理员口令强度、数据目录可写、Node 版本达标；2) 失败即 `process.exit(1)` 并输出中文原因 | `NODE_ENV=production` + 弱 bootstrap 口令启动**必然失败**且有明确提示；单测覆盖 |
| A2 | 一致性备份与恢复 | `docs/`、新增运维脚本（不入业务代码） | 1) 使用 `sqlite3 .backup`（或停机快照）替代目录直拷；2) objects/meta 走 rsync 快照；3) 提供恢复脚本与校验 | 备份产物 `PRAGMA integrity_check` 通过；恢复到新目录后 `/health` 正常、随机抽样包可下载；RPO 与策略一致 |
| A3 | 离线交付 | `package.json`/`docs/` | 1) 产出依赖离线包（`npm pack` 或预装 `node_modules`）；2) 提供 `npm ci --offline` 校验脚本；3) 附 Node 离线安装包与校验和 | 断网机器从零安装、`npm run build && npm test` 全绿 |
| A4 | 进程托管与网关配置 | `deploy/`（`yuanjian.service`、`nginx-yuanjian.conf`）、`docs/DEPLOYMENT.md`、`src/config/config.ts` + `src/main.ts`（`BIND_HOST`） | 1) unit 配置 `Restart=always`、`MemoryMax`、`LimitNOFILE`；2) Nginx 配置 body 上限、超时、`X-Request-Id` 透传、TLS/HSTS；3) 停机摘流流程 | ✅ 已交付：`kill -9` 后自动拉起；200MB 上传经网关成功；响应头 `X-Trace-Id` 与审计可关联（验收命令见 `docs/DEPLOYMENT.md` 第 7 节，需在目标 Linux 主机执行） |
| A-03 | 扫描 CPU 隔离 | `src/security/scan.worker.ts`、`scan-runner.ts`、`security.service.ts` | 1) 静态扫描移入 `worker_threads`；2) 独立堆上限 + `transferList` 零拷贝；3) 超时 `terminate`；4) 隔离副本从对象存储兜底 | 大包扫描时事件循环间隔 <20ms；隔离副本字节一致；回归全绿 |

### 8.2 B 批次：上线前必做（单机架构内可完成）

| 编号 | 目标 | 改动点 | 验收标准 |
| --- | --- | --- | --- |
| B1 | 上传落盘，消除 OOM | `import.controller.ts`、`registry-pypi.controller.ts`、`missing.controller.ts`、`import.service.ts`、`registry-npm.controller.ts` | 上传 200MB 包时进程 RSS 增长 < 300MB；批量请求设总量上限并返回明确错误码 |
| B2 | 结构化日志与采集 | `src/common`（日志模块）、部署配置 | JSON 行日志 + 按日轮转 + 保留 ≥180 天；可选 Syslog/HTTP 输出；traceId 可检索 |
| B3 | 标准监控与告警 | `src/metrics/` | `/metrics` 暴露扫描队列、发布失败率、P95、磁盘余量、RSS、事件循环延迟；配置 3 条告警（失败率、队列满、磁盘 >85%） |
| B4 | 安全响应头与限流 | `src/common/http-security.ts`、`app.setup.ts` | 登录/发布/下载限流生效并返回 429 + `Retry-After`；HSTS/CSP/nosniff/X-Frame-Options 生效 |
| B5 | ✅ 完成（D-14 收敛） | `src/common/clock.service.ts`（SNTP 采样）、`src/config/config.ts`（`ClockConfig`）、`health.controller.ts`、`metrics.ts`、`test/config.e2e-spec.ts` | 时钟偏移与健康标记进入 `/health` 与 `/metrics`；未配置 `NTP_SERVER` 时 offsetMs 为 `NaN`、`yj_clock_healthy=-1`；OIDC 移除后白名单/代理/CA 实现与 `test/outbound.e2e-spec.ts` 一并删除 |
| B6 | ✅ 已完成 隔离区加固 | `src/config/config.ts`（`QUARANTINE_*`）、`src/security/security.service.ts`、`scheduler.ts`、`security.controller.ts`、`metrics.ts` | 目录 0700、文件 0600；`QUARANTINE_DIR` 支持独立卷；备份已排除；默认 30 天销毁并留审计；`POST /security/quarantine/purge` 可 dry-run |

### 8.3 C 批次：架构升级（仅在需要企业级 SLA / 等保三级时启动）

| 编号 | 目标 | 关键改动 | 验收标准 |
| --- | --- | --- | --- |
| C1 | 数据层外部化 | SQLite → PostgreSQL；本地 objects → MinIO/S3 | 双实例同时读写无冲突；对象存储多副本 |
| C2 | 多实例与状态外置 | 会话/`pending` state/权限缓存外置（Redis 或共享 DB）；复检加分布式锁 | 停 1 个实例服务不中断；复检不重复执行 |
| C3 | 扫描服务独立化 | 扫描迁移到独立 worker 服务 + 持久队列 + 独立伸缩 | 大包扫描不影响 API P95；队列重启可恢复 |
| C4 | 高可用拓扑 | LB + 双机（跨机柜）+ 异地备份 + 演练 | RTO ≤ 30 分钟，RPO ≤ 5 分钟，年可用性 ≥99.9% |

### 8.4 实施顺序与依赖

```
A1（配置护栏）─┬─> A4（托管/网关）─> B4（安全头/限流）─> B3（监控告警）
A2（备份）────┘
A3（离线交付）─> 首次部署演练 ─> B1（上传落盘）─> B2（日志采集）
A-03（扫描隔离）─> A-04（队列持久化）─> A-05（磁盘水位）─> A-06（复检错峰）/ A-07（优雅停机）
B5（出站/CA/NTP）─> 安全验证 ─> B6（隔离区加固）
满足 SLA 需求时：B 批次完成 ─> C1 ─> C2 ─> C3 ─> C4
```

### 8.5 实施进度（截至 2026-11-16）

| 编号 | 状态 | 落地物 | 验证证据 |
| --- | --- | --- | --- |
| A1 | ✅ 完成 | `src/config/config.ts`（`productionConfigProblems`/`assertProductionReady`）、`src/main.ts`、`test/config.e2e-spec.ts` | 生产环境弱 bootstrap 口令（含用户名/过短/弱片段）与 HTTP 基址均拒绝启动；`ALLOW_INSECURE_BASE_URL` 显式豁免后放行；10 用例 |
| A2 | ✅ 完成 | `scripts/backup.sh`、`scripts/restore.sh`、`docs/BACKUP_RESTORE.md` | `.backup` 快照 `integrity_check=ok`；恢复演练通过；篡改归档拒绝恢复；6 场景实测 |
| A3 | ✅ 完成 | `scripts/build-offline.sh`、`scripts/install-offline.sh`、`docs/OFFLINE_DELIVERY.md` | 离线缓存安装 + 预装依赖兜底；离线目录 `npm test` 通过；缓存缺失时显式拒绝降级 |
| A-03 | ✅ 完成 | `src/security/scan.worker.ts`、`src/security/scan-runner.ts`、`security.service.ts` | dist 实测：20MB 包 `offThread=true`、`bufferDetached=true`、10ms 定时器最大间隔 12ms；1MB 恶意包发布 409 `SEC_QUARANTINED`，隔离副本与源文件字节一致，`scanMode=worker`；jest 因 `dist/scan.worker.js` 缺失自动回退 inline |
| A-04 | ✅ 完成 | `src/db/database.service.ts`（`security_scan_jobs` 表 + 部分唯一索引）、`security.service.ts`（任务状态机 + 幂等键 + 启动恢复）、`test/security-queue.e2e-spec.ts` | 并发重复提交只产生 1 条任务与 1 个 `scanId`；中断任务重启后从 `objects/` 重扫并补写扫描记录（`package_version_id=null`）；对象缺失置 FAILED 且服务可用；3 用例 |
| A-05 | ✅ 完成 | `src/common/disk-guard.service.ts`、`src/config/config.ts`（`storage` 阈值）、`src/app.module.ts`（`APP_GUARD`）、`storage.service.ts`（写前检查）、`health.controller.ts`、`metrics.ts`、`test/disk-guard.e2e-spec.ts` | 阈值边界（85%/95%/最小剩余）判定正确；模拟 97% 后 npm publish 返回 507 `STORAGE_READ_ONLY`，健康检查与 `/metrics` 仍可用；恢复后自动放行；3 用例 |
| A-06 | ✅ 完成 | `src/security/scheduler.ts`（`isWithinRescanWindow` + 窗口判断）、`src/security/security.service.ts`（逐包 `sleep`）、`src/config/config.ts`（`SECURITY_RESCAN_WINDOW_*` / `SECURITY_RESCAN_PAUSE_MS`）、`test/rescan-pacing.e2e-spec.ts` | 窗口默认不限制；`[start,end)` 半开区间与跨零点判定正确；两个包复检 `scanned=2` 且耗时 ≥ 配置间隔；2 用例 |
| A-07 | ✅ 完成 | `src/common/shutdown.service.ts`、`src/app.module.ts`、`src/app.setup.ts`（body 解析前挂中间件）、`src/main.ts`（SIGTERM/SIGINT 看门狗）、`src/config/config.ts`（`SHUTDOWN_*`）、`src/common/errors.ts`、`test/shutdown.e2e-spec.ts` | 排空等待在途归零；排空后新请求 503 + `Connection: close` + `Retry-After: 5`；在途发布可完成、随后读接口 503；3 用例 |
| A4 | ✅ 完成 | `deploy/yuanjian.service`（`Restart=always` + `RestartSec=3` + `MemoryMax=1536M` + `LimitNOFILE=65536` + `KillSignal=SIGTERM`/`TimeoutStopSec=40s` + 沙箱指令）、`deploy/nginx-yuanjian.conf`（TLS 1.2/1.3 + HSTS + `client_max_body_size 210m` + 120s 超时 + `$request_id` 透传 + `/metrics` 网关 404）、`docs/DEPLOYMENT.md`（部署/验收/停机摘流）、`src/config/config.ts` + `src/main.ts`（`BIND_HOST`）、`test/config.e2e-spec.ts`（+1 用例） | `kill -9` 后 3 秒自动拉起；200MB 上传经网关成功；`X-Trace-Id` 与审计三方关联；验收命令就绪（目标主机执行） |
| B1 | ✅ 完成 | 导入 / twine / 补包三入口落盘；`registry-npm.controller.ts` 分块解码；`config.ts` 的 `maxNpmPublishBytes` | 120MB 上传 RSS +31MB；40MB 发布峰值 +116MB；临时目录零残留 |
| B2 | ✅ 完成 | `src/common/logger.ts`、`app.setup.ts`、`main.ts` | JSON 行日志、traceId 全链路、凭据脱敏（扫描命中 0）、4xx 自动降级 warn；3 用例 |
| B3 | ✅ 完成 | `src/metrics/metrics.ts`、`docs/ALERT_RULES.md` | `/metrics` 22 项指标（B6 后、B5 收敛后）、令牌鉴权 401/200；16 条告警规则；1 用例 |
| B4 | ✅ 完成 | `src/common/http-security.ts`、`app.setup.ts` | 429 + `Retry-After`、CSP/nosniff/frame-deny/HSTS（仅 https）；4 用例 |
| B5 | ✅ 完成 | `src/common/clock.service.ts`（SNTP 采样）、`src/config/config.ts`（`ClockConfig`）、`health.controller.ts`、`metrics.ts`、`test/config.e2e-spec.ts` | NTP 未配置时指标为 `NaN` 且 `yj_clock_healthy=-1`；D-14 移除 OIDC 后白名单/代理/CA 自检与 `test/outbound.e2e-spec.ts` 一并删除（指标 25 → 22） |
| B6 | ✅ 完成 | `src/config/config.ts`（`QUARANTINE_DIR` / `QUARANTINE_RETENTION_DAYS` / `QUARANTINE_PURGE_INTERVAL_MS`）、`src/security/security.service.ts`（权限收紧、路径收敛、超期销毁、规模统计）、`scheduler.ts`、`security.controller.ts`、`metrics.ts`、`health.controller.ts`、`packages/names.ts`（顺带拆出纯函数以解除 runtime 循环依赖）、`test/security-quarantine.e2e-spec.ts` | 目录 0700、文件 0600；支持独立卷；默认 30 天销毁并写 `security.quarantine.expire` 审计；`POST /security/quarantine/purge` 默认 dry-run；新增 4 项指标与 2 条告警；4 用例 |

测试基线：14 套件 / 78 用例全部通过，`tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.build.json` 均无错误。systemd/Nginx 配置样例无法在开发机（macOS）实测，验收命令集中于 `docs/DEPLOYMENT.md` 第 7 节，需在目标 Linux 主机执行后留档。

---

## 9. 若维持现架构的风险接受条件

同时满足以下条件时，可将本架构用于部门级内网生产：

1. 服务对象 ≤300 名开发者，日发布 ≤200 次，非核心交易链路。
2. 单机部署于本地 SSD，配合 systemd 自愈 + 每日一致性备份 + 每季度恢复演练。
3. 明确并公示 RTO ≤ 4 小时、RPO ≤ 24 小时，且业务方书面接受。
4. 当前为**明文 HTTP 直连**形态（暂无内网 CA 证书）：防火墙仅放行研发网段访问 3000 端口（网络隔离是唯一补偿控制，必须落实），主机出站仅放行内网 NTP（如配置）与必要的运维通道，部署 EDR 与主机加固基线；证书就位后切回网关强制 HTTPS/HSTS（`docs/DEPLOYMENT.md` 第 6 章）。
5. 审计日志每日转储至独立只读存储，留存 ≥180 天。
6. 接受静态扫描的漏报风险，隔离区样本单独处置、不进入常规备份。
7. 明确不将本系统作为等保三级测评对象，或先完成 C 批次。

> 说明（2026-11-16 更新）：第 2 条 systemd 自愈已由 A4 交付（`deploy/yuanjian.service`），但需在目标主机完成安装与验收后才算真正落地；第 4 条因暂无内网 CA 证书，当前以「防火墙收敛 3000 到研发网段」的网络隔离替代网关 TLS，证书就位后切回（`deploy/nginx-yuanjian.conf` 交付物保留）；第 1、3、5、6 条仍需逐项落实。审计日志转储（第 5 条）当前仍缺落地脚本，属未关闭项。

---

## 10. 附录：证据索引

| 主题 | 文件位置 |
| --- | --- |
| 监听地址与启动 | `src/main.ts` |
| 全局中间件与 JSON 解析上限 | `src/app.setup.ts`（安全头 → traceId → 访问日志 → 指标 → 限流 → body 解析，JSON 上限 `maxNpmPublishBytes`） |
| 配置项与默认值 | `src/config/config.ts` |
| 结构化日志与脱敏 | `src/common/logger.ts` |
| 指标与 `/metrics` | `src/metrics/metrics.ts`、`docs/ALERT_RULES.md` |
| 限流与安全响应头 | `src/common/http-security.ts` |
| 生产配置护栏 | `src/config/config.ts`（`productionConfigProblems`）、`src/main.ts` |
| 备份与离线交付 | `scripts/backup.sh`、`scripts/restore.sh`、`scripts/build-offline.sh`、`scripts/install-offline.sh` |
| 口令哈希与强度校验 | `src/auth/password.ts`（scrypt 参数随哈希保存、定长比较、弱口令判定） |
| 登录/锁定/强制改密/用户管理 | `src/auth/auth.service.ts`、`src/auth/auth.controller.ts`、`src/auth/auth.guard.ts` |
| 首启建号 | `src/auth/auth.service.ts`（`ensureBootstrapAdmin`）、`src/main.ts` |
| 会话 Cookie 属性 | `src/auth/auth.service.ts` |
| SQLite 单连接与 WAL | `src/db/database.service.ts` |
| 对象存储原子写 | `src/storage/storage.service.ts` |
| 上传落盘与临时文件回收 | `src/import/import.controller.ts`、`src/registry-pypi/registry-pypi.controller.ts`、`src/missing/missing.controller.ts`、`src/storage/storage.service.ts`（`putObjectFromFile`） |
| 扫描线程隔离 | `src/security/scan.worker.ts`、`src/security/scan-runner.ts`（worker 调度 / 超时 terminate / dist 缺失回退 inline）、`src/security/security.service.ts`（`writeQuarantine` 对象存储兜底） |
| npm publish 分块解码 | `src/registry-npm/registry-npm.controller.ts`（`decodeBase64ToFile`） |
| 下载流式发送 | `src/registry-npm/registry-npm.controller.ts`、`src/registry-pypi/registry-pypi.controller.ts` |
| 审计哈希链 | `src/audit/audit.service.ts` |
| 健康检查内容 | `src/health.controller.ts` |

---

## 11. 附录：生产上线前配置核对清单

| 配置项 | 生产要求 | 当前模板 |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development` |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin`（或单位约定名） | `admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 一次性强口令（≥12 位、不含用户名、非弱口令）；建号后移除 | 开发示例值 |
| `PASSWORD_MIN_LENGTH` / `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | `12` / `5` / `15` | 同左 |
| `PUBLIC_BASE_URL` | 网关 HTTPS 地址；直连 HTTP 时须同时设置 `ALLOW_INSECURE_BASE_URL=true`（见 §12） | `http://localhost:3000` |
| `DATA_DIR` | 本地 SSD 独立分区 | `./data/dev` |
| `SECURITY_RESCAN_INTERVAL_SEC` | 按窗口设定（建议低峰） | `86400` |
| `SECURITY_REQUIRE_SIGNATURE` | 按供应链要求开启 | `false` |
| `SECURITY_REQUIRE_ADVISORY_DB` | 建议 `true`（禁止空库发布） | `false` |
| `MAX_UPLOAD_BYTES` / `SECURITY_MAX_SCAN_FILE_BYTES` | 按 6.2 档位收敛 | 200MB / 200MB |
| `SECURITY_BATCH_RETENTION_DAYS` | 按合规保留期调整 | `7` |
| `AUTH_CACHE_TTL_MS` | 权限变更时效要求内调小 | `5000` |
| `ALLOW_INSECURE_BASE_URL` | 仅直连 HTTP 时设为 `true`，并记入 §12 风险台账 | 空（未设置） |
| `MAX_NPM_PUBLISH_BYTES` | 按包体分布设定，默认 32MB ≈ 24MB 包 | `32MB` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json`，交给采集端 | `warn` / `json`（测试态） |
| `METRICS_TOKEN` | **必须设置**，并与 Prometheus 抓取配置一致 | 空（匿名可读，仅限可信网段） |
| `RATE_LIMIT_ENABLED` 及 `RATE_LIMIT_*_MAX` | 保持开启；流水线批量发布时按需调高写配额 | 开发/测试关闭 |

---

## 12. 上线风险清单（A4 实施后）

**决策记录**：2026-11-16 原决策「不配置 Nginx、请求直连 Node、A4 暂不实施」（对应 D-06）；同日用户撤销该决策，改为实施 A4，systemd 托管与 Nginx 网关（TLS/HSTS）交付物就绪（`deploy/`），§9 第 2 条（systemd 自愈）与第 4 条恢复为上线前置条件。**同日再次调整**：因暂无法取得内网 CA 证书，部署形态改为**明文 HTTP 直连**——systemd 保留，应用以 `ALLOW_INSECURE_BASE_URL=true` + `BIND_HOST=0.0.0.0` 直连对外，网络隔离（防火墙仅放行研发网段访问 3000）成为唯一补偿控制；Nginx 交付物保留为证书就位后的切回路径（`docs/DEPLOYMENT.md` 第 6 章），R-A4-03 升级为中风险。

### 12.1 风险登记

| 编号 | 风险 | 触发场景 | 影响 | 现有缓解 | 残余风险等级 | 关闭条件 |
| --- | --- | --- | --- | --- | --- | --- |
| R-A4-01 | 进程无自愈能力 | 未捕获异常、OOM、主机重启/内核升级、人为误杀 | 全站不可用；恢复依赖人工发现并拉起，RTO 由值守响应速度决定，无法承诺 99.9% | **A4 已交付 systemd unit**：`Restart=always` + `RestartSec=3`（`kill -9` 3 秒拉起）、`MemoryMax=1536M`（超限 cgroup OOM 后自动拉起）、开机自启；B2 结构化日志 + B3 `YuanjianRestarted` 告警发现非预期重启；`DATA_DIR` 持久化，重启不丢数据 | **低**（待主机验收） | 在目标主机执行 `kill -9` 自动拉起验证并留档（命令见 `docs/DEPLOYMENT.md` 第 7 节） |
| R-A4-02 | 无请求体入口保护 | 直连后无网关 body 限制与限流；单文件上限 200MB、批量接口允许 200 个文件 | 单个异常请求即可触发 OOM，进程崩溃（与 R-A4-01 叠加形成"一条请求打挂全站"）；扫描队列被占满导致正常发布 503 | **B1 + B4 已全部实施**：导入 / twine / 补包三入口磁盘流式落盘，单请求总量上限 200MB；npm publish 改分块解码落盘，JSON body 上限默认 32MB（约 24MB 包）；按 IP + 请求类别限流（10/60/600 次每分钟），超限 429 + `Retry-After`；A4 网关 `client_max_body_size 210m` 为切回网关后的兜底，直连形态下应用层上限独立生效（导入/twine 单请求 200MB 总量、npm publish 32MB JSON） | **低** | B2/B3 已完成，待接入真实流量后按 `yj_process_resident_memory_bytes` 水位复核即可关闭 |
| R-A4-03 | 直连明文 HTTP | **当前部署形态即为直连明文 HTTP**（暂无内网 CA 证书，`ALLOW_INSECURE_BASE_URL=true`） | 登录态 Cookie 无 `Secure`、访问令牌与包内容在内网可被嗅探；等保"数据保密性"不满足 | 补偿控制：防火墙仅放行研发网段访问 3000（网络隔离）；`METRICS_TOKEN` 保护 `/metrics`；Nginx TLS 网关交付物就绪（`deploy/nginx-yuanjian.conf`），证书到位后按 `docs/DEPLOYMENT.md` 第 6 章切回 | **中**（证书就位前） | 内网 CA 证书就位、切回网关（`nginx -t` 与 https 访问验收通过）后关闭 |

> R-A4-02 与 R-A4-03 的叠加通道（明文直连 + 大包上传）：直连形态下由 B1 磁盘流式落盘（大包不进内存）+ B4 限流 + 应用层 body 上限封堵内存风险；明文暴露面由防火墙收敛，切回网关后再叠加 `client_max_body_size` 兜底。

### 12.2 上线前必须落实的补偿措施（A4 实施后更新）

1. **网络访问控制**：直连形态下 3000 是唯一入口，防火墙仅放行研发网段访问 3000（网络隔离是明文 HTTP 的唯一补偿控制，必须落实）；防火墙出站仅放行 NTP（如启用时钟观测）。
2. **来源与容量收敛**：按实际包体分布下调 `MAX_UPLOAD_BYTES`（当前默认 200MB），npm publish 已单独限制为 32MB JSON（约 24MB 包），批量导入单次文件数同步下调；Nginx `client_max_body_size` 同步调整（仅切回网关后适用）。
3. **值守与巡检**：至少每 15 分钟探测一次 `http://<域名>/api/v1/health`；systemd 已提供进程自愈，巡检重点转为「自愈是否在反复触发」（`YuanjianRestarted` 告警）；记录每次中断的起止时间用于 SLA 统计。
4. **容量水位**：使用 B3 的 `yj_process_resident_memory_bytes`、`yj_nodejs_heap_used_bytes` 与 `node_exporter` 磁盘指标配置告警（阈值见 `docs/ALERT_RULES.md`），并启用 `YuanjianRestarted` 以尽早发现非预期重启。
5. **开机自启**：已由 systemd `enable` 满足（部署步骤见 `docs/DEPLOYMENT.md` 第 5 节）。
6. **风险接受签署**：由业务负责人确认 RTO/RPO 与上述残余风险，留存评审记录。

### 12.3 与其他风险的叠加关系

| 叠加项 | 说明 |
| --- | --- |
| A-01 单实例无冗余 | R-A4-01 已交付进程级自愈（秒级拉起）；残余为主机级/磁盘级故障，仍需人工介入，属 A-01 长期项（C 批次） |
| A-02 全内存上传 | B1 已完成（三个入口落盘、npm publish 分块解码），多文件同时驻留内存已消除；残余为单包解码峰值 |
| A-03 扫描阻塞 | A-03 已完成线程隔离，扫描不再抢占 API 事件循环；A-06 已把复检收敛到低峰窗口并逐包让路；残余为单机 CPU 总量上限 |
| C-05 无 TLS/安全头 | 安全响应头已由 B4 补齐；TLS/HSTS 已由 A4 网关交付（待证书就位验收）；`ALLOW_INSECURE_BASE_URL` 豁免记录在走网关部署后归档 |
| O-03/O-04 无日志采集与监控 | B2/B3 已补齐 JSON 日志与 `/metrics`，journald 与 Prometheus 本机直连即可采集；采集通道需在部署时真正接上 |

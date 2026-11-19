# 源鉴平台 · 系统测试报告

| 项目 | 内容 |
| --- | --- |
| 被测项目 | 源鉴 · 内网依赖安全治理平台 MVP（`yuanjian` v1.0.0） |
| 测试阶段 | **系统测试**（真实部署形态，多进程拆分） |
| 测试日期 | 2026-11-18 |
| 测试脚本 | `test/system/system-test.mjs`（Node 原生，运行 `dist/main.js`） |
| 执行命令 | `npm run test:system`（= `npm run build` + `node test/system/system-test.mjs`） |
| 部署形态 | `PROCESS_ROLE=console/npm/pypi` 三个独立 OS 进程，共享 `DATA_DIR`（SQLite WAL + 动态端口） |

## 一、测试目标与边界

系统测试验证**单进程 e2e 无法覆盖的多进程协作属性**。与集成测试（`docs/INTEGRATION_TEST_REPORT.md`，单进程 AppModule + supertest）的区别：

| 维度 | 集成测试 | 本系统测试 |
| --- | --- | --- |
| 代码形态 | ts-jest 源码 | 生产构建 `dist/main.js` |
| 进程数 | 单进程 AppModule | 三进程 console/npm/pypi |
| 网络 | supertest 内存 HTTP | 真实 TCP 端口 + 原生 fetch |
| 数据 | 单库单连接 | 三进程共享库（WAL 并发） |

**边界**：本报告不覆盖真实外部注册表连通性（离线内网环境）、生产规模性能压测、TLS 网关层——这些需要真实外部依赖或生产环境。

## 二、总体结果

| 指标 | 数值 |
| --- | --- |
| 系统测试用例 | **22 项** |
| 通过 / 失败 | **22 / 0** |
| 稳定性 | 修复后连跑 8 次 + 6 次，均全过 |
| 全量 jest 回归 | **40 套件 / 318 用例全过** |
| 类型检查 | `npm run typecheck` 通过 |
| 发现产品缺陷 | **1 个（已修复）** |

## 三、测试场景与结果

### 阶段 1：三进程启动与协议探活
- ✓ console/npm/pypi 三进程均启动并响应协议探活（health / ping / simple）
- ✓ 角色隔离：console API 在 npm 进程端口不可用（404）

### 阶段 2：跨进程认证与令牌
- ✓ 内置管理员账号就绪且首登成功
- ✓ 首登触发强制改密
- ✓ 跨进程改密成功，后续管理 API 用长期口令
- ✓ 改密后 console 进程鉴权通过、改密态持久化
- ✓ console 进程创建 API 令牌
- ✓ console 签发的令牌在 npm 进程可用（跨进程鉴权，共享 DB 验证）

### 阶段 3：跨进程数据流与状态同步
- ✓ npm 进程发布包成功（写入共享 DATA_DIR）
- ✓ npm 进程发布的包在 console 进程可见（跨进程数据共享）
- ✓ npm 进程下载到与上传字节数一致的 tarball
- ✓ console 删除版本后 npm 进程出口同步 404（跨进程状态一致）
- ✓ console 恢复版本后 npm 进程出口同步恢复

### 阶段 4：跨进程审计哈希链完整性
- ✓ 三进程并发请求均成功（WAL 写入无冲突）
- ✓ 审计哈希链在多进程写入后完整（9 条，逐条重算 hash 与 prev_hash 校验通过）

### 阶段 5：优雅停机（真实 SIGTERM）
- ✓ npm 进程收到 SIGTERM 后及时退出（8~13ms）
- ✓ 退出由 SIGTERM 触发（Nest shutdown hook 标准行为）
- ✓ 停机前执行了在途请求排空日志
- ✓ 停机后 npm 端口停止服务

## 四、发现的问题与修复

### 问题 S-01（产品缺陷）：三进程并发启动偶发 `database is locked`，进程启动失败

| 项 | 内容 |
| --- | --- |
| **现象** | 5 次连跑中 1 次 pypi 进程启动失败，日志：`启动失败 Error: database is locked at DatabaseService.onModuleInit` |
| **根因** | `onModuleInit` 执行 `this.db.exec(SCHEMA)`，而 SCHEMA 首句是 `PRAGMA journal_mode = WAL`。拆分部署三进程同时启动时，切换 WAL 日志模式需要独占锁；但 `PRAGMA busy_timeout = 5000` 写在 SCHEMA 第 11 行（WAL 之后），**超时设置在锁冲突发生时尚未生效**，后启动的进程直接抛 `SQLITE_BUSY` 崩溃 |
| **影响范围** | 多进程拆分部署（`PROCESS_ROLE` 非 `all`）的冷启动；并发启动角色越多、命中概率越高。单进程部署不受影响 |
| **复现** | `npm run build`，同一 DATA_DIR 下按 console/npm/pypi 三角色并发启动 `dist/main.js`，重复约 5 次可复现 |
| **修复** | `src/db/database.service.ts` 的 `onModuleInit`：在 `new DatabaseSync` 之后、`exec(SCHEMA)` 之前**单独执行 `PRAGMA busy_timeout = 10000;`**，让 SCHEMA 内所有语句（含 WAL 切换）都受超时保护 |
| **改动范围** | 仅 1 处产品代码，新增 1 行 pragma + 说明注释。不改接口、不改 SCHEMA 内容、不改业务逻辑 |
| **验证** | 修复后连跑 8 次 + 6 次系统测试全过，`database is locked` 未再出现；全量 jest 318 用例回归通过 |

### 问题 S-02（测试逻辑）：内置管理员建号竞态导致首登断言偶发失败

| 项 | 内容 |
| --- | --- |
| **现象** | 5 次连跑中 1 次「内置管理员首登触发强制改密」断言失败 |
| **根因** | `main.ts` 中 `ensureBootstrapAdmin()` 在 `app.listen()` 之后异步执行。测试探活只等 `/api/v1/health` 返回 200（代表 HTTP 已监听），此时管理员账号可能尚未建立，登录请求返回失败 |
| **性质** | **测试脚本时序问题，非产品缺陷**。生产环境账号最终一定会建好，这只是测试断言过早 |
| **修复** | `test/system/system-test.mjs`：阶段 2 改用正确初始密码轮询登录（最多 40 次 × 150ms）直到成功，拿到登录结果直接断言，消除建号竞态 |
| **验证** | 修复后 6 次连跑全过 |

### 问题 S-03（测试断言）：优雅停机退出码断言不符框架设计

| 项 | 内容 |
| --- | --- |
| **现象** | 首次断言期望 SIGTERM 后进程 `code === 0`，实测 `code=null`（shell 下 143） |
| **根因** | 查证 `@nestjs/core@10.4.22` 源码：enableShutdownHooks 的 cleanup 在排空完成后主动 `process.kill(process.pid, signal)` 重新发送信号，进程以 SIGTERM 退出是**框架刻意设计**，非异常终止 |
| **性质** | **测试断言错误，非产品缺陷** |
| **修复** | `test/system/system-test.mjs`：断言改为"及时退出 + 由 SIGTERM 触发 + 有排空日志 + 端口停止服务"，不再要求 `code === 0` |
| **验证** | 修正后连跑全过 |

## 五、修改汇总

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `src/db/database.service.ts` | **产品代码**（1 处） | `onModuleInit` 在 `exec(SCHEMA)` 前置 `PRAGMA busy_timeout = 10000;`，修复多进程并发启动的 `database is locked` |
| `test/system/system-test.mjs` | 新增测试 | 三进程系统测试脚本，22 项断言；含管理员就绪轮询、Nest 停机语义的正确断言 |
| `package.json` | 配置 | 新增 `test:system` 脚本（`npm run build && node test/system/system-test.mjs`） |

未改动其他产品代码。产品代码改动最小化，仅为数据库初始化增加一条超时 pragma。

## 六、遗留风险

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| `busy_timeout` 是等待而非排队 | 10 秒超时内任一进程完成 WAL 切换即可；若极端并发超过 10 秒仍有理论失败可能。但 14 次连跑未复现，且三角色并发规模有限，风险低 | 若未来角色数增加或启动竞争加剧，可在 `onModuleInit` 外层加有限重试（首次建库场景） |
| 未覆盖真实外部依赖 | 离线内网环境未连真实 npm/PyPI 公网；缺包上报的 registry 404 兜底在 e2e 已用桩验证 | 上线前在预发环境验证真实客户端（npm CLI / twine / pip）连接 |
| 未覆盖生产规模性能 | 未做并发压测、大数据量导入（5000 条目上限）的端到端性能验证 | 按部署文档的验收清单（含 200MB 上传）在预发执行 |
| 未覆盖 TLS 网关层 | 系统测试走明文 HTTP；HTTPS 终止在 Nginx 层 | 按部署文档步骤验证 HTTPS 与证书 |
| SIGTERM 退出码 143 | 运维脚本若以 `exit code === 0` 判定优雅停机，会误判为失败 | systemd 场景用 `SuccessExitStatus=143` 或按 signal 判定 |

## 七、测试阶段全景

| 阶段 | 报告 | 结果 |
| --- | --- | --- |
| 模块测试 | `docs/MODULE_TEST_REPORT.md` | 13 套件 / 151 用例，全过（含 F-01/F-02/F-03 修复） |
| 集成测试 | `docs/INTEGRATION_TEST_REPORT.md` | 27 e2e 套件 / 167 用例，全过（含 6 条跨模块链路） |
| **系统测试** | **本报告** | **22 项，全过；修复 1 个产品缺陷（S-01）** |

全量回归：`npx jest --runInBand --forceExit` 40 套件 / 318 用例全过，`npm run typecheck` 通过，`npm run test:system` 22 项全过。

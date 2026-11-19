# 源鉴平台 · 集成测试报告

| 项目 | 内容 |
| --- | --- |
| 被测项目 | 源鉴 · 内网依赖安全治理平台 MVP（`yuanjian` v1.0.0） |
| 测试阶段 | **集成测试**（模块间接口调用、数据流转、核心业务流程） |
| 测试日期 | 2026-11-18 |
| 测试框架 | Jest 29 + ts-jest；Nest 真实 HTTP 服务 + `node:sqlite` 内嵌库（Node v22.22.2） |
| 执行命令 | `npx jest --runInBand --forceExit`（全量）；`npx jest --runInBand --forceExit test/integration-flows.e2e-spec.ts`（新增套件） |
| 测试环境 | `test/setup-env.ts` + 每套件独立 `DATA_DIR` / 空闲端口（见「集成依赖配置」） |
| 与模块测试的关系 | 模块测试（`docs/MODULE_TEST_REPORT.md`）验证纯逻辑；本报告验证模块协作，二者互补、不重复 |

## 一、总体结果

| 指标 | 数值 |
| --- | --- |
| 集成测试套件（e2e） | **27 个**（原有 26 + 本次新增 1） |
| 集成测试用例 | **167 个**（原有 161 + 本次新增 6 条跨模块用例） |
| 集成用例通过 / 失败 | **167 / 0** |
| 全量回归套件 | **40 个**（27 e2e + 13 unit） |
| 全量回归用例 | **318 个，全部通过**（167 e2e + 151 unit） |
| 类型检查 | `npm run typecheck` 通过 |
| 执行耗时 | 全量约 30 秒 |

**结论：现有集成基线稳定，26 个原有 e2e 套件（161 用例）全部通过；新增跨模块集成套件 6 条用例全部通过，集成测试合计 167 用例全绿。未发现产品缺陷。测试过程中首次编写的 2 条断言因与真实接口契约不符而失败，已核实为用例问题并按实际行为修正，非产品问题（详见第四节）。**

## 二、测试范围

### 2.1 集成依赖配置检查

| 检查项 | 结论 |
| --- | --- |
| Node 运行时 | v22.22.2，满足 `node:sqlite` 实验特性要求；启动有 ExperimentalWarning，属正常提示，不影响功能 |
| 外部依赖 | 无独立数据库、无 Redis、无消息队列；SQLite 内嵌库随应用进程启动，降低集成环境搭建成本 |
| 数据隔离 | 每套件 `createTestApp(name)` 以 `data/e2e-<name>` 建独立目录，启动前 `rmSync` 清理、关闭后再次清理，实测无残留 |
| 端口隔离 | 通过 `net` 监听端口 0 动态分配空闲端口，避免与本地进程或套件间冲突 |
| 环境注入 | `test/setup-env.ts` 统一注入 `NODE_ENV=test` 及全部安全/限流参数，与 `.env.test` 对齐，防止直连开发数据 |
| 共享状态清理 | 各套件对配置覆盖层/字典覆盖层调用 `resetConfigCache` / `clearDictionaryOverrides` 共 28 处，跨套件无状态泄漏 |
| 测试夹具 | `fixtures.ts` 生成真实 npm tarball / zip / wheel，安全校验路径被真实覆盖，非占位桩 |

### 2.2 原有 e2e 覆盖清单（26 套件 / 161 用例，全部通过）

按业务域分组，验证各模块**内部**闭环：

| 业务域 | 套件 | 用例数 |
| --- | --- | --- |
| 认证与授权 | auth、auth-forced-change、token-revoke、token-scope、service-account、admin | 6 套件 |
| 包仓库协议 | registry、registry-python-versions、regression-official-package | 3 套件 |
| 导入与缺包 | import、missing-report | 2 套件 |
| 安全治理 | security、security-quarantine、security-rescan、security-queue、rescan-pacing、disk-guard | 6 套件 |
| 包生命周期 | package-delete、retention、retention-audit、backup | 4 套件 |
| 配置与基础设施 | config、dictionary、http-security、logger、shutdown | 5 套件 |

执行结果：26/26 套件通过，161/161 用例通过。

### 2.3 本次新增：跨模块数据流集成套件（1 套件 / 6 用例）

新增文件：`test/integration-flows.e2e-spec.ts`。聚焦**同一业务对象依次流经多个模块**时的接口契约与数据一致性，这是按模块切分的原有用例较少覆盖的维度。

| # | 用例 | 涉及模块链路 | 场景类型 |
| --- | --- | --- | --- |
| I-01 | 导入批次 → 校验 → 入库 → 包详情 → registry 下载 → 审计，同一对象全链路数据一致 | import → security → packages → registry → audit | 主要成功路径 |
| I-02 | registry 发布 → 删除 → registry 不可见 → 恢复 → registry 重新可下载 | registry → packages → audit | 状态流转 + 跨模块一致性 |
| I-03 | 缺包上报 → 补包导入 → 入库 → registry 可下载 → 缺包关闭 → 审计闭环 | missing → import → packages → registry → audit | 主要成功路径（业务闭环） |
| I-04 | 高危包隔离 → registry 与包详情均不可见 → 放行 → 两出口同步可见 | security → packages → registry | 关键异常场景 |
| I-05 | 全失败批次 partial 提交成功但零入库，strict 模式整批拒绝 | import → packages | 边界条件（空结果集） |
| I-06 | 重复版本再次导入不产生重复入库，registry 版本数保持不变 | registry → import → packages | 边界条件（幂等/重复数据） |

## 三、执行结果明细

### 3.1 新增套件逐用例结果

```
PASS test/integration-flows.e2e-spec.ts
  ✓ I-01 导入 → 校验 → 入库 → 详情 → registry 下载 → 审计 (349 ms)
  ✓ I-02 发布 → 删除 → registry 不可见 → 恢复 → 重新可下载 (308 ms)
  ✓ I-03 缺包上报 → 补包 → 入库 → 下载 → 关闭 → 审计 (277 ms)
  ✓ I-04 高危包隔离 → 双出口不可见 → 放行 → 双出口可见 (304 ms)
  ✓ I-05 全失败批次 partial 零入库 / strict 整批拒绝 (474 ms)
  ✓ I-06 重复导入幂等，registry 版本数不变 (358 ms)

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
```

### 3.2 关键数据流转验证点

- **I-01**：验证 `import-batches` 建批次 → `validate` 产出安全扫描记录 → `commit` 写入包库 → `packages/detail` 可见 → `npm` 协议 packument 与 tarball 可下载（字节数与上传包一致）→ `audit-logs` 可按 `resourceId` 追溯。证明数据从导入模块流出后被 registry 与审计模块正确消费。
- **I-02**：验证包版本的"软删除/恢复"状态在 `packages` 模块与 `registry` 下载出口**同步**——删除后 tarball 返回 404，恢复后返回 200 且内容一致；删除/恢复动作均进入审计。
- **I-03**：验证缺包记录（`missing_dependencies`）经补包接口直接驱动入库，补包后能被 registry 协议下载，缺包状态同步从 `open` 变 `resolved`，补包动作进审计——五模块闭环无断点。
- **I-04**：验证安全隔离结论在多个出口一致生效——高危包被拦截后，registry packument 与包详情同时 404，隔离区可见；放行后两个出口同时恢复可见，体现 `security → packages → registry` 的数据流转。
- **I-05 / I-06**：覆盖空结果集与重复数据两类边界，确认跨模块写入不产生孤立数据或重复版本。

### 3.3 全量回归

- `npx jest --runInBand --forceExit`：**40 套件 / 318 用例全部通过，0 失败**（27 e2e / 167 用例 + 13 unit / 151 用例）。
- `npm run typecheck`：通过。

## 四、发现的问题、失败原因与处置

### 4.1 产品缺陷

**本次集成测试未发现产品缺陷。** 26 个原有 e2e 套件与 6 条新增跨模块用例全部通过，模块间接口契约与数据流转行为正常。

### 4.2 测试编写过程中的失败（均为用例问题，已修正）

首次运行新增套件时 2 条用例失败，经核实均为**我对接口契约的假设错误**，非产品问题：

| 现象 | 失败原因 | 处置 |
| --- | --- | --- |
| I-03 缺包记录查不到：`.find(i => i.name === name)` 返回 undefined | `missing_dependencies` 列表返回的字段是 `normalized_name`（规范化后的包名），不是 `name` | 用例改用 `normalized_name` 匹配后通过 |
| I-05 期望全失败批次提交返回 400 `BATCH_EMPTY`，实际返回 201 | `BATCH_EMPTY` 仅在批次**条目数为 0** 时抛（服务层防御），auto 识别阶段会提前拦截空文件；端到端可达的是"有条目但全 invalid"，partial 正常跳过、提交成功但 committed=0 | 用例改断言为"partial 提交成功零入库 + strict 整批拒绝"的真实行为；`BATCH_EMPTY` 本身的回归由模块测试 `errors.spec.ts` 覆盖 |

修正后 6 条用例全部通过。这两次失败恰好体现了集成测试的价值：**暴露了测试对真实跨模块契约的理解偏差**，避免把错误假设固化进用例。

### 4.3 观察到的边界说明（非缺陷，未改代码）

- **BATCH_EMPTY 端到端不可达**：auto 导入的空文件在识别阶段即被拦截，服务层 `items.length === 0` 的防御在正常 API 路径下不会触发。该错误码仍保留作为内部防御，模块测试已覆盖其登记与文案。
- **审计哈希链**：由 `retention-audit.e2e-spec.ts` 的转储脚本专门校验（全量快照、篡改取证、180 天底线），本报告不重复建设。
- **配置运行时覆盖**：由 `dictionary.e2e-spec.ts` 覆盖"扫描开关开启/关闭直接改变 registry 入库行为"，跨模块联动已验证，未重复。

## 五、修复建议

本次无需产品代码修复。后续建议：

| 优先级 | 建议 |
| --- | --- |
| P2 | 将 `test/integration-flows.e2e-spec.ts` 纳入常规 CI 的 e2e 阶段，作为跨模块数据流的回归门禁 |
| P3 | 后续如新增"模块间状态同步"类需求（如新的发布渠道、新的处置动作），在 `integration-flows` 中按 I-01~I-06 的模式补充链路用例 |
| P3 | 集成测试当前串行执行（`--runInBand`）以共享 `NODE_ENV` 与配置覆盖层状态；如需并行，应先解决配置缓存的进程内共享问题 |

## 六、测试范围边界（明确声明）

- 本报告聚焦**集成测试**：模块间接口调用、数据流转、核心业务流程。
- 未开展**系统测试**（如多进程拆分部署 `PROCESS_ROLE=console/npm/pypi` 的跨进程协作、真实外部注册表连通性、生产规模性能压测）——这些属于后续系统测试阶段。
- 纯函数/模块内部逻辑由模块测试覆盖（`docs/MODULE_TEST_REPORT.md`），本报告不重复。
- 测试全程未修改任何产品源码；仅新增 1 个集成测试文件。

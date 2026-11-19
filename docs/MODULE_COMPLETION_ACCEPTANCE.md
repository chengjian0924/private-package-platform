# 模块完善功能验收报告

- **日期**：2026-11-16
- **范围**：MVP 交付基线（A/B 批次完成后）之上的模块完善改造，批次 1-6 全部闭环
- **结论**：**通过**。typecheck / build / 全量测试（19 套件 113 用例）全绿，dist 产物部署形态冒烟通过，新增功能均有对应测试覆盖

## 1. 验收范围

本次改造针对 MVP 阶段登记的遗留项，按六条规范逐批实施：

| 批次 | 规范条目 | 完成项 | 状态 |
| --- | --- | --- | --- |
| 1. npm 发布通道加固 | 补全业务逻辑 / 异常边界 | 多版本原子发布（RV-22）、SRI integrity 权威校验（RV-23）、附件 key 精确匹配、自定义 dist-tags 持久化 | ✅ |
| 2. 隔离区与复检一致性 | 补全业务逻辑 / 异常边界 | 放行幂等三段式 claim/complete/abandon（RV-18）、复检互斥（RV-19）、隔离列表按 sha 分组 versions[]（RV-17）、批量放行 | ✅ |
| 3. 审计转储与保留期 | 补全业务逻辑 / 接口闭环 | 审计每日转储脚本（C-04，上线前必须项）、扫描/报告/埋点保留期清理（RV-26）、报告下载审计（RV-31） | ✅ |
| 4. 单元测试体系 | 单元测试 | jest 支持 `*.spec.ts` 单测通道，补 4 套件 24 用例（包名规范化、摘要工具、审计脱敏、遥测） | ✅ |
| 5. 结构与注释 | 可维护性 | 关键路径中文注释（两阶段发布、三段式处置、保留期清理、转储校验）；telemetry `list()` 死代码清理 | ✅ |
| 6. 全模块联调 | 联调验收 | typecheck + build + 19 套件 113 用例 + dist 生产形态冒烟（健康/登录/转储脚本） | ✅ |

## 2. 功能验收明细

### 2.1 npm 发布通道（批次 1）

| 用例 | 验证点 | 结果 |
| --- | --- | --- |
| registry.e2e：多版本原子发布 | `{1.1.0, 1.5.0, 1.2.0}` 中 1.5.0 重复 → 整体 409，packument 不含 1.1.0/1.2.0 | ✅ |
| registry.e2e：SRI 权威校验 | integrity 填错 + shasum 填对 → 400 `PKG_INTEGRITY_MISMATCH`（旧实现会被 shasum 掩盖放过） | ✅ |
| registry.e2e：dist-tags | `--tag beta` 发布后 packument `dist-tags.beta` 持久化输出；标签指向非本次版本 → 400 `SYS_VALIDATION` | ✅ |

实现要点：预检（解码→大小→SRI→查重→预扫描）全部通过后，单事务（`db.tx()`）写入全部版本；回滚时对象文件按内容寻址自然成为孤儿，由既有 orphans 清扫回收。`packages` 表新增 `dist_tags` 列（`ensureColumn` 迁移，存量库自动补列）。

### 2.2 隔离区与复检（批次 2）

| 用例 | 验证点 | 结果 |
| --- | --- | --- |
| quarantine.e2e：放行幂等 | 二次放行返回 `already=true`，审计仅 1 条 release，包只入库一次 | ✅ |
| quarantine.e2e：批量放行 | `POST quarantine/release`（ids 数组）逐条独立结果，无效 id 报 `SEC_NOT_FOUND`，空 ids 400 | ✅ |
| quarantine.e2e：versions 分组 | 隔离列表按 sha256 分组输出 `versions[]`，组内每条记录可独立追溯 | ✅ |
| quarantine.e2e：复检互斥 | 存在 RUNNING 运行记录时 manual 复检 → 409 `SEC_RESCAN_BUSY`；进程崩溃残留的僵尸锁（>24h）自动释放 | ✅ |

新增错误码：`SEC_QUARANTINE_BUSY`（409）、`SEC_RESCAN_BUSY`（409）。

### 2.3 审计转储与保留期（批次 3）

| 用例 | 验证点 | 结果 |
| --- | --- | --- |
| retention.e2e：保留期清理 | dry-run 预览 → apply 删除超期扫描；每版本保留最近一次（徽标依赖）；报告文件同步清理 | ✅ |
| retention.e2e：报告下载审计 | 下载 json 报告 → `audit_logs` 落 `security.report.download`（含格式与包坐标） | ✅ |
| retention.e2e：转储脚本 | 全量快照 + 哈希链校验通过（退出码 0，行数与库内一致）；同日重跑幂等覆盖 | ✅ |
| retention.e2e：篡改检出 | 库副本上篡改一行审计 → 退出码 1 + `.BROKEN` 取证文件 | ✅ |
| retention.e2e：留存底线 | `--retention 90` → 退出码 2 拒绝执行（等保 ≥180 天） | ✅ |

配置与接口：`SECURITY_SCAN_RETENTION_DAYS`（默认 180，0 关闭）、`POST /api/v1/security/maintenance/purge-scans`（默认 dry-run）、`scripts/audit-dump.mjs`（`AUDIT_DUMP_DIR` 必填，转储文件 0444 只读）。

### 2.4 单元测试体系（批次 4）

| 套件 | 覆盖 | 用例数 |
| --- | --- | --- |
| unit/names.spec.ts | npm/PyPI（PEP 503）包名规范化与合法性边界（scope、长度 214、非法字符） | 10 |
| unit/http-util.spec.ts | sha256Hex/digestOf（sha256/sha1/SRI sha512）与 node:crypto 对齐、空内容边界 | 5 |
| unit/audit-sanitize.spec.ts | 审计脱敏：敏感键打码、深度上限 4、数组截断 50、长串截断 500 | 5 |
| unit/telemetry.spec.ts | 埋点写入（schema 版本、traceId、payload 兜底）、行序递增 | 3 |

jest 配置：`testRegex` 扩展为 `.*\.(e2e-)?spec\.ts$`，单测与 e2e 同命令运行、互不影响。

## 3. 联调验证

| 项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | ✅ 0 错误 |
| 构建 | `npm run build` | ✅ 产物正常 |
| 全量测试 | `npm test` | ✅ 19 套件 113 用例全绿（改造前 78 → 净增 35） |
| 部署形态冒烟 | dist 产物 + 生产环境变量启动 | ✅ `/api/v1/health` 200（production）；admin 登录成功并触发首登强制改密（符合设计）；包列表 403（改密前会话受限，符合设计） |
| 转储脚本生产冒烟 | 真实生产库跑 `audit-dump.mjs` | ✅ 哈希链校验通过、快照 0444 只读 |

## 4. 变更清单

**源码**（8 文件）：
- `src/registry-npm/registry-npm.controller.ts`：publish 两阶段重写
- `src/packages/packages.service.ts`：`insertVersionSync` 拆分、`insertVersionsAtomic`、`mergeDistTags`、`assertNotDuplicate` 公共化、packument 合并标签
- `src/security/security.service.ts`：隔离处置三段式、复检互斥、`purgeExpiredScans`、隔离列表分组
- `src/security/security.controller.ts`：release/remove 重编排、批量放行、purge-scans 接口、报告下载审计
- `src/security/scheduler.ts`：保留期清理接入定时任务
- `src/config/config.ts`：`scanRetentionDays` 配置
- `src/db/database.service.ts`：`packages.dist_tags` 列 + 迁移
- `src/audit/audit.service.ts`：`sanitizeAuditDetail` 导出；`src/telemetry/telemetry.service.ts`：死代码清理

**脚本**：`scripts/audit-dump.mjs`（新增）

**测试**：`registry.e2e-spec.ts` +3、`security-quarantine.e2e-spec.ts` +3、`retention-audit.e2e-spec.ts`（新增）+5、`test/unit/`（新增）4 套件 24 用例

**文档**：`docs/DEPLOYMENT.md`（8.1 审计转储章节、环境变量、验收清单第 12 项、残余风险更新）、`README.md`（环境变量表）

## 5. 遗留事项（本次范围外，已在 HANDOFF 登记）

- **C1-C4 架构升级**：数据层外部化、多实例、扫描独立服务、HA 拓扑（超出单机 MVP 边界）
- **目标主机 A4 验收**：需 Linux 主机环境，按 DEPLOYMENT 第 7 章清单执行（已新增第 12 项审计转储验收）
- **RV-30**：扫描结果 sha256 缓存（当前仅并发去重）
- **RV-32 / O-07**：安全规则外置（当前硬编码于 `rules.ts`）
- **RV-27 / RV-28**：控制台分页筛选 UI、漏洞库浏览页（前端迭代项，后端接口已就绪）

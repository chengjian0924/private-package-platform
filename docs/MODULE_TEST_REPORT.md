# 源鉴平台 · 模块测试报告

| 项目 | 内容 |
| --- | --- |
| 被测项目 | 源鉴 · 内网依赖安全治理平台 MVP（`yuanjian` v1.0.0） |
| 测试阶段 | 模块测试（单元 / 模块级），**未执行集成测试与系统测试** |
| 测试日期 | 2026-11-18 |
| 测试框架 | Jest 29 + ts-jest，Node `node:test` SQLite |
| 执行命令 | `npx jest --runInBand --forceExit test/unit` |
| 测试环境 | `test/setup-env.ts` 注入（NODE_ENV=test，DATA_DIR 隔离，指纹与生产基线一致） |

> **第二轮（缺陷修复 + 用例扩充）已完成**：修复 F-01、F-02 两处产品代码，并在原有 105 用例基础上扩充至 **150 用例，全部通过**。
> **第三轮（观察项处置）已完成**：确认「未知生态回落 pypi」无实际影响、不改代码；确认审计脱敏名单盲点为真实风险并修复（F-03），用例增至 **151，全部通过**。各节内容为最终状态。

## 一、总体结果（修复后）

| 指标 | 数值 |
| --- | --- |
| 测试套件 | 13 个（执行 13） |
| 测试用例 | **151 个**（首轮 105 + 第二轮 45 + 第三轮 1） |
| 通过 | **151** |
| 失败 | **0** |
| 通过率 | 100% |
| 执行耗时 | 约 4 秒 |
| 类型检查 | `npm run typecheck` 通过 |

结论：**首轮 2 个缺陷 + 第三轮 1 个确认有影响的观察项均已修复并回归验证通过，151 个模块用例全绿；未执行集成/系统测试。**

## 二、模块清单与覆盖情况

| # | 功能模块 | 源码位置 | 测试文件 | 用例数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 口令规则 / 批量建号解析 | `auth/password.ts`、`auth/batch-import.util.ts` | `password-rules.spec.ts` | 10 | 全过 |
| 2 | 口令哈希与初始密码 | `auth/password.ts` | `password-hash.spec.ts` *(新增)* | 10 | 全过 |
| 3 | 包名规范化 | `packages/names.ts` | `names.spec.ts` | 17 | 全过 |
| 4 | 包元数据 / 完整性校验 | `packages/package-validator.ts` | `package-validator.spec.ts` | 24 | 全过 |
| 5 | 漏洞库版本范围匹配 | `security/vuln.service.ts` | `vuln-version.spec.ts` *(新增)* | 11 | 全过 |
| 6 | 安全行为规则（误报回归） | `security/scan-runner.ts`、`rules.ts` | `behavior-false-positive.spec.ts` | 2 | 全过 |
| 7 | 审计详情脱敏 | `audit/audit.service.ts` | `audit-sanitize.spec.ts` | 12 | 全过（F-03 已修） |
| 8 | 摘要 / 时间工具 | `common/http.util.ts` | `http-util.spec.ts` | 5 | 全过 |
| 9 | 接口限流 / 磁盘水位判定 | `common/http-security.ts`、`disk-guard.service.ts` | `rate-limit-disk.spec.ts` *(新增)* | 19 | 全过 |
| 10 | 统一错误码 | `common/errors.ts` | `errors.spec.ts` *(新增)* | 10 | 全过（F-02 已修） |
| 11 | 配置字典覆盖层 | `config/overrides.ts` | `config-overrides.spec.ts` *(新增)* | 9 | 全过 |
| 12 | 存储路径与对象读写 | `storage/storage.service.ts` | `storage-path.spec.ts` *(新增)* | 19 | 全过（F-01 已修） |
| 13 | 遥测埋点 | `telemetry/telemetry.service.ts` | `telemetry.spec.ts` | 3 | 全过 |

> 第一轮：原 7 套件 60 用例 → 新增 6 套件 45 用例（共 105），发现 2 缺陷。
> 第二轮：修复 2 缺陷，并扩充 45 用例至 150（存储 +13、限流磁盘 +8、包名 +6、审计 +6、口令哈希 +4、漏洞版本 +3、错误码 +2、配置 +3）。

## 三、测试维度说明

每个模块均按四类场景设计用例：

- **核心逻辑**：纯函数逐位对齐标准实现（如 `sha256Hex` 对齐 `node:crypto`）、区间匹配、状态机等。
- **正常流程**：合法输入得到预期输出（正确口令校验通过、合法 key 解析到 DATA_DIR 内、区间内版本命中）。
- **边界条件**：长度上下限（8 位口令、214 字符包名）、窗口临界值、水位阈值（85%/95%）、窗口到期重计数、`~=` / `==1.*` 版本语义、`totalBytes=0` 兜底。
- **异常场景**：脏数据不抛错（空哈希返回 false、超大 scrypt 参数防 DoS）、目录穿越、未登记错误码、非法文件类型、被篡改的完整性摘要。

## 四、发现的问题

### F-01　`StorageService.absolutePath` 路径前缀混淆（中危，纵深防御缺陷）

- **状态**：首轮失败（`BUG-F01`），第二轮已修复并通过（`storage-path.spec.ts` → `F-01 回归`）
- **源码**：`src/storage/storage.service.ts:134-141`
- **现象**：校验逻辑为 `abs.startsWith(path.resolve(base))`。当兄弟目录名恰好以 `DATA_DIR` 目录名为前缀时，`../<baseName>-evil/secret.txt` 解析后仍以 base 字符串开头，校验被绕过，函数返回 DATA_DIR 之外的绝对路径且不抛错。
- **复现步骤**：
  1. 设 `DATA_DIR = /tmp/yuanjian-storage-unit-abc`；
  2. 调用 `storage.absolutePath('../yuanjian-storage-unit-abc-evil/secret.txt')`；
  3. 预期：抛 `非法存储路径`；实际：正常返回 `/tmp/yuanjian-storage-unit-abc-evil/secret.txt`。
- **影响范围**：`absolutePath` 被导入服务（`detail.storedFile`）、npm / PyPI 注册表控制器（`version.storage_key`）、安全服务共 9 处调用。**当前所有调用方传入的都是系统生成的相对 key**（`batches/<uuid>/files/<清洗后文件名>`、`objects/<sha256前2位>/<sha256>`），未见外部输入直达路径，因此**当前无已确认的可利用链路**；但作为唯一路径防线，其契约已失效，一旦未来有可控 key 传入即升级为任意文件读取。属于中危纵深防御缺陷。
- **修复建议**：改用基于路径段的判定，不要字符串前缀比较：
  ```ts
  const root = path.resolve(base);
  const abs = path.resolve(base, relativeKey);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('非法存储路径');
  return abs;
  ```
  已按此方案修复，`F-01 回归` 用例已转绿。

### F-02　错误码 `BATCH_EMPTY` 未在错误码表登记（低危，用户体验缺陷）

- **状态**：首轮失败（`BUG-F02`），第二轮已修复并通过（`errors.spec.ts` → `F-02 回归`）
- **源码**：抛出点 `src/import/import.service.ts:528`；错误码表 `src/common/errors.ts:10-105`
- **现象**：`commit()` 在批次条目数为 0 时抛 `new ApiError('BATCH_EMPTY')`，但 `ERROR_DEFS` 中无此键。构造器回退为 `{ status: 400, message: 'BATCH_EMPTY' }`，前端拿到的是英文裸 code，而非统一中文提示。同类兄弟码 `BATCH_NOT_FOUND` / `BATCH_NO_FILES` / `BATCH_STATE_INVALID` 均已登记，属遗漏。
- **复现步骤**：
  1. 静态扫描全部 `fail(...)` / `new ApiError(...)` 调用，与 `ERROR_DEFS` 求差集 → 差集为 `['BATCH_EMPTY']`；
  2. 或构造状态为 `VALIDATED` 且条目数为 0 的批次调用 `commit()`，观察返回 `message = 'BATCH_EMPTY'`。
- **影响范围**：仅影响“批次校验完成后条目为空即提交”这一边界路径；当前批次保存时通常已有条目，触发概率低。影响为错误提示退化，不涉及数据安全与权限。
- **修复建议**：在 `ERROR_DEFS` 增加一条，例如 `BATCH_EMPTY: { status: 400, message: '批次中没有可入库的条目' }`。已按此登记，`F-02 回归` 用例已转绿；全量一致性断言已保留，防止后续再漏登记。

### F-03　审计脱敏名单未覆盖常见凭据键名（中危，凭据外泄风险）

- **状态**：第三轮确认有影响并修复（`audit-sanitize.spec.ts` → `F-03 回归`）
- **源码**：`src/audit/audit.service.ts:20`
- **现象**：脱敏名单 `SENSITIVE_KEYS = /pass(word)?|token|secret|authorization|credential/i` 未覆盖 `x-api-key`、`apiKey`、`api_key`、`privateKey`、`session_id`、`session`、`auth`、`cookie` 等常见凭据键名。审计 `detail` 按**键名**脱敏，这些键会原样落库。
- **影响范围**：审计日志落盘且可导出（`audit.controller.ts`），并进入 `prev_hash` 哈希链。`packages.controller.ts` 把 `deleteVersion`/`restoreVersion` 的 `result` 对象整体展开写入 `detail`；任何后续把带上述键名对象写入 detail 的调用点都会静默泄露凭据到持久化审计。属真实风险，非理论问题。
- **修复**：扩展正则覆盖 `api[_-]?key` / `x-apikey` / `private[_-]?key` / `session[_-]?id` / `passwd` 等词片段，并增加 `SENSITIVE_EXACT_KEYS` 精确集合处理 `session`/`auth`/`cookie`/`set-cookie`/`apikey`/`sessionid` 等短键（用整键匹配避免误伤 `revokedSessions`、`sessionCount`、`actorRole` 等统计字段）。

### O-01　未知生态回落 pypi（无实际影响，不修复）

- **结论**：保持现状，不改代码。
- **依据**：`isValidName`/`normalizeName` 的全部调用点中，`ecosystem` 均为内部产生——导入阶段由文件名/清单识别后写死 `'npm'`/`'pypi'`（`import.service.ts:264,270,276`），`packages.controller.ts:19` 对 query 参数做了白名单过滤，TS 类型已约束为 `'npm' | 'pypi'`。外部无法传入未知生态，该回落分支不可达。改它属于无意义重构，违背"保持核心行为不变"。

## 五、缺陷修复与测试用例扩充（第二、三轮）

### 5.1 产品代码改动（共 3 处，无接口签名与核心行为变更）

| 文件 | 改动 | 原因 | 影响范围 |
| --- | --- | --- | --- |
| `src/storage/storage.service.ts` | `absolutePath` 把 `abs.startsWith(base)` 改为 `path.relative(base, abs)` 后判断 `rel === '..' \|\| rel.startsWith('..' + path.sep) \|\| path.isAbsolute(rel)` | 字符串前缀比较把同前缀兄弟目录误判为在根内；改用路径段判定按真实层级越界检查 | 仅路径合法性判定结果；正常 key 解析结果、返回类型、`Error('非法存储路径')` 异常类型与文案均不变；`''`/`.` 指向根目录仍放行 |
| `src/common/errors.ts` | `ERROR_DEFS` 批次分组新增 `BATCH_EMPTY: { status: 400, message: '批次中没有可入库的条目' }` | 抛出的 `BATCH_EMPTY` 未登记，构造器回退成英文裸 code | 仅该错误码的展示文案由 `BATCH_EMPTY` 变为中文；status 仍 400，接口与调用签名不变 |
| `src/audit/audit.service.ts`（第三轮） | 扩展 `SENSITIVE_KEYS` 覆盖 api-key/private-key/session-id/passwd 等写法；新增 `SENSITIVE_EXACT_KEYS` 整键集合处理 session/auth/cookie 等短键 | 脱敏名单漏掉常见凭据键名，审计 detail 按键名脱敏会静默落库 | 仅扩展被脱敏的键名集合；`sanitizeAuditDetail` 签名不变；已验证 `revokedSessions`/`sessionCount`/`actorRole` 等统计字段不误伤 |

未改动任何其他源码；无重构、无依赖增减。类型检查 `npm run typecheck` 通过。

### 5.2 新增测试覆盖点（共 +46 用例）

**F-01 路径安全回归（`storage-path.spec.ts`，6→19）**
- 合法路径：普通 key、空 key/`.` 指向根目录、`./` 前导与 `..` 内部归一
- 非法输入：`../` 父级穿越、同前缀兄弟目录（`base-evil`、`base2`）、绝对路径、多层绕过后再绕回、`../../` 连续上跳
- 存储读写：空 Buffer、128KB 较大写入、`putMeta` 字符串/Buffer 一致 key、删除不存在对象返回 false
- 文件名清洗：安全字符保留、绝对路径取 basename、空文件名边界

**F-02 错误码回归（`errors.spec.ts`，8→10）**
- `BATCH_EMPTY` 返回中文提示且不等于裸 code、全项目抛出码与错误码表一致性门禁
- 空 code / 超长 code / undefined 入参兜底不抛 TypeError

**其他模块边界与异常扩充**
- 口令哈希（6→10）：空/超长/Unicode 口令哈希校验、篡改 salt/key 的哈希校验失败、scrypt 参数越界拒绝、初始密码长度 1 与 128 极端值
- 漏洞版本匹配（8→11）：空白范围、`||` 空分支、非标准版本回退、`==`/`!=` 精确比较
- 限流与磁盘（11→19）：limit=1 边界、极大 windowMs/limit 不溢出、2 万+ key 剪枝兜底、空 key、阈值恰好相等取更严重档、minFreeBytes 严格小于边界、free>total 异常采样、阈值 0 极端配置
- 包名规范（11→17）：null/undefined、单字符与 214/215 长度边界、scope 多段/空段/点开头、连续分隔符折叠、Unicode 拒绝、未知生态回落语义记录
- 审计脱敏（5→12）：空对象/空数组、多命名风格敏感键、非敏感字段不误伤、数组内对象递归脱敏、500 字符边界、F-03 凭据键名回归（api-key/private-key/session-id/cookie 等写法）、统计类键名不误伤
- 配置覆盖层（6→9）：null 值覆盖语义、全分组字段一次性覆盖、清空幂等

### 5.3 验证结果

- `npx jest --runInBand --forceExit test/unit`：13 套件 / **151 用例全过**，0 失败。
- 首轮两个失败用例（BUG-F01 / BUG-F02）及第三轮 F-03 相关断言均已转为通过的回归用例。
- 「未知生态回落 pypi」经调用链分析判定为不可达分支，以中性用例记录行为、不改代码。

## 六、测试范围边界（明确声明）

- 本次**仅执行模块测试**：测试对象为单个模块内的纯函数与类方法，依赖通过临时目录 / 假对象隔离，不启动完整 Nest 应用、不发起真实 HTTP 请求、不跨模块串联业务流。
- **未执行**集成测试（模块间接口、真实 DB 事务联动）与系统测试（端到端业务场景、性能、部署）。`test/*.e2e-spec.ts` 下的 25 个端到端套件本次未运行。
- 因此本报告不能替代集成/系统测试结论；三个缺陷（F-01/F-02/F-03）已修复且模块测试全绿，后续可进入集成测试阶段。

## 七、修复优先级与后续动作

| 优先级 | 动作 | 状态 |
| --- | --- | --- |
| P1 | 修复 F-01 路径校验，消除潜在任意文件读取面 | 已完成 |
| P2 | 补齐 F-02 错误码，恢复统一中文提示 | 已完成 |
| P3 | 扩充用例并回归，确认 13 套件 / 150 用例全绿 + 类型检查通过 | 已完成 |
| P4 | 评估两个观察项：未知生态回落（无影响，不改）、审计脱敏盲点（有影响，修 F-03） | 已完成 |
| P5 | 确认 13 套件 / 151 用例全绿 + 类型检查通过 | 已完成 |
| P6 | 进入集成测试阶段（另立测试计划），覆盖模块间协作与真实 DB 事务 | 待开展 |

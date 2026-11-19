# 缺包上报接入 CI（调用方视角）

> 前置结论：源鉴的缺失依赖**不会自动发现**。私有源收到不存在的包只返回 404，`npm install` / `pip install` 失败在平台侧不留任何记录。要让缺口进「缺失依赖」列表，必须在调用方流水线里主动上报。
>
> 本文给的是**最小改造**方案：一个零依赖脚本，比对出缺口后只上报缺口，不做全量上传。

## 1. 为什么不建议全量上报

上报接口 `POST /api/v1/dependency-reports` 不做真伪校验——写什么就记什么。若 CI 把整个依赖清单推上去：

- 「缺失依赖」列表会被已存在的包塞满，真正待补的包淹没在里面；
- 每条记录都有 `hits` 计数，重复上报会让 `hits` 虚高，无法据此判断需求强度；
- 补包动作变成盲猜，管理员要逐条人工核对。

正确做法：先拿项目声明依赖和私有源做差集，只把差集推上去。

## 2. 三步接入

### 第 1 步：按项目开一个机器账号（管理员执行一次）

CI 里的令牌代表“哪个项目在上报”。如果几十个仓库共用某位同事的令牌，审计日志里全是同一个 actor，事后无法回答“这条缺口是谁报的”。所以**一个仓库一个机器账号**。

平台提供 `scripts/ci-provision-account.mjs`，一条命令完成：建机器账号（`ci-<project>`，不可口令登录）→ 签发同名令牌 → 打印 CI 变量。脚本零依赖，在运维机或跳板机上执行即可：

```bash
YJ_ADMIN_USER=admin YJ_ADMIN_PASSWORD='***' \
node scripts/ci-provision-account.mjs \
  --base https://yuanjian.corp.internal \
  --project group/repo
```

输出（令牌只显示这一次）：

```bash
YJ_BASE_URL=https://yuanjian.corp.internal
YJ_TOKEN=yj_xxxxxxxx
YJ_PROJECT=group/repo
```

把这三行写进 CI 的密文变量（GitLab masked variable、Jenkins credentials），**不要提交到仓库**。加 `--write .env.ci` 可以落到 0600 权限的文件里，导入后立即删除。

同样的操作也可以在控制台完成：**用户管理 → 新建账号 → 账号类型选「机器账号」**，创建成功后会自动弹出签发令牌的窗口。机器账号在列表里带 `CI` 标签，凭据列显示「仅令牌」。

为什么不让 CI 共用人员账号：

- 机器账号不设口令，口令登录直接被拒（`AUTH_SERVICE_ACCOUNT`），令牌泄漏的影响面只限该账号；
- 人员改密、被锁、离职都不会让流水线断掉；
- 审计行会记录令牌哈希，按令牌名即可筛出该项目：`GET /api/v1/audit-logs?tokenName=ci-group-repo`。

账号名规则：项目路径归一化成 `ci-group-repo`（非字母数字转 `-`，超过 32 位时截断并加短哈希）。需要换名时用 `--username`。

> 已有环境仍可用某个 developer 账号的个人令牌过渡，但请尽快按项目拆分，否则审计无法归因。

### 第 2 步：把脚本放进流水线

脚本：`scripts/ci-report-missing.mjs`，**零依赖**（只用 Node 内置 `fetch`），Node 18+ 直接跑，不需要 `npm install`。

把它放进调用方仓库（建议 `.ci/ci-report-missing.mjs`），或放在内网共享的 CI 工具仓库里，各项目用 `curl` 拉下来。

### 第 3 步：加一个 CI 步骤

原则：**放在安装依赖之后、构建之后**，此时清单已确定；失败也不该阻断发布（除非你开了门禁模式）。

```bash
node .ci/ci-report-missing.mjs \
  --base "$YJ_BASE_URL" \
  --token "$YJ_TOKEN" \
  --project "$CI_PROJECT_PATH"
```

默认行为：读 `./package.json` 的 `dependencies` + `optionalDependencies`，读 `./requirements.txt`，逐个探测私有源，只上报缺口。文件不存在就跳过对应生态。

## 3. 参数

| 参数 | 说明 |
| --- | --- |
| `--base <url>` | 平台地址，如 `https://yuanjian.corp.internal`（也可用 `YJ_BASE_URL`） |
| `--token <t>` | 访问令牌（也可用 `YJ_TOKEN`） |
| `--project <name>` | 项目标识，写进缺失记录的 `project_id`，建议用仓库路径（也可用 `YJ_PROJECT`） |
| `--npm <file>` | `package.json` 路径，默认 `./package.json` |
| `--pypi <file>` | `requirements.txt` 路径，默认 `./requirements.txt` |
| `--input <file>` | 直接给缺口清单，跳过探测；可重复传多个 |
| `--include-dev` | 连 `devDependencies` 一起比对（默认不含，避免测试工具污染缺口） |
| `--name-only` | 只判包是否存在，不比对版本 |
| `--dry-run` | 只打印差集，不上报（不需要令牌，可用于巡检） |
| `--strict` | 发现缺口时退出码 2，用于卡门禁 |
| `--soft` | 上报失败 / 探测失败只警告不阻断 |
| `--concurrency <n>` | 探测并发，默认 6 |

### 退出码

| 码 | 含义 | CI 建议 |
| --- | --- | --- |
| 0 | 无缺口，或已成功上报 | 继续 |
| 1 | 参数缺失、私有源不可达、鉴权失败 | 默认阻断，便于发现问题；确认可忽略时加 `--soft` |
| 2 | 有缺口且带 `--strict` | 阻断，逼调用方先补包 |

> 探测失败（超时、5xx）**不会**被当成缺口，但也**不会**静默通过——脚本会列出探测失败的包并以退出码 1 结束，避免「0 缺口」的假象。

## 4. 构建失败场景：上报解析出的包

`npm ci` / `pip install` 直接失败时，清单未必完整，但有明确的错误包名可抓。做法是先用 shell 抓出包名，写成 `gaps.json`，再交给脚本上报：

```bash
# 例：从 npm 报错里抓 404 的包名（E404 后跟包名）
npm ci 2>&1 | tee npm.log
grep -oE "E404[^']*'[^']+'" npm.log | sed -E "s/.*'(.*)'/\1/" | sort -u \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const names=s.split("\n").filter(Boolean);
      console.log(JSON.stringify({ecosystem:"npm",dependencies:names}));
    })' > gaps.json || true

node .ci/ci-report-missing.mjs --base "$YJ_BASE_URL" --token "$YJ_TOKEN" \
  --project "$CI_PROJECT_PATH" --input gaps.json --soft
```

`gaps.json` 格式（数组或单个对象都支持）：

```json
{
  "ecosystem": "npm",
  "dependencies": [
    { "name": "left-pad", "versionSpec": "^1.3.0" },
    "lodash"
  ]
}
```

pypi 同理，抓 `No matching distribution found for <name>`：

```bash
grep -oE "No matching distribution found for [A-Za-z0-9._-]+" pip.log | awk '{print $NF}' | sort -u
```

## 5. CI 配置示例

### GitLab CI

```yaml
stages: [build, report]

report-missing:
  stage: report
  image: node:22-alpine
  needs: [build]
  allow_failure: true          # 上报失败不阻断发布；要卡门禁就删掉这行并加 --strict
  variables:
    YJ_BASE_URL: https://yuanjian.corp.internal
  script:
    - node ci/ci-report-missing.mjs --base "$YJ_BASE_URL" --token "$YJ_TOKEN" --project "$CI_PROJECT_PATH"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

> 脚本本身建议 vendor 进调用方仓库的 `ci/` 目录（单文件零依赖，约 16KB），或由内网 CI 工具仓库统一下发。`YJ_TOKEN` 配成 GitLab 的 masked variable。

### Jenkins（Declarative Pipeline）

```groovy
stage('上报缺包') {
  when { branch 'main' }
  steps {
    withCredentials([string(credentialsId: 'yuanjian-token', variable: 'YJ_TOKEN')]) {
      sh '''
        node ci/ci-report-missing.mjs \
          --base https://yuanjian.corp.internal \
          --token "$YJ_TOKEN" \
          --project "$JOB_NAME" || true
      '''
    }
  }
}
```

### 本地手动跑（排查用，不需要令牌）

```bash
node scripts/ci-report-missing.mjs --base http://127.0.0.1:3000 --dry-run
```

输出示例：

```
源鉴缺包上报 · 项目 svc-order · http://127.0.0.1:3000
依赖来源：npm:package.json(38)，pypi:requirements.txt(6)
声明依赖 44 个，命中缺口 3 个

  [npm]  old-axios                          1.7.0         无匹配版本（源内 1 个，最高 0.27.2）
  [npm]  left-pad                           ^1.3.0        私有源无此包
  [pypi] pandas                             ==2.2.0       私有源无此包
```

## 6. 凭证轮换与回收

机器账号的令牌不过期，靠人工轮换。建议节奏：

| 场景 | 操作 |
| --- | --- |
| 例行轮换（如每 6 个月） | 重跑开户脚本签发新令牌，更新 CI 变量，再到控制台吊销旧令牌 |
| 令牌泄漏 | 控制台 → 用户管理 → 该机器账号「签发令牌」换新，然后吊销泄漏的令牌；不必重建账号 |
| 临时停用（如流水线维护） | 用户管理里把账号「禁用」。令牌立即不可用，但**未作废**，重新启用会自动恢复 |
| 项目归档 / 账号离职 | 用户管理里点「吊销令牌」，永久作废该账号全部凭据，重新启用也不会恢复 |
| 审计归因 | `GET /api/v1/audit-logs?tokenName=ci-group-repo`，按令牌名筛全部上报记录 |

**「禁用」与「吊销」别搞反**：

| | 禁用账号 | 吊销令牌 |
| --- | --- | --- |
| 令牌还能用吗 | 不能（`401`） | 不能（`401`） |
| 凭据还在吗 | 在，`revoked_at` 仍为空 | 不在，`revoked_at` 已写入 |
| 可恢复吗 | 可以，启用后立即恢复 | 不可以，只能重新签发 |
| 适用场景 | 临时停用、排查问题 | 离职、泄漏、项目下线 |

凭据列会显示每个账号还挂着几个未吊销令牌，禁用状态下标为橙色——看到橙色就说明「账号已经停了，但凭据还没烧掉」，需要判断是继续留着还是点「吊销令牌」。

注意：同一账号可以持有多个令牌，重跑开户脚本不会自动作废旧令牌。换发后请显式吊销上一枚，否则泄漏的旧令牌仍然可用。

## 7. 已知局限

- **版本区间是简化实现**：支持 `^ ~ ~> >= <= > < = == != * x`、空格并列与 `||`，不处理 npm 的 prerelease 语义与 `1.2 - 1.4` 这种连字符区间。无法解析的写法按「满足」处理——宁可漏报，也不把噪音塞进缺失表。
- **PyPI 版本从文件名推断**：私有源的 `/pypi/simple/<name>/` 只给文件名，脚本取文件名里第一个数字分段当版本。遇到无版本信息的极端命名的包，会退化成「只判存在」。
- **跳过非 registry 来源**：`file:` / `link:` / `workspace:` / `git+` / `http(s)://` 依赖不上报，它们本来就不该进私有源。
- **不做去重合并跨项目**：同一包被 5 个项目报，会产生 5 条记录（去重键含 `projectId`）。这是刻意的——能看出有多少个项目在等这个包。

## 8. 什么时候才需要改后端

如果后续确实需要「零改造自动发现」，只有两条路，都不建议现在做：

1. 在 npm/pypi 的 404 分支里写缺失表——拼写错误、扫描器探测、`/-/ping` 类旁路请求都会进表，噪音远大于价值；
2. 旁路分析 Nginx access log 的 404 反写数据库——不动接口，但多一个运维组件和一条信任链。

先跑一段时间 CI 上报，看真实缺口量再决定。

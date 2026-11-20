# 离线 npm 包批量导入脚本使用手册

`scripts/import-npm-batch.mjs`：把一个 dsh 离线插件包（双层 zip，内层含 541 个 `tarballs/*.tgz` + `registry.json`）里的全部 tgz，按 npm publish 协议批量导入源鉴私有 npm 源。

适用对象：`njcb-offline-plugins-win-x64.zip` 这类**带完整依赖闭包**的离线包。不包含运行时安装程序（`njcb-harness-*-win-x64.zip`，那个是 exe，进不了源鉴）。

---

## 0. 为什么不用 `npm publish`

三条理由，每条都是硬约束：

1. **文件名不匹配。** 包内 tgz 的文件名是内容 sha256（如 `67ed61ee....tgz`），不是 npm CLI 要求的 `<name>-<version>.tgz`。直接 `npm publish <file>` 会失败。
2. **`publishConfig` 指向公网。** 每个包的 `package.json` 里带 `publishConfig.registry = https://registry.npmjs.org/`。npm CLI 会按它推送到公网——内网包绝对不能这么干。本脚本直接构造 publish body 发往你指定的 `--base`，`publishConfig` 完全不参与路由，并且在构造元数据时已删除该字段。
3. **integrity 必须原样保留。** 脚本校验每个 tgz 的实际 sha256 与 `registry.json.artifacts` 声明一致，再把元数据里的 `dist.integrity` / `dist.shasum` 原样透传。源鉴用解码后的文件重算 sha512 比对，内容一致就不会触发 `PKG_INTEGRITY_MISMATCH`。**不要手工重打包 tgz**，那会改变字节使 integrity 失效。

---

## 1. 前置条件

- Node.js ≥ 22（项目本身要求；脚本用到原生 `fetch`）
- 项目已 `npm install`（脚本依赖 `adm-zip`，项目已有该依赖）
- 源鉴账号具备 `package:publish` 权限，且已取得 API Token（`yj_...`）
- 源鉴「字典管理 → 上传包大小上限 → npm」不低于要导入的最大包（本包最大 `@dsh-ops/bash-win32-x64@0.2.1` 为 **161MB**，默认 200MB 已够；若把字典调低会被 `UPLOAD_FILE_TOO_LARGE` 拒绝）
- 若源鉴开着漏洞扫描（`security.scanEnabled=true`），带原生二进制的包（如上面那个 161MB 包）可能被判 `QUARANTINE`/`BLOCK`。可通过控制台关闭扫描或放行后再导（详见 `USER_GUIDE.md` 安全校验章节）

### 取 API Token

控制台登录后：`POST /api/v1/auth/tokens` `{"name":"offline-import"}`，或页面「API 令牌」菜单创建。令牌只在创建时展示一次。首次登录的内置管理员必须先改密才能建 token。

---

## 2. 命令

### 2.1 先 dry-run（强烈建议）

```bash
cd /opt/yuanjian   # 项目目录

node scripts/import-npm-batch.mjs \
  --zip /data/njcb-offline-plugins-win-x64.zip \
  --base http://<host>:3000 \
  --username <用户> --token "$YJ_TOKEN" \
  --dry-run
```

dry-run 只解压、读清单、校验文件齐全与体积，打印每个包的顺序与大小，**不发任何请求**。确认清单数量（应为 541）和大包体积后再实导。

### 2.2 正式导入

```bash
node scripts/import-npm-batch.mjs \
  --zip /data/njcb-offline-plugins-win-x64.zip \
  --base http://<host>:3000 \
  --username <用户> --token "$YJ_TOKEN" \
  --batch-size 20 --concurrency 4
```

参数说明：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--zip` / `--dir` | 必填二选一 | 双层 zip 路径；或已解压的内层目录（含 `tarballs/` + `registry.json`）。给 `--dir` 可跳过解压，适合重复导入 |
| `--base` | `http://127.0.0.1:3000` | 源鉴根地址，不带 `/npm/` 后缀 |
| `--username` / `--token` | 环境变量 `YJ_USERNAME` / `YJ_TOKEN` | Basic 认证的 `用户名:令牌` |
| `--batch-size` | `20` | 每批包数；`0` 表示不分批一次全导 |
| `--concurrency` | `4` | 批内并发数。源鉴默认限流写入较宽松，4 足够；失败多可降到 1 |
| `--limit` | `0`（不限） | 只导前 N 个，调试用 |
| `--only-targets` | 关 | 只导 `plugins.txt` 里的 22 个包（**不推荐**：会跳过依赖闭包，安装时 404） |
| `--retry` / `--retry-delay` | `3` / `1000` | 5xx / 网络错误按指数退避重试；409 已存在不重试 |
| `--timeout` | `120000` | 单请求超时 ms；161MB 包 base64 后约 215MB，慢网可调到 300000 |
| `--batch-delay` | `500` | 批间停顿 ms |
| `--state` | `<zip同级>/.import-npm-state.json` | 断点状态文件；失败清单写到同目录 `.import-npm-failures.json` |
| `--reset` | 关 | 忽略状态文件从头跑（已入库的包会返回 409，被当作幂等成功，不会重复写入） |
| `--fail-fast` | 关 | 首个失败即停止；默认继续跑完当前批 |
| `--dry-run` | 关 | 只扫描不发送 |

### 2.3 断点续传

脚本每成功一个包就写状态文件。中断后直接重跑同一条命令（**不要加 `--reset`**），已成功的包会被跳过：

```
成功=N 已存在=M 状态跳过=K 失败=F
```

`--reset` 也不会造成重复写入：源鉴 `PKG_VERSION_DUPLICATE`（409）被识别为幂等成功。

---

## 3. 输出与排错

进度逐行打印：`OK <name>@<version>` 或 `FAIL <name>@<version> [状态] 原因`。失败详情写到 `.import-npm-failures.json`，含原始错误码与响应片段。

常见失败：

| 错误 | 原因 | 处理 |
|---|---|---|
| `AUTH_UNAUTHENTICATED` | token 无效或用户名不匹配 | 重新创建 token；确认 `--username` 与建 token 的账号一致 |
| `SYS_VALIDATION` + `UPLOAD_FILE_TOO_LARGE` | 包超过字典业务上限 | 调大字典「npm 上传包大小上限」或提高 HTTP 硬天花板 `MAX_NPM_PUBLISH_BYTES` 后重启 |
| `SEC_*` / `QUARANTINE` / `BLOCK` | 安全扫描拦截原生二进制或可疑命令 | 看失败清单里的 scanId，到控制台「安全校验」复核；或临时关闭扫描后重跑 |
| `PKG_VERSION_DUPLICATE` | 版本已存在 | 脚本已按成功处理，无需干预 |
| `PKG_TARBALL_INVALID` + `tarball 中未找到 package.json` | 少数离线包（如 `@types/*`）用真实包名作顶层目录（`d3-array/package.json`），而非 npm 标准 `package/package.json` | 源鉴已兼容两种布局（含安全扫描的 manifest 定位）。若仍失败，确认镜像版本 ≥ `2937dd7`；这批包全部自带 package.json，不是缺清单 |
| `local-hash-mismatch` | 本地 tgz 与 registry.json 声明的 sha256 不一致 | 离线包损坏，重新下载；不要强行重打包 |
| 请求超时 | 大包 + 慢网 | `--timeout 300000`，并把 `--concurrency` 降到 1 |

导入完成后，下游 dsh profile 的 `.npmrc` 指向源鉴，并在 `cordis.patch.yml` 配 `offline: true` + `npmRegistry: http://<host>:3000/npm/`。市场会把源鉴里所有带 `dsh` 字段的包自动上架。注意 tarball 下载地址里的 host 由源鉴 `NPM_BASE_URL` / `PUBLIC_BASE_URL` 决定：**必须设成下游能访问的地址**，否则 packument 里会写回 `localhost:3000`，下游拉包失败（与导入脚本无关）。

packument 只透传安装解析需要的白名单字段：`description`、`engines`、`dependencies`、`peerDependencies`、`peerDependenciesMeta`、`optionalDependencies`、`os`、`cpu`、`bin`、`main`、`module`、`exports`、`dsh`、`license`、`repository`、`homepage`、`keywords`。`scripts`、`publishConfig` 等执行/发布相关字段刻意不透传；`dist`、`security`、`dist-tags` 由服务端计算。

---

## 4. 已验证范围

在本地隔离实例上做过端到端验证：

- 双层 zip 自动解压 → 识别 541 个 tgz → 按体积升序分批
- 实导小样本（3 个包），入库后 packument 版本元数据正确
- 从源鉴下载 tarball，sha256 与离线包声明完全一致
- 409 幂等、断点续传、状态文件、失败清单路径均验证通过

未做的：541 个全量实导（耗时取决于网络与安全扫描策略）、Windows 客户端 `dsh plugin add` 的实际安装。建议先小批量实导 + 一台客户端试装，再全量铺开。

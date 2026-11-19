# 本地源鉴运行与双源安装验证报告

验证日期：2026-11-19
环境：macOS arm64 / Node 22.22.2 / Python 3.13.12
目标实例：`http://127.0.0.1:3000`（development，`data/dev`）

## 一、服务状态

| 项 | 结果 |
|---|---|
| health | `status: ok`，包数 516（514 npm + 2 pypi），存储占用 66.1% |
| 控制台 `GET /` | HTTP 200，64 KB |
| npm registry `GET /npm/<pkg>` | HTTP 200（`/npm/` 根路径 404 属正常，无空名包） |
| PyPI simple `GET /pypi/simple/` | HTTP 200，索引 numpy / pandas |

服务在验证前已运行于 3000 端口，验证全程未中断，结束时仍为 `ok`。

## 二、numpy 安装（PyPI 源）

源内原有 numpy 2.5.5 / 2.5.4 均为 `cp315-win_arm64`，与本机（Python 3.13 / macOS arm64）不兼容。为使验证具备真实可运行性，先从上游下载兼容 wheel 并上传至源鉴，再完全通过源鉴安装。

**步骤与结果**

| 步骤 | 结果 |
|---|---|
| 下载 `numpy-2.2.6-cp313-cp313-macosx_14_0_arm64.whl`（5.1 MB） | 成功，sha256 `f1372f04…b74d` |
| 插入临时 API token 并 `POST /pypi/legacy/` 上传 | HTTP 200，simple 页出现新版本 |
| `pip install --index-url http://127.0.0.1:3000/pypi/simple/ numpy==2.2.6`（隔离 venv） | 成功，从源鉴下载 5.1 MB，408 MB/s |
| `import numpy` 及计算 | 版本 2.2.6；矩阵乘 `[[19,22],[43,50]]`、特征值 `[-0.3723, 5.3723]` 均正确 |

结论：PyPI 索引 → 文件下载 → sha256 校验 → pip 安装 → 运行时计算，全链路通过。

## 三、npm 包安装（npm 源）

### 包的选择依据

未指定具体包名，选择标准是与本项目（dsh 内网插件方案）直接相关且能覆盖不同复杂度：

| 包 | 版本 | 选择依据 |
|---|---|---|
| `dshmarket` | 1.73.18-intra.3 | 内网插件市场核心入口，22 个目标插件之一 |
| `dsh-ops` | 0.4.1 | 目标插件之一，验证零直接依赖包的发布/拉取 |
| `dsh-ppt` | 0.20.5 | 目标插件之一，5 个直接依赖，验证传递依赖闭包 |

`.npmrc` 指向 `http://127.0.0.1:3000/npm/`，在隔离目录用真实 `npm install` 安装。

### 结果

| 项 | 结果 |
|---|---|
| `npm install dshmarket@1.73.18-intra.3` | added 4 packages / 422 ms |
| `npm install dsh-ops` | added 1 package / 511 ms |
| `npm install dsh-ppt` | added 12 packages / 578 ms |
| `npm ls --depth=1` | 三个顶层包与全部传递依赖均解析正确，无 `UNMET DEPENDENCY` |
| tarball 来源 | `package-lock.json` 中均为 `http://127.0.0.1:3000/npm/...` |

`dsh-ppt` 实测依赖树：`@office-kit/pptx@0.21.0`、`@stardustlc/dsh-updates@0.1.4`、`csv-parse@6.1.0`、`fflate@0.8.3`、`jsep@1.4.0`；其 `dsh.bundle.patch` 与 client inject 元数据完整保留。

### 发现的异常（包自身问题，非源鉴故障）

`require('dshmarket')` 首次失败：

```
Cannot find package '@deepseek-ai/schemastery' imported from .../dshmarket/lib/settings.js
```

原因：`dshmarket` 的 `package.json` 只声明了 `js-yaml`、`undici`，但代码 import 了 `@deepseek-ai/*` 系列包（源码中检索到 20+ 个），属于上游包元数据依赖声明不完整。这些包本应由 dsh 运行时提供，在纯净 npm 项目中不被解析。

处理：从源鉴手动 `npm install @deepseek-ai/schemastery`（源内有 3.19.0 / 3.18.5）后，加载成功，导出 `apply`、`describeProfileContext`、`name`、`useLauncherInstallAnchor`、`useTrustedHosts`。

影响：dsh 实际运行环境自带这些 runtime 包，不影响插件在 dsh 内使用；但若要在普通 Node 项目直接 import dshmarket，需手动补齐 `@deepseek-ai/*` 依赖。

## 四、基础功能测试

| 编号 | 测试 | 期望 | 实际 | 状态 |
|---|---|---|---|---|
| T1 | 未鉴权拉取 npm 公开包 | 200 | 200 | 通过 |
| T2 | 未鉴权访问 PyPI simple | 200 | 200 | 通过 |
| T3 | 未鉴权 npm publish | 401 | 401 | 通过 |
| T4 | 未鉴权 twine upload | 401 | 401 | 通过 |
| T5 | 带 token 访问管理 API | 200 | 200 | 通过 |
| T6 | 不存在的 npm 包 | 404 | 404 | 通过 |
| T7 | integrity 篡改包 | 拒绝 | 400 `PKG_INTEGRITY_MISMATCH` | 通过 |
| T8 | 缺包访问自动登记 | 落库 | `missing_dependencies` 新增记录，hits=1 | 通过 |
| T9 | PyPI wheel 下载哈希 | 与声明一致 | 下载 sha256 与 simple 页声明完全相同 | 通过 |
| T10 | npm tarball 重复下载 | 200 | 200 | 通过 |

**关键日志/响应**

- T7：`{"error":"PKG_INTEGRITY_MISMATCH","reason":"文件摘要与声明不一致","traceId":"5cd54204-..."}` HTTP 400
- T8：`{"dedupe_key":"registry:pypi:definitely-not-a-real-package-xyz:*","ecosystem":"pypi","hits":1,...}`
- T9：下载与声明 sha256 均为 `f1372f041402e37e5e633e586f62aa53de2eac8d98cbfb822806ce4bbefcb74d`

10 项全部通过，无失败项。

## 五、清理与留存

- 验证用 API token 已撤销（`revoked_at` 已写，active token 为 0）
- 临时 venv、npm 项目、wheel 缓存均已删除
- 源鉴服务保持运行；上传的 numpy 2.2.6 wheel 留在 PyPI 源中作为可用包
- 服务最终状态：`status ok`，packages 516

# 离线交付与安装（A3）

## 1. 交付模式

采用「离线缓存为主 + 预装依赖兜底」：

| 产物 | 作用 | 是否必需 |
| --- | --- | --- |
| `yuanjian-app-<版本>-<日期>.tar.gz` | 应用源码（不含 `node_modules`/`data`/`dist`） | 必需 |
| `yuanjian-npm-cache-<版本>-<日期>.tar.gz` | npm 离线缓存，目标机据此 `npm ci --offline` 重建依赖 | 必需（可审计路径） |
| `yuanjian-node_modules-<版本>-<日期>.tar.gz` | 预装依赖，仅在无 npm 或缓存不兼容时兜底 | 可选 |
| `MANIFEST.txt` / `MANIFEST.sha256` | 构建环境信息与产物校验和 | 必需 |

## 2. 构建（可联网的构建机）

```bash
./scripts/build-offline.sh
# 产物默认落在 ./dist-offline
```

脚本执行内容：

1. 校验 Node ≥ 22.5 与 `npm`/`rsync`/`tar` 可用。
2. `npm ci --cache dist-offline/npm-cache`：用独立缓存目录安装依赖，同时把全部依赖 tarball 写入缓存（不污染本机 `~/.npm`）。
3. `npm run typecheck && npm run build`：产物不可构建时直接失败，不产出残次包。
4. 打包源码、缓存、`node_modules`，生成 `MANIFEST.txt` 与逐文件 sha256。

> 构建机与目标机的 **npm 主版本需一致**。离线缓存是内容寻址结构，跨主版本可能出现 `ENOTCACHED`。

## 3. 安装（内网目标机）

```bash
# 标准安装：缓存重建依赖
./scripts/install-offline.sh /opt/yuanjian/delivery /opt/yuanjian

# 缓存不可用时的兜底：显式确认使用预装依赖
./scripts/install-offline.sh /opt/yuanjian/delivery /opt/yuanjian --fallback-node-modules

# 覆盖已有应用目录（旧目录改名保留，不删除）
./scripts/install-offline.sh /opt/yuanjian/delivery /opt/yuanjian --force

# 安装后跑完整 e2e（需要 devDependencies）
./scripts/install-offline.sh /opt/yuanjian/delivery /opt/yuanjian --with-test
```

目录结果：

```
/opt/yuanjian/
├── app/                # 应用与 dist/
└── npm-cache/          # 离线依赖缓存，后续升级可复用
```

脚本行为约束：

- 先按 `MANIFEST.sha256` 校验全部产物，任一不匹配即中止（退出码 1）。
- 应用目录非空且未加 `--force` 时拒绝安装（退出码 4），不会静默覆盖。
- `npm ci --offline --ignore-scripts`：默认不执行依赖的生命周期脚本，降低供应链风险；如某依赖确需安装脚本，需评估后手工执行。
- 缓存安装失败且未显式指定 `--fallback-node-modules` 时中止（退出码 5），不静默降级。

## 4. 验收标准

| 项 | 标准 |
| --- | --- |
| 完整性 | `sha256sum -c MANIFEST.sha256` 全部 OK |
| 依赖来源 | 安装日志中出现 `npm ci --offline` 且无网络请求；`npm ls --omit=dev` 无缺失 |
| 构建 | `npm run build` 通过，`dist/main.js` 存在 |
| 功能 | `--with-test` 时 15 套件 83 用例全部通过 |
| 启动 | 用生产配置启动后 `/api/v1/health` 返回 `status: ok` |
| 断网验证 | 目标机断开公网后重复安装与启动，行为一致 |

## 5. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm error code ENOTCACHED` | 缓存未包含某个 tarball，或 npm 主版本不一致 | 用同版本 npm 重新执行 `build-offline.sh`；或临时加 `--fallback-node-modules` |
| `npm ci` 报 lockfile 不一致 | 交付包内 `package-lock.json` 与 `package.json` 不匹配 | 回到构建机重跑 `npm ci` 后重新打包，不要手工改 lock |
| 测试失败且提示找不到 jest | 使用了 `--omit=dev` 或预装包被裁剪 | 预装包保留全量依赖；测试只在 `--with-test` 时执行 |
| 平台上 `Optional chaining` 报错 | 目标机 Node 低于 22.5 | 升级 Node（A1 启动校验也会直接拒绝低版本） |
| 安全扫描提示依赖漏洞 | 交付缓存中依赖版本落后 | 在构建机升级依赖并重新出包，不在目标机打补丁 |

## 6. 升级与回滚

- **升级**：新版本重新执行 `build-offline.sh`，目标机 `install-offline.sh <新交付目录> <安装根目录> --force`；旧应用目录保留为 `app.pre-install-<时间戳>`。
- **回滚**：停服 → 将 `app.pre-install-<时间戳>` 改回 `app` → 启动；数据库变更按 `scripts/restore.sh` 的备份回退（升级前先执行一次 `backup.sh`）。
- 离线缓存可跨版本复用，`npm ci` 会按新 lock 只取缺失的包。

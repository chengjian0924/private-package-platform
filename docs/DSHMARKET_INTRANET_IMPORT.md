# dshmarket 内网版导入源鉴操作手册

目标：把 `chengjian0924/dshmarket-intra`（内网版插件市场，包名 `dshmarket@1.73.18-intra.3`）导入源鉴私有 npm 源，供内网 DeepSeek Harness 通过 `dsh plugin add` 安装。

下文 `<HOST>:3000` 换成源鉴实际地址；`<用户>` / `<令牌>` 换成源鉴账号与 API Token。

---

## 0. 先读这一节：四个会让你失败的事实

1. **这个 fork 没有 GitHub Release 预构建包。** 仓库只提交了 `client/client.js`，`lib/` 需要 `tsc` 构建。必须先 clone → build → `npm pack` 得到 tgz。上游 `dsh-market/dsh-market` 的 release tarball 不能用于这个内网 fork（代码不同）。
2. **包名和公网 npm 的 `dshmarket` 完全同名。** 版本 `1.73.18-intra.3` 是 prerelease，`semver.gt('1.73.18-intra.3','1.73.18') === false`。源鉴里若有官方版，内网版不会成为 `latest`。源鉴只放内网版即可。
3. **`publishConfig.registry` 指向 `https://registry.npmjs.org/`。** 不同 npm 版本对它的优先级处理不一致，发布时可能无视 `--registry` 把包推到公网。发布前**必须**从 tgz 的 `package.json` 里删掉该字段。
4. **源鉴没有上游代理，依赖必须全量导入。** `dshmarket` 的依赖 / peerDeps / client inject 涉及多个 `@deepseek-ai/*` 包；`offline-bundle.mjs` 只按名字下载 tarball，**不解析依赖树**。少一个包，`dsh plugin add` 就失败。

---

## 1. 联网侧：构建内网 fork 的 tarball

在有公网的机器上：

```bash
git clone https://github.com/chengjian0924/dshmarket-intra.git
cd dshmarket-intra
npm install
npm run build          # tsc 生成 lib/，并重建 client bundle
npm pack               # → dshmarket-1.73.18-intra.3.tgz
```

`prepack` 脚本会跑 `npm run build` 和 `scripts/preflight.mjs`。若预检因锁文件 foreign-host 规则报错，按提示处理，**不要跳过构建直接 pack**（会缺 `lib/`）。

---

## 2. 联网侧：补齐依赖包

`dshmarket` 需要这些包才能在 dsh 里解析成功。逐个下载 tarball（版本以 dsh 实际安装的版本为准，下面给出的是 `package.json` 声明的范围）：

```bash
mkdir -p deps && cd deps
npm pack js-yaml@4.3.2 undici@7.29.1 \
  @deepseek-ai/cordis@4.0.1 \
  @deepseek-ai/dsh-settings@0.2.1-rc.1 \
  @deepseek-ai/schemastery@3.18.1 \
  @deepseek-ai/dsh-client-locale \
  @deepseek-ai/dsh-client-ui-settings \
  @deepseek-ai/dsh-client-ui-theme \
  dsh-plugin-updates
```

注意：

- `dsh-settings` / `schemastery` 在 `peerDependenciesMeta` 里标了 `optional`，但 client 注入链可能用到；内网离线环境建议全导。
- `@deepseek-ai/*` 的版本必须从目标 dsh 实例的 lockfile 里取精确版本，避免 API 不兼容。
- 这些包本身还有传递依赖。稳妥做法是在联网机器上建临时项目写全量依赖，`npm install` 后用 `npm pack` 逐个导出，或从 `node_modules` 批量打包。

---

## 3. 联网侧（可选）：镜像整个插件市场目录

如果只想用市场插件本身，跳过这一步——`offline: true` 下**源鉴里的包就是目录**，不需要 `plugins.json`。

如果要批量镜像市场里列出的所有插件：

```bash
node scripts/offline-bundle.mjs \
  --out ./bundle \
  --target http://<HOST>:3000/npm/ \
  --registry https://registry.npmjs.org \
  --replace dshmarket=./dshmarket-1.73.18-intra.3.tgz
```

产出：

- `bundle/tarballs/*.tgz` —— 版本 pinned 的 tarball
- `bundle/tarballs/publish.sh` / `publish.cmd` —— 生成的发布脚本
- `bundle/plugins.json` —— 只含可安装条目的目录（GitHub-only 条目被剔除）
- `bundle/README.txt` —— 配置片段

`--replace` 是关键：不用它，脚本会从 npmjs 下载**官方版** dshmarket 覆盖你的内网 fork。

---

## 4. 内网侧：登录源鉴

```bash
npm config set registry http://<HOST>:3000/npm/
npm login --registry http://<HOST>:3000/npm/
```

`npm login` 成功后会把 API Token 写进 `.npmrc` 的 `_auth`。手工配置时 `_auth` = `base64(用户名:令牌)`。源鉴 npm 路由的 Basic 认证**只认 API Token**，不认用户名口令。

---

## 5. 内网侧：发布（关键步骤）

### 5.1 去掉 tgz 里的 publishConfig

对每个要发布的 tgz 执行（以 dshmarket 为例）：

```bash
mkdir -p /tmp/dsh-publish && cd /tmp/dsh-publish
tar xzf /path/to/dshmarket-1.73.18-intra.3.tgz
node -e '
const fs = require("fs");
const f = "package/package.json";
const p = JSON.parse(fs.readFileSync(f, "utf8"));
delete p.publishConfig;
fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
'
tar czf dshmarket-1.73.18-intra.3.tgz package
```

### 5.2 发布

```bash
npm publish ./dshmarket-1.73.18-intra.3.tgz --registry http://<HOST>:3000/npm/
```

然后按同样方式发布第 2 步（和第 3 步）的所有依赖 tarball。用 `offline-bundle.mjs` 的话，在 `tarballs/` 目录里直接 `sh publish.sh`——但**先按 5.1 处理每个 tgz 的 publishConfig**，生成脚本里没有这一步。

### 5.3 验证

```bash
npm view dshmarket versions --registry http://<HOST>:3000/npm/
curl -s http://<HOST>:3000/npm/dshmarket
```

在源鉴控制台「包管理」确认版本 `1.73.18-intra.3` 已入库、扫描结论为 PASS。若被 `BLOCK` / `QUARANTINE`，按扫描详情整改；临时放行需管理员在「字典管理」关闭扫描开关（fail-open，谨慎）。

---

## 6. 内网侧：配置 dsh

### 6.1 市场配置（profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-market
  name: dshmarket
  config:
    offline: true
    npmRegistry: http://<HOST>:3000/npm/
```

`offline: true` 下源鉴就是目录：每个声明了 `dsh` 字段的包都会上架，不需要维护 `plugins.json`。只有需要固定顺序或人工筛选时才加 `catalog:` / `plugins: [...]`。

### 6.2 pnpm 的 registry（profile 目录 `.npmrc`）

`dsh plugin add` 底层转发给 profile 目录内的 pnpm，它读的是 profile 的 `.npmrc`：

```ini
registry=http://<HOST>:3000/npm/
//<HOST>:3000/npm/:_auth=<base64 of 用户名:令牌>
```

如果内网所有包都在源鉴，全局 registry 指过去即可；如果只有私有 scope 走源鉴，用 `@scope:registry=...` 分流。

### 6.3 安装与验证

```bash
dsh plugin --profile web add dshmarket
dsh --profile web --dump-config | grep -A3 dsh-market
dsh web
```

打开 Plugins 页的 **Plugin Market** 标签（dsh 0.2.1+），列表应来自源鉴。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 包被推到 npmjs.org | tgz 里 `publishConfig.registry` 覆盖了 `--registry` | 执行 5.1 |
| `dsh plugin add` 报 404 | 依赖包没入库（源鉴无上游代理） | 补齐第 2 步全部依赖 |
| 市场列表为空 | 包没声明 `dsh` 字段，或 `npmRegistry` 路径写错 | 检查包内 `package.json` 的 `dsh.bundle`；确认 registry 带 `/npm/` |
| 安装到错误 profile | Desktop 版 profile 不是 `web` | Desktop 用应用内 Settings → Plugins 安装 |
| 上传被安全扫描拦截 | client bundle 或 install 脚本命中规则 | 看扫描详情，整改或管理员临时关闭扫描 |
| 内网版不是 `latest` | prerelease 版本号排序低于正式版 | 源鉴只保留内网版，或显式指定版本安装 |

# 控制台分页组件使用说明

适用版本：控制台 `public/pagination.js`（无构建、无框架依赖，随 `index.html` 以 `<script>` 引入）。

## 1. 能力范围

| 能力 | 说明 |
|---|---|
| 页码点击 | 当前页高亮，点击其它页切换数据 |
| 上一页 / 下一页 | 到达首/末页时对应按钮自动禁用 |
| 首页 / 末页 | `«` / `»` 一键跳转 |
| 每页条数 | 默认 `10 / 20 / 50 / 100`，切换后回到第 1 页 |
| 跳转输入 | 只接受 `1..总页数` 的正整数，越界时输入框红底抖动提示且不跳转 |
| 页码省略 | 超过 7 页时折叠为 `1 … 4 5 6 … 20`，始终保留首末页与当前页邻域 |
| 空数据 | `total = 0` 时组件整体隐藏，由业务视图的空态提示接管 |
| 加载态 | `setLoading(true)` 时控件置灰禁用，表格由调用方渲染骨架屏 |
| URL 同步 | 分页状态写入 `location.hash`，刷新或前进后退可恢复 |
| 响应式 | ≤760px 时总条数独占一行，控件、每页条数、跳转依次换行 |

## 2. API

```js
var pager = Pagination.mount({
  el: 'pkg-pager',        // 容器 id 或元素，建议放在卡片内表格之后
  view: 'packages',       // 所属视图名，写入 hash 的 view 段
  key: 'pkg',             // 视图内唯一标识，hash 字段为 pkg.page / pkg.size
  pageSizes: [10, 20, 50, 100], // 可选，缺省即此值
  onChange: function (page, pageSize) { /* 重新拉数据或重切本地缓存 */ },
});

pager.update({ total: 92, page: 2, pageSize: 20 }); // 数据返回后回填
pager.reset();          // 筛选条件变化：回第 1 页，不触发 onChange
pager.setLoading(true); // 请求中
pager.getPage(); pager.getPageSize(); pager.getTotal();
```

辅助方法：

- `Pagination.skeleton(rows, cols)`：返回骨架屏 `<tr>` HTML，直接写入 `tbody`。
- `Pagination.readHash()` / `Pagination.writeHash(patch, { clearPaging })`：hash 读写；切视图时用 `clearPaging` 清掉旧视图的分页参数。

## 3. 服务端分页与本地分页

服务端分页（接口返回 `{ items, total, page, pageSize }`）：

```js
var params = new URLSearchParams({
  page: String(pager.getPage()),
  pageSize: String(pager.getPageSize()),
});
api('/api/v1/audit-logs?' + params).then(function (data) {
  var items = applyPaged(pager, data, loadAudit); // 页码越界时自动回第 1 页重载
  if (!items) return;
  // 渲染 items
});
```

本地分页（接口全量返回，如令牌、用户、隔离区）：

```js
api('/api/v1/users').then(function (data) {
  pageCache.user = data.items || [];
  pagers.user.update({ total: pageCache.user.length });
  renderUsersPage(pageSlice('user')); // 按当前页切片
});
```

`onChange` 里对本地分页只需重新 `pageSlice` 渲染，不必再发请求。

## 4. URL 参数约定

```
#view=security&sec.page=2&sec.size=20&quar.page=1&quar.size=20&adv.page=1&adv.size=10
```

- `view`：当前视图，权限校验后决定进入哪个页面。
- `<key>.page` / `<key>.size`：各分页器独立保存，互不干扰；同一视图内可并存多个分页器。
- 切换视图时清空其它视图的分页参数，避免参数无限堆积。
- 手改 hash 造成页码越界时：服务端分页回第 1 页重载，本地分页自动收敛到末页。

## 5. 各模块接入情况

| 模块 | 容器 id | key | 数据来源 | 分页方式 |
|---|---|---|---|---|
| 包管理 | `pkg-pager` | `pkg` | `/api/v1/packages` | 服务端 |
| 缺失依赖 | `missing-pager` | `mis` | `/api/v1/missing-dependencies` | 服务端 |
| 安全校验·校验记录 | `sec-pager` | `sec` | `/api/v1/security/scans` | 服务端 |
| 安全校验·隔离区 | `sec-quarantine-pager` | `quar` | `/api/v1/security/quarantine` | 本地 |
| 安全校验·漏洞库查询 | `adv-pager` | `adv` | `/api/v1/security/advisories` | 服务端 |
| 审计日志 | `audit-pager` | `aud` | `/api/v1/audit-logs` | 服务端 |
| 访问令牌 | `token-pager` | `tok` | `/api/v1/auth/tokens` | 本地 |
| 用户管理 | `users-pager` | `usr` | `/api/v1/users` | 本地 |
| 批量导入明细 | — | — | 单批次结果 | 不分页（需纵览全部校验项） |

## 6. 视觉规范

- 控件高度 30px、圆角 7px，与 `.btn.small` 同高，视觉基线一致。
- 当前页填充主色 `--primary` 白字，其余按钮白底描边；禁用态透明度 42%。
- 总条数文案：`共 N 条 · 第 X / Y 页`，数字使用等宽数字（`tabular-nums`），翻页时列宽不跳动。
- 省略号为 `…`，不加边框，保持与页码按钮同一基线。
- 加载中：控件整体透明度 55% 且不可点击，表格显示骨架屏行。

## 7. 验证方法

1. `npm test`：后端回归，确认接口分页结构未被破坏。
2. 浏览器多宽度：1440 / 1024 / 500 / 375，检查 `document.documentElement.scrollWidth === innerWidth`（无横向溢出）。
3. 交互回归：末页点「下一页」应禁用；跳转输入 `0`、`999`、`abc` 均被拒绝；每页条数切换后回到第 1 页；刷新后分页状态保持。
4. 数据量为 0 的列表（如隔离区为空）应只显示空态提示，不出现空白分页条。

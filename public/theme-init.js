/* 主题前置脚本（外链，符合站点 CSP script-src 'self'）
   在 CSS 加载后、body 渲染前同步执行，避免夜间主题首次加载闪白。
   优先级：本地手动选择 > 系统 prefers-color-scheme > 日间。 */
(function () {
  try {
    var saved = localStorage.getItem('yj-theme');
    var dark = saved
      ? saved === 'dark'
      : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.getElementById('color-scheme');
    if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
  } catch (e) {
    // localStorage 在隐私模式或受限环境可能抛错，静默降级到日间
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

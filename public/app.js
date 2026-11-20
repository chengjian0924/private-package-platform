/* 源鉴 · 内网依赖安全治理平台 控制台交互逻辑 */
(function () {
  'use strict';

  var state = {
    user: null,
    permissions: [],
    batchId: '',
    autoFiles: [],
    currentView: 'packages',
    // 登录后由服务端下发的功能开关；默认按开启处理，避免旧响应缺失字段时误隐藏模块
    features: { securityScanEnabled: true },
    // 删除/恢复版本后需要重新展开的包分组（列表重渲染后消费一次）
    pkgReopen: null,
  };

  // 各视图分页组件实例；pageCache 存本地分页的全量数据（后端无分页接口的列表）
  var pagers = {};
  var pageCache = {};

  // [标题, 权限点]：模块的用途靠侧栏名称与页内结构自解释，不再重复一行副标题
  var VIEW_META = {
    packages: ['包管理', 'package:read'],
    import: ['批量导入', 'import:run'],
    missing: ['缺失依赖', 'package:read'],
    security: ['安全校验', 'security:read'],
    audit: ['审计日志', 'audit:read'],
    tokens: ['访问令牌', 'token:manage'],
    users: ['用户管理', 'user:manage'],
    dictionary: ['字典管理', 'config:manage'],
    manual: ['用户手册', null],
  };

  // 仅管理员可见的模块：权限点之外再加角色兜底，避免后续误给非管理员授予这些权限
  var ADMIN_ONLY_VIEWS = { audit: true, users: true, dictionary: true };
  var MIN_REFRESH_MS = 60 * 1000;

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(value) {
    if (!value) return '-';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /** 紧凑时间：半宽卡片里只显示「月-日 时:分」，完整时间用 title 补齐 */
  function fmtDayTime(value) {
    if (!value) return '-';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtSize(bytes) {
    var n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // Toast 采用堆叠容器：连续操作的结果不会互相覆盖，最多保留 4 条
  var TOAST_META = { ok: '\u2713', err: '\u2715', warn: '!', info: 'i' };
  function showToast(message, type) {
    var stack = $('toast');
    if (!stack) return;
    var kind = type === 'ok' || type === 'err' || type === 'warn' ? type : 'info';
    var item = document.createElement('div');
    item.className = 'toast-item ' + kind;
    item.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = TOAST_META[kind];
    var text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message == null ? '' : String(message);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '\u00d7';
    item.appendChild(icon);
    item.appendChild(text);
    item.appendChild(close);
    stack.appendChild(item);
    while (stack.children.length > 4) stack.removeChild(stack.firstElementChild);

    var timer = null;
    var ttl = kind === 'err' ? 7000 : 3600;
    function dismiss() {
      if (timer) clearTimeout(timer);
      item.classList.add('out');
      setTimeout(function () {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 200);
    }
    function arm() {
      timer = setTimeout(dismiss, ttl);
    }
    close.addEventListener('click', dismiss);
    // 悬停暂停倒计时，避免用户阅读长错误信息时提示先消失
    item.addEventListener('mouseenter', function () {
      if (timer) clearTimeout(timer);
    });
    item.addEventListener('mouseleave', arm);
    arm();
  }

  // 统一确认弹窗：保留原生 confirm 的阻塞式语义（Promise），但提供危险操作配色与键盘支持
  var confirmResolve = null;
  function confirmAction(opts) {
    var modal = $('confirm-modal');
    var o = opts || {};
    if (!modal) return Promise.resolve(window.confirm(o.message || '确认操作？'));
    if (confirmResolve) {
      var stale = confirmResolve;
      confirmResolve = null;
      stale(false);
    }
    $('confirm-title').textContent = o.title || '确认操作';
    $('confirm-message').textContent = o.message || '';
    $('confirm-ok').textContent = o.confirmText || '确认';
    $('confirm-ok').className = 'btn ' + (o.tone === 'danger' ? 'danger' : 'primary');
    $('confirm-icon').className = 'confirm-icon' + (o.tone ? ' ' + o.tone : '');
    modal.classList.remove('hidden');
    setTimeout(function () {
      $('confirm-cancel').focus();
    }, 30);
    return new Promise(function (resolve) {
      confirmResolve = resolve;
    });
  }
  function settleConfirm(ok) {
    var modal = $('confirm-modal');
    if (modal) modal.classList.add('hidden');
    if (!confirmResolve) return;
    var resolve = confirmResolve;
    confirmResolve = null;
    resolve(!!ok);
  }

  /** 复制文本：优先 Clipboard API，非安全上下文回退到临时 textarea */
  function copyText(value, label) {
    var text = String(value == null ? '' : value);
    function done() {
      showToast((label || '内容') + '已复制到剪贴板', 'ok');
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      if (ok) done();
      else showToast('复制失败，请手动选择文本复制', 'err');
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  // 在途请求计数：任一 API 未结束则顶部进度条可见
  var inflight = 0;
  function trackStart() {
    inflight += 1;
    var bar = $('global-progress');
    if (bar) bar.classList.remove('hidden');
  }
  function trackEnd() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) {
      var bar = $('global-progress');
      if (bar) bar.classList.add('hidden');
    }
  }

  /** 统一请求：解包 {code,message,data,traceId}，失败抛出带 code/traceId 的错误 */
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.formData) {
      init.body = opts.formData;
    } else if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    trackStart();
    return fetch(path, init).then(function (res) {
      var contentType = res.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') === -1) {
        return res.text().then(function (text) {
          throw new Error('服务返回了非 JSON 响应（HTTP ' + res.status + '）：' + text.slice(0, 120));
        });
      }
      return res.json().then(function (payload) {
        if (!res.ok || (payload && payload.code !== undefined && payload.code !== 0)) {
          var err = new Error((payload && payload.message) || '请求失败（HTTP ' + res.status + '）');
          err.code = payload && payload.code;
          err.traceId = payload && payload.traceId;
          err.details = payload && payload.details;
          err.status = res.status;
          throw err;
        }
        return payload && payload.data !== undefined ? payload.data : payload;
      });
    }).catch(function (err) {
      // 服务端仍判定为强制改密态（如其它端重置了密码）：立刻收回业务界面
      if (err && err.code === 'AUTH_PASSWORD_CHANGE_REQUIRED' && state.user) {
        state.user.mustChangePassword = true;
        $('app-view').classList.add('hidden');
        openPasswordModal(true);
      }
      throw err;
    }).finally(trackEnd);
  }

  function reportError(err) {
    var text = err && err.message ? err.message : '未知错误';
    if (err && err.code) text = '[' + err.code + '] ' + text;
    // 服务端把字段级原因放在 details.reason，原样带出才能告诉用户具体哪条规则没过
    if (err && err.details && err.details.reason) text += '：' + err.details.reason;
    if (err && err.traceId) text += '（traceId: ' + err.traceId + '）';
    showToast(text, 'err');
    if (!err || !err.code) console.error(err);
  }

  function setLoading(el, on) {
    if (!el) return;
    el.classList.toggle('loading', !!on);
    // 让屏幕阅读器知道表格正在刷新，而不只是视觉上变淡
    el.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /**
   * 表格请求失败：把骨架行替换成明确的错误空态并附重试按钮。
   * 只改展示，不改变任何请求参数或数据结构；retry 由调用方传入原有的加载函数。
   */
  function showTableError(tbody, cols, retry) {
    if (!tbody) return;
    tbody.innerHTML =
      '<tr><td colspan="' + cols + '">' +
      '<div class="empty is-error">加载失败，请稍后重试。' +
      (typeof retry === 'function'
        ? '<button type="button" class="btn small empty-action" data-table-retry>重新加载</button>'
        : '') +
      '</div></td></tr>';
    var btn = tbody.querySelector('[data-table-retry]');
    if (btn) btn.addEventListener('click', function () { retry(); });
  }

  /** 设置提交按钮的加载态：同时打 disabled 与视觉 class，避免只禁用却无反馈 */
  function setButtonLoading(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('is-loading', !!on);
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  /**
   * 服务端分页响应统一处理：页码越界（如手改 hash）时回第 1 页重载，
   * 正常时把 total/page/pageSize 回填 pager（组件内部对页码做上限收敛）
   */
  function applyPaged(pager, data, reload) {
    var items = (data && data.items) || [];
    var total = (data && data.total) || 0;
    var pageSize = (data && data.pageSize) || pager.getPageSize();
    var page = (data && data.page) || 1;
    if (!items.length && page > 1 && total > 0 && page > Math.ceil(total / pageSize)) {
      pager.reset();
      reload();
      return null;
    }
    pager.update({ total: total, page: page, pageSize: pageSize });
    return items;
  }

  /** 本地分页切片：从 pageCache 中按 pager 当前页取数据 */
  function pageSlice(cacheKey) {
    var pager = pagers[cacheKey];
    var all = pageCache[cacheKey] || [];
    // 页码最小值兜底：空列表曾把页码收敛为 0，避免 slice(-20, 0) 取不到数据
    var page = Math.max(1, pager.getPage());
    var start = (page - 1) * pager.getPageSize();
    return all.slice(start, start + pager.getPageSize());
  }

  /** 本地分页统一回填：拉全量后更新总数，组件内部对当前页做收敛 */
  function applyLocalPaged(cacheKey, items) {
    pageCache[cacheKey] = items || [];
    var pager = pagers[cacheKey];
    pager.update({ total: pageCache[cacheKey].length });
    // 空转非空时页码会停留在 0，必须回到第 1 页再切片
    if (pageCache[cacheKey].length && pager.getPage() < 1) pager.reset();
    return pageSlice(cacheKey);
  }

  function hasPerm(perm) {
    return state.permissions.indexOf(perm) !== -1;
  }

  function isAdmin() {
    return Boolean(state.user && state.user.role === 'admin');
  }

  function scanEnabled() {
    return state.features.securityScanEnabled !== false;
  }

  /**
   * 视图可见性：权限点 + 管理员专属模块 + 功能开关三层判断。
   * 漏洞扫描关闭后，普通用户不再看到安全校验；管理员保留入口用于查看历史台账。
   */
  function canSeeView(name) {
    var meta = VIEW_META[name];
    if (!meta) return false;
    // 用户手册无权限点，所有登录用户可见
    if (name === 'manual') return true;
    if (ADMIN_ONLY_VIEWS[name] && !isAdmin()) return false;
    if (!hasPerm(meta[1])) return false;
    if (name === 'security' && !scanEnabled() && !isAdmin()) return false;
    return true;
  }

  function visibleViews() {
    return Object.keys(VIEW_META).filter(canSeeView);
  }

  /**
   * 用户手册按当前角色权限裁剪：只保留用户实际可见、可操作的章节与说明。
   * 权限点标记在 HTML 的 data-manual-perm 上，逗号分隔表示需同时具备。
   * 目录随之重建，避免出现点了却找不到内容的空链接。
   */
  function applyManualVisibility() {
    var view = $('view-manual');
    if (!view) return;
    view.querySelectorAll('[data-manual-perm]').forEach(function (el) {
      var required = (el.getAttribute('data-manual-perm') || '').split(',');
      var ok = required.every(function (perm) {
        return hasPerm(perm.trim());
      });
      el.classList.toggle('hidden', !ok);
    });
    var links = $('manual-toc-links');
    if (!links) return;
    var html = '';
    view.querySelectorAll('.manual-sec').forEach(function (sec) {
      if (sec.classList.contains('hidden')) return;
      html += '<a data-scroll="' + esc(sec.id) + '">' +
        esc(sec.getAttribute('data-manual-title') || '') + '</a>';
    });
    links.innerHTML = html;

    // 编辑入口只给管理员；角色在运行中被改掉时顺手退出编辑态，避免普通用户看到源码框
    var canEdit = isAdmin();
    if (!canEdit && manualState.editMode) setManualEditMode(false);
    ['manual-edit-toggle', 'manual-save', 'manual-defaults'].forEach(function (id) {
      if ($(id)) $(id).classList.toggle('hidden', !canEdit);
    });
  }

  // ---------- 用户手册：管理员编辑，所有登录用户共享 ----------

  var manualState = {
    defaults: {},
    overrides: {},
    editMode: false,
    loaded: false,
  };

  /** 章节正文 = 除标题与编辑框之外的直接子节点 */
  function manualBodyNodes(sec) {
    return Array.prototype.filter.call(sec.children, function (child) {
      return !child.classList.contains('card-head') && !child.classList.contains('manual-edit-area');
    });
  }

  function manualBodyHtml(sec) {
    return manualBodyNodes(sec)
      .map(function (child) { return child.outerHTML; })
      .join('');
  }

  /** 首屏先把内置静态章节存下来，作为「恢复默认」的基准 */
  function captureManualDefaults() {
    document.querySelectorAll('#view-manual .manual-sec').forEach(function (sec) {
      manualState.defaults[sec.id] = manualBodyHtml(sec);
    });
  }

  function effectiveManualHtml(id) {
    var override = manualState.overrides[id];
    if (override && typeof override.html === 'string') return override.html;
    return manualState.defaults[id] || '';
  }

  /** 用服务端覆盖项替换章节正文；没有覆盖的章节继续用内置内容 */
  function applyManualOverrides() {
    document.querySelectorAll('#view-manual .manual-sec').forEach(function (sec) {
      var editArea = null;
      Array.prototype.forEach.call(sec.children, function (child) {
        if (child.classList.contains('manual-edit-area')) editArea = child;
      });
      manualBodyNodes(sec).forEach(function (child) { child.remove(); });

      var html = effectiveManualHtml(sec.id);
      if (html) {
        var box = document.createElement('div');
        box.innerHTML = html;
        while (box.firstChild) sec.appendChild(box.firstChild);
      }
      if (editArea) sec.appendChild(editArea);
    });
  }

  function loadManualContent(options) {
    var opts = options || {};
    if (manualState.loaded && !opts.force) {
      applyManualOverrides();
      applyManualVisibility();
      return;
    }
    return api('/api/v1/manual/content')
      .then(function (data) {
        manualState.overrides = (data && data.sections) || {};
        manualState.loaded = true;
        applyManualOverrides();
        applyManualVisibility();
      })
      .catch(function (err) {
        // 接口异常时继续展示内置手册，不让用户看到空白页
        manualState.loaded = true;
        applyManualOverrides();
        applyManualVisibility();
        reportError(err);
      });
  }

  function setManualEditMode(on) {
    manualState.editMode = Boolean(on);
    var toggle = $('manual-edit-toggle');
    if (toggle) toggle.textContent = manualState.editMode ? '退出编辑' : '编辑手册';
    ['manual-save', 'manual-defaults'].forEach(function (id) {
      if ($(id)) $(id).classList.toggle('hidden', !manualState.editMode);
    });

    document.querySelectorAll('#view-manual .manual-sec').forEach(function (sec) {
      var area = null;
      Array.prototype.forEach.call(sec.children, function (child) {
        if (child.classList.contains('manual-edit-area')) area = child;
      });
      if (!area) {
        area = document.createElement('div');
        area.className = 'manual-edit-area';
        var textarea = document.createElement('textarea');
        textarea.setAttribute('data-manual-edit', sec.id);
        textarea.setAttribute('aria-label', '编辑 ' + (sec.getAttribute('data-manual-title') || sec.id) + ' 内容');
        area.appendChild(textarea);
        sec.appendChild(area);
      }
      area.classList.toggle('hidden', !manualState.editMode);
      if (manualState.editMode) {
        var ta = area.querySelector('textarea');
        ta.value = effectiveManualHtml(sec.id);
        ta.classList.remove('manual-changed');
      }
    });
  }

  function manualChanges() {
    var changes = {};
    document.querySelectorAll('#view-manual textarea[data-manual-edit]').forEach(function (ta) {
      var id = ta.getAttribute('data-manual-edit');
      if (ta.value !== effectiveManualHtml(id)) changes[id] = ta.value;
    });
    return changes;
  }

  function saveManualContent() {
    var changes = manualChanges();
    if (!Object.keys(changes).length) {
      showToast('没有需要保存的修改', 'info');
      return;
    }
    setButtonLoading($('manual-save'), true);
    api('/api/v1/manual/content', { method: 'PUT', body: { sections: changes } })
      .then(function (data) {
        manualState.overrides = (data && data.sections) || {};
        applyManualOverrides();
        applyManualVisibility();
        // 重新写入 textarea，保证「已保存」后的基线就是当前内容
        setManualEditMode(true);
        showToast('用户手册已保存，所有登录用户可见', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('manual-save'), false);
      });
  }

  function resetManualDefaults() {
    var sections = {};
    document.querySelectorAll('#view-manual textarea[data-manual-edit]').forEach(function (ta) {
      sections[ta.getAttribute('data-manual-edit')] = '';
    });
    if (!Object.keys(sections).length) return;
    confirmAction({
      title: '恢复手册默认内容',
      message: '将清除管理员对全部章节的修改，所有用户恢复内置用户手册。',
      confirmText: '恢复默认',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      setButtonLoading($('manual-defaults'), true);
      api('/api/v1/manual/content', { method: 'PUT', body: { sections: sections } })
        .then(function (data) {
          manualState.overrides = (data && data.sections) || {};
          applyManualOverrides();
          applyManualVisibility();
          setManualEditMode(true);
          showToast('已恢复内置手册', 'ok');
        })
        .catch(reportError)
        .finally(function () {
          setButtonLoading($('manual-defaults'), false);
        });
    });
  }

  /** 侧栏显隐统一入口：登录后、字典开关变化、定时刷新功能位都复用，避免三处逻辑漂移 */
  function applyNavVisibility() {
    var allowed = visibleViews();
    document.querySelectorAll('#nav .nav-item').forEach(function (btn) {
      var view = btn.getAttribute('data-view');
      btn.classList.toggle('hidden', allowed.indexOf(view) === -1);
    });
    // 分组标题跟随其下导航项显隐：整组无权限时不留空标题
    document.querySelectorAll('#nav .nav-group-label').forEach(function (label) {
      var anyVisible = false;
      var node = label.nextElementSibling;
      while (node && !node.classList.contains('nav-group-label')) {
        if (!node.classList.contains('hidden')) anyVisible = true;
        node = node.nextElementSibling;
      }
      label.classList.toggle('hidden', !anyVisible);
    });
    applyManualVisibility();
  }

  /** 批量导入形态：关闭漏洞校验后隐藏步骤条与全量校验卡，上传即走基础校验+入库 */
  function applyScanMode() {
    var on = scanEnabled();
    var importView = $('view-import');
    if (importView) importView.classList.toggle('scan-off', !on);
    var uploadText = $('auto-upload-text');
    if (uploadText) uploadText.textContent = on ? '上传并自动识别' : '上传并直接入库';
  }

  /** 应用服务端下发的能力位；开关变化导致当前视图不可见时自动切走 */
  function applyFeatureState(features) {
    if (!features || typeof features.securityScanEnabled !== 'boolean') return;
    var changed = state.features.securityScanEnabled !== features.securityScanEnabled;
    state.features.securityScanEnabled = features.securityScanEnabled;
    applyScanMode();
    applyNavVisibility();
    if (changed && state.user && !canSeeView(state.currentView)) {
      switchView(visibleViews()[0] || 'packages');
      return;
    }
    // 包管理的版本表按开关列渲染「安全」列，开关变化后重载以重建表头，避免留下失效列
    if (changed && state.currentView === 'packages' && !$('app-view').classList.contains('hidden')) {
      loadPackages();
    }
  }

  // ---------- 登录态 ----------

  function showLoginError(message) {
    var el = $('login-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function showLogin() {
    $('app-view').classList.add('hidden');
    $('pwd-modal').classList.add('hidden');
    $('pwd-modal').classList.remove('forced');
    $('login-view').classList.remove('hidden');
    $('login-password').value = '';
    showLoginError('');
    $('login-username').focus();
  }

  function renderCurrentUser() {
    if (!state.user) return;
    var name = state.user.displayName || state.user.username;
    var initial = String(name || '?').trim().slice(0, 1).toUpperCase();
    $('current-user').innerHTML =
      '<span class="avatar" aria-hidden="true">' + esc(initial) + '</span>' +
      '<span class="user-meta"><span class="user-name">' + esc(name) + '</span>' +
      '<span class="user-sub">' + esc(state.user.role) + '</span></span>';
  }

  function showApp() {
    $('login-view').classList.add('hidden');
    if (state.user.mustChangePassword) {
      // 强制改密：不进入业务布局，界面被改密页整屏接管；接口层另有守卫兜底
      $('app-view').classList.add('hidden');
      openPasswordModal(true);
      return;
    }
    $('pwd-modal').classList.add('hidden');
    $('pwd-modal').classList.remove('forced');
    $('app-view').classList.remove('hidden');
    renderCurrentUser();
    applyScanMode();
    applyNavVisibility();
    var allowed = visibleViews();
    // 刷新恢复：hash 指向的视图在权限内时优先进入
    var hashView = Pagination.readHash().view;
    switchView(allowed.indexOf(hashView) !== -1 ? hashView : allowed[0] || 'packages');
    startFeaturePolling();
  }

  /** 拉取当前会话（含权限与强制改密标记）：登录成功与页面加载共用同一入口 */
  function refreshSession() {
    return api('/api/v1/auth/me').then(function (data) {
      state.user = data.user;
      state.permissions = data.permissions || [];
      // features 缺失时按开启处理，兼容旧服务端响应
      state.features.securityScanEnabled = !data.features || data.features.securityScanEnabled !== false;
      showApp();
    });
  }

  var featurePollTimer = null;
  var lastFeatureSync = 0;

  /** 定时同步功能开关：管理员关闭漏洞校验后，其他已登录会话也无需刷新页面即可收敛入口 */
  function refreshFeatures(force) {
    if (!state.user) return Promise.resolve();
    if (!force && Date.now() - lastFeatureSync < MIN_REFRESH_MS / 2) return Promise.resolve();
    lastFeatureSync = Date.now();
    return api('/api/v1/features')
      .then(function (data) {
        applyFeatureState(data);
      })
      .catch(function () {
        // 能力位同步失败不打断当前会话，下个周期重试
      });
  }

  function startFeaturePolling() {
    if (featurePollTimer) return;
    featurePollTimer = setInterval(function () {
      refreshFeatures(false);
    }, MIN_REFRESH_MS);
    // 切回标签页立即补一次，避免后台挂起导致开关状态长期滞后
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshFeatures(true);
    });
  }

  function loginErrorMessage(err) {
    var text = err && err.message ? err.message : '登录失败';
    if (!err) return text;
    if (err.code === 'AUTH_ACCOUNT_LOCKED') {
      var minutes = err.details && err.details.retryAfterSec ? Math.ceil(err.details.retryAfterSec / 60) : 0;
      if (minutes > 0) text += '，请约 ' + minutes + ' 分钟后重试';
    } else if (err.code === 'AUTH_INVALID_CREDENTIALS' && err.details && err.details.remainingAttempts >= 0) {
      text += '，还可尝试 ' + err.details.remainingAttempts + ' 次';
    }
    return text;
  }

  function submitLogin(e) {
    if (e) e.preventDefault();
    var username = $('login-username').value.trim();
    var password = $('login-password').value;
    if (!username || !password) {
      showLoginError('请输入用户名与密码');
      return;
    }
    showLoginError('');
    setButtonLoading($('login-submit'), true);
    api('/api/v1/auth/login', { method: 'POST', body: { username: username, password: password } })
      .then(function (data) {
        $('login-password').value = '';
        state.user = data.user;
        return refreshSession();
      })
      .catch(function (err) {
        showLoginError(loginErrorMessage(err));
      })
      .finally(function () {
        setButtonLoading($('login-submit'), false);
      });
  }

  // ---------- 改密 ----------

  function openPasswordModal(forced) {
    $('pwd-modal').setAttribute('data-forced', forced ? '1' : '0');
    // forced 时整屏接管：背景不透明、业务界面不可见，也不提供关闭入口
    $('pwd-modal').classList.toggle('forced', !!forced);
    $('pwd-modal').classList.remove('hidden');
    $('pwd-close').classList.toggle('hidden', !!forced);
    $('pwd-title').textContent = forced ? '首次登录：设置新密码' : '修改密码';
    // 强制改密不问原密码：账号本来就是用初始密码登录进来的，再让用户抄一遍没有意义
    $('pwd-old-field').classList.toggle('hidden', !!forced);
    $('pwd-old').disabled = !!forced;
    $('pwd-old').required = !forced;
    $('pwd-old').value = '';
    $('pwd-new').value = '';
    $('pwd-confirm').value = '';
    $('pwd-hint').textContent = forced
      ? '新密码不少于 8 位，且不能包含用户名或常见弱口令片段；两次输入必须一致。'
      : '新密码不少于 8 位，且不能与原密码、用户名或常见弱口令片段相同；两次输入必须一致。';
    (forced ? $('pwd-new') : $('pwd-old')).focus();
  }

  function closePasswordModal() {
    // 强制改密时不允许关闭，避免停留在无权限的空壳界面
    if ($('pwd-modal').getAttribute('data-forced') === '1') return;
    $('pwd-modal').classList.add('hidden');
  }

  function submitPasswordChange(e) {
    e.preventDefault();
    var forced = $('pwd-modal').getAttribute('data-forced') === '1';
    var oldPwd = forced ? '' : $('pwd-old').value;
    var newPwd = $('pwd-new').value;
    var confirmPwd = $('pwd-confirm').value;
    if (!forced && !oldPwd) {
      showToast('请输入原密码', 'err');
      $('pwd-old').focus();
      return;
    }
    // 与后端 PASSWORD_MIN_LENGTH 默认值保持一致；后端会再校验一次
    if (newPwd.length < 8) {
      showToast('新密码长度不能少于 8 位', 'err');
      return;
    }
    if (newPwd !== confirmPwd) {
      showToast('两次输入的新密码不一致', 'err');
      return;
    }
    if (!forced && newPwd === oldPwd) {
      showToast('新密码不能与原密码相同', 'err');
      return;
    }
    var btn = $('pwd-form').querySelector('button[type="submit"]');
    setButtonLoading(btn, true);
    // 强制改密不传 oldPassword：服务端按 must_change_password 判定，主动改密仍必须带
    var payload = { newPassword: newPwd, confirmPassword: confirmPwd };
    if (!forced) payload.oldPassword = oldPwd;
    api('/api/v1/auth/change-password', {
      method: 'POST',
      body: payload,
    })
      .then(function () {
        showToast('密码已更新', 'ok');
        $('pwd-modal').classList.add('hidden');
        $('pwd-modal').classList.remove('forced');
        if (state.user) state.user.mustChangePassword = false;
        return refreshSession();
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading(btn, false);
      });
  }

  function switchView(name) {
    if (!VIEW_META[name]) name = 'packages';
    // 越权/开关关闭的视图不允许通过 hash 或脚本直接进入
    if (!canSeeView(name)) {
      var fallback = visibleViews()[0] || 'packages';
      if (fallback !== name) {
        switchView(fallback);
        return;
      }
      if (!canSeeView(name)) return;
    }
    // 字典表单有未保存修改时先确认，避免点错菜单静默丢改动
    if (state.currentView === 'dictionary' && name !== 'dictionary' && dictDirty) {
      confirmAction({
        title: '放弃未保存的修改',
        message: '字典配置有未保存的修改，离开本页将丢失这些修改。',
        confirmText: '放弃修改并离开',
        tone: 'danger',
      }).then(function (ok) {
        if (!ok) return;
        dictDirty = false;
        switchView(name);
      });
      return;
    }
    state.currentView = name;
    // 切视图时清掉旧视图的分页参数，hash 只保留当前视图各分页器的状态
    Pagination.writeHash({ view: name }, { clearPaging: true });
    document.querySelectorAll('#nav .nav-item').forEach(function (btn) {
      var active = btn.getAttribute('data-view') === name;
      btn.classList.toggle('active', active);
      // aria-current 让读屏用户知道当前所在模块
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach(function (section) {
      section.classList.toggle('hidden', section.id !== 'view-' + name);
    });
    $('view-title').textContent = VIEW_META[name][0];
    document.title = VIEW_META[name][0] + ' · 源鉴';
    if (name === 'manual') loadManualContent();
    if (name === 'packages') loadPackages();
    if (name === 'missing') loadMissing();
    if (name === 'security') loadSecurity();
    if (name === 'audit') loadAudit();
    if (name === 'tokens') loadTokens();
    if (name === 'users') loadUsers();
    if (name === 'dictionary') loadDictionary();
    // 进入受扫描开关影响的视图时强制拉一次能力位：避免用户刚打开页面就切换，
    // 而 60s 轮询尚未触发时看到已过期的步骤条、校验卡或版本表「安全」列
    if (name === 'import' || name === 'security' || name === 'packages') {
      applyScanMode();
      refreshFeatures(true);
    }
  }

  /** 顶栏刷新按当前视图分发；导入页是纯本地流程，只提示不重载 */
  function refreshCurrentView() {
    var view = state.currentView;
    if (view === 'packages') return loadPackages();
    if (view === 'missing') return loadMissing();
    if (view === 'security') return loadSecurity();
    if (view === 'audit') return loadAudit();
    if (view === 'tokens') return loadTokens();
    if (view === 'users') return loadUsers();
    if (view === 'dictionary') return loadDictionary();
    if (view === 'manual') return loadManualContent({ force: true });
    if (view === 'import') showToast('导入批次保存在当前页面状态中，刷新不会丢失进度', 'info');
  }

  // ---------- 侧栏折叠 / 搜索 / 筛选 ----------

  var SIDEBAR_KEY = 'yj.sidebar.rail';
  function applySidebarRail(rail) {
    var shell = $('app-view');
    var btn = $('sidebar-toggle');
    shell.classList.toggle('rail', !!rail);
    if (btn) {
      btn.setAttribute('aria-expanded', rail ? 'false' : 'true');
      btn.title = rail ? '展开侧栏' : '折叠侧栏';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function initSidebar() {
    var rail = false;
    try {
      rail = localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch (e) {
      rail = false;
    }
    applySidebarRail(rail);
    var btn = $('sidebar-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = !$('app-view').classList.contains('rail');
      applySidebarRail(next);
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      } catch (e) {
        // 隐私模式下 localStorage 不可写，折叠状态只在本次会话生效
      }
    });
  }

  function updateClearButtons() {
    document.querySelectorAll('.field-clear[data-clear]').forEach(function (btn) {
      var input = $(btn.getAttribute('data-clear'));
      btn.classList.toggle('hidden', !input || !input.value);
    });
  }

  /** 输入停顿后自动检索，回车立即检索；避免每次敲键都打后端 */
  function bindSearch(id, run) {
    var input = $(id);
    if (!input) return;
    var timer = null;
    function trigger() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run();
    }
    input.addEventListener('input', function () {
      updateClearButtons();
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, 350);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        trigger();
      }
    });
  }

  var FILTER_RESET = {
    packages: [['pkg-search', ''], ['pkg-ecosystem', ''], ['pkg-include-deleted', false]],
    missing: [['missing-status', ''], ['missing-ecosystem', ''], ['missing-source', '']],
    security: [['sec-name', ''], ['sec-ecosystem', ''], ['sec-disposition', '']],
    advisories: [['adv-search', ''], ['adv-ecosystem', '']],
    audit: [['audit-action', ''], ['audit-token', ''], ['audit-result', '']],
  };

  function resetFilters(name) {
    (FILTER_RESET[name] || []).forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      // 复选框没有 value 语义，重置走 checked
      if (el.type === 'checkbox') el.checked = !!pair[1];
      else el.value = pair[1];
    });
    updateClearButtons();
    if (name === 'packages') {
      pagers.pkg.reset();
      loadPackages();
    } else if (name === 'missing') {
      pagers.missing.reset();
      loadMissing();
    } else if (name === 'security') {
      pagers.sec.reset();
      loadSecurityScans();
    } else if (name === 'advisories') {
      pagers.adv.reset();
      loadAdvisories();
    } else if (name === 'audit') {
      pagers.audit.reset();
      loadAudit();
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function focusPrimarySearch() {
    var map = {
      packages: 'pkg-search',
      security: 'sec-name',
      audit: 'audit-action',
      tokens: 'token-name',
      users: 'user-username',
    };
    var el = $(map[state.currentView] || '');
    if (!el) return;
    el.focus();
    if (typeof el.select === 'function') el.select();
  }

  function init() {
    refreshSession().catch(function (err) {
      state.user = null;
      state.permissions = [];
      showLogin();
      // 401 是未登录的正常路径，只有其它错误才需要提示
      if (err && err.status !== 401) reportError(err);
    });
  }

  // ---------- 包管理 ----------

  /** 包名分组头：默认收起，只在展开时按需拉版本明细，避免整页请求 */
  function renderPkgGroup(p) {
    // 删除/恢复都是版本级操作，入口在展开后的版本明细里；分组头只显示计数与折叠
    var meta = p.versionCount + ' 个版本';
    if (p.deletedVersionCount) meta += ' · ' + p.deletedVersionCount + ' 个已删除';
    meta += ' · ' + fmtTime(p.createdAt);
    return (
      '<article class="pkg-group" data-eco="' + esc(p.ecosystem) + '" data-name="' + esc(p.name) + '"' +
      ' data-deleted="' + (p.deletedVersionCount || 0) + '">' +
      '<div class="pkg-bar">' +
      '<button type="button" class="pkg-head" aria-expanded="false">' +
      '<svg class="icon caret" aria-hidden="true"><use href="#i-chevron-down"></use></svg>' +
      '<span class="pkg-name">' + esc(p.name) + '</span>' +
      '<span class="pill muted">' + esc(p.ecosystem) + '</span>' +
      '<span class="pkg-meta">' + meta + '</span>' +
      '<span class="pkg-toggle">展开</span>' +
      '</button>' +
      '</div>' +
      '<div class="pkg-body" hidden></div>' +
      '</article>'
    );
  }

  /**
   * 删除单个版本：二次确认 → 调用 API → 刷新列表。
   * 服务端还会按 uploader_id 再校验一次，前端的 canDelete 只用于隐藏入口，不是安全边界。
   */
  function deleteVersion(btn) {
    if (btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
    var versionId = btn.getAttribute('data-version-id');
    if (!versionId) return;
    var label = btn.getAttribute('data-version-label') || '该版本';
    var group = btn.closest('.pkg-group');
    // 管理员代删他人版本：提示这是代操作、会记审计，且原上传人仍可恢复
    var proxy = btn.getAttribute('data-proxy') === '1';
    confirmAction({
      title: proxy ? '代为删除版本' : '删除版本',
      message: '确认删除 ' + label + '？删除后立即从私有源下架，可在「含已删除」中恢复。' +
        (proxy ? '该版本由他人上传，删除属于代操作，会记入审计日志，原上传人可自行恢复。' : ''),
      confirmText: '删除',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      setButtonLoading(btn, true);
      api('/api/v1/packages/versions/' + encodeURIComponent(versionId), { method: 'DELETE' })
        .then(function () {
          showToast('已删除版本：' + label, 'ok');
          reloadKeepingGroup(group);
        })
        .catch(function (err) {
          setButtonLoading(btn, false);
          showToast('删除失败：' + ((err && err.message) || '请稍后重试'), 'err');
        });
    });
  }

  /** 恢复已删除的版本：仅上传者本人可见入口，服务端同样二次校验 */
  function restoreVersion(btn) {
    if (btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
    var versionId = btn.getAttribute('data-version-id');
    if (!versionId) return;
    var label = btn.getAttribute('data-version-label') || '该版本';
    var group = btn.closest('.pkg-group');
    // 管理员代恢复他人版本：明确告知这是代操作，且恢复后归属仍是原上传人
    var proxy = btn.getAttribute('data-proxy') === '1';
    confirmAction({
      title: proxy ? '代为恢复版本' : '恢复版本',
      message: '确认恢复 ' + label + '？恢复后将重新出现在私有源并可被安装。' +
        (proxy ? '该版本由他人上传，恢复属于代操作，会记入审计日志，归属仍是原上传人。' : ''),
      confirmText: '恢复',
    }).then(function (ok) {
      if (!ok) return;
      setButtonLoading(btn, true);
      api('/api/v1/packages/versions/' + encodeURIComponent(versionId) + '/restore', { method: 'POST' })
        .then(function () {
          showToast('已恢复版本：' + label, 'ok');
          reloadKeepingGroup(group);
        })
        .catch(function (err) {
          setButtonLoading(btn, false);
          showToast('恢复失败：' + ((err && err.message) || '请稍后重试'), 'err');
        });
    });
  }

  /**
   * 删除/恢复后重新拉列表：计数会变，必须整页刷新；但整页刷新会把分组收起，
   * 所以记住刚才操作的包，渲染完成后重新展开，省掉用户再点一次的麻烦。
   */
  function reloadKeepingGroup(group) {
    if (group) {
      state.pkgReopen = {
        eco: group.getAttribute('data-eco'),
        name: group.getAttribute('data-name'),
      };
    }
    loadPackages();
  }

  // 大包不读进内存：超过阈值走原生导航下载，小包走 blob 以便给出可靠的"下载完成"反馈
  var DOWNLOAD_BLOB_LIMIT = 50 * 1024 * 1024;

  /** 下载列：地址缺失时如实标注"不可用"，不给点了没反应的按钮 */
  function pkgDownloadCell(v) {
    if (!v.downloadUrl) return '<span class="muted small" title="该版本暂无可用下载">不可用</span>';
    return (
      '<button type="button" class="btn ghost small btn-download" ' +
      'data-download-url="' + esc(v.downloadUrl) + '" ' +
      'data-download-name="' + esc(v.filename || v.version || 'package') + '" ' +
      'title="下载 ' + esc(v.filename || '') + '（' + fmtSize(v.sizeBytes) + '）">' +
      '<svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg>下载</button>'
    );
  }

  /** 降级：原生导航触发下载，不受同源策略限制（拆分部署时 registry 在别的端口） */
  function fallbackDownload(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('已发起下载：' + (filename || '文件') + '，请在浏览器中确认', 'info');
  }

  /**
   * 版本下载：fetch → blob → 触发保存，全程带按钮 loading 与 toast 反馈。
   * - 重复点击：入口 busy 检查 + setButtonLoading 的 disabled，双保险
   * - 网络异常 / 跨域：TypeError（fetch 拿不到响应）降级到原生导航下载
   * - 大文件：Content-Length 超阈值同样降级，避免整包读进内存撑爆页面
   * - 业务错误（404 / JSON 错误信封）：如实报错，不降级
   */
  function downloadVersion(btn) {
    if (btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
    var url = btn.getAttribute('data-download-url');
    var filename = btn.getAttribute('data-download-name') || 'package';
    if (!url) {
      showToast('该版本暂无可用下载地址', 'warn');
      return;
    }
    setButtonLoading(btn, true);
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        var contentType = res.headers.get('content-type') || '';
        if (contentType.indexOf('application/json') !== -1) {
          // 端点回 JSON：多半是错误的信封，按业务失败处理
          return res.json().then(function (payload) {
            throw new Error((payload && (payload.message || payload.reason)) || '下载失败');
          });
        }
        if (!res.ok) throw new Error('下载失败（HTTP ' + res.status + '）');
        if (Number(res.headers.get('content-length') || 0) > DOWNLOAD_BLOB_LIMIT) {
          fallbackDownload(url, filename);
          return null;
        }
        return res.blob();
      })
      .then(function (blob) {
        if (!blob) return; // 已走降级分支
        var objectUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
        showToast('下载完成：' + filename, 'ok');
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          // fetch 没拿到响应：拆分部署跨域或网络异常，降级到原生导航
          fallbackDownload(url, filename);
        } else {
          showToast('下载失败：' + (err && err.message ? err.message : '未知错误'), 'err');
        }
      })
      .finally(function () {
        setButtonLoading(btn, false);
      });
  }

  // wheel 平台标签 → 展示用架构名。保留未识别标签原值，避免丢失信息。
  function archLabel(tag) {
    var t = String(tag || '').toLowerCase();
    if (t === 'any' || t === 'universal' || t === 'universal2') return '通用';
    if (/x86_64|amd64|win64/.test(t)) return 'x64';
    if (/aarch64|arm64/.test(t)) return 'arm64';
    if (/i[3-6]86|x86(?!_64)/.test(t)) return 'x86';
    if (/ppc64/.test(t)) return 'ppc64';
    if (/s390x/.test(t)) return 's390x';
    return String(tag);
  }

  // 把标签数组渲染成 pill 列表；空数组显示占位符。
  function pillList(values, empty) {
    if (!values || !values.length) return '<span class="muted small">' + esc(empty || '—') + '</span>';
    return '<span class="compat-tags">' +
      values.map(function (x) { return '<span class="pill muted">' + esc(x) + '</span>'; }).join('') +
      '</span>';
  }

  /** 从版本详情的 compatibility/metadata 推导架构与兼容 Python 版本 */
  function versionCompatibility(v) {
    var compat = v.compatibility || {};
    var meta = v.metadata || {};
    var tags = compat.wheelTags || {};
    // Python 版本：优先用服务端算好的 compatiblePython，回退到 wheel 标签自行解析（cp310 → 3.10）
    var py = compat.compatiblePython;
    if (!py || !py.length) {
      var pyTags = tags.python || meta.pythonTags || [];
      py = pyTags
        .map(function (tag) {
          var m = /^(?:cp|py)(\d)(\d+)$/.exec(String(tag));
          if (m) return m[1] + '.' + m[2];
          if (/^(?:cp|py)[23]$/.test(String(tag))) return String(tag).slice(2) + '.x';
          return null;
        })
        .filter(Boolean);
    }
    // 架构：wheel 平台标签；npm 无平台标签时按 engines.cpu 或标通用
    var platforms = tags.platform || meta.platformTags || [];
    var archs = platforms.length ? platforms.map(archLabel) : [];
    if (!archs.length && compat.engines && compat.engines.cpu) {
      archs = (Array.isArray(compat.engines.cpu) ? compat.engines.cpu : [compat.engines.cpu]).map(archLabel);
    }
    if (!archs.length) archs = ['通用'];
    // npm 包没有 Python 版本概念，用 Node 引擎要求替代，避免显示无关字段
    var nodeEngine = compat.engines && compat.engines.node;
    if (!py.length && !nodeEngine) py = [];
    var pyLabel = nodeEngine && !py.length ? ['Node ' + nodeEngine] : py;
    return { archs: archs, pythons: pyLabel };
  }

  /**
   * 版本行操作按钮：正常版本给「删除」，已删除版本给「恢复」。
   * 只有上传者本人能拿到入口；其他人的版本一个操作按钮都不渲染，只留下载。
   * 兜底仍在服务端：uploader_id 不匹配直接 403。
   */
  function versionActionButton(kind, v, label) {
    var isDelete = kind === 'delete';
    if (!(isDelete ? v.canDelete : v.canRestore)) return '';
    var text = isDelete ? '删除' : '恢复';
    // 不是自己的版本，只有管理员会看到按钮：这是代操作，文案要说清楚，别让人以为是自己的
    var proxy = v.uploadedByViewer === false;
    var title = (proxy ? '代为' + text + ' ' + label + '（他人上传）' : text + ' ' + label);
    return (
      '<button type="button" class="btn ghost small ' + (isDelete ? 'btn-version-delete' : 'btn-version-restore') + '" ' +
      'data-version-id="' + esc(v.id) + '" data-version-label="' + label + '"' +
      (proxy ? ' data-proxy="1"' : '') + ' title="' + title + '">' +
      '<svg class="icon" aria-hidden="true"><use href="#' + (isDelete ? 'i-trash' : 'i-refresh') + '"></use></svg>' +
      text + '</button>'
    );
  }

  function pkgVersionsTable(versions, ecosystem) {
    // PyPI 表头按用户习惯显示为 "Python版本"（首字母大写、无空格），单独取消表头统一的大写转换
    var compatTh = ecosystem === 'npm'
      ? '<th>Node 版本</th>'
      : '<th class="case-normal">Python版本</th>';
    // 漏洞校验关闭后没有校验记录，整列一起隐藏，避免留下一列无意义的占位
    var showSecurity = scanEnabled();
    var rows = (versions || [])
      .map(function (v) {
        var compat = versionCompatibility(v);
        var deleted = v.status === 'deleted';
        var blocked = v.status !== 'active' && !deleted;
        var label = esc(v.filename || v.version || '该版本');
        var actions;
        if (deleted) {
          actions = '<span class="pill err">已删除</span>' + versionActionButton('restore', v, label);
        } else if (blocked) {
          // 隔离/其它非 active 状态：交给安全校验流程处置，这里不提供下载与删除
          actions = '<span class="pill warn">已隔离</span>';
        } else {
          actions = pkgDownloadCell(v) + versionActionButton('delete', v, label);
        }
        return (
          '<tr' + (deleted ? ' class="row-deleted"' : '') +
          '><td class="mono">' + esc(v.version) + '</td><td class="mono">' + esc(v.filename) +
          '</td><td>' + fmtSize(v.sizeBytes) + '</td><td>' + pillList(compat.archs, '未知') +
          '</td><td>' + pillList(compat.pythons, '—') + '</td><td>' +
          esc(v.uploaderName || '-') + '</td>' +
          (showSecurity
            ? '<td>' +
              (hasPerm('security:read')
                ? '<button class="btn ghost small" data-version="' + esc(v.id) + '">校验详情</button>'
                : '<span class="muted small">-</span>') +
              '</td>'
            : '') +
          '<td class="row-actions">' + actions + '</td></tr>'
        );
      })
      .join('');
    var cols = showSecurity ? 8 : 7;
    return (
      '<div class="table-wrap"><table class="table"><thead><tr><th>版本</th><th>文件</th><th>大小</th><th>架构</th>' + compatTh +
      '<th>上传人</th>' + (showSecurity ? '<th>安全</th>' : '') + '<th>操作</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="' + cols + '"><span class="muted small">暂无版本信息</span></td></tr>') +
      '</tbody></table></div>'
    );
  }

  function loadPkgVersions(group) {
    var body = group.querySelector('.pkg-body');
    var params = new URLSearchParams({
      ecosystem: group.getAttribute('data-eco'),
      name: group.getAttribute('data-name'),
    });
    if (includeDeleted()) params.set('includeDeleted', '1');
    body.innerHTML = '<div class="empty is-loading">正在加载版本…</div>';
    api('/api/v1/packages/detail?' + params.toString())
      .then(function (detail) {
        body.innerHTML = pkgVersionsTable(detail.versions, group.getAttribute('data-eco'));
        // 卡片上写着「N 个已删除」但筛选没勾时，展开只会看到在用版本，
        // 这里补一句去路提示，否则用户会以为恢复入口丢了。
        var hiddenDeleted = Number(group.getAttribute('data-deleted') || 0);
        if (hiddenDeleted > 0 && !includeDeleted()) {
          body.insertAdjacentHTML(
            'beforeend',
            '<p class="pkg-hint">还有 ' + hiddenDeleted +
              ' 个已删除版本，勾选右上角「含已删除」后可查看并恢复。</p>',
          );
        }
        body.querySelectorAll('button[data-version]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openVersionScan(btn.getAttribute('data-version'));
          });
        });
        body.querySelectorAll('button.btn-download').forEach(function (btn) {
          btn.addEventListener('click', function () {
            downloadVersion(btn);
          });
        });
        group.dataset.loaded = '1';
      })
      .catch(function () {
        body.innerHTML =
          '<div class="empty is-error">版本加载失败。' +
          '<button type="button" class="btn small empty-action" data-version-retry>重新加载</button></div>';
        body.querySelector('[data-version-retry]').addEventListener('click', function () {
          loadPkgVersions(group);
        });
      });
  }

  function togglePkgGroup(group) {
    var open = !group.classList.contains('open');
    group.classList.toggle('open', open);
    group.querySelector('.pkg-head').setAttribute('aria-expanded', open ? 'true' : 'false');
    group.querySelector('.pkg-toggle').textContent = open ? '收起' : '展开';
    group.querySelector('.pkg-body').hidden = !open;
    if (open && !group.dataset.loaded) loadPkgVersions(group);
  }

  /** 列表重渲染后把刚才操作的包重新展开（删除/恢复后保持上下文） */
  function reopenPendingGroup() {
    var pending = state.pkgReopen;
    if (!pending) return;
    state.pkgReopen = null;
    var groups = $('pkg-list').querySelectorAll('.pkg-group');
    for (var i = 0; i < groups.length; i += 1) {
      var g = groups[i];
      if (g.getAttribute('data-eco') === pending.eco && g.getAttribute('data-name') === pending.name) {
        togglePkgGroup(g);
        return;
      }
    }
  }

  /** 是否连带展示已删除版本与仅剩已删除版本的包壳 */
  function includeDeleted() {
    var el = $('pkg-include-deleted');
    return !!(el && el.checked);
  }

  function loadPackages() {
    var pager = pagers.pkg;
    var q = $('pkg-search').value.trim();
    var eco = $('pkg-ecosystem').value;
    var params = new URLSearchParams({ page: String(pager.getPage()), pageSize: String(pager.getPageSize()) });
    if (q) params.set('q', q);
    if (eco) params.set('ecosystem', eco);
    if (includeDeleted()) params.set('includeDeleted', '1');
    var list = $('pkg-list');
    list.innerHTML = '<div class="empty is-loading">正在加载…</div>';
    pager.setLoading(true);
    setLoading(list, true);
    api('/api/v1/packages?' + params.toString())
      .then(function (data) {
        var items = applyPaged(pager, data, loadPackages);
        if (!items) return;
        list.innerHTML = items.map(renderPkgGroup).join('');
        $('pkg-empty').classList.toggle('hidden', items.length > 0);
        reopenPendingGroup();
      })
      .catch(function (err) {
        state.pkgReopen = null;
        list.innerHTML =
          '<div class="empty is-error">加载失败，请稍后重试。' +
          '<button type="button" class="btn small empty-action" id="pkg-retry">重新加载</button></div>';
        $('pkg-retry').addEventListener('click', loadPackages);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
        setLoading(list, false);
      });
  }

  // ---------- 批量导入 ----------

  function setStep(step) {
    document.querySelectorAll('#import-steps .step').forEach(function (el) {
      var n = Number(el.getAttribute('data-step'));
      el.classList.toggle('active', n === step);
      // 已完成步骤保留勾选态，形成可回看的进度轨迹
      el.classList.toggle('done', n < step);
    });
  }

  /** 免清单模式：后端从包文件自身识别包名/版本并直接建批次，之后沿用校验/入库 */
  function uploadAutoPackages() {
    if (!state.autoFiles.length) {
      showToast('请先选择包文件', 'err');
      return;
    }
    var form = new FormData();
    state.autoFiles.forEach(function (file) {
      form.append('files', file, file.name);
    });
    var box = $('auto-result');
    setLoading(box, true);
    api('/api/v1/import-batches/auto', { method: 'POST', formData: form })
      .then(function (data) {
        state.batchId = data.batchId;
        $('batch-id').textContent = '批次 ' + data.batchId.slice(0, 8);
        $('batch-id').classList.remove('hidden');
        var p = data.preview || {};
        var failed = data.failed || [];
        var ecoText = Object.keys(p.byEcosystem || {})
          .map(function (k) {
            return k + ' ' + p.byEcosystem[k] + ' 项';
          })
          .join(' / ');
        box.innerHTML =
          '<div>已识别 <b>' + (p.total || 0) + '</b> 个包（' + esc(ecoText) + '），新增版本 ' +
          (p.newCount || 0) + ' 个，已存在 ' + (p.existingCount || 0) + ' 个</div>' +
          (failed.length
            ? '<div class="reason warn">未识别 ' + failed.length + ' 个：<br>' +
              failed.map(function (f) {
                return esc(f.filename) + '：' + esc(f.reason);
              }).join('<br>') + '</div>'
            : '');
        box.classList.remove('hidden');
        $('import-empty').classList.add('hidden');
        $('commit-btn').disabled = true;
        // 关闭漏洞校验时不展示分步校验：上传后直接跑基础校验并入库，结果就地回显
        if (!scanEnabled()) {
          return autoIngestBatch(box, p, failed);
        }
        setStep(2);
        showToast('识别完成，可开始全量校验', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        setLoading(box, false);
      });
  }

  /** 扫描关闭的快速通道：validate（跳过六维扫描）+ commit(partial) 一次完成 */
  function autoIngestBatch(box, preview, failed) {
    var base = '/api/v1/import-batches/' + encodeURIComponent(state.batchId);
    if (!preview.total) {
      box.innerHTML =
        '<div class="reason warn">没有可入库的包，请检查文件格式后重新上传。</div>' +
        (failed.length
          ? '<div class="reason warn">未识别 ' + failed.length + ' 个：<br>' +
            failed.map(function (f) {
              return esc(f.filename) + '：' + esc(f.reason);
            }).join('<br>') + '</div>'
          : '');
      box.classList.remove('hidden');
      showToast('没有可入库的包', 'err');
      return Promise.resolve();
    }
    box.innerHTML =
      '<div class="empty is-loading">已识别 <b>' + (preview.total || 0) +
      '</b> 个包，正在完成基础校验并直接入库…</div>';
    box.classList.remove('hidden');
    return api(base + '/validate', { method: 'POST' })
      .then(function () {
        return api(base + '/commit', { method: 'POST', body: { mode: 'partial' } });
      })
      .then(function (result) {
        return api(base).then(function (batch) {
          renderAutoIngestResult(box, base, preview, failed, result.stats || {}, batch.items || []);
          showToast('已直接入库，可在「包管理」中查看', 'ok');
        });
      })
      .catch(function (err) {
        box.innerHTML =
          '<div class="reason warn">直接入库失败：' + esc((err && err.message) || '未知错误') +
          '。请检查包文件完整性后重试。</div>';
        box.classList.remove('hidden');
        reportError(err);
      });
  }

  /** 快速通道结果：不再有独立结果表，把统计、未识别项与逐条失败原因都收进上传卡 */
  function renderAutoIngestResult(box, base, preview, failed, stats, items) {
    var rejected = (items || []).filter(function (item) {
      return item.status === 'INVALID' || item.status === 'FAILED' || item.status === 'SKIPPED';
    });
    var statPills =
      '<div class="summary">' +
      '<span class="pill info">总计 ' + (stats.total || items.length || 0) + '</span>' +
      '<span class="pill ok">已入库 ' + (stats.committed || 0) + '</span>' +
      '<span class="pill err">失败 ' + (stats.failed || 0) + '</span>' +
      '<span class="pill muted">跳过 ' + (stats.skipped || 0) + '</span>' +
      '</div>';
    var failedBlock = failed.length
      ? '<div class="reason warn">未识别 ' + failed.length + ' 个：<br>' +
        failed.map(function (f) {
          return esc(f.filename) + '：' + esc(f.reason);
        }).join('<br>') + '</div>'
      : '';
    var rejectedBlock = rejected.length
      ? '<div class="reason warn"><b>未入库 ' + rejected.length + ' 个：</b><br>' +
        rejected.slice(0, 10).map(function (item) {
          var reason = (item.issues || []).map(function (issue) {
            return (issue.code || '') + ' ' + (issue.message || '');
          }).join('；');
          return esc(item.name + '@' + item.version) + '：' + esc(reason || statusText(item.status));
        }).join('<br>') + (rejected.length > 10 ? '<br>…另有 ' + (rejected.length - 10) + ' 个' : '') +
        '</div>'
      : '';
    box.innerHTML =
      '<div>已识别 <b>' + (preview.total || 0) + '</b> 个包，漏洞校验已关闭，基础校验后直接入库。</div>' +
      statPills + failedBlock + rejectedBlock +
      '<div class="row"><a class="btn ghost small" href="' + base + '/report?format=csv" target="_blank" rel="noopener">下载报告</a></div>';
    box.classList.remove('hidden');
  }

  function statusText(status) {
    var map = { INVALID: '校验失败', FAILED: '入库失败', SKIPPED: '已跳过' };
    return map[status] || status || '-';
  }

  function runValidate() {
    if (!state.batchId) {
      showToast('请先上传包文件并完成自动识别', 'err');
      return;
    }
    setLoading($('import-items'), true);
    setButtonLoading($('validate-btn'), true);
    api('/api/v1/import-batches/' + encodeURIComponent(state.batchId) + '/validate', { method: 'POST' })
      .then(function (data) {
        renderBatch(data.stats || {});
        return refreshBatchItems();
      })
      .then(function () {
        setStep(3);
        $('commit-btn').disabled = false;
        $('report-link').href =
          '/api/v1/import-batches/' + encodeURIComponent(state.batchId) + '/report?format=csv';
        $('report-link').classList.remove('hidden');
        showToast('校验完成，请查看逐条结果后入库', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('validate-btn'), false);
        setLoading($('import-items'), false);
      });
  }

  function runCommit() {
    if (!state.batchId) return;
    var mode = $('commit-mode').value;
    confirmAction({
      title: '确认批量入库',
      message: '将以 ' + mode + ' 模式把校验通过的包写入私有源。strict 模式下存在失败项会整体中止。',
      confirmText: '确认入库',
    }).then(function (ok) {
      if (!ok) return;
      setLoading($('import-items'), true);
      setButtonLoading($('commit-btn'), true);
      api('/api/v1/import-batches/' + encodeURIComponent(state.batchId) + '/commit', {
        method: 'POST',
        body: { mode: mode },
      })
        .then(function (data) {
          renderBatch(data.stats || {});
          return refreshBatchItems();
        })
        .then(function () {
          showToast('批量入库完成，可在「包管理」中查看', 'ok');
        })
        .catch(reportError)
        .finally(function () {
          setButtonLoading($('commit-btn'), false);
          setLoading($('import-items'), false);
        });
    });
  }

  function renderBatch(stats) {
    $('import-summary').innerHTML =
      '<span class="pill info">总计 ' + (stats.total || 0) + '</span>' +
      '<span class="pill ok">通过 ' + (stats.valid != null ? stats.valid : stats.committed || 0) + '</span>' +
      '<span class="pill err">失败 ' + (stats.invalid != null ? stats.invalid : stats.failed || 0) + '</span>' +
      (stats.warnings != null ? '<span class="pill warn">告警 ' + stats.warnings + '</span>' : '') +
      (stats.skipped != null ? '<span class="pill muted">跳过 ' + stats.skipped + '</span>' : '') +
      (stats.targetIssues && stats.targetIssues.length
        ? '<span class="pill warn">targets: ' + esc(stats.targetIssues.join(', ')) + '</span>'
        : '');
    $('import-summary').classList.remove('hidden');
  }

  function statusPill(status) {
    var map = {
      VALID: ['ok', '校验通过'],
      INVALID: ['err', '校验失败'],
      PENDING: ['muted', '待校验'],
      COMMITTED: ['ok', '已入库'],
      SKIPPED: ['muted', '已跳过'],
      FAILED: ['err', '入库失败'],
    };
    var item = map[status] || ['muted', status || '-'];
    return '<span class="pill ' + item[0] + '">' + esc(item[1]) + '</span>';
  }

  function refreshBatchItems() {
    if (!state.batchId) return Promise.resolve();
    return api('/api/v1/import-batches/' + encodeURIComponent(state.batchId)).then(function (batch) {
      var items = batch.items || [];
      $('import-items').querySelector('tbody').innerHTML = items
        .map(function (item) {
          var issues = (item.issues || [])
            .map(function (issue) {
              return esc((issue.code || '') + ' ' + (issue.message || ''));
            })
            .join('<br>');
          return (
            '<tr><td>' + item.itemNo + '</td><td>' + esc(item.name) + '</td><td class="mono">' + esc(item.version) +
            '</td><td>' + esc(item.ecosystem) + '</td><td>' + statusPill(item.status) +
            '</td><td class="small">' + (issues || '<span class="muted">-</span>') + '</td></tr>'
          );
        })
        .join('');
      $('import-empty').classList.toggle('hidden', items.length > 0);
      // 部分失败时保留入库按钮，便于切换 partial 模式重试
      var hasValid = items.some(function (item) {
        return item.status === 'VALID' || item.status === 'COMMITTED';
      });
      if (hasValid) $('commit-btn').disabled = false;
    });
  }

  // ---------- 缺失依赖 ----------

  function loadMissing() {
    var pager = pagers.missing;
    var params = new URLSearchParams({ page: String(pager.getPage()), pageSize: String(pager.getPageSize()) });
    if ($('missing-status').value) params.set('status', $('missing-status').value);
    if ($('missing-ecosystem').value) params.set('ecosystem', $('missing-ecosystem').value);
    if ($('missing-source') && $('missing-source').value) params.set('source', $('missing-source').value);
    var tbody = $('missing-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(6, 8);
    pager.setLoading(true);
    setLoading($('missing-table'), true);
    api('/api/v1/missing-dependencies?' + params.toString())
      .then(function (data) {
        var items = applyPaged(pager, data, loadMissing);
        if (!items) return;
        tbody.innerHTML = items
          .map(function (m) {
            var open = m.status === 'open';
            var canSupplement = hasPerm('missing:supplement');
            var sourceMap = { registry: '自动上报', ci: '项目上报', import: '批量导入' };
            var sourcePill = { registry: 'info', ci: '', import: 'warn' };
            var origin = m.source === 'registry'
              ? (m.requester_ip ? esc(m.requester_ip) : '自动探针')
              : esc(m.project_id || '-');
            return (
              '<tr><td class="mono">' + esc(m.normalized_name) + '</td><td>' + esc(m.ecosystem) +
              '</td><td class="mono">' + esc(m.version_spec) + '</td><td><span class="pill ' +
              (sourcePill[m.source] || '') + '">' + (sourceMap[m.source] || esc(m.source || 'ci')) +
              '</span></td><td>' + origin +
              '</td><td>' + m.hits + '</td><td>' +
              (open ? '<span class="pill err">待补充</span>' : '<span class="pill ok">已解决</span>') +
              '</td><td>' + (open && canSupplement
                ? '<button class="btn primary small" data-id="' + esc(m.id) + '" data-name="' + esc(m.normalized_name) +
                  '" data-eco="' + esc(m.ecosystem) + '">补充此包</button>'
                : '<span class="muted small">' + fmtTime(m.last_seen_at) + '</span>') +
              '</td></tr>'
            );
          })
          .join('');
        $('missing-empty').classList.toggle('hidden', items.length > 0);
        tbody.querySelectorAll('button[data-id]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openSupplement(btn.getAttribute('data-id'), btn.getAttribute('data-name'), btn.getAttribute('data-eco'));
          });
        });
      })
      .catch(function (err) {
        showTableError(tbody, 8, loadMissing);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
        setLoading($('missing-table'), false);
      });
  }

  function openSupplement(id, name, ecosystem) {
    $('supplement-id').value = id;
    $('supplement-name').value = name;
    $('supplement-version').value = '';
    $('supplement-python').value = '';
    $('supplement-file').value = '';
    $('supplement-python').closest('label').classList.toggle('hidden', ecosystem !== 'pypi');
    $('modal-title').textContent = '补充缺失包：' + name + '（' + ecosystem + '）';
    $('modal').classList.remove('hidden');
    $('supplement-file').focus();
  }

  function submitSupplement(event) {
    event.preventDefault();
    var id = $('supplement-id').value;
    var fileInput = $('supplement-file');
    if (!id || !fileInput.files.length) {
      showToast('请选择要上传的包文件', 'err');
      return;
    }
    var form = new FormData();
    form.append('file', fileInput.files[0], fileInput.files[0].name);
    if ($('supplement-name').value.trim()) form.append('name', $('supplement-name').value.trim());
    if ($('supplement-version').value.trim()) form.append('version', $('supplement-version').value.trim());
    if ($('supplement-python').value.trim()) form.append('requiresPython', $('supplement-python').value.trim());

    var submitBtn = $('supplement-form').querySelector('button[type="submit"]');
    setButtonLoading(submitBtn, true);
    api('/api/v1/missing-dependencies/' + encodeURIComponent(id) + '/supplement', {
      method: 'POST',
      formData: form,
    })
      .then(function () {
        $('modal').classList.add('hidden');
        showToast('补包成功，缺失记录已关闭', 'ok');
        loadMissing();
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading(submitBtn, false);
      });
  }

  // ---------- 安全校验 ----------

  var DIMENSION_META = [
    ['integrity', '格式与完整性'],
    ['malware', '恶意代码'],
    ['vulnerability', '已知漏洞'],
    ['permission', '权限风险'],
    ['secret', '敏感信息'],
    ['behavior', '行为风险'],
  ];

  var SEVERITY_META = {
    critical: ['err', '严重'],
    high: ['err', '高危'],
    medium: ['warn', '中危'],
    low: ['info', '低危'],
    none: ['info', '无风险'],
  };

  var DISPOSITION_META = {
    ALLOW: ['ok', 'ALLOW 通过'],
    WARN: ['warn', 'WARN 告警'],
    QUARANTINE: ['warn', 'QUARANTINE 隔离'],
    BLOCK: ['err', 'BLOCK 拦截'],
  };

  var SIGNATURE_META = {
    verified: ['ok', '已验证'],
    unsigned: ['debug', '未提供'],
    invalid: ['err', '验签失败'],
  };

  var DIM_STATUS_META = {
    pass: ['ok', '通过'],
    warn: ['warn', '告警'],
    fail: ['err', '不通过'],
    unknown: ['debug', '依据不足'],
  };

  var TRIGGER_META = { upload: '上传', rescan: '复检' };

  /** 结论/处置/签名/维度状态统一渲染为带等级图标的标签（info / warn / err / debug） */
  function metaPill(meta, value) {
    var item = meta[value] || ['debug', value || '-'];
    return '<span class="log-level ' + item[0] + '">' + esc(item[1]) + '</span>';
  }

  function loadSecurity() {
    loadSecurityOverview();
    loadSecurityScans();
    loadSecurityQuarantine();
    loadAdvisories();
  }

  function loadSecurityOverview() {
    api('/api/v1/security/overview')
      .then(function (data) {
        var counts = data.counts || {};
        var cards = [
          ['通过', counts.ALLOW || 0, 'ok'],
          ['告警', counts.WARN || 0, 'warn'],
          ['待复核隔离', data.pendingQuarantine || 0, 'warn'],
          ['已拦截', counts.BLOCK || 0, 'err'],
          ['漏洞库条目', data.advisories || 0, 'info'],
        ]
          .map(function (item) {
            return '<div class="sec-card ' + item[2] + '"><div class="sec-card-num">' + item[1] +
              '</div><div class="sec-card-label">' + esc(item[0]) + '</div></div>';
          })
          .join('');
        var last = data.lastRescan;
        var lastText = last
          ? '最近复检 ' + fmtTime(last.started_at) + '（扫描 ' + (last.scanned || 0) + ' 个版本，变化 ' +
            (last.changed || 0) + ' 个，新增隔离 ' + (last.quarantined || 0) + ' 个）'
          : '尚未执行定期复检';
        $('sec-overview').innerHTML = cards +
          '<div class="sec-policy">漏洞扫描：' + (data.scanEnabled === false ? '已关闭（字典管理）' : '开启') +
          ' · 拦截阈值：' + esc(data.blockSeverity || '-') +
          ' · 隔离阈值：' + esc(data.quarantineSeverity || '-') +
          ' · 签名校验：' + (data.signatureRequired ? '必需' : '可选') +
          ' · ' + esc(lastText) + '</div>';
        var eco = data.advisoriesByEcosystem || {};
        // 徽标只留总数，生态拆分放在下方键值行，避免同一组数字在卡片里出现两遍
        $('sec-advisory-count').textContent = '共 ' + (data.advisories || 0) + ' 条';
        renderAdvisoryStatus(data);
      })
      .catch(reportError);
  }

  /**
   * 漏洞库同步卡片的「库状态」区块：两块统计磁贴（导入时间 / 生态覆盖）+ 严重级别条形图。
   * 排查「为什么这个包从不命中漏洞」时，能直接看出库里有哪些档位、占比多少。
   */
  function renderAdvisoryStatus(data) {
    var eco = data.advisoriesByEcosystem || {};
    var sev = data.advisoriesBySeverity || {};
    var last = data.lastAdvisoryImport;
    var lastEl = $('sec-advisory-last');
    if (lastEl) {
      lastEl.textContent = last ? fmtTime(last.createdAt) : '尚未导入';
    }
    var srcEl = $('sec-advisory-source');
    if (srcEl) {
      srcEl.textContent = last
        ? (last.source || 'unknown') + ' · ' + (last.advisoryCount || 0) + ' 条' +
          (last.importedBy ? ' · ' + last.importedBy : '')
        : '—';
    }
    var ecoEl = $('sec-advisory-eco');
    if (ecoEl) {
      ecoEl.textContent =
        'npm ' + (eco.npm || 0) + ' · PyPI ' + (eco.pypi || 0) + ' · 跨生态 ' + (eco.wildcard || 0);
    }

    // 严重级别条形图：按占比画，缺省档位不占行
    var sevEl = $('sec-advisory-sev');
    if (!sevEl) return;
    var order = ['critical', 'high', 'medium', 'moderate', 'low', 'unknown'];
    var keys = order.filter(function (k) { return sev[k]; });
    if (!keys.length) {
      // 库里可能有 severity 用其他大小写/写法，统一兜底统计一次
      keys = Object.keys(sev).filter(function (k) { return sev[k]; });
    }
    if (!keys.length) {
      sevEl.innerHTML = '<div class="sec-sev-empty">尚未导入漏洞库，暂无级别分布。</div>';
      return;
    }
    var max = keys.reduce(function (m, k) { return Math.max(m, Number(sev[k]) || 0); }, 0) || 1;
    // class 名只认白名单：库里出现 CRITICAL / Moderate 之类写法时归一到已知档位，
    // 未识别的走中性色，避免拼出无效类名导致条形无色
    var SEV_CLASS = { critical: 'critical', high: 'high', medium: 'medium', moderate: 'medium', low: 'low' };
    sevEl.innerHTML = keys
      .map(function (k) {
        var n = Number(sev[k]) || 0;
        var pct = Math.max(3, Math.round((n / max) * 100));
        var cls = SEV_CLASS[String(k).toLowerCase()] || 'other';
        return (
          '<div class="sec-sev-row">' +
          '<span class="sec-sev-name">' + esc(k) + '</span>' +
          '<span class="sec-sev-track"><span class="sec-sev-bar ' + cls + '" style="width:' + pct + '%"></span></span>' +
          '<span class="sec-sev-count">' + n + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function loadSecurityScans() {
    var pager = pagers.sec;
    var params = new URLSearchParams({ page: String(pager.getPage()), pageSize: String(pager.getPageSize()) });
    var name = $('sec-name').value.trim();
    if (name) params.set('name', name);
    if ($('sec-ecosystem').value) params.set('ecosystem', $('sec-ecosystem').value);
    if ($('sec-disposition').value) params.set('disposition', $('sec-disposition').value);

    var tbody = $('sec-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(6, 9);
    pager.setLoading(true);
    setLoading($('sec-table'), true);
    api('/api/v1/security/scans?' + params.toString())
      .then(function (data) {
        var items = applyPaged(pager, data, loadSecurityScans);
        if (!items) return;
        tbody.innerHTML = items
          .map(function (s) {
            return (
              '<tr><td class="small nowrap">' + fmtTime(s.createdAt) + '</td><td class="mono">' +
              esc(s.name) + '@' + esc(s.version) + '</td><td>' + esc(s.ecosystem) + '</td><td>' +
              metaPill(SEVERITY_META, s.verdict) + '</td><td>' + metaPill(DISPOSITION_META, s.disposition) +
              '</td><td>' + s.riskScore + '</td><td>' + metaPill(SIGNATURE_META, s.signatureStatus) +
              '</td><td class="small">' + esc(TRIGGER_META[s.trigger] || s.trigger) +
              '</td><td><button class="btn ghost small" data-scan="' + esc(s.id) + '">详情</button></td></tr>'
            );
          })
          .join('');
        $('sec-empty').classList.toggle('hidden', items.length > 0);
        tbody.querySelectorAll('button[data-scan]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openScanDetail(btn.getAttribute('data-scan'));
          });
        });
      })
      .catch(function (err) {
        showTableError(tbody, 9, loadSecurityScans);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
        setLoading($('sec-table'), false);
      });
  }

  /** 隔离区：后端全量返回，前端本地分页 */
  function loadSecurityQuarantine() {
    var pager = pagers.quar;
    var tbody = $('sec-quarantine-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(5, 5);
    pager.setLoading(true);
    api('/api/v1/security/quarantine')
      .then(function (data) {
        $('sec-quarantine-count').textContent = '待复核 ' + ((data.items || []).length);
        var items = applyLocalPaged('quar', data.items || []);
        renderQuarantinePage(items);
      })
      .catch(function (err) {
        showTableError(tbody, 5, loadSecurityQuarantine);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
      });
  }

  function renderQuarantinePage(items) {
    var tbody = $('sec-quarantine-table').querySelector('tbody');
    var canManage = hasPerm('security:manage');
    tbody.innerHTML = items
      .map(function (s) {
        // 半宽卡片里放 5 列会把「放行/废弃」挤出可视区：包名与版本合并成一行，
        // 时间只留月-日时分，操作按钮去掉间隙，整体压到容器宽度内
        return (
          '<tr><td><span class="mono q-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="small muted q-ver">' + esc(s.version) + '</span></td>' +
          '<td>' + metaPill(SEVERITY_META, s.verdict) + '</td>' +
          '<td class="small nowrap" title="' + esc(fmtTime(s.createdAt)) + '">' + fmtDayTime(s.createdAt) +
          '</td><td class="q-actions">' +
          (canManage
            ? '<button class="btn ghost small" data-scan="' + esc(s.id) + '">详情</button>' +
              '<button class="btn small" data-release="' + esc(s.id) + '" data-label="' + esc(s.name + '@' + s.version) +
              '">放行</button>' +
              '<button class="btn small danger" data-discard="' + esc(s.id) + '" data-label="' + esc(s.name + '@' + s.version) +
              '">废弃</button>'
            : '<button class="btn ghost small" data-scan="' + esc(s.id) + '">详情</button>') +
          '</td></tr>'
        );
      })
      .join('');
    $('sec-quarantine-empty').classList.toggle('hidden', (pageCache.quar || []).length > 0);
    tbody.querySelectorAll('button[data-scan]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openScanDetail(btn.getAttribute('data-scan'));
      });
    });
    tbody.querySelectorAll('button[data-release]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        releaseQuarantine(btn.getAttribute('data-release'), btn.getAttribute('data-label'));
      });
    });
    tbody.querySelectorAll('button[data-discard]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        discardQuarantine(btn.getAttribute('data-discard'), btn.getAttribute('data-label'));
      });
    });
  }

  /** 漏洞库查询：服务端分页（q 模糊匹配包名/编号/标题，ecosystem 过滤） */
  function loadAdvisories() {
    var pager = pagers.adv;
    var params = new URLSearchParams({ page: String(pager.getPage()), pageSize: String(pager.getPageSize()) });
    var q = $('adv-search').value.trim();
    if (q) params.set('q', q);
    if ($('adv-ecosystem').value) params.set('ecosystem', $('adv-ecosystem').value);
    var tbody = $('adv-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(6, 9);
    pager.setLoading(true);
    setLoading($('adv-table'), true);
    api('/api/v1/security/advisories?' + params.toString())
      .then(function (data) {
        var items = applyPaged(pager, data, loadAdvisories);
        if (!items) return;
        tbody.innerHTML = items
          .map(function (a) {
            // ecosystem='*' 是跨生态条目：对 npm 与 pypi 同时生效，必须一眼看出
            var ecoCell = a.ecosystem === 'npm'
              ? 'npm'
              : a.ecosystem === 'pypi'
                ? 'PyPI'
                : '<span class="pill warn" title="跨生态条目：npm 与 PyPI 扫描都会命中">跨生态</span>';
            return (
              '<tr><td>' + esc(a.source) + '</td><td class="mono small">' + esc(a.advisory_id) +
              '</td><td class="small">' + ecoCell + '</td><td class="mono">' + esc(a.package_name) +
              '</td><td class="mono small">' + esc(a.affected_range) +
              '</td><td>' + metaPill(SEVERITY_META, a.severity) + '</td><td>' +
              (a.cvss == null ? '-' : a.cvss) + '</td><td class="mono small">' + esc(a.fixed_version || '-') +
              '</td><td class="small nowrap">' + fmtTime(a.published_at) + '</td></tr>'
            );
          })
          .join('');
        $('adv-empty').classList.toggle('hidden', items.length > 0);
      })
      .catch(function (err) {
        showTableError(tbody, 9, loadAdvisories);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
        setLoading($('adv-table'), false);
      });
  }

  function openVersionScan(versionId) {
    api('/api/v1/security/scans?versionId=' + encodeURIComponent(versionId) + '&pageSize=1')
      .then(function (data) {
        var item = (data.items || [])[0];
        if (!item) {
          showToast('该版本暂无安全校验记录（可能为历史入库数据）');
          return;
        }
        openScanDetail(item.id);
      })
      .catch(reportError);
  }

  function openScanDetail(id) {
    api('/api/v1/security/scans/' + encodeURIComponent(id))
      .then(function (scan) {
        $('scan-modal-title').textContent = scan.name + '@' + scan.version + ' · 安全校验详情';
        var dims = DIMENSION_META.map(function (pair) {
          var dim = (scan.dimensions || {})[pair[0]] || {};
          var status = DIM_STATUS_META[dim.status] || ['muted', dim.status || '-'];
          return (
            '<div class="dim-row"><div class="dim-name">' + esc(pair[1]) + '</div><div>' +
            '<span class="pill ' + status[0] + '">' + esc(status[1]) + '</span></div>' +
            '<div class="small muted">' + esc(dim.summary || '未执行') + '</div></div>'
          );
        }).join('');

        var findings = (scan.findings || []).map(function (f) {
          return (
            '<div class="finding"><div class="finding-head">' + metaPill(SEVERITY_META, f.severity) +
            ' <b>' + esc(f.title) + '</b> <span class="mono small muted">' + esc(f.ruleId) + '</span></div>' +
            '<div class="small muted">' + esc(f.dimensionLabel || f.dimension) +
            (f.location ? ' · 位置：' + esc(f.location) : '') + '</div>' +
            '<div class="small">' + esc(f.detail) + '</div>' +
            (f.evidence ? '<div class="small mono evidence">' + esc(f.evidence) + '</div>' : '') +
            '<div class="small fix">整改建议：' + esc(f.remediation) + '</div></div>'
          );
        }).join('');

        var reportBase = '/api/v1/security/scans/' + encodeURIComponent(scan.id) + '/report';
        $('scan-modal-body').innerHTML =
          '<div class="scan-meta">' +
          '<span>结论：' + metaPill(SEVERITY_META, scan.verdict) + '</span>' +
          '<span>处置：' + metaPill(DISPOSITION_META, scan.disposition) + '</span>' +
          '<span>风险分：' + scan.riskScore + '</span>' +
          '<span>签名：' + metaPill(SIGNATURE_META, scan.signatureStatus) + '</span>' +
          '<span>触发：' + esc(TRIGGER_META[scan.trigger] || scan.trigger) + '</span>' +
          '<span>耗时：' + scan.durationMs + ' ms</span>' +
          '<span>时间：' + fmtTime(scan.createdAt) + '</span>' +
          '</div>' +
          '<div class="small mono muted scan-hash">sha256：' + esc(scan.sha256) +
          (scan.traceId ? ' · traceId：' + esc(scan.traceId) : '') + '</div>' +
          '<div class="row"><a class="btn small" href="' + reportBase + '?format=json" target="_blank" rel="noopener">下载 JSON 报告</a>' +
          '<a class="btn small" href="' + reportBase + '?format=csv" target="_blank" rel="noopener">下载 CSV 报告</a></div>' +
          '<h4 class="sec-sub">六维校验结果</h4><div class="dim-list">' + dims + '</div>' +
          '<h4 class="sec-sub">风险明细（' + ((scan.findings || []).length) + '）</h4>' +
          (findings || '<div class="empty">未发现风险项</div>');
        $('scan-modal').classList.remove('hidden');
        $('scan-modal-close').focus();
      })
      .catch(reportError);
  }

  function releaseQuarantine(id, label) {
    confirmAction({
      title: '确认放行隔离包',
      message: '放行 ' + label + ' 后将写入私有源并可被依赖安装，请确保已完成人工复核。',
      confirmText: '确认放行',
      tone: 'primary',
    }).then(function (ok) {
      if (!ok) return;
      api('/api/v1/security/quarantine/' + encodeURIComponent(id) + '/release', { method: 'POST' })
        .then(function () {
          showToast('已放行 ' + label, 'ok');
          loadSecurity();
        })
        .catch(reportError);
    });
  }

  function discardQuarantine(id, label) {
    confirmAction({
      title: '废弃隔离包',
      message: '确认废弃 ' + label + '？隔离文件将被清理，该操作不可恢复。',
      confirmText: '确认废弃',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      api('/api/v1/security/quarantine/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          showToast('已废弃 ' + label, 'ok');
          loadSecurity();
        })
        .catch(reportError);
    });
  }

  function importAdvisories() {
    var input = $('sec-advisory-file');
    if (!input.files.length) {
      showToast('请先选择漏洞库 JSON 文件', 'err');
      return;
    }
    var form = new FormData();
    form.append('file', input.files[0], input.files[0].name);
    var btn = $('sec-advisory-import');
    setButtonLoading(btn, true);
    setLoading($('sec-advisory-result'), true);
    api('/api/v1/security/advisories/import', { method: 'POST', formData: form })
      .then(function (data) {
        var errors = data.errors || [];
        var skipped = data.skipped || 0;
        var hint = errors.length
          ? '<div class="reason">跳过 ' + skipped + ' 条：' + esc(errors.slice(0, 5).join('；')) + '</div>'
          : skipped > 0
            ? '<div class="reason warn">跳过 ' + skipped + ' 条：条目缺少编号或包名，未写入漏洞库</div>'
            : '<div class="reason warn">漏洞库已同步，建议立即执行一次全量复检</div>';
        $('sec-advisory-result').innerHTML =
          '<div>新增 <b>' + (data.imported || 0) + '</b> 条，更新 <b>' + (data.updated || 0) +
          '</b> 条，跳过 <b>' + skipped + '</b> 条</div>' + hint;
        $('sec-advisory-result').classList.remove('hidden');
        input.value = '';
        $('sec-advisory-picker').classList.remove('has-file');
        $('sec-advisory-picker').querySelector('.file-picker-text').textContent = '未选择 JSON 文件';
        showToast('漏洞库导入完成', 'ok');
        loadSecurityOverview();
        // 导入后漏洞库内容已变化，同步刷新下方查询表格
        loadAdvisories();
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading(btn, false);
        setLoading($('sec-advisory-result'), false);
      });
  }

  function runRescan() {
    confirmAction({
      title: '启动全量复检',
      message: '将对全部已入库版本重新执行六维扫描。命中高危的版本会被自动隔离，是否继续？',
      confirmText: '开始复检',
      tone: 'primary',
    }).then(function (ok) {
      if (!ok) return;
      var btn = $('sec-rescan');
      setButtonLoading(btn, true);
      setLoading($('sec-table'), true);
      api('/api/v1/security/rescan', { method: 'POST', body: {} })
        .then(function (data) {
          showToast(
            '复检完成：扫描 ' + (data.scanned || 0) + ' 个版本，变化 ' + (data.changed || 0) +
              ' 个，新增隔离 ' + (data.quarantined || 0) + ' 个',
            'ok',
          );
          loadSecurity();
        })
        .catch(reportError)
        .finally(function () {
          setButtonLoading(btn, false);
          setLoading($('sec-table'), false);
        });
    });
  }

  // ---------- 审计日志 ----------

  function loadAudit() {
    var pager = pagers.audit;
    var params = new URLSearchParams({ page: String(pager.getPage()), pageSize: String(pager.getPageSize()) });
    var action = $('audit-action').value.trim();
    var tokenName = $('audit-token').value.trim();
    if (action) params.set('action', action);
    if (tokenName) params.set('tokenName', tokenName);
    if ($('audit-result').value) params.set('result', $('audit-result').value);
    // CSV 导出与当前筛选一致，条数取当前每页条数与 100 的较大值，保证全量导出不打折
    $('audit-export').href = '/api/v1/audit-logs?format=csv&pageSize=' + Math.max(100, pager.getPageSize()) +
      (action ? '&action=' + encodeURIComponent(action) : '') +
      (tokenName ? '&tokenName=' + encodeURIComponent(tokenName) : '') +
      ($('audit-result').value ? '&result=' + $('audit-result').value : '');

    var tbody = $('audit-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(6, 7);
    pager.setLoading(true);
    setLoading($('audit-table'), true);
    api('/api/v1/audit-logs?' + params.toString())
      .then(function (data) {
        var items = applyPaged(pager, data, loadAudit);
        if (!items) return;
        tbody.innerHTML = items
          .map(function (log) {
            return (
              '<tr><td class="small nowrap">' + fmtTime(log.created_at) +
              // 操作人存的是内部 UUID，截断展示到前 8 位并保留 title 全值，避免折行拉高行高
              '</td><td class="mono" title="' + esc(log.actor_id || '') + '">' + esc(String(log.actor_id || '-').slice(0, 8)) +
              '</td><td class="small">' + (log.actor_token_name ? esc(log.actor_token_name) : '<span class="muted">-</span>') +
              '</td><td class="mono">' + esc(log.action) +
              '</td><td class="small nowrap" title="' + esc((log.resource_type || '') + (log.resource_id ? ' / ' + log.resource_id : '')) + '">' +
              esc(log.resource_type || '-') +
              (log.resource_id ? ' / ' + esc(String(log.resource_id).slice(0, 8)) : '') + '</td><td>' +
              (log.result === 'success' ? '<span class="log-level ok">success</span>' : '<span class="log-level err">' + esc(log.result) + '</span>') +
              '</td><td class="mono small nowrap">' + esc(String(log.trace_id || '').slice(0, 16)) + '</td></tr>'
            );
          })
          .join('');
        $('audit-empty').classList.toggle('hidden', items.length > 0);
      })
      .catch(function (err) {
        showTableError(tbody, 7, loadAudit);
        reportError(err);
      })
      .finally(function () {
        pager.setLoading(false);
        setLoading($('audit-table'), false);
      });
  }

  // ---------- 访问令牌 ----------

  /**
   * 令牌清单：管理员看到全部账号（含已吊销），普通用户只看到自己的。
   * 范围由后端按权限裁决，前端只用 scope 参数声明意图，越权请求会被 403 挡回。
   */
  function loadTokens() {
    var tbody = $('token-body');
    if (!tbody) return;
    var admin = isAdmin();
    var scope = tokenScope();
    // 「全部/仅我的」只有管理员能切；筛选条件（令牌名 + 状态）所有角色都能用
    if ($('token-scope')) $('token-scope').classList.toggle('hidden', !admin);
    if ($('token-filter')) {
      $('token-filter').placeholder = admin ? '按账号或令牌名过滤' : '按令牌名过滤';
      $('token-filter').setAttribute('aria-label', $('token-filter').placeholder);
    }
    if ($('token-list-title')) $('token-list-title').textContent = admin ? '令牌清单' : '我的访问令牌';
    tbody.innerHTML = Pagination.skeleton(admin ? 6 : 5, 5);
    pagers.token.setLoading(true);
    var url = '/api/v1/auth/tokens' + (scope === 'all' ? '?scope=all' : '');
    api(url)
      .then(function (data) {
        pageCache.tokenRaw = data.items || [];
        renderTokenList();
      })
      .catch(function (err) {
        showTableError(tbody, admin ? 6 : 5, loadTokens);
        reportError(err);
      })
      .finally(function () {
        pagers.token.setLoading(false);
      });
  }

  /** 令牌视图范围：只有管理员能切到 all，其余一律按 self 处理 */
  function tokenScope() {
    return isAdmin() && $('token-scope') ? $('token-scope').value : 'self';
  }

  /** 状态筛选：默认只看有效令牌，已吊销的收纳在「全部状态 / 已吊销」里 */
  function tokenStatus() {
    return $('token-status') ? $('token-status').value : 'active';
  }

  /**
   * 本地过滤（令牌名/归属账号 + 状态）：数据已全量在手，不走二次请求，
   * 避免每次输入都打后端，也避免刚吊销完的令牌还挂在「仅有效」视图里。
   */
  function tokenMatches(t) {
    var revoked = !!t.revoked_at;
    var st = tokenStatus();
    if (st === 'active' && revoked) return false;
    if (st === 'revoked' && !revoked) return false;
    var input = $('token-filter');
    var kw = input ? input.value.trim().toLowerCase() : '';
    if (!kw) return true;
    return [t.name, t.username, t.display_name, t.role, t.account_type].some(function (v) {
      return String(v == null ? '' : v).toLowerCase().indexOf(kw) !== -1;
    });
  }

  function renderTokenList() {
    if (!pagers.token) return;
    var raw = pageCache.tokenRaw || [];
    var filtered = raw.filter(tokenMatches);
    applyLocalPaged('token', filtered);
    renderTokensPage(pageSlice('token'));
    if ($('token-list-sub')) {
      var revokedCount = raw.filter(function (t) { return !!t.revoked_at; }).length;
      var text = '共 ' + raw.length + ' 个令牌 · 有效 ' + (raw.length - revokedCount);
      if (revokedCount) text += ' · 已吊销 ' + revokedCount;
      if (filtered.length !== raw.length) text += ' ｜ 当前显示 ' + filtered.length + ' 个';
      $('token-list-sub').textContent = text;
    }
  }

  function renderTokensPage(items) {
    var tbody = $('token-body');
    var showOwner = tokenScope() === 'all';
    if ($('token-owner-th')) $('token-owner-th').classList.toggle('hidden', !showOwner);
    tbody.innerHTML = items
      .map(function (t) {
        var revoked = !!t.revoked_at;
        // 吊销原因直接显示：运维排查时，「手动吊销」和「批量清理」对应完全不同的处理路径
        var reasonShort = { manual: '手动', bulk_revoke: '批量', admin_revoke: '管理员' }[t.revoke_reason] || '';
        // 归属账号：机器账号带 CI 标签，禁用账号标出来，避免管理员误判「令牌还有效」
        var owner = showOwner
          ? '<td class="small">' + esc(t.username) +
            (t.account_type === 'service' ? ' <span class="pill info">CI</span>' : '') +
            (t.user_status === 'disabled' ? ' <span class="pill warn">已禁用</span>' : '') +
            '</td>'
          : '';
        return (
          '<tr><td>' + esc(t.name) + '</td>' + owner +
          '<td class="small nowrap">' + fmtTime(t.created_at) +
          '</td><td class="small nowrap">' + fmtTime(t.last_used_at) + '</td><td>' +
          (revoked
            ? '<span class="pill muted">已吊销' + (reasonShort ? ' · ' + reasonShort : '') + '</span>'
            : '<span class="pill ok">有效</span>') +
          '</td><td>' + (revoked ? '' :
            '<button class="btn ghost small" data-hash="' + esc(t.token_hash) + '" data-owner="' +
            esc(t.username || '') + '" data-name="' + esc(t.name) + '">吊销</button>') +
          '</td></tr>'
        );
      })
      .join('');
    var empty = $('token-empty');
    if (empty) {
      empty.classList.toggle('hidden', (pageCache.token || []).length > 0);
      var rawCount = (pageCache.tokenRaw || []).length;
      if (!rawCount) empty.textContent = '尚无访问令牌。';
      else if (tokenStatus() === 'active') empty.textContent = '没有有效的令牌，已吊销的可切到「已吊销」查看。';
      else empty.textContent = '没有匹配的令牌，换个关键字试试。';
    }
    tbody.querySelectorAll('button[data-hash]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        revokeToken(btn.getAttribute('data-hash'), btn.getAttribute('data-owner'), btn.getAttribute('data-name'));
      });
    });
  }

  function createToken() {
    var name = $('token-name').value.trim();
    if (!name) {
      showToast('请填写令牌名称', 'err');
      return;
    }
    setButtonLoading($('token-create'), true);
    api('/api/v1/auth/tokens', { method: 'POST', body: { name: name } })
      .then(function (data) {
        $('token-result').innerHTML =
          '<div>令牌仅展示一次，请立即保存：</div>' +
          '<div class="token-line"><code>' + esc(data.token) + '</code>' +
          '<button type="button" class="btn small" data-copy="' + esc(data.token) +
          '" data-copy-label="访问令牌">复制</button></div>';
        $('token-result').classList.remove('hidden');
        $('token-name').value = '';
        showToast('令牌创建成功', 'ok');
        loadTokens();
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('token-create'), false);
      });
  }

  function revokeToken(hash, owner, name) {
    var mine = !owner || (state.user && owner === state.user.username);
    var label = name ? '令牌「' + name + '」' : '该令牌';
    confirmAction({
      title: mine ? '吊销访问令牌' : '吊销他人令牌',
      message: mine
        ? '确认吊销' + label + '？\n\n吊销后立即永久作废、无法恢复，使用它的 CLI / CI 会立刻失败，只能重新生成。'
        : '确认吊销账号「' + owner + '」的' + label + '？\n\n该令牌立即永久作废，重新启用账号也不会恢复；只想临时停用请改用「禁用账号」。',
      confirmText: '确认吊销',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      api('/api/v1/auth/tokens/' + encodeURIComponent(hash) + '/revoke', { method: 'POST' })
        .then(function () {
          showToast(mine ? '令牌已吊销' : '已吊销 ' + owner + ' 的令牌', 'ok');
          loadTokens();
        })
        .catch(reportError);
    });
  }

  // ---------- 用户管理（仅管理员） ----------

  /** 凭据（初始密码 / 令牌）只返回一次，统一用弹窗展示，避免明文留在列表页 */
  function showCredential(title, value, label, notice) {
    $('credential-title').textContent = title;
    $('credential-body').innerHTML =
      '<div>' + esc(label) + '仅展示一次，请立即保存并通过安全渠道传递：</div>' +
      '<div class="token-line"><code>' + esc(value) + '</code>' +
      '<button type="button" class="btn small" data-copy="' + esc(value) +
      '" data-copy-label="' + esc(label) + '">复制</button></div>' +
      (notice ? '<div class="small" style="margin-top:6px">' + esc(notice) + '</div>' : '');
    $('credential-modal').classList.remove('hidden');
  }

  function showInitialPassword(title, password, notice) {
    showCredential(title, password, '初始密码', notice);
  }

  function updateUser(id, patch, okMessage) {
    api('/api/v1/users/' + encodeURIComponent(id), { method: 'PATCH', body: patch })
      .then(function () {
        showToast(okMessage || '账号已更新', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        // 无论成败都重载：失败时（如管理员唯一保护）把控件恢复成服务端真实状态
        loadUsers();
      });
  }

  function resetUserPassword(id, username) {
    confirmAction({
      title: '重置账号密码',
      message: '确认重置账号 ' + username + ' 的密码？该用户所有登录态将立即失效，并需在下次登录时改密。',
      confirmText: '确认重置',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      api('/api/v1/users/' + encodeURIComponent(id) + '/reset-password', { method: 'POST' })
        .then(function (data) {
          showInitialPassword('已重置 ' + username + ' 的密码', data.initialPassword, data.notice);
        })
        .catch(reportError)
        .finally(function () {
          loadUsers();
        });
    });
  }

  /** 用户列表：后端全量返回，前端本地分页 */
  function loadUsers() {
    var tbody = $('users-table').querySelector('tbody');
    tbody.innerHTML = Pagination.skeleton(6, 8);
    pagers.user.setLoading(true);
    setLoading($('users-table'), true);
    api('/api/v1/users')
      .then(function (data) {
        var items = applyLocalPaged('user', data.items || []);
        renderUsersPage(items);
      })
      .catch(function (err) {
        showTableError(tbody, 8, loadUsers);
        reportError(err);
      })
      .finally(function () {
        pagers.user.setLoading(false);
        setLoading($('users-table'), false);
      });
  }

  function renderUsersPage(items) {
    var tbody = $('users-table').querySelector('tbody');
    tbody.innerHTML = items
      .map(function (u) {
        // 管理员账号唯一：内置管理员角色只读，其他账号也不能被提升为 admin
        var isAdmin = u.role === 'admin';
        var isService = u.accountType === 'service';
        var roleCell = isAdmin
          ? '<span class="pill info" title="管理员账号唯一，由系统初始化创建">admin</span>'
          : '<select class="input narrow" data-action="role" data-id="' + esc(u.id) +
            '" data-role="' + esc(u.role) + '" data-name="' + esc(u.username) + '">' +
            ['reader', 'developer']
              .map(function (r) {
                return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
              })
              .join('') + '</select>';
        var nameCell =
          '<span class="mono">' + esc(u.username) + '</span>' +
          (isService ? ' <span class="pill info" title="机器账号：不可登录控制台，仅支持访问令牌">CI</span>' : '');
        // 机器账号没有可用口令，凭据列直接说明它只能靠令牌
        // 令牌数必须与账号状态一起读：禁用只是「暂时不可用」，凭据仍然保留，
        // 重新启用会自动恢复；要永久断开必须显式吊销，两者在界面上不能混为一谈
        var tokenCount = u.activeTokenCount || 0;
        var credentialCell;
        if (isService) {
          // 数量并入 pill，避免窄屏下列宽不足把「2 个」拆成两行
          var serviceLabel = '仅令牌' + (u.status === 'active' && tokenCount > 0 ? ' ' + tokenCount : '');
          credentialCell =
            '<span class="pill info" title="机器账号没有口令，只能使用访问令牌">' + serviceLabel + '</span>' +
            (u.status === 'disabled' && tokenCount > 0
              ? ' <span class="pill warn" title="账号已禁用：令牌当前不可用但并未作废，重新启用账号后会自动恢复；要永久断开请点「吊销令牌」">' +
                tokenCount + ' 个未吊销</span>'
              : '');
        } else {
          credentialCell =
            (u.mustChangePassword ? '<span class="pill warn">待改密</span>' : '<span class="pill ok">已设置</span>') +
            (tokenCount > 0 ? ' <span class="small muted">' + tokenCount + ' 个</span>' : '');
        }
        var actions = '';
        if (!isAdmin) {
          actions +=
            '<button class="btn ghost small" data-action="toggle" data-id="' + esc(u.id) +
            '" data-status="' + esc(u.status) + '" data-name="' + esc(u.username) + '">' +
            (u.status === 'active' ? '禁用' : '启用') + '</button>';
          actions += isService
            ? '<button class="btn ghost small" data-action="issue" data-id="' + esc(u.id) +
              '" data-name="' + esc(u.username) + '">签发令牌</button>'
            : '<button class="btn ghost small danger" data-action="reset" data-id="' + esc(u.id) +
              '" data-name="' + esc(u.username) + '">重置密码</button>';
          // 只在真有令牌时出现，避免给无凭据的账号一个空操作
          if (tokenCount > 0) {
            actions +=
              '<button class="btn ghost small danger" data-action="revoke-all" data-id="' + esc(u.id) +
              '" data-name="' + esc(u.username) + '" data-count="' + tokenCount + '">吊销令牌</button>';
          }
        }
        return (
          '<tr><td>' + nameCell + '</td><td>' + esc(u.displayName || '-') +
          '</td><td>' + esc(u.email || '-') +
          '</td><td>' + roleCell + '</td><td>' +
          (u.status === 'active' ? '<span class="pill ok">启用</span>' : '<span class="pill muted">禁用</span>') +
          '</td><td>' + credentialCell +
          '</td><td class="nowrap">' + (isService ? '-' : fmtTime(u.passwordUpdatedAt)) +
          '</td><td class="row-actions">' + actions + '</td></tr>'
        );
      })
      .join('');
    $('users-empty').classList.toggle('hidden', (pageCache.user || []).length > 0);

    tbody.querySelectorAll('select[data-action="role"]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var id = sel.getAttribute('data-id');
        var username = sel.getAttribute('data-name') || '';
        var prev = sel.getAttribute('data-role') || '';
        var next = sel.value;
        if (next === prev) return;
        // 角色决定能不能发布/导入，误点一次就多一份写权限，必须先确认
        confirmAction({
          title: '调整账号角色',
          message:
            '确认把账号「' + username + '」的角色从 ' + prev + ' 调整为 ' + next + '？\n\n' +
            (next === 'developer'
              ? 'developer 可发布包、执行导入与补包。'
              : 'reader 只读：不能再发布包或执行导入。') +
            '调整立即生效，该账号的令牌权限同步变化。',
          confirmText: '确认调整',
        }).then(function (ok) {
          if (!ok) {
            // 取消后把下拉恢复成服务端真实值，避免界面显示一个并未保存的角色
            sel.value = prev;
            return;
          }
          updateUser(id, { role: next }, '角色已调整为 ' + next);
        });
      });
    });
    tbody.querySelectorAll('button[data-action="toggle"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var username = btn.getAttribute('data-name') || '';
        var current = btn.getAttribute('data-status');
        var next = current === 'active' ? 'disabled' : 'active';
        confirmAction({
          title: next === 'disabled' ? '禁用账号' : '启用账号',
          message:
            next === 'disabled'
              ? '确认禁用账号「' + username + '」？\n\n禁用后该账号所有登录态立即失效，名下令牌同时不可用；凭据不会作废，重新启用后自动恢复。'
              : '确认启用账号「' + username + '」？启用后该账号可重新登录，未吊销的令牌立即恢复可用。',
          confirmText: next === 'disabled' ? '确认禁用' : '确认启用',
          tone: next === 'disabled' ? 'danger' : 'primary',
        }).then(function (ok) {
          if (!ok) return;
          updateUser(id, { status: next }, next === 'disabled' ? '账号已禁用' : '账号已启用');
        });
      });
    });
    tbody.querySelectorAll('button[data-action="reset"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        resetUserPassword(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
      });
    });
    tbody.querySelectorAll('button[data-action="issue"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openIssueToken(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
      });
    });
    tbody.querySelectorAll('button[data-action="revoke-all"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        revokeAllAccountTokens(
          btn.getAttribute('data-id'),
          btn.getAttribute('data-name'),
          btn.getAttribute('data-count')
        );
      });
    });
  }

  /**
   * 批量吊销某账号全部令牌。
   * 文案必须与「禁用」形成对照：禁用可恢复，吊销不可恢复，
   * 这是运维最容易搞反的一步。
   */
  function revokeAllAccountTokens(userId, username, count) {
    confirmAction({
      title: '吊销全部令牌',
      message:
        '将永久作废「' + username + '」名下 ' + count + ' 个令牌，相关 CI 会立即失败，' +
        '且重新启用账号也不会恢复，只能重新签发。\n\n只想临时停用请改用「禁用」。',
      confirmText: '永久吊销',
      tone: 'danger',
    }).then(function (ok) {
      if (!ok) return;
      api('/api/v1/users/' + encodeURIComponent(userId) + '/tokens/revoke-all', { method: 'POST' })
        .then(function (data) {
          showToast('已永久吊销 ' + data.revoked + ' 个令牌', 'ok');
          loadUsers();
        })
        .catch(reportError);
    });
  }

  function createUser() {
    var username = $('user-username').value.trim();
    if (!username) {
      showToast('请输入用户名', 'err');
      return;
    }
    var accountType = $('user-type').value;
    setButtonLoading($('user-create'), true);
    api('/api/v1/users', {
      method: 'POST',
      body: {
        username: username,
        displayName: $('user-display').value.trim() || undefined,
        email: $('user-email').value.trim() || undefined,
        role: $('user-role').value,
        accountType: accountType,
      },
    })
      .then(function (data) {
        var isService = data.user.accountType === 'service';
        // 初始密码由管理员统一掌握，创建成功只反馈结果并关闭弹窗
        showToast('账号 ' + data.user.username + ' 创建成功', 'ok');
        $('user-username').value = '';
        $('user-display').value = '';
        $('user-email').value = '';
        $('user-type').value = 'human';
        $('user-role').value = 'reader';
        $('user-create-modal').classList.add('hidden');
        loadUsers();
        // 机器账号没有口令，创建完直接进入签发令牌，避免管理员再去列表里找
        if (isService) openIssueToken(data.user.id, data.user.username);
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('user-create'), false);
      });
  }

  // ---------- 机器账号：签发令牌 ----------

  var issueTarget = null;

  function openIssueToken(id, username) {
    issueTarget = { id: id, username: username };
    $('token-issue-modal-title').textContent = '为 ' + username + ' 签发令牌';
    // 账号名已带 ci- 前缀时不再重复拼，避免出现 ci-ci-xxx
    $('token-issue-name').value = username.indexOf('ci-') === 0 ? username : 'ci-' + username;
    $('token-issue-modal').classList.remove('hidden');
    $('token-issue-name').focus();
  }

  function issueToken() {
    if (!issueTarget) return;
    var name = $('token-issue-name').value.trim();
    if (!name) {
      showToast('请填写令牌名称', 'err');
      return;
    }
    setButtonLoading($('token-issue-confirm'), true);
    api('/api/v1/users/' + encodeURIComponent(issueTarget.id) + '/tokens', {
      method: 'POST',
      body: { name: name },
    })
      .then(function (data) {
        $('token-issue-modal').classList.add('hidden');
        showCredential('令牌已签发 · ' + issueTarget.username, data.token, '访问令牌', data.notice);
        showToast('令牌签发成功', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('token-issue-confirm'), false);
      });
  }

  // ---------- 批量建号 ----------

  function renderBatchResult(data) {
    var el = $('batch-user-result');
    var html =
      '<div class="small">共 ' + esc(data.total) + ' 行：成功 <b>' + esc(data.createdCount) +
      '</b>，失败 <b>' + esc(data.failedCount) + '</b></div>';

    if (data.created && data.created.length) {
      // 初始密码统一由管理员掌握，结果表不再逐行展示
      html +=
        '<div class="table-wrap" style="margin-top:10px"><table class="table"><thead><tr>' +
        '<th>行号</th><th>用户名</th><th>角色</th></tr></thead><tbody>' +
        data.created.map(function (item) {
          return '<tr><td>' + esc(item.row) + '</td><td class="mono">' + esc(item.username) +
            '</td><td>' + esc(item.role) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }
    if (data.failed && data.failed.length) {
      html +=
        '<div class="table-wrap" style="margin-top:10px"><table class="table"><thead><tr>' +
        '<th>行号</th><th>用户名</th><th>失败原因</th></tr></thead><tbody>' +
        data.failed.map(function (item) {
          return '<tr><td>' + esc(item.row) + '</td><td class="mono">' + esc(item.username) +
            '</td><td>' + esc(item.reason) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }
    if (data.notice) html += '<div class="small muted" style="margin-top:8px">' + esc(data.notice) + '</div>';
    el.innerHTML = html;
    el.classList.remove('hidden');
    el.scrollIntoView({ block: 'nearest' });
  }

  function uploadBatchUsers() {
    var input = $('batch-user-file');
    var file = input.files && input.files[0];
    if (!file) {
      showToast('请先选择 Excel 文件（.xlsx）', 'err');
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      showToast('仅支持 .xlsx 文件，请下载模板后填写', 'err');
      return;
    }
    var btn = $('batch-user-upload');
    var reader = new FileReader();
    reader.onload = function () {
      // 去掉 dataURL 前缀，只把 base64 传给后端解析
      var base64 = String(reader.result || '').replace(/^data:[^;]*;base64,/, '');
      setButtonLoading(btn, true);
      api('/api/v1/users/batch', { method: 'POST', body: { fileName: file.name, contentBase64: base64 } })
        .then(function (data) {
          renderBatchResult(data);
          if (data.createdCount > 0) loadUsers();
        })
        .catch(reportError)
        .finally(function () {
          setButtonLoading(btn, false);
        });
    };
    reader.onerror = function () {
      showToast('读取文件失败，请重试', 'err');
    };
    reader.readAsDataURL(file);
  }

  /** 模板走同源下载，浏览器自动带上会话 Cookie */
  function downloadBatchTemplate() {
    window.location.href = '/api/v1/users/batch/template';
  }

  // ---------- 字典管理（仅管理员） ----------

  // key → 服务端下发的条目元数据（type/min/max/label/unit），保存前校验用
  var dictMeta = {};
  var dictDirty = false;

  // 显示单位换算：unit 只影响输入框里的展示值，字典存储与业务计算始终用原始单位（字节）
  var DICT_UNIT_DIVISOR = { MB: 1024 * 1024 };
  /** 原始值（字节）→ 输入框显示值（如 MB） */
  function dictShownNumber(meta, n) {
    var divisor = meta && DICT_UNIT_DIVISOR[meta.unit];
    return divisor && typeof n === 'number' ? n / divisor : n;
  }
  /** 输入框显示值（如 MB）→ 原始值（字节），四舍五入到整字节 */
  function dictStoredNumber(meta, n) {
    var divisor = meta && DICT_UNIT_DIVISOR[meta.unit];
    return divisor ? Math.round(n * divisor) : n;
  }
  /** 去掉浮点误差：最多两位小数，整数不带小数点；非数字（如 boolean 基线）原样输出 */
  function dictNumText(n) {
    if (typeof n !== 'number') return String(n == null ? '' : n);
    return String(Math.round(n * 100) / 100);
  }

  /** 同步状态标签与保存按钮可用态；干净态禁用保存，避免无意义的重复提交 */
  function setDictDirty(on) {
    dictDirty = !!on;
    var badge = $('dict-status');
    if (badge) {
      badge.textContent = on ? '有未保存的修改' : '已同步';
      badge.className = 'pill ' + (on ? 'warn' : 'ok');
    }
    var btn = $('dict-save');
    if (btn && !btn.classList.contains('is-loading')) btn.disabled = !on;
  }

  /** 按服务端元数据渲染分组表单：boolean → 开关下拉，int → 数字输入框 */
  function renderDictionaryGroups(groups) {
    dictMeta = {};
    $('dict-groups').innerHTML = (groups || [])
      .map(function (g) {
        var rows = (g.items || [])
          .map(function (it) {
            dictMeta[it.key] = it;
            var control;
            if (it.type === 'boolean') {
              control =
                '<select class="input narrow" data-dict-key="' + esc(it.key) + '" aria-label="' + esc(it.label) + '">' +
                '<option value="true"' + (it.value === true ? ' selected' : '') + '>开启</option>' +
                '<option value="false"' + (it.value === false ? ' selected' : '') + '>关闭</option>' +
                '</select>';
            } else {
              // 有 unit 的项（上传上限）按显示单位换算，其余项保持原始数值
              var shownVal = dictNumText(dictShownNumber(it, it.value));
              var shownMin = it.min != null ? dictNumText(dictShownNumber(it, it.min)) : null;
              var shownMax = it.max != null ? dictNumText(dictShownNumber(it, it.max)) : null;
              control =
                '<input type="number" class="input narrow" data-dict-key="' + esc(it.key) +
                '" aria-label="' + esc(it.label) + '" value="' + esc(shownVal) + '"' +
                (shownMin != null ? ' min="' + esc(shownMin) + '"' : '') +
                (shownMax != null ? ' max="' + esc(shownMax) + '"' : '') +
                ' step="' + (it.unit ? 'any' : '1') + '" inputmode="' +
                (it.unit ? 'decimal' : 'numeric') + '" />';
            }
            // 只显示数据：环境基线与更新时间；配置项含义统一放在用户手册
            var hint =
              '环境基线：' +
              esc(dictNumText(dictShownNumber(it, it.defaultValue))) +
              (it.unit ? ' ' + esc(it.unit) : '') +
              (it.updatedAt ? ' · 更新于 ' + fmtTime(it.updatedAt) : '');
            return (
              '<div class="dict-row-label">' + esc(it.label) + '</div>' +
              '<div>' + control + '</div>' +
              '<div class="dict-hint">' + hint + '</div>'
            );
          })
          .join('');
        return (
          '<div class="card"><div class="card-head"><h3>' + esc(g.label) + '</h3></div>' +
          '<div class="dict-grid">' + rows + '</div></div>'
        );
      })
      .join('');
  }

  /** 有未保存修改时先确认再重载；force 用于确认后的实际拉取 */
  function loadDictionary(options) {
    var opts = options || {};
    if (dictDirty && !opts.force) {
      confirmAction({
        title: '放弃未保存的修改',
        message: '字典配置有未保存的修改，重新加载将丢失这些修改。',
        confirmText: '放弃修改',
        tone: 'danger',
      }).then(function (ok) {
        if (ok) loadDictionary({ force: true });
      });
      return;
    }
    var box = $('dict-groups');
    box.innerHTML = '<div class="empty is-loading">正在加载字典配置…</div>';
    $('dict-empty').classList.add('hidden');
    api('/api/v1/dictionary')
      .then(function (data) {
        var groups = data.groups || [];
        renderDictionaryGroups(groups);
        if (!groups.length) {
          $('dict-empty').textContent = '暂无字典配置项。';
          $('dict-empty').classList.remove('hidden');
        }
        setDictDirty(false);
      })
      .catch(function (err) {
        box.innerHTML = '';
        var empty = $('dict-empty');
        empty.innerHTML =
          '字典配置加载失败，请稍后重试。' +
          '<button type="button" class="btn small empty-action" id="dict-retry">重新加载</button>';
        empty.classList.remove('hidden');
        var retry = $('dict-retry');
        if (retry) retry.addEventListener('click', function () { loadDictionary({ force: true }); });
        reportError(err);
      });
  }

  /**
   * 收集并校验表单：整数项越界 / 非整数时标记 aria-invalid 并聚焦首个问题字段。
   * 服务端会再校验一遍（前端绕过不了），这里先拦住明显错误减少一次往返。
   */
  function collectDictionaryValues() {
    var values = {};
    var firstBad = null;
    var problem = '';
    document.querySelectorAll('#dict-groups [data-dict-key]').forEach(function (el) {
      var key = el.getAttribute('data-dict-key');
      var meta = dictMeta[key] || {};
      el.removeAttribute('aria-invalid');
      if (meta.type === 'boolean') {
        values[key] = el.value === 'true';
        return;
      }
      var n = Number(String(el.value).trim());
      var label = meta.label || key;
      // 有显示单位的项允许小数（如 200.5 MB），其余项仍要求整数
      var hasUnit = !!DICT_UNIT_DIVISOR[meta.unit];
      if (!Number.isFinite(n) || (!hasUnit && !Number.isInteger(n))) {
        el.setAttribute('aria-invalid', 'true');
        if (!firstBad) { firstBad = el; problem = label + (hasUnit ? ' 必须为数字' : ' 必须为整数'); }
        return;
      }
      // min/max 是原始单位（字节），先换算到显示单位再和输入框的值比较
      var min = dictShownNumber(meta, meta.min);
      var max = dictShownNumber(meta, meta.max);
      if (min != null && n < min) {
        el.setAttribute('aria-invalid', 'true');
        if (!firstBad) { firstBad = el; problem = label + ' 不能小于 ' + dictNumText(min); }
        return;
      }
      if (max != null && n > max) {
        el.setAttribute('aria-invalid', 'true');
        if (!firstBad) { firstBad = el; problem = label + ' 不能大于 ' + dictNumText(max); }
        return;
      }
      // 提交回服务端时换回原始单位（字节），后端校验与业务读取都不需要感知显示单位
      values[key] = dictStoredNumber(meta, n);
    });
    return { values: values, firstBad: firstBad, problem: problem };
  }

  /** 从保存响应中取某个字典项的生效值，供前端即时联动侧栏与导入形态 */
  function dictionaryValue(groups, key) {
    for (var i = 0; i < (groups || []).length; i++) {
      var items = groups[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j].key === key) return items[j].value;
      }
    }
    return undefined;
  }

  function saveDictionary() {
    var result = collectDictionaryValues();
    if (result.firstBad) {
      showToast(result.problem, 'err');
      result.firstBad.focus();
      return;
    }
    setButtonLoading($('dict-save'), true);
    var saved = false;
    api('/api/v1/dictionary', { method: 'PUT', body: { values: result.values } })
      .then(function (data) {
        saved = true;
        var groups = data.groups || [];
        renderDictionaryGroups(groups);
        // 管理员保存后本会话立即联动：关闭扫描后普通模块的入口与导入形态同步收敛
        var scan = dictionaryValue(groups, 'security.scanEnabled');
        if (typeof scan === 'boolean') applyFeatureState({ securityScanEnabled: scan });
        showToast('字典配置已保存，限流、漏洞扫描与保留清理策略已在全部服务进程生效', 'ok');
      })
      .catch(reportError)
      .finally(function () {
        setButtonLoading($('dict-save'), false);
        // 成功回到干净态（保存按钮禁用）；失败保留脏标记，已填修改不丢、可直接重试
        if (saved) setDictDirty(false);
      });
  }

  // ---------- 事件绑定 ----------

  function bindFileDrop(dropzoneId, inputId, multiple, onFiles) {
    var zone = $(dropzoneId);
    var input = $(inputId);
    function syncState(files) {
      // 选中文件后用实线高亮边框，明确“已就绪”而不是仍等待拖拽
      zone.classList.toggle('has-file', files.length > 0);
    }
    zone.addEventListener('click', function () {
      input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      syncState(files);
      onFiles(files);
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      if (!multiple && files.length > 1) files = [files[0]];
      syncState(files);
      onFiles(files);
    });
  }

  function bindEvents() {
    // 先固定内置手册基准，后续的服务端覆盖与「恢复默认」都以此为参照
    captureManualDefaults();

    // 挂载各视图分页组件：服务端分页的 onChange 重发请求，本地分页的 onChange 重切缓存
    pagers.pkg = Pagination.mount({ el: 'pkg-pager', view: 'packages', key: 'pkg', onChange: loadPackages });
    pagers.missing = Pagination.mount({ el: 'missing-pager', view: 'missing', key: 'mis', onChange: loadMissing });
    pagers.sec = Pagination.mount({ el: 'sec-pager', view: 'security', key: 'sec', onChange: loadSecurityScans });
    pagers.quar = Pagination.mount({
      el: 'sec-quarantine-pager',
      view: 'security',
      key: 'quar',
      onChange: function () {
        renderQuarantinePage(pageSlice('quar'));
      },
    });
    pagers.adv = Pagination.mount({ el: 'adv-pager', view: 'security', key: 'adv', onChange: loadAdvisories });
    pagers.audit = Pagination.mount({ el: 'audit-pager', view: 'audit', key: 'aud', onChange: loadAudit });
    pagers.token = Pagination.mount({
      el: 'token-pager',
      view: 'tokens',
      key: 'tok',
      onChange: function () {
        renderTokensPage(pageSlice('token'));
      },
    });
    pagers.user = Pagination.mount({
      el: 'users-pager',
      view: 'users',
      key: 'usr',
      onChange: function () {
        renderUsersPage(pageSlice('user'));
      },
    });

    $('login-form').addEventListener('submit', submitLogin);
    initSidebar();
    $('view-refresh').addEventListener('click', refreshCurrentView);

    // 主题切换：切换 html[data-theme]、同步 meta 与 aria，并持久化到 localStorage
    (function initTheme() {
      var toggle = $('theme-toggle');
      var meta = $('color-scheme');
      function syncAria() {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
        toggle.title = dark ? '切换到日间主题' : '切换到夜间主题';
      }
      syncAria();
      toggle.addEventListener('click', function () {
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var next = dark ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        if (meta) meta.setAttribute('content', next);
        try { localStorage.setItem('yj-theme', next); } catch (e) { /* 隐私模式忽略 */ }
        syncAria();
        showToast(next === 'dark' ? '已切换到夜间主题' : '已切换到日间主题', 'ok');
      });
    })();
    document.querySelectorAll('[data-reset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        resetFilters(btn.getAttribute('data-reset'));
      });
    });
    document.querySelectorAll('.field-clear[data-clear]').forEach(function (btn) {
      var input = $(btn.getAttribute('data-clear'));
      if (!input) return;
      btn.addEventListener('click', function () {
        input.value = '';
        updateClearButtons();
        // 复用 input 事件，保证清空后同样走“重置页码 + 重新查询”路径
        input.dispatchEvent(new Event('input'));
        input.focus();
      });
    });
    updateClearButtons();
    $('logout-btn').addEventListener('click', function () {
      api('/auth/logout', { method: 'POST' })
        .catch(function () {})
        .finally(function () {
          state.user = null;
          state.permissions = [];
          showLogin();
        });
    });
    $('pwd-open').addEventListener('click', function () {
      openPasswordModal(false);
    });
    $('pwd-close').addEventListener('click', closePasswordModal);
    $('pwd-form').addEventListener('submit', submitPasswordChange);
    $('pwd-modal').addEventListener('click', function (e) {
      if (e.target === $('pwd-modal')) closePasswordModal();
    });
    document.querySelectorAll('#nav .nav-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchView(btn.getAttribute('data-view'));
      });
    });
    // 用户手册目录由权限裁剪动态生成，用事件委托绑定；
    // scrollIntoView 定位避免锚点 hash 破坏分页器的 view 参数
    $('view-manual').addEventListener('click', function (e) {
      var link = e.target.closest('[data-scroll]');
      if (!link) return;
      var target = $(link.getAttribute('data-scroll'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 分组卡片用事件委托，展开/收起/删除/恢复都不需要重新绑定
    $('pkg-list').addEventListener('click', function (e) {
      var del = e.target.closest('.btn-version-delete');
      if (del) {
        deleteVersion(del);
        return;
      }
      var restore = e.target.closest('.btn-version-restore');
      if (restore) {
        restoreVersion(restore);
        return;
      }
      var head = e.target.closest('.pkg-head');
      if (head) togglePkgGroup(head.closest('.pkg-group'));
    });
    bindSearch('pkg-search', function () {
      // 搜索条件变化后原页码语义失效，回第 1 页再查
      pagers.pkg.reset();
      loadPackages();
    });
    $('pkg-ecosystem').addEventListener('change', function () {
      pagers.pkg.reset();
      loadPackages();
    });
    $('pkg-include-deleted').addEventListener('change', function () {
      pagers.pkg.reset();
      loadPackages();
    });
    $('scan-modal-close').addEventListener('click', function () {
      $('scan-modal').classList.add('hidden');
    });

    bindFileDrop('auto-drop', 'auto-files', true, function (files) {
      state.autoFiles = files;
      $('auto-result').innerHTML = files.length
        ? '已选择 ' + files.length + ' 个文件：' + files.map(function (f) { return esc(f.name); }).join('、')
        : '';
      $('auto-result').classList.remove('hidden');
    });
    $('auto-upload').addEventListener('click', uploadAutoPackages);
    $('validate-btn').addEventListener('click', runValidate);
    $('commit-btn').addEventListener('click', runCommit);

    $('missing-refresh').addEventListener('click', loadMissing);
    $('missing-status').addEventListener('change', function () {
      pagers.missing.reset();
      loadMissing();
    });
    $('missing-ecosystem').addEventListener('change', function () {
      pagers.missing.reset();
      loadMissing();
    });
    if ($('missing-source')) {
      $('missing-source').addEventListener('change', function () {
        pagers.missing.reset();
        loadMissing();
      });
    }
    $('modal-close').addEventListener('click', function () {
      $('modal').classList.add('hidden');
    });
    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) $('modal').classList.add('hidden');
    });
    $('supplement-form').addEventListener('submit', submitSupplement);

    $('audit-refresh').addEventListener('click', loadAudit);
    bindSearch('audit-action', function () {
      pagers.audit.reset();
      loadAudit();
    });
    bindSearch('audit-token', function () {
      pagers.audit.reset();
      loadAudit();
    });
    $('audit-result').addEventListener('change', function () {
      pagers.audit.reset();
      loadAudit();
    });

    $('token-create').addEventListener('click', createToken);
    $('token-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createToken();
    });
    // 管理员切换「全部 / 仅我的」：范围变了必须回第 1 页再拉，否则页码越界会空白
    $('token-scope').addEventListener('change', function () {
      $('token-filter').value = '';
      updateClearButtons();
      pagers.token.reset();
      loadTokens();
    });
    // 状态筛选纯本地：已吊销/有效都已在内存里，切筛选不需要再打后端
    $('token-status').addEventListener('change', function () {
      pagers.token.reset();
      renderTokenList();
    });
    bindSearch('token-filter', function () {
      pagers.token.reset();
      renderTokenList();
    });

    // 字典管理：表单控件由事件委托统一标记脏态，保存/重载走顶部按钮
    $('dict-groups').addEventListener('change', function () { setDictDirty(true); });
    $('dict-groups').addEventListener('input', function () { setDictDirty(true); });
    $('dict-save').addEventListener('click', saveDictionary);
    $('dict-reload').addEventListener('click', function () { loadDictionary(); });

    // 打开新建账号弹窗：清掉上次的批量结果与已选文件，避免残留干扰
    $('user-create-open').addEventListener('click', function () {
      var result = $('batch-user-result');
      result.classList.add('hidden');
      result.innerHTML = '';
      var input = $('batch-user-file');
      input.value = '';
      var picker = $('batch-user-picker');
      picker.classList.remove('has-file');
      picker.querySelector('.file-picker-text').textContent = '未选择文件';
      $('user-create-modal').classList.remove('hidden');
      // 每次打开都回到人员账号，避免上次选过机器账号后误建
      $('user-type').value = 'human';
      $('user-username').focus();
    });
    $('user-create-modal-close').addEventListener('click', function () {
      $('user-create-modal').classList.add('hidden');
    });
    $('user-create-modal').addEventListener('click', function (e) {
      if (e.target === $('user-create-modal')) $('user-create-modal').classList.add('hidden');
    });
    $('user-create').addEventListener('click', createUser);
    $('token-issue-close').addEventListener('click', function () {
      $('token-issue-modal').classList.add('hidden');
    });
    $('token-issue-modal').addEventListener('click', function (e) {
      if (e.target === $('token-issue-modal')) $('token-issue-modal').classList.add('hidden');
    });
    $('token-issue-confirm').addEventListener('click', issueToken);
    $('token-issue-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') issueToken();
    });
    $('credential-close').addEventListener('click', function () {
      $('credential-modal').classList.add('hidden');
      $('credential-body').innerHTML = '';
    });
    $('credential-modal').addEventListener('click', function (e) {
      // 明文凭据只在这一处出现，关闭即销毁 DOM，避免留在页面里被截图或翻源码拿到
      if (e.target === $('credential-modal')) {
        $('credential-modal').classList.add('hidden');
        $('credential-body').innerHTML = '';
      }
    });
    $('batch-user-upload').addEventListener('click', uploadBatchUsers);
    $('batch-user-template').addEventListener('click', downloadBatchTemplate);
    // 自定义文件选择器：把选中文件名回填到可视框内
    $('batch-user-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      var picker = this.closest('.file-picker');
      picker.classList.toggle('has-file', Boolean(file));
      picker.querySelector('.file-picker-text').textContent = file ? file.name : '未选择文件';
    });

    $('sec-refresh').addEventListener('click', loadSecurityScans);
    bindSearch('sec-name', function () {
      pagers.sec.reset();
      loadSecurityScans();
    });
    $('sec-ecosystem').addEventListener('change', function () {
      pagers.sec.reset();
      loadSecurityScans();
    });
    $('sec-disposition').addEventListener('change', function () {
      pagers.sec.reset();
      loadSecurityScans();
    });
    $('adv-refresh').addEventListener('click', loadAdvisories);
    bindSearch('adv-search', function () {
      pagers.adv.reset();
      loadAdvisories();
    });
    $('adv-ecosystem').addEventListener('change', function () {
      pagers.adv.reset();
      loadAdvisories();
    });
    $('sec-rescan').addEventListener('click', runRescan);
    $('sec-advisory-import').addEventListener('click', importAdvisories);
    // 自定义文件选择器：把选中文件名回填到可视框内
    $('sec-advisory-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      var picker = this.closest('.file-picker');
      picker.classList.toggle('has-file', Boolean(file));
      picker.querySelector('.file-picker-text').textContent = file ? file.name : '未选择 JSON 文件';
    });
    $('scan-modal-close').addEventListener('click', function () {
      $('scan-modal').classList.add('hidden');
    });
    $('scan-modal').addEventListener('click', function (e) {
      if (e.target === $('scan-modal')) $('scan-modal').classList.add('hidden');
    });

    // 用户手册编辑：入口与保存按钮由 applyManualVisibility 按角色显隐
    $('manual-edit-toggle').addEventListener('click', function () {
      setManualEditMode(!manualState.editMode);
    });
    $('manual-save').addEventListener('click', saveManualContent);
    $('manual-defaults').addEventListener('click', resetManualDefaults);
    document.addEventListener('input', function (e) {
      if (!e.target || !e.target.matches || !e.target.matches('textarea[data-manual-edit]')) return;
      var id = e.target.getAttribute('data-manual-edit');
      e.target.classList.toggle('manual-changed', e.target.value !== effectiveManualHtml(id));
    });

    // 确认弹窗：取消默认聚焦，降低回车误触危险操作的概率
    $('confirm-cancel').addEventListener('click', function () {
      settleConfirm(false);
    });
    $('confirm-ok').addEventListener('click', function () {
      settleConfirm(true);
    });
    $('confirm-modal').addEventListener('click', function (e) {
      if (e.target === $('confirm-modal')) settleConfirm(false);
    });

    // 一次性密钥 / 初始密码的复制按钮由事件委托处理，避免动态节点重复绑定
    document.addEventListener('click', function (e) {
      var target = e.target;
      var btn = target && target.closest ? target.closest('[data-copy]') : null;
      if (!btn) return;
      copyText(btn.getAttribute('data-copy'), btn.getAttribute('data-copy-label'));
    });

    // 全局快捷键：Esc 关闭最上层弹窗；“/” 聚焦当前视图搜索；“R” 刷新当前视图
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('confirm-modal').classList.contains('hidden')) {
          e.preventDefault();
          settleConfirm(false);
          return;
        }
        if (!$('user-create-modal').classList.contains('hidden')) {
          e.preventDefault();
          $('user-create-modal').classList.add('hidden');
          return;
        }
        if (!$('scan-modal').classList.contains('hidden')) {
          e.preventDefault();
          $('scan-modal').classList.add('hidden');
          return;
        }
        if (!$('modal').classList.contains('hidden')) {
          e.preventDefault();
          $('modal').classList.add('hidden');
          return;
        }
        if (!$('pwd-modal').classList.contains('hidden')) {
          e.preventDefault();
          closePasswordModal();
        }
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        focusPrimarySearch();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        refreshCurrentView();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    init();
  });
})();

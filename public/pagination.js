/* 控制台公共分页组件：统一页码/上下页/首末页/每页条数/跳转交互，支持省略折叠、加载态与 hash 同步 */
(function () {
  'use strict';

  var DEFAULT_PAGE_SIZES = [10, 20, 50, 100];
  var MAX_BUTTONS = 7; // 页码按钮数上限，超出时折叠为省略占位

  /** 解析 location.hash 为参数对象 */
  function readHash() {
    var params = {};
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return params;
    raw.split('&').forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx > 0) {
        params[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
      }
    });
    return params;
  }

  /**
   * 写 hash（replaceState 不产生浏览器历史，避免逐页回退）
   * 默认合并语义：保留其它分页器（如 security 视图下 scans/quarantine/advisories）的字段
   * opts.clearPaging=true 时先丢弃全部 *.page/*.size 字段（切换视图时清理旧视图参数）
   */
  function writeHash(patch, opts) {
    var params = readHash();
    if (opts && opts.clearPaging) {
      Object.keys(params).forEach(function (k) {
        if (k !== 'view' && !/\.(page|size)$/.test(k)) delete params[k];
      });
    }
    Object.keys(patch).forEach(function (k) {
      params[k] = patch[k];
    });
    var parts = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    });
    var url = location.pathname + location.search + (parts.length ? '#' + parts.join('&') : '');
    history.replaceState(null, '', url);
  }

  /**
   * 页码序列：总页数不多时全展示；过多时始终保留首末页 + 当前页邻域，其余折叠为 '...'
   */
  function pageList(page, pages) {
    if (pages <= MAX_BUTTONS) {
      var all = [];
      for (var i = 1; i <= pages; i++) all.push(i);
      return all;
    }
    if (page <= 4) return [1, 2, 3, 4, 5, '...', pages];
    if (page >= pages - 3) return [1, '...', pages - 4, pages - 3, pages - 2, pages - 1, pages];
    return [1, '...', page - 1, page, page + 1, '...', pages];
  }

  /**
   * 挂载分页组件
   * opts.el        容器元素或 id（必填）
   * opts.view      所属视图名：hash 的 view 段，匹配时刷新可恢复本分页器状态
   * opts.key       同视图内的唯一标识，hash 字段为 {key}.page / {key}.size
   * opts.pageSizes 每页条数可选项，默认 [10,20,50,100]
   * opts.onChange  页码或条数变化后的回调(page, pageSize)，由调用方发起数据加载
   */
  function mount(opts) {
    opts = opts || {};
    var el = typeof opts.el === 'string' ? document.getElementById(opts.el) : opts.el;
    if (!el) return null;
    var conf = {
      view: opts.view || '',
      key: opts.key || 'pg',
      pageSizes: opts.pageSizes && opts.pageSizes.length ? opts.pageSizes : DEFAULT_PAGE_SIZES,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : function () {},
    };

    var st = { page: 1, pageSize: conf.pageSizes.indexOf(20) !== -1 ? 20 : conf.pageSizes[0], total: 0, loading: false };

    // 刷新恢复：hash 指向本视图时沿用该分页器上次参数；pageSize 必须在可选项内，防手改变形
    var h = readHash();
    if (conf.view && h.view === conf.view) {
      var hp = parseInt(h[conf.key + '.page'], 10);
      var hs = parseInt(h[conf.key + '.size'], 10);
      if (hp >= 1) st.page = hp;
      if (hs > 0 && conf.pageSizes.indexOf(hs) !== -1) st.pageSize = hs;
    }

    function totalPages() {
      return st.total > 0 ? Math.max(1, Math.ceil(st.total / st.pageSize)) : 0;
    }

    function syncHash() {
      if (!conf.view) return;
      var patch = { view: conf.view };
      patch[conf.key + '.page'] = st.page;
      patch[conf.key + '.size'] = st.pageSize;
      writeHash(patch);
    }

    function render() {
      var pages = totalPages();
      // 无数据时整体隐藏，空态提示交由业务视图的 empty 区展示
      if (st.total <= 0) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }
      el.classList.remove('hidden');
      var buttons = pageList(st.page, pages)
        .map(function (item) {
          if (item === '...') return '<span class="pager-ellipsis">…</span>';
          var active = item === st.page;
          return (
            '<button type="button" class="pager-btn' + (active ? ' active' : '') +
            '" data-page="' + item + '" aria-label="第 ' + item + ' 页"' +
            (active || st.loading ? ' disabled' : '') + '>' + item + '</button>'
          );
        })
        .join('');
      var sizeOptions = conf.pageSizes
        .map(function (s) {
          return '<option value="' + s + '"' + (s === st.pageSize ? ' selected' : '') + '>' + s + '</option>';
        })
        .join('');
      el.innerHTML =
        '<div class="pager-info">共 <b>' + st.total + '</b> 条 · 第 ' + st.page + ' / ' + pages + ' 页</div>' +
        '<div class="pager-controls' + (st.loading ? ' loading' : '') + '">' +
        '<button type="button" class="pager-btn nav" data-act="first" title="首页" aria-label="首页"' +
        (st.page <= 1 || st.loading ? ' disabled' : '') + '>«</button>' +
        '<button type="button" class="pager-btn nav" data-act="prev" title="上一页" aria-label="上一页"' +
        (st.page <= 1 || st.loading ? ' disabled' : '') + '>‹</button>' +
        buttons +
        '<button type="button" class="pager-btn nav" data-act="next" title="下一页" aria-label="下一页"' +
        (st.page >= pages || st.loading ? ' disabled' : '') + '>›</button>' +
        '<button type="button" class="pager-btn nav" data-act="last" title="末页" aria-label="末页"' +
        (st.page >= pages || st.loading ? ' disabled' : '') + '>»</button>' +
        '</div>' +
        '<div class="pager-size">每页 <select class="pager-size-select" aria-label="每页条数"' +
        (st.loading ? ' disabled' : '') + '>' + sizeOptions + '</select> 条</div>' +
        // 只有一页时跳转无意义，隐藏跳转区
        (pages > 1
          ? '<div class="pager-jump">跳至 <input type="text" class="pager-jump-input" inputmode="numeric" placeholder="页码"' +
            (st.loading ? ' disabled' : '') + ' /> 页 <button type="button" class="pager-btn nav" data-act="jump"' +
            (st.loading ? ' disabled' : '') + '>跳转</button></div>'
          : '');
    }

    function goTo(page) {
      var pages = totalPages();
      if (page < 1 || page > pages || page === st.page || st.loading) return;
      st.page = page;
      syncHash();
      render();
      conf.onChange(st.page, st.pageSize);
    }

    /** 跳转输入校验：非正整数或越界时红框抖动提示，不发起跳转 */
    function applyJump() {
      var input = el.querySelector('.pager-jump-input');
      if (!input || input.disabled) return;
      var raw = input.value.trim();
      var n = /^[1-9]\d*$/.test(raw) ? parseInt(raw, 10) : 0;
      if (n < 1 || n > totalPages()) {
        input.classList.add('err');
        input.title = '请输入 1 - ' + totalPages() + ' 之间的页码';
        setTimeout(function () {
          input.classList.remove('err');
          input.title = '';
        }, 600);
        return;
      }
      input.value = '';
      goTo(n);
    }

    // 事件委托挂在容器上：内部 innerHTML 重绘不会造成重复绑定
    el.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.disabled || st.loading) return;
      if (btn.hasAttribute('data-page')) {
        goTo(parseInt(btn.getAttribute('data-page'), 10));
        return;
      }
      var act = btn.getAttribute('data-act');
      if (act === 'first') goTo(1);
      else if (act === 'prev') goTo(st.page - 1);
      else if (act === 'next') goTo(st.page + 1);
      else if (act === 'last') goTo(totalPages());
      else if (act === 'jump') applyJump();
    });

    el.addEventListener('change', function (e) {
      if (e.target.classList.contains('pager-size-select') && !st.loading) {
        st.pageSize = parseInt(e.target.value, 10);
        st.page = 1; // 条数变化后原页码语义失效，统一回第 1 页
        syncHash();
        render();
        conf.onChange(st.page, st.pageSize);
      }
    });

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('pager-jump-input')) {
        e.preventDefault();
        applyJump();
      }
    });

    render();

    return {
      /**
       * 数据加载完成后回填：
       * - total 必传；服务端分页时 page/pageSize 用响应实际值纠偏（防手改 hash 越界）
       * - 本地分页只传 total，当前页超出总页数时自动收敛
       */
      update: function (data) {
        data = data || {};
        if (data.pageSize && conf.pageSizes.indexOf(data.pageSize) !== -1) st.pageSize = data.pageSize;
        st.total = data.total || 0;
        var pages = totalPages();
        if (data.page && data.page >= 1) {
          // 总数为 0 时 pages 为 0，页码必须兜底到 1，否则空转非空会卡在第 0 页
          st.page = Math.max(1, Math.min(data.page, pages));
        } else if (st.page > pages) {
          st.page = Math.max(1, pages);
        }
        syncHash();
        render();
      },
      /** 筛选条件变化时回第 1 页（不触发 onChange，由调用方随后主动加载） */
      reset: function () {
        st.page = 1;
        syncHash();
        render();
      },
      /** 加载态：控件禁用 + 置灰 */
      setLoading: function (on) {
        st.loading = !!on;
        render();
      },
      getPage: function () {
        return st.page;
      },
      getPageSize: function () {
        return st.pageSize;
      },
      getTotal: function () {
        return st.total;
      },
    };
  }

  /** 表格骨架屏：数据返回前渲染占位行（cols 为列数，rows 为行数） */
  function skeleton(rows, cols) {
    var html = '';
    for (var r = 0; r < (rows || 6); r++) {
      html += '<tr class="skeleton-row">';
      for (var c = 0; c < (cols || 5); c++) html += '<td><div class="skeleton-cell"></div></td>';
      html += '</tr>';
    }
    return html;
  }

  window.Pagination = { mount: mount, skeleton: skeleton, readHash: readHash, writeHash: writeHash };
})();

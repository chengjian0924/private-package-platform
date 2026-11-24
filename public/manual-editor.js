/**
 * 用户手册所见即所得编辑器。
 *
 * 目标：管理员改手册不需要看 HTML —— 直接在正文上改字，用工具栏调段落格式与代码块，
 * 从文档/网页复制的内容（含 Markdown）粘贴进来会自动转成仓库既有的排版类名。
 *
 * 产出仍是 HTML 片段：服务端 manual-sanitize 会再走一遍白名单，前端这一步只做
 * 「把浏览器产生的脏标签收敛成语义标签」，两者职责不重叠。
 *
 * 依赖：无。仅用 document.execCommand —— 该 API 虽被标记废弃，但 Chrome/Edge/Firefox
 * 均长期支持，是内网控制台里唯一不需要引入第三方富文本库的可行方案。
 */
(function (global) {
  'use strict';

  /** 段落类：光标所在块用于判断当前格式 */
  var BLOCK_TAGS = {
    P: 1,
    H3: 1,
    H4: 1,
    LI: 1,
    PRE: 1,
    TD: 1,
    TH: 1,
    DIV: 1,
    BLOCKQUOTE: 1,
  };

  /** 手册里可用到的权限点：与 ROLE_PERMISSIONS 对齐，标注中文用途便于选择 */
  var PERMISSIONS = [
    ['package:publish', '发布 / 删除包'],
    ['import:run', '批量导入、上报缺失依赖'],
    ['missing:supplement', '自助补包'],
    ['security:read', '查看安全校验'],
    ['security:manage', '隔离区处置、复检'],
    ['audit:read', '审计日志'],
    ['user:manage', '用户管理'],
    ['token:manage', '访问令牌'],
    ['config:manage', '字典 / 配置管理'],
    ['package:read', '包查看（全角色）'],
  ];

  var HINT_TEXT = '粘贴 Markdown / 网页内容会自动转成排版';

  var BAR_HTML =
    '<div class="me-bar" role="toolbar" aria-label="排版工具栏">' +
    '<select class="me-select" data-me="block" aria-label="段落类型" title="段落类型">' +
    '<option value="p">正文</option>' +
    '<option value="expect">要点提示</option>' +
    '<option value="h4">小标题</option>' +
    '<option value="ol">编号步骤</option>' +
    '<option value="ul">项目符号</option>' +
    '<option value="pre">代码块</option>' +
    '</select>' +
    '<span class="me-sep" aria-hidden="true"></span>' +
    '<button type="button" class="me-btn me-bold" data-me="bold" title="加粗（Ctrl+B）" aria-label="加粗">B</button>' +
    '<button type="button" class="me-btn" data-me="code" title="行内代码" aria-label="行内代码">&lt;/&gt;</button>' +
    '<button type="button" class="me-btn" data-me="link" title="插入链接" aria-label="插入链接">链接</button>' +
    '<button type="button" class="me-btn" data-me="perm" title="限定该段可见权限" aria-label="限定可见权限">权限</button>' +
    '<span class="me-sep" aria-hidden="true"></span>' +
    '<button type="button" class="me-btn me-plain" data-me="clear" title="清除本段格式" aria-label="清除格式">清除格式</button>' +
    '<div class="me-hint">' + HINT_TEXT + '</div>' +
    '<div class="me-pop hidden" role="dialog" aria-label="工具面板"></div>' +
    '</div>' +
    '<div class="me-canvas" contenteditable="true" spellcheck="false" ' +
    'aria-label="正文编辑区"></div>';

  var HTML_KEEP = {
    P: 1, H3: 1, H4: 1, OL: 1, UL: 1, LI: 1, PRE: 1, CODE: 1,
    B: 1, STRONG: 1, I: 1, EM: 1, BR: 1, HR: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, A: 1, SMALL: 1,
  };

  // ---------- 基础工具 ----------

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function unwrap(node) {
    var parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  function hasBlockChild(node) {
    for (var i = 0; i < node.children.length; i += 1) {
      if (BLOCK_TAGS[node.children[i].tagName]) return true;
    }
    return false;
  }

  // ---------- Markdown 粘贴 ----------

  function mdInline(text) {
    var slots = [];
    var source = String(text).replace(/`([^`]+)`/g, function (m, code) {
      slots.push('<code>' + escapeHtml(code) + '</code>');
      return '\u0001' + (slots.length - 1) + '\u0001';
    });
    source = escapeHtml(source)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
        if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return label;
        return '<a href="' + escapeAttr(url) + '" target="_blank">' + label + '</a>';
      });
    return source.replace(/\u0001(\d+)\u0001/g, function (m, idx) {
      return slots[Number(idx)];
    });
  }

  function isTableRow(line) {
    return /^\s*\|.*\|\s*$/.test(line) || /^\s*[^|\s][^|]*\|/.test(line);
  }

  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(line);
  }

  function splitRow(line) {
    return line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map(function (cell) { return cell.trim(); });
  }

  function startsBlock(line) {
    return (
      /^\s*```/.test(line) ||
      /^\s*#{1,4}\s/.test(line) ||
      /^\s*[-*+]\s/.test(line) ||
      /^\s*\d+[.)]\s/.test(line) ||
      /^\s*>/.test(line) ||
      isTableRow(line)
    );
  }

  /** Markdown 子集 → 手册排版 HTML。够覆盖从 README / 文档站复制过来的常见写法。 */
  function mdToHtml(markdown) {
    var lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i += 1; continue; }

      // 代码围栏
      if (/^\s*```/.test(line)) {
        var buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push('<pre class="manual-code"><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 表格：表头 + 分隔行 + 数据行
      if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        var table = '<div class="table-wrap"><table class="table"><thead><tr>';
        head.forEach(function (cell) { table += '<th>' + mdInline(cell) + '</th>'; });
        table += '</tr></thead><tbody>';
        rows.forEach(function (row) {
          table += '<tr>';
          for (var c = 0; c < head.length; c += 1) {
            table += '<td>' + mdInline(row[c] || '') + '</td>';
          }
          table += '</tr>';
        });
        table += '</tbody></table></div>';
        out.push(table);
        continue;
      }

      // 标题：# 当章内大标题，## 及更深转成小标题
      var heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
      if (heading) {
        var level = heading[1].length;
        out.push(
          level <= 1
            ? '<h3>' + mdInline(heading[2]) + '</h3>'
            : '<h4 class="manual-sub">' + mdInline(heading[2]) + '</h4>',
        );
        i += 1;
        continue;
      }

      // 引用：手册里用「提示段」承接
      if (/^\s*>\s?/.test(line)) {
        var quoted = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<p class="manual-note">' + mdInline(quoted.join(' ')) + '</p>');
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ordered = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ordered.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i += 1;
        }
        out.push(
          '<ol class="manual-steps">' +
            ordered.map(function (item) { return '<li>' + mdInline(item) + '</li>'; }).join('') +
            '</ol>',
        );
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        var bullets = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          bullets.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i += 1;
        }
        out.push(
          '<ul class="manual-steps">' +
            bullets.map(function (item) { return '<li>' + mdInline(item) + '</li>'; }).join('') +
            '</ul>',
        );
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      // 普通段落
      var para = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
        para.push(lines[i].trim());
        i += 1;
      }
      if (para.length) out.push('<p class="manual-note">' + mdInline(para.join(' ')) + '</p>');
    }

    return out.join('');
  }

  function looksLikeMarkdown(text) {
    if (!text || text.length < 2) return false;
    if (/<\/?[a-z][^>]*>/i.test(text)) return false;
    return (
      /(^|\n)\s*(#{1,4}\s|[-*+]\s|\d+[.)]\s|```|\||>)/.test(text) ||
      /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(text)
    );
  }

  /** 网页/Word 复制来的 HTML：只留语义标签，属性只留链接地址，其余样式全丢。 */
  function sanitizePastedHtml(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var nodes = Array.prototype.slice.call(doc.body.querySelectorAll('*'));
    nodes.forEach(function (node) {
      if (!node.parentNode) return;
      var tag = node.tagName;

      if (!HTML_KEEP[tag]) {
        if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'BLOCKQUOTE') {
          if (hasBlockChild(node)) { unwrap(node); return; }
          var p = doc.createElement('p');
          p.className = 'manual-note';
          while (node.firstChild) p.appendChild(node.firstChild);
          node.parentNode.replaceChild(p, node);
          return;
        }
        unwrap(node);
        return;
      }

      var href = tag === 'A' ? node.getAttribute('href') : null;
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        node.removeAttribute(attr.name);
      });
      if (href && /^(https?:\/\/|mailto:|\/|#)/i.test(href)) {
        node.setAttribute('href', href);
        node.setAttribute('target', '_blank');
      }
    });
    return doc.body.innerHTML;
  }

  // ---------- 浏览器脏标签收敛 ----------

  function preText(pre) {
    var out = '';
    (function walk(node) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) {
          out += child.nodeValue;
          return;
        }
        if (child.nodeName === 'BR') {
          out += '\n';
          return;
        }
        var isBlock = child.nodeName === 'DIV' || child.nodeName === 'P';
        if (isBlock && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        walk(child);
        if (isBlock && out.charAt(out.length - 1) !== '\n') out += '\n';
      });
    })(pre);
    return out.replace(/\n+$/, '');
  }

  function convertSpan(span) {
    var style = (span.getAttribute('style') || '').toLowerCase();
    var keepBox = span.hasAttribute('data-manual-perm') || (span.className && span.className.trim());
    if (keepBox) {
      span.removeAttribute('style');
      return;
    }
    var bold = /font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(style);
    var mono = /font-family\s*:[^;]*(mono|consolas|menlo|courier)/.test(style);
    if (bold) {
      span.outerHTML = '<b>' + span.innerHTML + '</b>';
      return;
    }
    if (mono) {
      span.outerHTML = '<code>' + span.innerHTML + '</code>';
      return;
    }
    unwrap(span);
  }

  /**
   * 把编辑区里的内容收敛成手册可用的语义结构，返回 HTML 字符串。
   * 在克隆节点上做，避免改动用户正在看的 DOM（光标位置不会跳）。
   */
  function normalize(root) {
    // 点了「行内代码」但还没输入时用零宽空格占位，落库前必须清掉，
    // 否则数据库里会存下一串看不见的字符
    var cleanDoc = root.ownerDocument;
    var walker = cleanDoc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null, false);
    var textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(function (node) {
      if (node.nodeValue.indexOf('\u200b') !== -1) {
        node.nodeValue = node.nodeValue.replace(/\u200b/g, '');
      }
    });

    // 顶层裸文本包成段落，否则保存后会丢
    var loose = [];
    Array.prototype.forEach.call(root.childNodes, function (node) {
      if (node.nodeType === 3) {
        if (node.nodeValue.trim()) loose.push(node);
        else root.removeChild(node);
      }
    });
    loose.forEach(function (node) {
      var p = root.ownerDocument.createElement('p');
      p.className = 'manual-note';
      root.replaceChild(p, node);
      p.appendChild(node);
    });

    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (node) {
      if (!node.parentNode) return;
      var tag = node.tagName;

      if (tag === 'SPAN') { convertSpan(node); return; }
      if (tag === 'FONT' || tag === 'STYLE' || tag === 'SCRIPT') { unwrap(node); return; }

      if (tag === 'DIV') {
        node.removeAttribute('style');
        if (!hasBlockChild(node)) {
          var p = root.ownerDocument.createElement('p');
          if (node.hasAttribute('data-manual-perm')) {
            p.setAttribute('data-manual-perm', node.getAttribute('data-manual-perm'));
          }
          p.className = 'manual-note';
          while (node.firstChild) p.appendChild(node.firstChild);
          node.parentNode.replaceChild(p, node);
        }
        return;
      }

      if (tag === 'PRE') {
        node.removeAttribute('style');
        if (!node.className.trim()) node.className = 'manual-code';
        var codeChild = null;
        Array.prototype.forEach.call(node.children, function (child) {
          if (child.tagName === 'CODE') codeChild = child;
        });
        if (codeChild) {
          Array.prototype.forEach.call(node.children, function (child) {
            if (child !== codeChild) child.parentNode.removeChild(child);
          });
          codeChild.removeAttribute('style');
          codeChild.removeAttribute('class');
          codeChild.textContent = preText(node);
        } else {
          var text = preText(node);
          node.innerHTML = '<code>' + escapeHtml(text) + '</code>';
        }
        return;
      }

      // 其余标签：清掉内联样式与事件属性，保留语义属性
      node.removeAttribute('style');
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name === 'class' || name === 'href' || name === 'target' || name === 'title' ||
            name === 'data-manual-perm' || name === 'colspan' || name === 'rowspan') return;
        node.removeAttribute(attr.name);
      });
      if (tag === 'A') {
        var href = node.getAttribute('href') || '';
        if (!/^(https?:\/\/|mailto:|\/|#)/i.test(href)) {
          node.removeAttribute('href');
        } else {
          node.setAttribute('target', '_blank');
        }
      }
    });

    // 空的代码片段（占位后没输入就离开）不落库，否则会显示成一个空灰块
    Array.prototype.slice.call(root.querySelectorAll('code')).forEach(function (node) {
      var parent = node.parentElement;
      while (parent && parent !== root) {
        if (parent.tagName === 'PRE') return;
        parent = parent.parentElement;
      }
      if (!node.textContent) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    });

    // 代码块是块级元素：历史内容里若被包进 p/h4/li（早期 insertHTML 的遗留），提升到同级
    Array.prototype.slice.call(root.querySelectorAll('pre')).forEach(function (pre) {
      var parent = pre.parentNode;
      if (!parent || parent === root) return;
      if (!/^(P|H4|H3|LI|TD|TH)$/.test(parent.tagName)) return;
      if (parent.textContent.trim() === pre.textContent.trim() && parent.children.length === 1) {
        parent.parentNode.replaceChild(pre, parent);
      } else {
        parent.parentNode.insertBefore(pre, parent.nextSibling);
      }
    });

    // 段落内不应出现块级元素（历史数据或浏览器命令造成的非法嵌套），提升到同级
    Array.prototype.slice.call(root.querySelectorAll('p, h3, h4')).forEach(function (host) {
      if (!host.parentNode) return;
      var blocks = Array.prototype.filter.call(host.children, function (child) {
        return /^(OL|UL|PRE|TABLE|DIV)$/.test(child.tagName);
      });
      if (!blocks.length) return;
      var anchor = host;
      blocks.forEach(function (block) {
        anchor.parentNode.insertBefore(block, anchor.nextSibling);
        anchor = block;
      });
      if (!host.textContent.trim()) host.parentNode.removeChild(host);
    });

    // 补齐手册排版类名
    Array.prototype.forEach.call(root.querySelectorAll('p'), function (p) {
      if (!p.className.trim()) p.className = 'manual-note';
    });
    Array.prototype.forEach.call(root.querySelectorAll('ol, ul'), function (list) {
      if (!list.className.trim()) list.className = 'manual-steps';
    });
    Array.prototype.forEach.call(root.querySelectorAll('h4'), function (h) {
      if (!h.className.trim()) h.className = 'manual-sub';
    });
    Array.prototype.forEach.call(root.querySelectorAll('h3'), function (h) {
      h.className = '';
    });

    // 清掉空段落与行尾换行残留
    Array.prototype.slice.call(root.querySelectorAll('p')).forEach(function (p) {
      var text = (p.textContent || '').replace(/\u00a0/g, ' ').trim();
      var onlyBreak = p.children.length === 1 && p.children[0].tagName === 'BR';
      if ((!text && !p.querySelector('img,table,code,br')) || (onlyBreak && p.innerHTML === '<br>')) {
        if (p.parentNode) p.parentNode.removeChild(p);
        return;
      }
      if (p.lastChild && p.lastChild.nodeName === 'BR') p.removeChild(p.lastChild);
    });

    return root.innerHTML.replace(/&nbsp;/g, ' ').trim();
  }

  // ---------- 选区与命令 ----------

  function placeCaretAtEnd(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    var sel = global.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function attach(section, options) {
    if (section.__me) return section.__me;
    var opts = options || {};
    var doc = section.ownerDocument;

    var wrap = doc.createElement('div');
    wrap.className = 'manual-edit-area';
    wrap.innerHTML = BAR_HTML;

    var canvas = wrap.querySelector('.me-canvas');
    canvas.setAttribute('aria-label', (opts.title || '章节') + ' 正文编辑区');
    canvas.innerHTML = opts.html || '';

    // 原只读正文搬走，编辑期只保留一份内容
    Array.prototype.slice.call(section.children).forEach(function (child) {
      if (child.classList.contains('card-head')) return;
      if (child.classList.contains('manual-edit-area')) return;
      child.parentNode.removeChild(child);
    });
    section.appendChild(wrap);

    var bar = wrap.querySelector('.me-bar');
    var select = wrap.querySelector('[data-me="block"]');
    var pop = wrap.querySelector('.me-pop');
    var hint = wrap.querySelector('.me-hint');
    var hintTimer = null;
    var cleanups = [];
    var inst = { section: section, wrap: wrap, canvas: canvas, cleanups: cleanups };
    section.__me = inst;
    cleanups.push(function () {
      if (hintTimer) global.clearTimeout(hintTimer);
      hintTimer = null;
    });

    function closePop() {
      pop.classList.add('hidden');
      pop.innerHTML = '';
    }

    function currentBlock(explicitNode) {
      var node = explicitNode || null;
      if (!node) {
        var sel = global.getSelection();
        if (!sel || !sel.rangeCount) return null;
        node = sel.getRangeAt(0).startContainer;
      }
      return blockOf(node);
    }

    /** 从任意节点往上找最近的块级容器（停在编辑区边界） */
    function blockOf(node) {
      while (node && node !== canvas) {
        if (node.nodeType === 1 && BLOCK_TAGS[node.tagName]) return node;
        node = node.parentNode;
      }
      return null;
    }

    /** 往上找最近的指定标签（限编辑区内） */
    function closestTag(node, tagName) {
      while (node && node !== canvas) {
        if (node.nodeType === 1 && node.tagName === tagName) return node;
        node = node.parentNode;
      }
      return null;
    }

    function syncSelect() {
      var block = currentBlock();
      var value = 'p';
      if (block) {
        var tag = block.tagName;
        if (tag === 'PRE') value = 'pre';
        else if (tag === 'H4') value = 'h4';
        else if (tag === 'H3') value = 'h4';
        else if (tag === 'LI') {
          value = block.parentNode && block.parentNode.tagName === 'OL' ? 'ol' : 'ul';
        } else if (tag === 'P') {
          value = block.className.indexOf('manual-expect') !== -1 ? 'expect' : 'p';
        } else if (tag === 'DIV' || tag === 'TD' || tag === 'TH') {
          value = 'p';
        }
      }
      select.value = value;
    }

    /**
     * 工具栏按钮会抢焦点，focus 时浏览器可能把光标复位到编辑区开头。
     * 统一在这里保存/恢复选区，所有排版命令都在 withCaret 内执行。
     */
    function withCaret(action) {
      var sel = global.getSelection();
      var range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      canvas.focus();
      if (range && sel && canvas.contains(range.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return action();
    }

    function applyBlock(kind) {
      withCaret(function () {
        var block = currentBlock();

        if (kind === 'pre') {
          // 代码块是块级元素：只替换整个段落，不能用 insertHTML 塞进 p/h4 内部
          if (!block || block.tagName === 'PRE') return;
          var text = block.textContent || '';
          if (!text.trim()) return;
          var pre = doc.createElement('pre');
          pre.className = 'manual-code';
          var code = doc.createElement('code');
          code.textContent = text;
          pre.appendChild(code);
          if (block.tagName === 'LI') {
            block.innerHTML = '';
            block.appendChild(pre);
          } else if (block.parentNode) {
            block.parentNode.replaceChild(pre, block);
          }
          placeCaretAtEnd(code);
          return;
        }

        if (kind === 'ol' || kind === 'ul') {
          var inList = block && block.tagName === 'LI' && block.parentNode;
          var alreadyOrdered = inList && block.parentNode.tagName === 'OL';
          var alreadyBullet = inList && block.parentNode.tagName === 'UL';
          if ((kind === 'ol' && alreadyOrdered) || (kind === 'ul' && alreadyBullet)) return;
          doc.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
          var after = currentBlock();
          if (after && after.tagName === 'LI' && after.parentNode) {
            var list = after.parentNode;
            list.className = 'manual-steps';
            // execCommand 可能把列表塞进段落内部，这里提到同级
            var host = list.parentNode;
            if (host && /^(P|H4|H3)$/.test(host.tagName)) {
              if (!host.textContent.trim()) {
                host.parentNode.replaceChild(list, host);
              } else {
                host.parentNode.insertBefore(list, host.nextSibling);
              }
            }
          }
          return;
        }

        var map = {
          p: { tag: 'P', className: 'manual-note' },
          expect: { tag: 'P', className: 'manual-expect' },
          h4: { tag: 'H4', className: 'manual-sub' },
        };
        var target = map[kind];
        if (!target) return;
        var wasPre = block && block.tagName === 'PRE';
        doc.execCommand('formatBlock', false, target.tag);
        var next = currentBlock();
        if (next) {
          next.className = target.className;
          // 代码块降级成普通段落时，把内层 code 解包，否则正文会一直显示等宽
          if (wasPre) {
            var codeEl = next.querySelector('code');
            if (codeEl && next.children.length === 1 &&
                next.textContent.trim() === codeEl.textContent.trim()) {
              next.textContent = codeEl.textContent;
            }
          }
        } else if (!canvas.textContent.trim()) {
          var fresh = doc.createElement(target.tag.toLowerCase());
          fresh.className = target.className;
          fresh.appendChild(doc.createElement('br'));
          canvas.appendChild(fresh);
          placeCaretAtEnd(fresh);
        }
      });
    }

    /**
     * 清除格式：把当前段还原成普通正文。
     * - 代码块整块降级（块内没有「行内格式」可清，留着 pre 会一直是等宽大块）
     * - 列表项只清行内格式，拆掉 li 会在列表里留一个空位
     */
    function clearBlockFormat() {
      withCaret(function () {
        var block = currentBlock();
        if (!block) {
          flashHint('先把光标放到要清除格式的段落里', 'warn');
          return;
        }

        if (block.tagName === 'PRE') {
          var p = doc.createElement('p');
          p.className = 'manual-note';
          p.textContent = block.textContent || '';
          if (block.parentNode) block.parentNode.replaceChild(p, block);
          placeCaretAtEnd(p);
          syncSelect();
          return;
        }

        doc.execCommand('removeFormat');
        if (block.tagName === 'LI' || block.tagName === 'TD' || block.tagName === 'TH') {
          syncSelect();
          return;
        }

        doc.execCommand('formatBlock', false, 'P');
        var next = currentBlock();
        if (next && next.tagName === 'P') next.className = 'manual-note';
        syncSelect();
      });
    }

    // 浮层打开后焦点会离开编辑区，先把选区与目标块记下来，确认时再恢复
    var savedRange = null;
    var savedText = '';
    var permTarget = null;

    function rememberSelection() {
      var sel = global.getSelection();
      if (!sel || !sel.rangeCount || !sel.anchorNode || !canvas.contains(sel.anchorNode)) return;
      savedText = sel.isCollapsed ? '' : sel.toString();
      savedRange = sel.getRangeAt(0).cloneRange();
    }

    function restoreSelection() {
      canvas.focus();
      if (!savedRange || !canvas.contains(savedRange.startContainer)) return;
      var sel = global.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }

    function insertInlineCode() {
      var sel = global.getSelection();
      if (!sel || !sel.rangeCount || !canvas.contains(sel.anchorNode)) {
        flashHint('先把光标放到要加代码的位置，或选中要变成代码的文字', 'warn');
        return;
      }

      var range = sel.getRangeAt(0);
      if (range.collapsed) {
        // 没选中文字：插一个空的 code 把光标放进去，接着敲就是代码
        var empty = doc.createElement('code');
        empty.appendChild(doc.createTextNode('\u200b'));
        range.insertNode(empty);
        var inside = doc.createRange();
        inside.setStart(empty.firstChild, 1);
        inside.collapse(true);
        sel.removeAllRanges();
        sel.addRange(inside);
        canvas.focus();
        return;
      }

      var startBlock = blockOf(range.startContainer);
      var endBlock = blockOf(range.endContainer);
      if (startBlock && endBlock && startBlock !== endBlock) {
        flashHint('行内代码只能用于同一段落内的文字', 'warn');
        return;
      }
      if (startBlock && startBlock.tagName === 'PRE') return;

      // 选区已经整块在某段行内代码里 → 再点一次取消（toggle）
      var host = closestTag(range.startContainer, 'CODE');
      if (host && host === closestTag(range.endContainer, 'CODE') && !closestTag(host, 'PRE')) {
        unwrap(host);
        canvas.focus();
        return;
      }

      // 不用 execCommand('insertHTML')：它会改写选区两侧空格（插入 &nbsp;、吞掉尾随空格），
      // 表现为「代码块前后的字粘在一起」。直接用 Range 搬运节点，原文一个字符都不动。
      var contents = range.extractContents();
      var code = doc.createElement('code');
      code.appendChild(contents);
      range.insertNode(code);

      var around = doc.createRange();
      around.selectNodeContents(code);
      sel.removeAllRanges();
      sel.addRange(around);
      canvas.focus();
    }

    /** 统一的轻提示：借用工具栏右侧的说明位，不弹窗打断 */
    function flashHint(message, tone) {
      if (!hint) return;
      hint.textContent = message;
      hint.title = message;
      hint.classList.toggle('is-warn', tone === 'warn');
      if (hintTimer) global.clearTimeout(hintTimer);
      hintTimer = global.setTimeout(function () {
        hint.textContent = HINT_TEXT;
        hint.title = '';
        hint.classList.remove('is-warn');
        hintTimer = null;
      }, 2600);
    }

    /**
     * 粘贴多块内容（Markdown / 网页片段）时不能塞进当前段落：
     * 那会产出 <p><ol>…</ol></p> 这类非法嵌套。改为插到当前块的同级。
     */
    function insertBlockHtml(html) {
      var box = doc.createElement('div');
      box.innerHTML = html;
      var incoming = Array.prototype.slice.call(box.childNodes);
      if (!incoming.length) return;

      var block = currentBlock();
      // 空段落直接被内容替换，不留空行
      if (block && /^(P|H4|H3)$/.test(block.tagName) && !block.textContent.trim()) {
        var parent = block.parentNode;
        incoming.forEach(function (node) { parent.insertBefore(node, block); });
        parent.removeChild(block);
        return;
      }
      if (!block || block.tagName === 'TD' || block.tagName === 'TH') {
        incoming.forEach(function (node) { canvas.appendChild(node); });
        return;
      }
      var anchor = block;
      incoming.forEach(function (node) {
        anchor.parentNode.insertBefore(node, anchor.nextSibling);
        anchor = node;
      });
    }

    function openLinkPop() {
      rememberSelection();
      var picked = savedText.trim();
      var preset = /^https?:\/\//i.test(picked) ? picked : '';
      pop.innerHTML =
        '<label class="me-pop-label">链接地址' +
        '<input class="input me-pop-input" type="url" placeholder="https://..." value="' +
        escapeAttr(preset) + '" /></label>' +
        '<p class="me-pop-tip">选中文字后插入，文字会变成可点击链接。</p>' +
        '<div class="me-pop-actions">' +
        '<button type="button" class="btn small" data-me-pop="cancel">取消</button>' +
        '<button type="button" class="btn primary small" data-me-pop="ok">插入</button>' +
        '</div>';
      pop.classList.remove('hidden');
      var input = pop.querySelector('.me-pop-input');
      if (input) {
        input.focus();
        input.select();
      }
    }

    function commitLink() {
      var input = pop.querySelector('.me-pop-input');
      var url = input ? input.value.trim() : '';
      if (!url) { closePop(); return; }
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) {
        input.setCustomValidity('请填写 http(s)、mailto: 或站内路径');
        input.reportValidity();
        return;
      }
      restoreSelection();
      var sel = global.getSelection();
      var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !canvas.contains(range.startContainer)) {
        closePop();
        flashHint('链接需要插在正文里，先把光标放到段落中', 'warn');
        return;
      }

      var link = doc.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('target', '_blank');
      if (!range.collapsed) {
        // 跨段落选中的内容搬进 <a> 会得到 <a><p>…</p></a> 这种非法嵌套，直接拦下
        var from = blockOf(range.startContainer);
        var to = blockOf(range.endContainer);
        if (from && to && from !== to) {
          closePop();
          flashHint('链接不能跨段落，请先选中同一段内的文字', 'warn');
          return;
        }
        // 保留选中文字原有的加粗/代码等格式，而不是退化成纯文本
        link.appendChild(range.extractContents());
      } else {
        link.textContent = savedText || url;
      }
      range.insertNode(link);

      // 光标移到链接之后，方便接着输入
      var after = doc.createRange();
      after.setStartAfter(link);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      canvas.focus();
      closePop();
    }

    function openPermPop() {
      permTarget = currentBlock();
      var current = permTarget ? (permTarget.getAttribute('data-manual-perm') || '') : '';
      var items = PERMISSIONS.map(function (pair) {
        var active = current === pair[0] ? ' active' : '';
        return (
          '<button type="button" class="me-perm' + active + '" data-me-perm="' + pair[0] + '">' +
          '<code>' + pair[0] + '</code><span>' + pair[1] + '</span>' +
          '</button>'
        );
      }).join('');
      pop.innerHTML =
        '<p class="me-pop-title">当前段落：' + (current ? '仅具备 <code>' + escapeHtml(current) + '</code> 的用户可见' : '所有登录用户可见') + '</p>' +
        '<div class="me-perm-list">' + items + '</div>' +
        '<div class="me-pop-actions">' +
        '<button type="button" class="btn small" data-me-pop="cancel">取消</button>' +
        '<button type="button" class="btn ghost small" data-me-pop="clear">取消限制</button>' +
        '</div>';
      pop.classList.remove('hidden');
    }

    function applyPerm(code) {
      var block = permTarget;
      permTarget = null;
      if (!block || !canvas.contains(block)) {
        closePop();
        return;
      }
      if (code) block.setAttribute('data-manual-perm', code);
      else block.removeAttribute('data-manual-perm');
      closePop();
    }

    bar.addEventListener('mousedown', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      // 浮层里的输入框与按钮要能正常聚焦
      if (target.closest('.me-pop')) return;
      // 原生下拉/输入框必须保留默认行为：preventDefault 会让 <select> 直接打不开，
      // 同时先把光标位置记下来，下拉展开会带走焦点与选区
      if (target.closest('select, input, textarea')) {
        closePop();
        rememberSelection();
        return;
      }
      // 其余按钮：防止点工具栏时编辑区失焦、选区丢失
      event.preventDefault();
    });

    bar.addEventListener('click', function (event) {
      var popAction = event.target.closest('[data-me-pop]');
      if (popAction) {
        var action = popAction.getAttribute('data-me-pop');
        if (action === 'cancel') closePop();
        else if (action === 'ok') commitLink();
        else if (action === 'clear') applyPerm('');
        return;
      }

      var perm = event.target.closest('[data-me-perm]');
      if (perm) {
        applyPerm(perm.getAttribute('data-me-perm'));
        return;
      }

      var btn = event.target.closest('[data-me]');
      if (!btn) return;
      var cmd = btn.getAttribute('data-me');
      if (cmd === 'bold') {
        canvas.focus();
        doc.execCommand('styleWithCSS', false, false);
        doc.execCommand('bold');
      } else if (cmd === 'code') {
        canvas.focus();
        insertInlineCode();
      } else if (cmd === 'link') {
        openLinkPop();
      } else if (cmd === 'perm') {
        openPermPop();
      } else if (cmd === 'clear') {
        clearBlockFormat();
      }
    });

    select.addEventListener('change', function () {
      restoreSelection();
      if (!currentBlock() && canvas.textContent.trim()) {
        flashHint('先把光标放到要改格式的段落里', 'warn');
        syncSelect();
        return;
      }
      applyBlock(select.value);
      syncSelect();
    });

    // 有改动就把工具栏标成待保存态，保存后编辑器会重建，标记自然消失
    canvas.addEventListener('input', function () {
      wrap.classList.add('is-dirty');
    });

    // 点了「行内代码」却没输入就离开：把空占位删掉，不留在正文里当小灰点
    canvas.addEventListener('blur', function () {
      var removed = false;
      Array.prototype.slice.call(canvas.querySelectorAll('code')).forEach(function (code) {
        if (code.closest('pre')) return;
        if (code.textContent.replace(/\u200b/g, '') !== '') return;
        if (code.parentNode) {
          code.parentNode.removeChild(code);
          removed = true;
        }
      });
      // 拆掉占位后前后会留下两段相邻文本节点，合并回去免得后续插入位置错乱
      if (removed) canvas.normalize();
    });

    canvas.addEventListener('paste', function (event) {      var data = event.clipboardData;
      if (!data) return;
      var text = data.getData('text/plain') || '';
      var html = data.getData('text/html') || '';

      if (looksLikeMarkdown(text)) {
        event.preventDefault();
        insertBlockHtml(mdToHtml(text));
        return;
      }
      if (html) {
        event.preventDefault();
        insertBlockHtml(sanitizePastedHtml(html));
      }
    });

    // 纯文本粘贴兜底：浏览器默认会把换行变 div，这里统一成段落
    canvas.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        var block = currentBlock();
        if (block && block.tagName === 'PRE') return; // 代码块内回车保序
      }
    });

    var onSelectionChange = function () {
      var sel = global.getSelection();
      if (!sel || !sel.anchorNode || !canvas.contains(sel.anchorNode)) return;
      syncSelect();
    };
    doc.addEventListener('selectionchange', onSelectionChange);
    cleanups.push(function () { doc.removeEventListener('selectionchange', onSelectionChange); });

    // 首次进入：光标落到正文开头
    try {
      doc.execCommand('defaultParagraphSeparator', false, 'p');
      doc.execCommand('styleWithCSS', false, false);
    } catch (err) {
      /* 老浏览器不支持就退回默认行为 */
    }

    syncSelect();
    return inst;
  }

  function detach(section) {
    var inst = section.__me;
    if (!inst) return;
    inst.cleanups.forEach(function (fn) {
      try { fn(); } catch (err) { /* 清理失败不影响退出编辑 */ }
    });
    if (inst.wrap.parentNode) inst.wrap.parentNode.removeChild(inst.wrap);
    section.__me = null;
  }

  function isAttached(section) {
    return Boolean(section && section.__me);
  }

  /** 读取当前编辑内容（已收敛为标准排版 HTML） */
  function read(section) {
    var inst = section && section.__me;
    if (!inst) return '';
    return normalize(inst.canvas.cloneNode(true));
  }

  global.ManualEditor = {
    attach: attach,
    detach: detach,
    isAttached: isAttached,
    read: read,
    // 供单测直接验证纯函数
    _internal: {
      mdToHtml: mdToHtml,
      looksLikeMarkdown: looksLikeMarkdown,
      sanitizePastedHtml: sanitizePastedHtml,
      normalize: normalize,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

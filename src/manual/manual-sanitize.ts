/**
 * 用户手册 HTML 白名单清洗。
 *
 * 管理员可以编辑手册章节，但编辑的是 HTML 源片段；这段内容会下发给所有登录用户，
 * 因此必须在写入前做白名单过滤。策略：
 * - 只保留排版类标签，禁止 script / iframe / svg / form / style 等；
 * - 只允许 class / title / 安全 href / data-manual-perm 等少量属性；
 * - 未知标签转成转义文本，避免管理员写的 <package> 这类占位符凭空消失；
 * - 文本节点只转义尖括号，保留已有 &lt; 等实体，避免二次编码。
 */

const ALLOWED_TAGS = new Set([
  'p',
  'h3',
  'h4',
  'ol',
  'ul',
  'li',
  'pre',
  'code',
  'b',
  'strong',
  'em',
  'i',
  'small',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'a',
]);

const COMMON_ATTRS = new Set(['class', 'title']);
// 这两个 class 被前端当作结构标记，管理员内容里不允许自带，否则会干扰正文替换与编辑框定位
const RESERVED_CLASSES = new Set(['card-head', 'manual-edit-area']);
const EXTRA_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target']),
  td: new Set(['data-manual-perm']),
  tr: new Set(['data-manual-perm']),
  div: new Set(['data-manual-perm']),
  span: new Set(['data-manual-perm']),
  p: new Set(['data-manual-perm']),
  li: new Set(['data-manual-perm']),
};

const TAG_TOKEN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
const ATTR_TOKEN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function escapeText(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeHref(value: string): boolean {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(value);
}

function safePermission(value: string): boolean {
  return /^[a-z]+:[a-z]+(,[a-z]+:[a-z]+)*$/.test(value);
}

function parseAttrs(token: string): Array<[string, string]> {
  const body = token
    .replace(/^<\/?[A-Za-z][A-Za-z0-9-]*/, '')
    .replace(/\/?>$/, '');
  const out: Array<[string, string]> = [];
  ATTR_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_TOKEN.exec(body))) {
    const name = match[1];
    if (!name) continue;
    out.push([name, match[2] ?? match[3] ?? match[4] ?? '']);
  }
  return out;
}

function renderAttrs(tag: string, attrs: Array<[string, string]>): string {
  const allowed = new Set<string>([...COMMON_ATTRS, ...(EXTRA_ATTRS[tag] ?? [])]);
  let out = '';
  for (const [rawName, rawValue] of attrs) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    const value = rawValue;

    if (name === 'href') {
      if (!safeHref(value)) continue;
      out += ` href="${escapeAttr(value)}"`;
      continue;
    }
    if (name === 'target') {
      if (value.toLowerCase() !== '_blank') continue;
      // rel 不接受管理员输入，统一补 noopener，防止反 tabnabbing
      out += ' target="_blank" rel="noopener noreferrer"';
      continue;
    }
    if (name === 'rel') continue;
    if (name === 'data-manual-perm' && !safePermission(value)) continue;

    const safeValue =
      name === 'class'
        ? value
            .replace(/[^\w\s-]/g, ' ')
            .split(/\s+/)
            .filter((item) => item && !RESERVED_CLASSES.has(item))
            .join(' ')
        : value;
    out += ` ${name}="${escapeAttr(safeValue)}"`;
  }
  return out;
}

/** 返回可安全写入 innerHTML 的片段。 */
export function sanitizeManualHtml(input: string): string {
  let out = '';
  let cursor = 0;
  TAG_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_TOKEN.exec(input))) {
    out += escapeText(input.slice(cursor, match.index));
    const token = match[0];

    // 注释直接丢弃，不留痕迹
    if (token.startsWith('<!--')) {
      cursor = match.index + token.length;
      continue;
    }

    const nameMatch = token.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (!ALLOWED_TAGS.has(name)) {
      // 未知标签转成可见文本：<script> 不会执行，<package> 这类占位符也不会丢
      out += escapeText(token);
    } else if (token.startsWith('</')) {
      out += `</${name}>`;
    } else {
      out += `<${name}${renderAttrs(name, parseAttrs(token))}>`;
    }
    cursor = match.index + token.length;
  }

  out += escapeText(input.slice(cursor));
  return out;
}

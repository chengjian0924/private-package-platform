import * as path from 'node:path';

/**
 * 前端 Markdown 转换的纯函数单测。
 * 编辑器脚本是浏览器 IIFE，这里在 node 里加载它，只调用不依赖 DOM 的部分：
 * 从文档/网页粘贴 Markdown 时，转出来的结构必须正好是手册的排版类名，
 * 否则粘贴进来的内容会掉样式或掉代码块。
 */
interface EditorInternals {
  mdToHtml: (markdown: string) => string;
  looksLikeMarkdown: (text: string) => boolean;
}

function loadInternals(): EditorInternals {
  const file = path.join(__dirname, '../../public/manual-editor.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(file);
  return (globalThis as unknown as { ManualEditor: { _internal: EditorInternals } }).ManualEditor._internal;
}

const md = loadInternals();

describe('手册编辑器：Markdown 粘贴转换', () => {
  it('一级标题转 h3，二级及更深转小标题', () => {
    expect(md.mdToHtml('# 安装私有包')).toBe('<h3>安装私有包</h3>');
    expect(md.mdToHtml('## 步骤')).toBe('<h4 class="manual-sub">步骤</h4>');
    expect(md.mdToHtml('### 子步骤')).toBe('<h4 class="manual-sub">子步骤</h4>');
  });

  it('代码围栏保留原文并带 manual-code 类', () => {
    const html = md.mdToHtml(['```bash', 'npm config set registry http://host/npm/', 'npm install pkg', '```'].join('\n'));
    expect(html).toContain('<pre class="manual-code"><code>');
    expect(html).toContain('npm config set registry http://host/npm/');
    expect(html).toContain('npm install pkg');
    // 代码块里的内容不做行内解析
    expect(md.mdToHtml(['```', 'a **b** `c`', '```'].join('\n'))).toContain('a **b** `c`');
  });

  it('有序与无序列表都产出 manual-steps', () => {
    expect(md.mdToHtml(['1. 先登录', '2. 再发布'].join('\n'))).toBe(
      '<ol class="manual-steps"><li>先登录</li><li>再发布</li></ol>',
    );
    expect(md.mdToHtml(['- npm', '- pypi'].join('\n'))).toBe(
      '<ul class="manual-steps"><li>npm</li><li>pypi</li></ul>',
    );
  });

  it('表格转成 table-wrap + thead/tbody，列数以表头为准', () => {
    const html = md.mdToHtml(['| 风险 | 处置 |', '| --- | --- |', '| critical | 拦截 |'].join('\n'));
    expect(html).toContain('<table class="table">');
    expect(html).toContain('<th>风险</th><th>处置</th>');
    expect(html).toContain('<td>critical</td><td>拦截</td>');
  });

  it('行内代码、粗体、链接各自转换，链接补 target', () => {
    const html = md.mdToHtml('执行 `npm install` 后看 **预期**，详见 [文档](https://example.com/a)。');
    expect(html).toContain('<code>npm install</code>');
    expect(html).toContain('<b>预期</b>');
    expect(html).toContain('<a href="https://example.com/a" target="_blank">文档</a>');
  });

  it('非 http/站内地址的链接只保留文字，避免粘进 javascript:', () => {
    const html = md.mdToHtml('[点我](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('点我');
  });

  it('尖括号按文本转义，粘贴 <script> 不会变成标签', () => {
    const html = md.mdToHtml('把 <package> 换成包名');
    expect(html).toContain('&lt;package&gt;');
    expect(html).not.toContain('<package>');
  });

  it('识别 Markdown 特征，普通句子按纯文本粘贴', () => {
    expect(md.looksLikeMarkdown('# 标题')).toBe(true);
    expect(md.looksLikeMarkdown('- 列表项')).toBe(true);
    expect(md.looksLikeMarkdown('1. 第一步')).toBe(true);
    expect(md.looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(md.looksLikeMarkdown('含有 **加粗** 的句子')).toBe(true);
    expect(md.looksLikeMarkdown('这是一句普通的说明文字')).toBe(false);
    // 带 HTML 标签的走另一条清洗路径，不能当 Markdown 处理
    expect(md.looksLikeMarkdown('<p>已经是 HTML</p>')).toBe(false);
  });
});

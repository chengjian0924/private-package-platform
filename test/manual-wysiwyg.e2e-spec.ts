import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';

/** 所见即所得编辑器保存时会产出的结构：段落/小标题/步骤/代码块/表格/行内语义 */
const EDITOR_HTML =
  '<h3>安装私有包</h3>' +
  '<p class="manual-note">在项目里执行下面的命令：</p>' +
  '<h4 class="manual-sub">步骤</h4>' +
  '<ol class="manual-steps"><li>先 <b>登录</b> 私有源</li><li>再执行 <code>npm install pkg</code></li></ol>' +
  '<pre class="manual-code"><code>npm config set registry http://host/npm/\n\nnpm install &lt;pkg&gt;</code></pre>' +
  '<p class="manual-expect"><b>预期</b>：提示 added N packages。</p>' +
  '<div class="table-wrap"><table class="table"><thead><tr><th>风险</th><th>处置</th></tr></thead>' +
  '<tbody><tr><td><span class="pill err">critical</span></td><td>拦截</td></tr></tbody></table></div>' +
  '<p class="manual-note" data-manual-perm="package:publish">仅发布权限可见。</p>' +
  '<p class="manual-note" data-manual-perm="security:read:own">范围收窄的权限点。</p>';

function put(ctx: TestContext, sections: Record<string, string>, user = ADMIN) {
  return request(ctx.baseUrl)
    .put('/api/v1/manual/content')
    .auth(user.username, user.password)
    .send({ sections });
}

describe('用户手册所见即所得编辑（e2e）', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp('manual-wysiwyg');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('编辑器产出的排版结构保存后原样保留', async () => {
    const saved = await put(ctx, { 'manual-access': EDITOR_HTML }).expect(200);
    const stored = saved.body.data.sections['manual-access'].html as string;

    expect(stored).toContain('<h3>安装私有包</h3>');
    expect(stored).toContain('<h4 class="manual-sub">步骤</h4>');
    expect(stored).toContain('<p class="manual-note">在项目里执行下面的命令：</p>');
    expect(stored).toContain('<ol class="manual-steps">');
    expect(stored).toContain('<b>登录</b>');
    expect(stored).toContain('<code>npm install pkg</code>');
    expect(stored).toContain('<pre class="manual-code"><code>');
    expect(stored).toContain('<p class="manual-expect">');
    expect(stored).toContain('<table class="table">');
    expect(stored).toContain('<span class="pill err">critical</span>');
    // 代码块里的尖括号以实体形式留存，不会被还原成标签
    expect(stored).toContain('&lt;pkg&gt;');
  });

  it('权限标记支持两段与三段（security:read:own），普通用户读到同一份', async () => {
    const saved = await put(ctx, { 'manual-access': EDITOR_HTML }).expect(200);
    const stored = saved.body.data.sections['manual-access'].html as string;
    expect(stored).toContain('data-manual-perm="package:publish"');
    expect(stored).toContain('data-manual-perm="security:read:own"');

    const reader = await request(ctx.baseUrl)
      .get('/api/v1/manual/content')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(reader.body.data.sections['manual-access'].html).toBe(stored);
  });

  it('非法权限标记被丢弃，标签本身保留', async () => {
    const html =
      '<p class="manual-note" data-manual-perm="Package:Publish">大写权限码</p>' +
      '<p class="manual-note" data-manual-perm="a:b:c:d">层级过深</p>' +
      '<p class="manual-note" data-manual-perm="package:publish\' onmouseover=\'x">注入尝试</p>';
    const saved = await put(ctx, { 'manual-access': html }).expect(200);
    const stored = saved.body.data.sections['manual-access'].html as string;

    expect(stored).not.toContain('data-manual-perm');
    expect(stored).not.toContain('onmouseover');
    expect(stored).toContain('大写权限码');
    expect(stored).toContain('层级过深');
    expect(stored).toContain('注入尝试');
  });

  it('编辑器不会产出、服务端也拦得住的结构标记类', async () => {
    // card-head / manual-edit-area 被前端当作结构标记，出现在正文里会干扰替换
    const saved = await put(ctx, {
      'manual-access': '<p class="manual-note manual-edit-area">正文</p>',
    }).expect(200);
    const stored = saved.body.data.sections['manual-access'].html as string;
    expect(stored).toContain('class="manual-note"');
    expect(stored).not.toContain('manual-edit-area');
  });
});

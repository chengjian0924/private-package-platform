import * as crypto from 'node:crypto';
import request from 'supertest';
import { ADMIN, createTestApp, type TestContext } from './app-factory';
import { makeNpmTarball } from './fixtures';

function publish(ctx: TestContext, name: string, version: string, tarball: Buffer, signature: string) {
  return request(ctx.baseUrl)
    .put(`/npm/${name}`)
    .auth(ADMIN.username, ctx.npmTokens[ADMIN.username])
    .send({
      _id: name,
      name,
      'dist-tags': { latest: version },
      versions: { [version]: { name, version, dist: {} } },
      _attachments: {
        [`${name}-${version}.tgz`]: { data: tarball.toString('base64'), length: tarball.length },
      },
      signature,
    });
}

describe('强制签名下的复检与依赖区间判定（e2e）', () => {
  let ctx: TestContext;
  let privateKey: crypto.KeyObject;

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    process.env.SECURITY_TRUSTED_KEYS = JSON.stringify([
      { keyId: 'e2e-rescan', pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ]);
    // 复检路径的关键回归前提：开启强制签名，历史签名必须能复用，否则会被全量误隔离
    process.env.SECURITY_REQUIRE_SIGNATURE = 'true';
    // 单并发下排队逻辑必须正确：槽位转移出错会直接死锁
    process.env.SECURITY_SCAN_CONCURRENCY = '1';
    ctx = await createTestApp('security-rescan');
  });

  afterAll(async () => {
    delete process.env.SECURITY_REQUIRE_SIGNATURE;
    delete process.env.SECURITY_SCAN_CONCURRENCY;
    await ctx.close();
  });

  const sign = (buffer: Buffer) => crypto.sign(null, buffer, privateKey).toString('base64');

  it('签名包复检后签名保持 verified，空漏洞库只告警不隔离', async () => {
    const tarball = await makeNpmTarball('e2e-rescan-signed', '1.0.0');
    await publish(ctx, 'e2e-rescan-signed', '1.0.0', tarball, sign(tarball)).expect(201);

    const rescan = await request(ctx.baseUrl)
      .post('/api/v1/security/rescan')
      .auth(ADMIN.username, ADMIN.password)
      .send({})
      .expect(201);
    expect(rescan.body.data.scanned).toBeGreaterThanOrEqual(1);
    expect(rescan.body.data.quarantined).toBe(0);

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-rescan-signed' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(scans.body.data.items[0].signatureStatus).toBe('verified');
    // 空漏洞库时漏洞维度 unknown，整体至少 WARN，不能给 ALLOW 合格标识
    expect(scans.body.data.items[0].disposition).toBe('WARN');
    expect(scans.body.data.items[0].dimensions.vulnerability.status).toBe('unknown');

    const detail = await request(ctx.baseUrl)
      .get('/api/v1/packages/detail')
      .query({ ecosystem: 'npm', name: 'e2e-rescan-signed' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(detail.body.data.versions).toHaveLength(1);

    const quarantine = await request(ctx.baseUrl)
      .get('/api/v1/security/quarantine')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(
      quarantine.body.data.items.some((item: { name: string }) => item.name === 'e2e-rescan-signed'),
    ).toBe(false);
  });

  it('宽区间依赖与漏洞区间不相交时不隔离，锁定旧版本时隔离', async () => {
    await request(ctx.baseUrl)
      .post('/api/v1/security/advisories/import')
      .auth(ADMIN.username, ADMIN.password)
      .send({
        advisories: [
          {
            source: 'CVE',
            advisoryId: 'CVE-2099-0100',
            ecosystem: 'npm',
            packageName: 'lodash',
            affectedRange: '<4.17.21',
            severity: 'high',
            cvss: 8.1,
            title: 'lodash 原型污染',
            fixedVersion: '4.17.21',
          },
        ],
      })
      .expect(201);

    // 声明 ^4.17.21 与 <4.17.21 无交集，应直接判定不受影响
    const loose = await makeNpmTarball('e2e-dep-loose', '1.0.0', {
      dependencies: { lodash: '^4.17.21' },
    });
    await publish(ctx, 'e2e-dep-loose', '1.0.0', loose, sign(loose)).expect(201);
    const looseScans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-dep-loose' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(looseScans.body.data.items[0].disposition).toBe('ALLOW');

    // lockfile 锁定 4.17.20，落在受影响区间内，应进入隔离
    const lockfile = JSON.stringify({
      name: 'e2e-dep-lock',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { 'node_modules/lodash': { version: '4.17.20' } },
    });
    const locked = await makeNpmTarball(
      'e2e-dep-lock',
      '1.0.0',
      { dependencies: { lodash: '^4.17.21' } },
      { 'index.js': 'module.exports = 1;\n', 'package-lock.json': lockfile },
    );
    const res = await publish(ctx, 'e2e-dep-lock', '1.0.0', locked, sign(locked)).expect(409);
    expect(res.body.error).toBe('SEC_QUARANTINED');

    // 传递依赖同样要命中：只有 lockfile 里出现的 lodash 也应被判定
    const transitiveLock = JSON.stringify({
      name: 'e2e-dep-trans',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        'node_modules/chalk': { version: '5.3.0' },
        'node_modules/lodash': { version: '4.17.20' },
      },
    });
    const transitive = await makeNpmTarball(
      'e2e-dep-trans',
      '1.0.0',
      { dependencies: { chalk: '^5.3.0' } },
      { 'index.js': 'module.exports = 1;\n', 'package-lock.json': transitiveLock },
    );
    await publish(ctx, 'e2e-dep-trans', '1.0.0', transitive, sign(transitive)).expect(409);

    const scans = await request(ctx.baseUrl)
      .get('/api/v1/security/scans')
      .query({ name: 'e2e-dep-trans' })
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const detail = await request(ctx.baseUrl)
      .get(`/api/v1/security/scans/${scans.body.data.items[0].id}`)
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect(
      detail.body.data.findings.some((item: { ruleId: string }) => item.ruleId === 'VULN-TRANSITIVE'),
    ).toBe(true);
  });

  it('单并发限制下并发上传能排队完成，不死锁', async () => {
    const names = ['e2e-conc-a', 'e2e-conc-b', 'e2e-conc-c'];
    const tarballs = await Promise.all(names.map((name) => makeNpmTarball(name, '1.0.0')));
    const results = await Promise.all(names.map((name, index) => publish(ctx, name, '1.0.0', tarballs[index], sign(tarballs[index]))));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201]);
  });
});

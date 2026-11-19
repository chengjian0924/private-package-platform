import request from 'supertest';
import { ADMIN, DEVELOPER, READER, createTestApp, type TestContext } from './app-factory';
import { AuthService } from '../src/auth/auth.service';
import { makeNpmTarball } from './fixtures';

interface VersionItem {
  id: string;
  version: string;
  status: string;
  deletedAt: string | null;
  downloadUrl: string | null;
  canDelete: boolean;
  canRestore: boolean;
}

interface PackageItem {
  id: string;
  name: string;
  ecosystem: string;
  versionCount: number;
  deletedVersionCount: number;
}

type Account = { username: string; password: string };

describe('版本级删除 / 恢复 与「含已删除」筛选（e2e）', () => {
  let ctx: TestContext;
  /** 第二个开发者：用于验证「同角色、非本人」仍然删不了别人的版本 */
  const DEVELOPER2 = { username: 'developer2', password: 'Console-Dev2-9xQ7m' };

  beforeAll(async () => {
    ctx = await createTestApp('package-delete');
    const auth = ctx.app.get(AuthService);
    const second = await auth.createUser({ username: DEVELOPER2.username, role: 'developer' });
    await auth.changePassword({
      userId: second.user.id,
      oldPassword: second.initialPassword ?? undefined,
      newPassword: DEVELOPER2.password,
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** 同步返回 supertest Test，便于链式 .expect()；tarball 由调用方先 await 生成 */
  function publishRequest(account: Account, name: string, version: string, tarball: Buffer) {
    return request(ctx.baseUrl)
      .put(`/npm/${name}`)
      .auth(account.username, ctx.npmTokens[account.username])
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

  async function publish(account: Account, name: string, version: string): Promise<void> {
    const tarball = await makeNpmTarball(name, version, { engines: { node: '>=18' } });
    await publishRequest(account, name, version, tarball).expect(201);
  }

  async function detail(account: Account, name: string, includeDeleted = false) {
    const params = new URLSearchParams({ ecosystem: 'npm', name });
    if (includeDeleted) params.set('includeDeleted', '1');
    const res = await request(ctx.baseUrl)
      .get(`/api/v1/packages/detail?${params.toString()}`)
      .auth(account.username, account.password)
      .expect(200);
    return res.body.data as { versions: VersionItem[] };
  }

  /** 详情接口可能因为「对当前用户不可见」直接 404，这里只取状态码，便于断言 */
  function detailStatus(account: Account, name: string, includeDeleted = false) {
    const params = new URLSearchParams({ ecosystem: 'npm', name });
    if (includeDeleted) params.set('includeDeleted', '1');
    return request(ctx.baseUrl)
      .get(`/api/v1/packages/detail?${params.toString()}`)
      .auth(account.username, account.password);
  }

  async function listItem(account: Account, name: string, includeDeleted = false): Promise<PackageItem | undefined> {
    const params = new URLSearchParams({ ecosystem: 'npm', q: name });
    if (includeDeleted) params.set('includeDeleted', '1');
    const res = await request(ctx.baseUrl)
      .get(`/api/v1/packages?${params.toString()}`)
      .auth(account.username, account.password)
      .expect(200);
    return (res.body.data.items as PackageItem[]).find((item) => item.name === name);
  }

  function removeVersion(account: Account, id: string) {
    return request(ctx.baseUrl)
      .delete(`/api/v1/packages/versions/${id}`)
      .auth(account.username, account.password);
  }

  function restoreVersion(account: Account, id: string) {
    return request(ctx.baseUrl)
      .post(`/api/v1/packages/versions/${id}/restore`)
      .auth(account.username, account.password);
  }

  it('只删版本不删包：reader 与同角色他人都删不了，本人删除后同包其它版本不受影响', async () => {
    const name = 'e2e-del-version';
    await publish(DEVELOPER, name, '1.0.0');
    await publish(DEVELOPER, name, '2.0.0');
    const before = await detail(DEVELOPER, name);
    const v1 = before.versions.find((v) => v.version === '1.0.0')!;

    // reader 被方法级权限挡住；另一个 developer 被归属校验挡住（管理员不在此列，见专门用例）
    const byReader = await removeVersion(READER, v1.id).expect(403);
    expect(byReader.body.code).toBe('AUTH_FORBIDDEN');
    const byPeer = await removeVersion(DEVELOPER2, v1.id).expect(403);
    expect(byPeer.body.code).toBe('AUTH_FORBIDDEN');

    const removed = await removeVersion(DEVELOPER, v1.id).expect(200);
    expect(removed.body.data.version).toBe('1.0.0');
    expect(removed.body.data.deletedByAdmin).toBe(false);

    // 包壳还在，另一个版本仍可解析下载
    const after = await detail(DEVELOPER, name);
    expect(after.versions.map((v) => v.version)).toEqual(['2.0.0']);
    expect((await listItem(DEVELOPER, name))?.versionCount).toBe(1);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-2.0.0.tgz`).expect(200);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(404);
  });

  it('已删除版本只对上传者与管理员可见：普通用户勾选「含已删除」也看不到、也进不了详情', async () => {
    const name = 'e2e-del-visible';
    await publish(DEVELOPER, name, '1.0.0');
    const before = await detail(DEVELOPER, name);
    await removeVersion(DEVELOPER, before.versions[0].id).expect(200);

    // 上传者：默认看不到，勾选后能看到并可恢复
    await detailStatus(DEVELOPER, name).expect(404);
    const shown = await detail(DEVELOPER, name, true);
    expect(shown.versions).toHaveLength(1);
    expect(shown.versions[0].status).toBe('deleted');
    expect(shown.versions[0].deletedAt).toBeTruthy();
    expect(shown.versions[0].canRestore).toBe(true);
    expect(shown.versions[0].canDelete).toBe(false);
    expect(shown.versions[0].downloadUrl).toBeNull();

    // 管理员：能看到删除记录，且可以代为恢复，但仍不能替别人删除
    await detailStatus(ADMIN, name).expect(404);
    const asAdmin = await detail(ADMIN, name, true);
    expect(asAdmin.versions).toHaveLength(1);
    expect(asAdmin.versions[0].status).toBe('deleted');
    expect(asAdmin.versions[0].canRestore).toBe(true);
    expect(asAdmin.versions[0].canDelete).toBe(false);

    // 普通用户：包已无在用版本，连详情都不该存在，勾选「含已删除」也一样
    await detailStatus(READER, name).expect(404);
    await detailStatus(READER, name, true).expect(404);
  });

  it('恢复：未删除版本报 PKG_VERSION_NOT_DELETED，非本人且非管理员 403，本人恢复后重新可下载', async () => {
    const name = 'e2e-del-restore';
    await publish(DEVELOPER, name, '1.0.0');
    const id = (await detail(DEVELOPER, name)).versions[0].id;

    const notDeleted = await restoreVersion(DEVELOPER, id).expect(409);
    expect(notDeleted.body.code).toBe('PKG_VERSION_NOT_DELETED');

    await removeVersion(DEVELOPER, id).expect(200);
    // reader 没有 package:publish，先被权限层挡住
    await restoreVersion(READER, id).expect(403);

    const restored = await restoreVersion(DEVELOPER, id).expect(201);
    expect(restored.body.data.version).toBe('1.0.0');

    const after = await detail(DEVELOPER, name);
    expect(after.versions.map((v) => v.version)).toEqual(['1.0.0']);
    expect(after.versions[0].status).toBe('active');
    expect(after.versions[0].deletedAt).toBeNull();
    expect(after.versions[0].downloadUrl).toBeTruthy();
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(200);
  });

  it('管理员可代删他人版本，被删版本归属不变、原上传人仍可恢复，代操作写审计', async () => {
    const name = 'e2e-del-admin-proxy';
    await publish(DEVELOPER, name, '1.0.0');
    await publish(DEVELOPER, name, '2.0.0');
    const v1 = (await detail(DEVELOPER, name)).versions.find((v) => v.version === '1.0.0')!;

    // 管理员代删：成功且带代操作标记
    const removed = await removeVersion(ADMIN, v1.id).expect(200);
    expect(removed.body.data.version).toBe('1.0.0');
    expect(removed.body.data.deletedByAdmin).toBe(true);

    // 立即可从私有源下架，另一版本不受影响
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(404);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-2.0.0.tgz`).expect(200);

    // 归属不变：原上传人看到的是「已删除 + 可恢复」，管理员也是
    const ownerView = await detail(DEVELOPER, name, true);
    const ownerDeleted = ownerView.versions.find((v) => v.version === '1.0.0')!;
    expect(ownerDeleted.status).toBe('deleted');
    expect(ownerDeleted.canRestore).toBe(true);
    expect(ownerDeleted.canDelete).toBe(false);
    expect(ownerDeleted.downloadUrl).toBeNull();

    // 管理员两种方向都能操作
    const adminView = await detail(ADMIN, name, true);
    const adminDeleted = adminView.versions.find((v) => v.version === '1.0.0')!;
    expect(adminDeleted.canRestore).toBe(true);
    expect(adminDeleted.canDelete).toBe(false);
    expect(adminView.versions.find((v) => v.version === '2.0.0')!.canDelete).toBe(true);

    // 原上传人自己恢复：代删不等于代管，归属仍是本人
    const restored = await restoreVersion(DEVELOPER, v1.id).expect(201);
    expect(restored.body.data.restoredByAdmin).toBe(false);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(200);

    // 两次代操作都要能在审计里区分出管理员身份
    const logs = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?result=success')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const items = logs.body.data.items as { action: string; detail: Record<string, unknown> | null }[];
    expect(
      items.some((item) => item.action === 'package.version.delete' && item.detail?.deletedByAdmin === true),
    ).toBe(true);
    expect(items.some((item) => item.action === 'package.version.delete' && item.detail?.actorRole === 'admin')).toBe(
      true,
    );
  });

  it('管理员可恢复他人删除的版本（代操作留痕），恢复后归属仍是原上传人', async () => {
    const name = 'e2e-del-admin-restore';
    await publish(DEVELOPER, name, '1.0.0');
    const id = (await detail(DEVELOPER, name)).versions[0].id;
    await removeVersion(DEVELOPER, id).expect(200);

    const restored = await restoreVersion(ADMIN, id).expect(201);
    expect(restored.body.data.restoredByAdmin).toBe(true);

    // 恢复后对所有人生效：版本回到 active、可解析下载，owner 仍是原上传人
    const after = await detail(DEVELOPER, name);
    const byOwner = after.versions.find((v) => v.version === '1.0.0')!;
    expect(byOwner.status).toBe('active');
    expect(byOwner.canDelete).toBe(true);
    await request(ctx.baseUrl).get(`/npm/${name}/-/${name}-1.0.0.tgz`).expect(200);

    const logs = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=package.version.restore&result=success')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    const proxy = (
      logs.body.data.items as { resourceId: string; detail: Record<string, unknown> | null }[]
    ).find((item) => item.detail?.restoredByAdmin === true && item.detail?.actorRole === 'admin');
    expect(proxy).toBeTruthy();
  });

  it('删除最后一个版本后：本人与管理员勾选「含已删除」能看到包壳，普通用户列表里彻底消失', async () => {
    const name = 'e2e-del-last';
    await publish(DEVELOPER, name, '1.0.0');
    const id = (await detail(DEVELOPER, name)).versions[0].id;
    await removeVersion(DEVELOPER, id).expect(200);

    expect(await listItem(DEVELOPER, name)).toBeUndefined();
    const shown = await listItem(DEVELOPER, name, true);
    expect(shown).toBeTruthy();
    expect(shown!.versionCount).toBe(0);
    expect(shown!.deletedVersionCount).toBe(1);

    // 管理员能看到这条删除记录（用于运维排查与代恢复）
    const asAdmin = await listItem(ADMIN, name, true);
    expect(asAdmin).toBeTruthy();
    expect(asAdmin!.versionCount).toBe(0);
    expect(asAdmin!.deletedVersionCount).toBe(1);

    // 普通用户：默认列表与「含已删除」列表都不该出现这个包
    expect(await listItem(READER, name)).toBeUndefined();
    expect(await listItem(READER, name, true)).toBeUndefined();
  });

  it('部分删除：普通用户只看到剩余在用版本且无「已删除」计数，管理员与本人可见', async () => {
    const name = 'e2e-del-partial';
    await publish(DEVELOPER, name, '1.0.0');
    await publish(DEVELOPER, name, '2.0.0');
    const versions = (await detail(DEVELOPER, name)).versions;
    await removeVersion(DEVELOPER, versions.find((v) => v.version === '1.0.0')!.id).expect(200);

    // 普通用户：已删除版本被过滤，计数为 0（卡片刻只看得到「1 个版本」）
    const asReader = await detail(READER, name, true);
    expect(asReader.versions.map((v) => v.version)).toEqual(['2.0.0']);
    expect(asReader.versions.every((v) => v.canDelete === false && v.canRestore === false)).toBe(true);
    const readerListed = await listItem(READER, name, true);
    expect(readerListed?.versionCount).toBe(1);
    expect(readerListed?.deletedVersionCount).toBe(0);
    // 默认列表（不勾选）同样不能泄露删除统计
    expect((await listItem(READER, name))?.deletedVersionCount).toBe(0);

    // 管理员：能看到已删除版本与统计，且可代删代恢复
    const asAdmin = await detail(ADMIN, name, true);
    expect(asAdmin.versions.map((v) => v.version)).toEqual(['1.0.0', '2.0.0']);
    const adminDeleted = asAdmin.versions.find((v) => v.version === '1.0.0')!;
    expect(adminDeleted.status).toBe('deleted');
    expect(adminDeleted.canRestore).toBe(true);
    // 已删除行不再有删除入口（无论谁），但在用版本管理员可代删
    expect(adminDeleted.canDelete).toBe(false);
    expect(asAdmin.versions.find((v) => v.version === '2.0.0')!.canDelete).toBe(true);
    expect((await listItem(ADMIN, name, true))?.deletedVersionCount).toBe(1);

    // 上传者自己的视角里同样可见
    expect((await listItem(DEVELOPER, name, true))?.deletedVersionCount).toBe(1);
    // 本人默认列表也能看到自己的删除数（不需要勾选筛选）
    expect((await listItem(DEVELOPER, name))?.deletedVersionCount).toBe(1);
    // 管理员默认列表同样可见
    expect((await listItem(ADMIN, name))?.deletedVersionCount).toBe(1);
  });

  it('已删除版本仍占用版本号：同版本重传被拒并提示可恢复', async () => {
    const name = 'e2e-del-reupload';
    await publish(DEVELOPER, name, '1.0.0');
    const id = (await detail(DEVELOPER, name)).versions[0].id;
    await removeVersion(DEVELOPER, id).expect(200);

    const tarball = await makeNpmTarball(name, '1.0.0', { engines: { node: '>=18' } });
    const res = await publishRequest(DEVELOPER, name, '1.0.0', tarball).expect(409);
    // /npm/* 走 registry 风格错误体，错误码字段是 error 而非 code
    expect(res.body.error).toBe('PKG_VERSION_DELETED');
  });

  it('删除与恢复都写入审计日志', async () => {
    const del = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=package.version.delete&result=success')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect((del.body.data.items as unknown[]).length).toBeGreaterThanOrEqual(1);

    const restore = await request(ctx.baseUrl)
      .get('/api/v1/audit-logs?action=package.version.restore&result=success')
      .auth(ADMIN.username, ADMIN.password)
      .expect(200);
    expect((restore.body.data.items as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

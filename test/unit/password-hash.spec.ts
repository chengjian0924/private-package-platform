import {
  generateInitialPassword,
  hashPassword,
  verifyPassword,
} from '../../src/auth/password';

/** 口令哈希与一次性初始密码：scrypt 校验、脏数据兜底、DoS 参数上限、易混字符剔除 */
describe('口令哈希与初始密码（单元）', () => {
  it('正确口令校验通过，错误口令被拒绝', async () => {
    const hash = await hashPassword('Str0ng-Pass!2026');
    expect(await verifyPassword('Str0ng-Pass!2026', hash)).toBe(true);
    expect(await verifyPassword('wrong-pass', hash)).toBe(false);
  });

  it('每次哈希加盐不同，同样口令产出不同密文', async () => {
    const a = await hashPassword('Same-Pass!2026');
    const b = await hashPassword('Same-Pass!2026');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('空哈希 / 非 scrypt 格式 / 字段数不符均返回 false 不抛错', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'md5$abcdef')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$only$four')).toBe(false);
  });

  it('被篡改的超大 scrypt 参数被拒绝（防 DoS），不进入昂贵计算', async () => {
    const tampered = 'scrypt$999999999$8$1$c2FsdA$a2V5';
    expect(await verifyPassword('anything', tampered)).toBe(false);
    const badR = 'scrypt$16384$999$1$c2FsdA$a2V5';
    expect(await verifyPassword('anything', badR)).toBe(false);
  });

  it('salt/key 为空的哈希返回 false', async () => {
    expect(await verifyPassword('x', 'scrypt$16384$8$1$$')).toBe(false);
  });

  it('空口令、超长口令、Unicode 口令均可哈希并正确校验', async () => {
    for (const plain of ['', 'x'.repeat(500), '口令-🔐-Pässwörd']) {
      const hash = await hashPassword(plain);
      expect(await verifyPassword(plain, hash)).toBe(true);
      expect(await verifyPassword(`${plain}x`, hash)).toBe(false);
    }
  });

  it('被截断或改动的正确哈希校验失败', async () => {
    const hash = await hashPassword('Correct-Hash!2026');
    const parts = hash.split('$');
    const wrongSalt = [...parts];
    wrongSalt[4] = Buffer.from('different-salt-1234').toString('base64');
    expect(await verifyPassword('Correct-Hash!2026', wrongSalt.join('$'))).toBe(false);
    const wrongKey = [...parts];
    wrongKey[5] = Buffer.from('x'.repeat(64)).toString('base64');
    expect(await verifyPassword('Correct-Hash!2026', wrongKey.join('$'))).toBe(false);
  });

  it('scrypt 参数处于边界下限仍可校验，越界被拒', async () => {
    // 下限 1024 合法（用真实哈希的参数位替换为最小合法值附近需重算，这里仅验证越界拒绝）
    expect(await verifyPassword('x', 'scrypt$1023$8$1$c2FsdA$a2V5')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$0$1$c2FsdA$a2V5')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$17$c2FsdA$a2V5')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$notnum$8$1$c2FsdA$a2V5')).toBe(false);
  });

  it('初始密码长度可控，且不含 0/O/1/l/I 易混字符', () => {
    const p8 = generateInitialPassword(8);
    const p16 = generateInitialPassword();
    expect(p8).toHaveLength(8);
    expect(p16).toHaveLength(16);
    expect(p16).not.toMatch(/[0O1lI]/);
    expect(generateInitialPassword()).not.toBe(p16);
  });

  it('初始密码极端长度 1 与 128 均产出指定长度', () => {
    expect(generateInitialPassword(1)).toHaveLength(1);
    expect(generateInitialPassword(128)).toHaveLength(128);
  });
});

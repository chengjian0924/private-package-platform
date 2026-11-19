import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// 参数取 Node 默认同档（N=16384, r=8, p=1）：单次约 50-80ms，足以拖慢离线爆破又不影响登录体验
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
const SALT_LEN = 16;

/** 存储格式 scrypt$N$r$p$salt$key：参数随哈希保存，日后调参不会让存量口令失效 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(plain, salt, KEY_LEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * 校验口令。任何解析失败都返回 false 而非抛错：
 * 存量脏数据（如 password_hash 为 NULL）只应表现为该账号登不上，不能把 500 抛给登录接口。
 */
export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 上限防 DoS：被篡改的哈希不能把 scrypt 的 N 撑到天文数字拖垮进程
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scryptAsync(plain, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 返回首个不满足项的中文描述；null 表示通过。不含复杂度硬要求，避免内网用户把口令写在便签上 */
export function validatePasswordStrength(plain: string, username: string, minLength: number): string | null {
  if (plain.length < minLength) return `长度需不少于 ${minLength} 位`;
  if (plain.length > 128) return '长度不能超过 128 位';
  if (username && plain.toLowerCase().includes(username.toLowerCase())) return '不能包含用户名';
  if (/^(.)\1+$/u.test(plain)) return '不能为单一字符重复';
  const weak = ['password', '123456', 'qwerty', 'admin', 'letmein', 'welcome'];
  if (weak.some((item) => plain.toLowerCase().includes(item))) return '包含常见弱口令片段';
  return null;
}

// 去掉 0/O/1/l/I 等易混字符：初始密码常靠口头或纸面传递，必须能一次抄对
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_';

/** 一次性初始密码：由管理员建号/重置时生成，配合 must_change_password 强制首登改密 */
export function generateInitialPassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

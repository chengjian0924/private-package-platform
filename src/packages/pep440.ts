/**
 * PEP 440 版本号解析与规范化（纯函数，无外部依赖）。
 *
 * 目的：让 `1` / `1.0` / `1.0.0` / `v1.0` 这类在 PEP 440 语义下等价的版本
 * 落到同一个键，从而被 UNIQUE(package_id, normalized_version) 挡住，只保留一个。
 *
 * 参考 packaging.version.Version 的相等语义（Version.__eq__ / _cmpkey）：
 * - 前导 v 忽略，epoch 默认 0（1!1.0 与 1.0 不等）
 * - release 段去掉尾部零（1 == 1.0 == 1.0.0，0 == 0.0）
 * - pre 别名归一：alpha→a、beta→b、c/pre/preview→rc，缺省序号为 0
 * - post 别名归一：-N、postN/revN/rN，缺省序号为 0；「无 post」与「post0」不等
 * - dev 缺省序号为 0；「无 dev」与「dev0」不等
 * - local 段小写、分隔符 -_. 统一为 .、纯数字段去前导零
 *
 * 保持为独立模块是因为 database.service（存量迁移）与 packages.service（查重/查询）
 * 都要用它，而 packages.service 依赖 database.service，放在服务里会形成循环引用。
 */

export interface Pep440Parts {
  epoch: number;
  release: number[];
  pre: { label: 'a' | 'b' | 'rc'; num: number } | null;
  post: number | null;
  dev: number | null;
  local: string | null;
}

// 长别名在前，避免 a 抢先匹配 alpha、b 抢先匹配 beta、pre 抢先匹配 preview
const VERSION_RE =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** 解析 PEP 440 版本号；非法返回 null */
export function parsePep440(raw: string): Pep440Parts | null {
  if (typeof raw !== 'string') return null;
  const match = VERSION_RE.exec(raw);
  if (!match) return null;

  const release = match[2].split('.').map((part) => Number.parseInt(part, 10));
  if (release.some((n) => !Number.isSafeInteger(n))) return null;

  let pre: Pep440Parts['pre'] = null;
  if (match[3]) {
    const label = match[3].toLowerCase();
    const canonical =
      label === 'alpha' || label === 'a' ? 'a' : label === 'beta' || label === 'b' ? 'b' : 'rc';
    pre = { label: canonical, num: toInt(match[4], 0) };
  }

  const post = match[5] !== undefined ? toInt(match[5], 0) : match[6] !== undefined ? toInt(match[6], 0) : null;
  const dev = match[7] !== undefined ? toInt(match[7], 0) : null;
  const local = match[8]
    ? match[8]
        .toLowerCase()
        .split(/[-_.]+/)
        .map((segment) => (/^\d+$/.test(segment) ? String(Number.parseInt(segment, 10)) : segment))
        .join('.')
    : null;

  return { epoch: toInt(match[1], 0), release, pre, post, dev, local };
}

export function isValidPep440Version(raw: string): boolean {
  return parsePep440(raw) !== null;
}

/**
 * 相等语义键：PEP 440 相等的版本必然产生相同字符串。
 * 仅用于查重与查询，不作为对外展示的版本号（展示仍用上传时的原始 version，与文件名一致）。
 */
export function pep440VersionKey(raw: string): string | null {
  const parts = parsePep440(raw);
  if (!parts) return null;

  // release 去尾部零，全零时保留一段，保证 1 == 1.0 == 1.0.0、0 == 0.0
  const release = [...parts.release];
  while (release.length > 1 && release[release.length - 1] === 0) release.pop();

  // 无 pre 且有 dev 时 pre 为 -Infinity，完全 final 时为 +Infinity：
  // 两者都「没有 pre 标签」，但彼此不等，且与任何 a/b/rc 都不等，用哨兵区分。
  const pre = parts.pre ? `${parts.pre.label}${parts.pre.num}` : parts.dev !== null ? '~' : 'z';
  const post = parts.post === null ? '-' : `p${parts.post}`;
  const dev = parts.dev === null ? '-' : `d${parts.dev}`;
  const local = parts.local === null ? '-' : `+${parts.local}`;

  return `${parts.epoch}!${release.join('.')}|${pre}|${post}|${dev}|${local}`;
}

/** 非法版本号的兼容键：沿用历史口径，交由校验层拦截 PKG_VERSION_INVALID */
export function fallbackPypiVersionKey(raw: string): string {
  return (raw || '').trim().toLowerCase().replace(/^v/, '');
}

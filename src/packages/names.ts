/**
 * 包名规范化与生态类型独立成模块。
 * 原因：vuln.service 需要 normalizeName，而 packages.service 依赖 security.service，
 * 三者形成运行时循环引用；把纯函数拆出来可打破 security → vuln → packages → security 的闭环。
 */
export type Ecosystem = 'npm' | 'pypi';

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function normalizeName(ecosystem: Ecosystem, name: string): string {
  const trimmed = (name || '').trim();
  if (ecosystem === 'npm') {
    const lower = trimmed.toLowerCase();
    return NPM_NAME.test(lower) ? lower : '';
  }
  return trimmed.toLowerCase().replace(/[-_.]+/g, '-');
}

export function isValidName(ecosystem: Ecosystem, name: string): boolean {
  const normalized = normalizeName(ecosystem, name);
  if (!normalized || normalized.length > 214) return false;
  if (ecosystem === 'npm') return NPM_NAME.test(normalized);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized);
}

/**
 * npm 包元数据的透传白名单。
 *
 * 只透传安装解析确实需要、且不包含敏感执行内容的字段：
 * - dependencies / peerDependencies / optionalDependencies：版本解析
 * - engines / os / cpu：运行时与平台兼容性判断
 * - bin / main / module / exports：入口与可执行文件声明
 * - dsh：DeepSeek Harness 识别插件组合包（dsh.bundle）
 * - description / license / repository / homepage / keywords：展示与溯源
 *
 * 刻意不透传 scripts、publishConfig、_npmUser 等：可能含内网构建命令、
 * 内部 registry 地址或发布者信息；dist / security / dist-tags 由服务端计算。
 */
export const NPM_PASSTHROUGH_FIELDS = [
  'description',
  'engines',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'os',
  'cpu',
  'bin',
  'main',
  'module',
  'exports',
  'dsh',
  'license',
  'repository',
  'homepage',
  'keywords',
] as const;

export function pickNpmMetadata(
  source: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!source) return picked;
  for (const field of NPM_PASSTHROUGH_FIELDS) {
    const value = source[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

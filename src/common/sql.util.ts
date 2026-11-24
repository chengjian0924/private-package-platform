/**
 * SQL LIKE 文本匹配的小工具。
 *
 * SQLite 的 LIKE 中 `%` 匹配任意长度、`_` 匹配单字符。用户输入里出现这些字符
 * （如搜索 `100%`、`foo_bar`、Windows 风格的 `a\b`）时，若不转义，模式会被
 * 解释成通配符：搜 `%` 会命中全表，搜 `a_b` 会命中 `acb`。这里统一转义，
 * 让用户输入始终按字面量匹配。
 *
 * 注意：调用方必须在 SQL 中显式写 `LIKE ? ESCAPE '\'`，反斜杠才会被识别为
 * 转义符；只转义不加 ESCAPE 反而会匹配到字面反斜杠。
 */
export function likeContains(value: string): string {
  // 先转义反斜杠本身，再转义两个通配符，顺序不能颠倒
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

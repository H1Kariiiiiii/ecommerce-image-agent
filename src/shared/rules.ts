/**
 * 货号匹配工具：供 OCR 定位使用。
 * 纯函数，不依赖任何运行时环境，方便单元测试。
 */

/**
 * 生成 OCR 匹配货号的锚点正则：
 * 用户输入旧前缀（如 TOY）时，优先匹配以该前缀开头的文字；
 * 不输入时匹配通用货号形态（字母+数字）。
 *
 * 支持常见分隔符：- _ . / 空格（如 NO.JT888-10 / ABC/123 / ITEM-2024-A）。
 */
export function buildGoodsNumberPattern(anchor?: string): RegExp {
  // 分隔符集合（点号需转义）
  const SEP = '[\\-_ ./]'
  const a = anchor?.trim()
  if (a) {
    return new RegExp(
      `\\b${escapeRegExp(a)}(?:${SEP}?[A-Za-z0-9])*\\d[A-Za-z0-9${SEP}]*`,
      'i'
    )
  }
  // 字母开头（1~10 位），中间可有分隔符，必须含数字，可带尾缀
  return new RegExp(`[A-Za-z]{1,10}(?:${SEP}?[A-Za-z0-9])*\\d[A-Za-z0-9${SEP}]*`, 'g')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

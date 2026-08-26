import type { TextRegion } from '../../shared/types'
import { recognizeRegionText } from './ppocrRec'
import { buildGoodsNumberPattern } from '../../shared/rules'

/**
 * PP-OCR 货号检测（纯 PP-OCR 方案，无 Tesseract）：
 * 在整个图片上滑动扫描横向条带，每条带用 PP-OCR rec 识别文字，
 * 用货号正则（字母开头 + 数字 + 分隔符）匹配，取评分最高的结果。
 *
 * 条带策略（电商产品图货号常见位置排序）：
 * - 全图横向条带从下往上（货号常在底部），重叠滑动保证不漏；
 * - 条带高度取得较小（近似单行），避免把多行内容混在一起。
 */
export async function detectGoodsNumberV2(
  inputPath: string,
  anchor?: string
): Promise<{ text: string; region: TextRegion; confidence: number } | null> {
  const pattern = buildGoodsNumberPattern(anchor)
  const anchorLower = anchor?.trim().toLowerCase()

  // 全图条带：从下往上扫（货号常在底部），步长 0.7×条带高，重叠保证不漏
  const stripH = 0.09
  // 条带太矮 rec 识别会困难，太低会扫很多次；用 0.09 高 + 重叠
  let best: { text: string; region: TextRegion; confidence: number } | null = null
  let bestScore = -Infinity

  const seen = new Set<string>()
  for (let y = 1 - stripH; y >= -stripH * 0.5; y -= stripH * 0.7) {
    const region: TextRegion = {
      x: 0.04,
      y: Math.max(0, y),
      width: 0.92,
      height: Math.min(stripH, 1 - y)
    }
    if (region.height <= 0.02) continue

    const key = `${region.y.toFixed(2)}_${region.height.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)

    let result
    try {
      result = await recognizeRegionText(inputPath, region)
    } catch {
      continue
    }
    const text = (result?.text ?? '').trim()
    if (!text) continue

    let matched = false
    if (anchorLower) {
      matched = text.toLowerCase().startsWith(anchorLower) && /\d/.test(text)
    } else {
      pattern.lastIndex = 0
      matched = pattern.test(text)
    }
    if (!matched) continue

    // 评分：置信度 + 完整度（含数字且长度适中加分）+ 底部位置加分
    let score = result.confidence * 100
    if (/\d/.test(text)) score += 15
    score += Math.min(text.length * 2, 20)
    score += region.y * 3

    if (score > bestScore) {
      bestScore = score
      best = { text, region, confidence: result.confidence }
    }
  }

  return best
}

/**
 * PP-OCR 识别指定区域（供样式提取/校对用）。
 * 返回识别文本与置信度；失败返回 null。
 */
export async function recognizeWithPpOcr(
  inputPath: string,
  region: TextRegion
): Promise<{ text: string; confidence: number } | null> {
  try {
    const res = await recognizeRegionText(inputPath, region)
    if (!res.text.trim()) return null
    return res
  } catch {
    return null
  }
}

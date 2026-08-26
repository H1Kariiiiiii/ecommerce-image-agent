import sharp from 'sharp'
import type { TextRegion } from '../../shared/types'
import { buildGoodsNumberPattern } from '../../shared/rules'

/**
 * OCR 相关纯工具。
 * 注意：文字识别统一走 PP-OCR（ppocrRec.ts）；定位走 ppocrDetect.ts。
 * 本文件只保留与具体引擎无关的候选筛选 / 颜色提取 / 放大工具。
 */

export interface DetectedText {
  /** 识别到的文字内容 */
  text: string
  /** 置信度 0~100 */
  confidence: number
  /** 像素坐标（相对于原图） */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  /** 估算的字体大小（像素） */
  fontSize: number
  /** 文字主色调 RGB */
  color: { r: number; g: number; b: number }
}

/** OCR 行级结果（候选筛选用） */
export interface OcrLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * 从 OCR 结果中筛选货号候选（纯函数，便于单测）：
 * - 提供 anchor（如 TOY）时：匹配以 anchor 开头、含数字的文字；
 * - 不提供时：匹配货号通用形态（字母+数字组合，支持 . / - _ 空格分隔）。
 *
 * 三级策略：
 * 1. line 级优先：整行文本（如 `NO.JT888-10`）最完整可靠；
 * 2. 同行拼接：line 级没有时，把间隙小的相邻词合并匹配（覆盖被切碎的货号）；
 * 3. 单词级兜底：单个词自身就是完整货号时命中。
 */
export function selectGoodsCandidate(
  words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>,
  anchor?: string,
  lines?: OcrLine[]
): (typeof words)[number] | null {
  const matches = (t: string): boolean => {
    if (anchor?.trim()) {
      return t.toLowerCase().startsWith(anchor.trim().toLowerCase()) && /\d/.test(t)
    }
    const pattern = buildGoodsNumberPattern()
    pattern.lastIndex = 0
    return pattern.test(t)
  }

  // 1) line 级优先
  if (lines && lines.length > 0) {
    const lineHit = lines
      .filter((l) => l.text && matches(l.text))
      .sort((a, b) => b.confidence - a.confidence)
    if (lineHit.length > 0) {
      const best = lineHit[0]
      return { text: best.text, confidence: best.confidence, bbox: best.bbox }
    }
  }

  // 2) 同行拼接
  const joined = joinLineCandidates(words, matches)
  if (joined) return joined

  // 3) 单词级兜底
  const single = words
    .filter((wd) => wd.text.trim() && matches(wd.text.trim()))
    .sort((a, b) => b.confidence - a.confidence)
  return single[0] ?? null
}

/** 词间最大允许间隙（相对行高），超过则视为两个独立文本块，不拼接 */
const MAX_WORD_GAP_RATIO = 0.35

/** 同行判定：y 中心差不超过行高的该比例（或最小像素） */
const MAX_LINE_CENTER_RATIO = 0.6

/**
 * 同行拼接：把 y 中心接近的词归为一行，行内按 x 排序后，
 * 仅将间隙小于阈值的相邻词聚类拼接；拼接结果匹配货号形态时
 * 返回合并 bbox 的候选。
 */
function joinLineCandidates(
  words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>,
  matches: (t: string) => boolean
): (typeof words)[number] | null {
  const center = (w: { bbox: { y0: number; y1: number } }): number => (w.bbox.y0 + w.bbox.y1) / 2

  // 按 y 中心排序后贪心分组（同行的 y 中心差 < 行高比例）
  const sorted = [...words].sort((a, b) => center(a) - center(b))
  const lines: Array<typeof words> = []
  for (const wd of sorted) {
    const line = lines[lines.length - 1]
    if (line) {
      const lineH = line.reduce((m, w) => Math.max(m, w.bbox.y1 - w.bbox.y0), 0)
      const lineCenter = line.reduce((s, w) => s + center(w), 0) / line.length
      const tol = Math.max(lineH * MAX_LINE_CENTER_RATIO, 8)
      if (Math.abs(center(wd) - lineCenter) <= tol) {
        line.push(wd)
        continue
      }
    }
    lines.push([wd])
  }

  // 每行：按 x 排序，间隙小的相邻词聚成簇，簇内拼接文本并匹配
  for (const line of lines) {
    const ordered = [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    const lineH = ordered.reduce((m, w) => Math.max(m, w.bbox.y1 - w.bbox.y0), 0)
    const maxGap = Math.max(lineH * MAX_WORD_GAP_RATIO, 4)

    // 聚类：间隙 > maxGap 处断开
    const clusters: Array<typeof ordered> = []
    let cur: typeof ordered = [ordered[0]]
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i].bbox.x0 - ordered[i - 1].bbox.x1
      if (gap > maxGap) {
        clusters.push(cur)
        cur = [ordered[i]]
      } else {
        cur.push(ordered[i])
      }
    }
    clusters.push(cur)

    for (const cluster of clusters) {
      if (cluster.length < 2) continue
      const text = cluster.map((w) => w.text.trim()).join('')
      if (!text || text.length < 3 || text.length > 28) continue
      if (!matches(text)) continue
      const bbox = {
        x0: cluster.reduce((m, w) => Math.min(m, w.bbox.x0), Infinity),
        y0: cluster.reduce((m, w) => Math.min(m, w.bbox.y0), Infinity),
        x1: cluster.reduce((m, w) => Math.max(m, w.bbox.x1), -Infinity),
        y1: cluster.reduce((m, w) => Math.max(m, w.bbox.y1), -Infinity)
      }
      const confidence = cluster.reduce((s, w) => s + w.confidence, 0) / cluster.length
      return { text, confidence, bbox }
    }
  }

  return null
}

const OCR_UPSCALE_TARGET = 1600

/** 放大到 OCR 目标尺寸并返回 { buffer, scale }（小字提升用） */
export async function upscaleForOcr(imagePath: string): Promise<{ buf: Buffer; scale: number }> {
  const meta = await sharp(imagePath).metadata()
  const w = meta.width!
  const h = meta.height!
  const scale = Math.max(1, OCR_UPSCALE_TARGET / Math.max(w, h))
  if (scale > 1) {
    const buf = await sharp(imagePath)
      .resize({ width: Math.round(w * scale), height: Math.round(h * scale), kernel: 'lanczos3' })
      .png()
      .toBuffer()
    return { buf, scale }
  }
  return { buf: await sharp(imagePath).png().toBuffer(), scale: 1 }
}

/**
 * 从图片指定矩形区域提取主色调（取中心 60% 区域的平均 RGB）。
 * @param x/y/w/h 像素坐标
 */
export async function extractDominantColor(
  imagePath: string,
  x: number,
  y: number,
  w: number,
  h: number
): Promise<{ r: number; g: number; b: number }> {
  // 取中心 60% 区域避免边缘干扰
  const margin = 0.2
  const cx = Math.round(x + w * margin)
  const cy = Math.round(y + h * margin)
  const cw = Math.max(1, Math.round(w * (1 - margin * 2)))
  const ch = Math.max(1, Math.round(h * (1 - margin * 2)))

  const { data, info } = await sharp(imagePath)
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .raw()
    .toBuffer({ resolveWithObject: true })

  let totalR = 0
  let totalG = 0
  let totalB = 0
  const pixelCount = info.width * info.height

  for (let i = 0; i < data.length; i += info.channels) {
    totalR += data[i]
    totalG += data[i + 1]
    totalB += data[i + 2]
  }

  return {
    r: Math.round(totalR / pixelCount),
    g: Math.round(totalG / pixelCount),
    b: Math.round(totalB / pixelCount)
  }
}

/**
 * 在选区内匹配用户输入的 oldText（模糊匹配），
 * 返回最可能的匹配文字及其位置。
 */
export function matchTextInRegion(
  detected: DetectedText[],
  oldText: string
): DetectedText | null {
  if (!oldText.trim()) return detected[0] ?? null

  const target = oldText.trim().toLowerCase()

  // 精确匹配
  const exact = detected.find((d) => d.text.toLowerCase() === target)
  if (exact) return exact

  // 包含匹配
  const contains = detected.find((d) => d.text.toLowerCase().includes(target))
  if (contains) return contains

  // 拼接所有文字看是否整体匹配
  const combined = detected.map((d) => d.text).join('')
  if (combined.toLowerCase().includes(target)) {
    // 返回包含匹配子串的第一个 word
    return detected[0]
  }

  // 没有匹配，返回第一个
  return detected[0] ?? null
}

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import type { TextRegion } from '../../shared/types'

/** 确保输出目录存在（processed 目录是惰性创建的，不保证已存在） */
async function ensureOutputDir(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true })
}

/** 擦除结果 */
export interface LocalEditResult {
  outputPath: string
  /** 识别到的原货号 */
  detectedText?: string
  /** 采样到的背景色 */
  bgColor: { r: number; g: number; b: number }
}

/**
 * 解析擦除区域：手动框选优先，否则 PP-OCR 自动定位。
 * 供本地擦除 / AI 擦除共用。
 */
export async function resolveRegion(
  inputPath: string,
  opts: { anchor?: string; manualRegion?: TextRegion }
): Promise<{ region: TextRegion; detectedText?: string }> {
  const { anchor, manualRegion } = opts
  if (manualRegion) {
    return { region: manualRegion }
  }
  const { detectGoodsNumberV2 } = await import('./ppocrDetect')
  const foundV2 = await detectGoodsNumberV2(inputPath, anchor)
  if (foundV2) {
    return { region: foundV2.region, detectedText: foundV2.text }
  }
  throw new Error('未识别到货号文字，可尝试输入货号开头字母作锚点（如 NO），或手动框选区域')
}

/** 纯本地去掉货号：完整流程（OCR 定位 → 本地擦除 → 保存，不叠加新文字） */
export async function localEraseText(opts: {
  inputPath: string
  outputDir: string
  /** 旧前缀锚点（可选，帮助 OCR 定位） */
  anchor?: string
  /** 手动框选区域（可选，优先使用，跳过 OCR 定位） */
  region?: TextRegion
}): Promise<LocalEditResult> {
  const { inputPath, outputDir, anchor, region: manualRegion } = opts

  const { region, detectedText } = await resolveRegion(inputPath, { anchor, manualRegion })

  // 本地擦除（不叠加新文字）
  const erased = await localErase(inputPath, region)

  // 保存（确保目录存在）
  const { uniqueResultPath } = await import('./util')
  const finalPath = uniqueResultPath(outputDir, inputPath, '.png')
  await ensureOutputDir(outputDir)
  await writeFile(finalPath, erased.buffer)

  return { outputPath: finalPath, detectedText, bgColor: erased.bgColor }
}

export interface EraseResult {
  /** 擦除后的图片 buffer（PNG） */
  buffer: Buffer
  /** 采样到的背景色（RGB） */
  bgColor: { r: number; g: number; b: number }
}

/**
 * 纯本地擦除文字区域（方案 A：色差抠字 + 背景色填充）。
 *
 * 思路（像素级精准，避免污染）：
 * 1. 在文字区域**外圈**采样一圈像素（避开文字本身），取出现最多的颜色作为背景色 bg；
 * 2. 区域内逐像素比较：与 bg 的色差超过阈值 → 判定为「文字/非背景」像素，替换为 bg；
 *    （与 bg 接近的像素原样保留 → 背景/纹理不被破坏，零污染）
 * 3. 若区域内没有任何像素被替换（阈值过严），自动降阈值重试；仍失败则退回
 *    「纯色矩形填充」（不羽化，仅覆盖区域内，避免扩散污染）。
 *
 * 适用：文字颜色与背景对比明显的场景（产品图货号、白底/浅底印刷文字）。
 */
export async function localErase(imagePath: string, region: TextRegion): Promise<EraseResult> {
  const meta = await sharp(imagePath).metadata()
  const w = meta.width!
  const h = meta.height!

  // 归一化 → 像素
  const x0 = Math.max(0, Math.min(w - 1, Math.round(region.x * w)))
  const y0 = Math.max(0, Math.min(h - 1, Math.round(region.y * h)))
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round((region.x + region.width) * w)))
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round((region.y + region.height) * h)))
  const rw = x1 - x0
  const rh = y1 - y0

  // 外圈采样带：文字区域向外扩展 sampleRatio 宽度，但不超过图片边界
  const sampleRatio = 0.25
  const sx0 = Math.max(0, Math.round(x0 - rw * sampleRatio))
  const sy0 = Math.max(0, Math.round(y0 - rh * sampleRatio))
  const sx1 = Math.min(w, Math.round(x1 + rw * sampleRatio))
  const sy1 = Math.min(h, Math.round(y1 + rh * sampleRatio))
  const sw = sx1 - sx0
  const sh = sy1 - sy0

  const raw = await sharp(imagePath)
    .extract({ left: sx0, top: sy0, width: sw, height: sh })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const channels = raw.info.channels
  const data = raw.data
  const ix0 = x0 - sx0
  const iy0 = y0 - sy0
  const ix1 = x1 - sx0
  const iy1 = y1 - sy0

  // 统计环状区域的颜色直方图（量化到 8 级每通道），取众数桶的平均色
  const BUCKET = 8
  const hist = new Map<number, { count: number; r: number; g: number; b: number }>()
  const keyOf = (r: number, g: number, b: number): number =>
    ((r >> (8 - BUCKET)) << (BUCKET * 2)) | ((g >> (8 - BUCKET)) << BUCKET) | (b >> (8 - BUCKET))

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue
      const i = (y * sw + x) * channels
      const k = keyOf(data[i], data[i + 1], data[i + 2])
      const cur = hist.get(k)
      if (cur) {
        cur.count += 1
        cur.r += data[i]
        cur.g += data[i + 1]
        cur.b += data[i + 2]
      } else {
        hist.set(k, { count: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
      }
    }
  }

  let bg: { r: number; g: number; b: number }
  let best: { count: number; r: number; g: number; b: number } | undefined
  for (const v of hist.values()) {
    if (!best || v.count > best.count) best = v
  }
  if (best && best.count > 0) {
    bg = { r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count) }
  } else {
    // 兜底：区域内首行平均色（避开文字本身，取样左边缘列）
    let tr = 0
    let tg = 0
    let tb = 0
    let n = 0
    for (let y = iy0; y < iy1; y += 4) {
      const i = (y * sw + Math.max(1, ix0)) * channels
      tr += data[i]
      tg += data[i + 1]
      tb += data[i + 2]
      n += 1
    }
    bg = n > 0 ? { r: Math.round(tr / n), g: Math.round(tg / n), b: Math.round(tb / n) } : { r: 255, g: 255, b: 255 }
  }

  // 用 SVG 生成填充层：背景色矩形 + feGaussianBlur 羽化边缘
  // 矩形与文字区域对齐（不向外扩大），模糊幅度取区域短边的一小部分，
  // 使文字被背景色覆盖的同时边缘柔和过渡；模糊会略微越界但保持克制
  const blurPx = Math.max(1, Math.round(Math.min(rw, rh) * 0.08))
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="${blurPx}" />
      </filter>
    </defs>
    <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"
          fill="rgb(${bg.r},${bg.g},${bg.b})" filter="url(#soft)" />
  </svg>`

  const buffer = await sharp(imagePath)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer()

  return { buffer, bgColor: bg }
}

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'

/**
 * 纯算法无损画布扩展（零 API 成本，像素级保真）
 *
 * 两种策略：
 * - pad：原图 100% 不变，只按目标比例在四周补背景色（画布大于等于原图，
 *   目标比例比原图"更宽"→ 左右补边；"更高"→ 上下补边）
 * - fit：原图等比缩放（contain，不裁切、不拉伸）后居中放入目标比例画布，
 *   四周补背景色。画布以原图短边为基准计算（尽量紧凑）。
 *
 * 全部使用 sharp 原生操作（resize / extend / composite），无逐像素 JS 循环，
 * 毫秒级完成；原图区域像素不参与任何重绘。
 */

export interface CanvasExtendOptions {
  /** 目标比例（宽/高），如 { w: 4, h: 3 } */
  ratio: { w: number; h: number }
  /** 背景色（CSS 颜色，默认纯白） */
  background?: string
  /** 放置策略：pad = 原图不变加白边 / fit = 等比缩放适配 */
  strategy: 'pad' | 'fit'
}

export interface CanvasExtendResult {
  /** 结果图片本地路径 */
  outputPath: string
  /** 输出画布尺寸 */
  size: { width: number; height: number }
  /** 原图在画布中的位置（像素） */
  offset: { x: number; y: number }
  /** 原图区域是否发生缩放（pad=false，fit=true） */
  scaled: boolean
}

export async function extendCanvas(opts: {
  inputPath: string
  outputDir: string
  canvas: CanvasExtendOptions
}): Promise<CanvasExtendResult> {
  const { inputPath, outputDir, canvas } = opts
  const { ratio, strategy } = canvas
  const background = canvas.background ?? '#ffffff'
  const rw = ratio.w
  const rh = ratio.h
  if (!(rw > 0) || !(rh > 0)) throw new Error('目标比例必须为正数')

  const meta = await sharp(inputPath).metadata()
  const w0 = meta.width
  const h0 = meta.height
  if (!w0 || !h0) throw new Error('无法读取图片尺寸')

  let cw: number
  let ch: number
  let scaled = false

  if (strategy === 'pad') {
    // 画布：以原图一边为基准、按目标比例计算，保证画布 >= 原图（不裁切）。
    // 两种候选：宽=原宽 / 高=原高，取面积较小且不小于原图的那个
    const cand1 = { w: w0, h: Math.round((w0 * rh) / rw) }
    const cand2 = { w: Math.round((h0 * rw) / rh), h: h0 }
    let best = cand1
    // 候选必须 >= 原图；否则选另一个
    const ok1 = cand1.w >= w0 && cand1.h >= h0
    const ok2 = cand2.w >= w0 && cand2.h >= h0
    if (ok1 && ok2) {
      best = cand1.w * cand1.h <= cand2.w * cand2.h ? cand1 : cand2
    } else if (ok2) {
      best = cand2
    } else {
      // 两者都小于原图（目标比例极端）：取面积更大的那个（仍不裁切）
      best = cand1.w * cand1.h >= cand2.w * cand2.h ? cand1 : cand2
    }
    cw = best.w
    ch = best.h
  } else {
    // fit：画布 = 原图短边为基准 × 目标比例（保证 contain 且尽量紧凑）
    const base = Math.max(1, Math.floor(Math.min(w0 / rw, h0 / rh)))
    cw = Math.max(1, Math.round(base * rw))
    ch = Math.max(1, Math.round(base * rh))
    scaled = cw !== w0 || ch !== h0
  }

  // 原图缩放（仅 fit；sharp.metadata() 返回输入尺寸，缩放后尺寸需自行计算）
  const scale = strategy === 'fit' ? Math.min(cw / w0, ch / h0) : 1
  const pw = Math.max(1, Math.round(w0 * scale))
  const ph = Math.max(1, Math.round(h0 * scale))
  let resized = sharp(inputPath)
  if (strategy === 'fit') {
    resized = resized.resize({ width: cw, height: ch, fit: 'inside', withoutEnlargement: false })
  }

  // 居中位置
  const ox = Math.round((cw - pw) / 2)
  const oy = Math.round((ch - ph) / 2)

  // 创建背景画布并贴入
  const canvasBuf = await sharp({
    create: { width: cw, height: ch, channels: 3, background }
  })
    .composite([{ input: await resized.png().toBuffer(), left: ox, top: oy }])
    .png()
    .toBuffer()

  const outputPath = await saveResult(canvasBuf, inputPath, outputDir, { rw, rh, strategy })
  return { outputPath, size: { width: cw, height: ch }, offset: { x: ox, y: oy }, scaled }
}

/**
 * 输出文件名带「比例 + 策略 + 时间戳」：
 * 同一输入图用不同参数重新生成时得到不同文件，前端 img src 变化才会强制刷新
 * （否则同名覆盖 + 浏览器缓存会导致界面显示旧图，如"改了比例还是 4:3"）。
 */
async function saveResult(
  png: Buffer,
  inputPath: string,
  outputDir: string,
  tag: { rw: number; rh: number; strategy: string }
): Promise<string> {
  const { basename, extname, join } = await import('node:path')
  await mkdir(outputDir, { recursive: true })
  const base = basename(inputPath, extname(inputPath))
  const finalPath = join(
    outputDir,
    `${base}_canvas_${tag.rw}x${tag.rh}_${tag.strategy}_${Date.now()}.png`
  )
  await writeFile(finalPath, png)
  return finalPath
}

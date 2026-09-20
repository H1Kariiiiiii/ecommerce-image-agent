/**
 * 单张产品图的货号改写（纯算法，零 API 成本）
 * ==========================================
 * 对应原 Python 工具 label_tool.py 的 process_one：
 *
 *   1. 定位 —— 底部几何投影找出货号行（labelDetect.ts）
 *   2. 亚像素细化 —— 用灰度覆盖率把外框从 ±1px 收敛到 ±0.05px
 *   3. 估背景色 —— 外框四周一圈像素的中位数（浅色渐变底也成立）
 *   4. 擦除 —— 外框外扩 padX / padY 的矩形整块填成背景色
 *   5. 重绘 —— 用与原图字体实测匹配的 Arial Bold 渲染新文字，
 *              按 4 倍超采样栅格化到**亚像素**尺寸与位置，
 *              以「黑字 + 反相透明度」叠加 —— 与原图做逐像素相乘，
 *              数学上与 PIL 的 paste(color, box, mask) 完全等价。
 *   6. 自检 —— 写完重新读一遍，重绘模式查位置偏差，擦除模式查残留墨量。
 *
 * 与 Python 版的差异（都是修正/增强）：
 *   - 保留原图格式：PNG 仍存 PNG（Python 版一律存 JPEG，.png 会名不副实）；
 *   - 支持 WebP；GIF/BMP/TIFF 等无对应编码器的格式统一转存 PNG；
 *   - 字形尺寸与位置走亚像素（Python 版是整数外框，30px 高的字上有约 3% 字号误差）。
 */

import sharp from 'sharp'
import type { Metadata, OverlayOptions, Sharp } from 'sharp'
import type { LabelFileStatus, LabelMode } from '../../shared/types'
import {
  boxHeight,
  boxWidth,
  detectLabelBox,
  estimateBackgroundColor,
  parseCodeFromFilename,
  refineBoxSubpixel,
  resolveDetect,
  resolveTargetText,
  stemOf,
  type DetectConfig,
  type EdgeBox,
  type LabelBox
} from './labelDetect'

/** 字体链：首选 Arial Bold —— 拿真实产品图做过灰度叠加比对，与原图字体 IoU 0.934 */
export const DEFAULT_FONT_STACK =
  'Arial, "Arial Bold", "Liberation Sans", Helvetica, "DejaVu Sans", sans-serif'

const MAX_RENDER_SIZE = 2000

export interface ProcessLabelOptions {
  inputPath: string
  mode: LabelMode
  oldPrefix: string
  newPrefix: string
  fixedText?: string
  mapping?: Record<string, string>
  detect?: Partial<DetectConfig>
  padX?: number
  padY?: number
  /** JPEG 重编码质量 */
  quality?: number
  /** 只检测不产出结果图 */
  dryRun?: boolean
  /** 字体族（CSS font-family 写法）；缺省用 DEFAULT_FONT_STACK */
  fontStack?: string
  /**
   * 是否启用亚像素定位与栅格化（默认 true）。
   * 关掉后退化为整数外框 + 整数缩放，行为与原 Python 工具一致（用于对照或回退）。
   */
  subpixel?: boolean
}

export interface LabelOpResult {
  status: LabelFileStatus
  /** 检测到的文字框（整数，供界面展示与报告用） */
  box?: LabelBox
  /** 亚像素文字框（连续坐标） */
  edge?: EdgeBox
  /** 写入图片的新文字；null = 擦除；undefined = 未识别到 */
  text?: string | null
  note: string
  /** 处理后的图片（dryRun 时不产出） */
  buffer?: Buffer
  /** 前后对比图（crop 到文字行上下各 20px） */
  compareBuffer?: Buffer
  /** 建议的输出扩展名（含点） */
  outputExt: string
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface DetectHit {
  box: LabelBox | null
  /** 亚像素框（检测失败时为 null） */
  edge: EdgeBox | null
  width: number
  height: number
}

/** 灰度 raw + 检测 + 亚像素细化，供主流程与写后自检复用 */
async function detectInBuffer(input: string | Buffer, cfg: DetectConfig): Promise<DetectHit> {
  const img = sharp(input)
  const meta = await img.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (width <= 0 || height <= 0) return { box: null, edge: null, width: 0, height: 0 }
  const { data } = await img.greyscale().raw().toBuffer({ resolveWithObject: true })
  const box = detectLabelBox(data, width, height, cfg)
  return { box, edge: box ? refineBoxSubpixel(data, width, height, box, cfg) : null, width, height }
}

/**
 * 把文字渲染成「白底黑字」并裁到墨迹外框（等价于 PIL 的
 * 逐字号试探 + glyph.crop(inkBBox)），返回 PNG buffer 与墨迹尺寸。
 */
async function renderTrimmed(
  text: string,
  size: number,
  fontStack: string
): Promise<{ buf: Buffer; width: number; height: number }> {
  const pad = Math.ceil(size * 1.5)
  const w = Math.max(8, Math.ceil(size * 0.8 * text.length) + pad * 2)
  const h = Math.max(8, Math.ceil(size * 2) + pad * 2)
  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
    `<text x="${pad}" y="${pad + Math.round(size)}" font-family='${fontStack}' ` +
    `font-size="${size}" font-weight="bold" fill="#000000" xml:space="preserve">` +
    `${escapeXml(text)}</text></svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  // trim 以左上角像素（白）为基准裁掉四周空白 -> 得到墨迹外框。
  // threshold=127 等价于 PIL 的 `array < 128` 二值化边界（255-127=128）
  const trimmed = await sharp(png)
    .trim({ threshold: 127 })
    .toBuffer({ resolveWithObject: true })
  return { buf: trimmed.data, width: trimmed.info.width, height: trimmed.info.height }
}

/** 按给定像素尺寸渲染字形（白底黑字 PNG），供后续的亚像素栅格化使用 */
async function glyphAtSize(
  text: string,
  targetW: number,
  targetH: number,
  fontStack: string
): Promise<Buffer | null> {
  // 参考字号下量一次墨迹高度，按比例反推所需字号（比 Python 的逐号试探快得多）
  const REF = 200
  const probe = await renderTrimmed(text, REF, fontStack).catch(() => null)
  if (!probe || probe.height <= 0 || probe.width <= 0) return null
  const size = Math.max(8, Math.min(MAX_RENDER_SIZE, Math.round((REF * targetH) / probe.height)))
  const at = await renderTrimmed(text, size, fontStack).catch(() => null)
  const glyph = at && at.width > 0 && at.height > 0 ? at.buf : probe.buf
  return sharp(glyph).resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
}

/**
 * 整数路径（对应 Python 原版行为）：字形直接缩放到整数外框尺寸、贴在整数坐标上。
 * 保留它是为了能和新路径做 A/B 对照，也作为出问题时的回退开关。
 */
async function renderGlyphRgbaInteger(
  text: string,
  targetW: number,
  targetH: number,
  fontStack: string
): Promise<{ data: Buffer; width: number; height: number } | null> {
  if (targetW <= 0 || targetH <= 0) return null
  const png = await glyphAtSize(text, targetW, targetH, fontStack)
  if (!png) return null
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(targetW * targetH * 4)
  for (let i = 0, o = 0; i < data.length; i++, o += 4) {
    rgba[o] = 0
    rgba[o + 1] = 0
    rgba[o + 2] = 0
    rgba[o + 3] = 255 - data[i]
  }
  return { data: rgba, width: targetW, height: targetH }
}

/** 超采样倍率：把尺寸与位置的量化精度从 1px 提升到 1/SUBPIXEL_FACTOR px */
const SUBPIXEL_FACTOR = 4
/** 中间图上限，防止超大字号把内存吃满 */
const MAX_SUPERSAMPLE_PIXELS = 4_000_000

/**
 * 渲染新文字，按**亚像素**尺寸与位置输出可直接叠加的 RGBA 图
 * （RGB 全黑、Alpha = 255 - 字形灰度，与原图 source-over 等价于
 * PIL 的 `out.paste((0,0,0), box, 255 - glyph)`：只在笔画处按比例压暗）。
 *
 * 与整数版的关键区别：整数外框带 ±1px 量化误差，30px 高的字上就是 3% 的字号误差。
 * 这里先把字形按 SUB 倍分辨率栅格化、放到 1/SUB 像素精度的位置上，
 * 再做 SUB×SUB 盒式降采样 —— 等价于「按连续坐标栅格化字形」。
 *
 * @param widthF  连续宽度（像素，可为小数）
 * @param heightF 连续高度
 * @param offsetX 字形左边界在 tile 内的连续偏移，范围 [0,1)
 * @param offsetY 字形上边界在 tile 内的连续偏移，范围 [0,1)
 */
async function renderGlyphTile(
  text: string,
  widthF: number,
  heightF: number,
  offsetX: number,
  offsetY: number,
  fontStack: string
): Promise<{ data: Buffer; width: number; height: number } | null> {
  if (!(widthF > 0) || !(heightF > 0)) return null
  const tileW = Math.max(1, Math.ceil(widthF + offsetX))
  const tileH = Math.max(1, Math.ceil(heightF + offsetY))

  let sub = SUBPIXEL_FACTOR
  while (sub > 1 && tileW * tileH * sub * sub > MAX_SUPERSAMPLE_PIXELS) sub--

  const glyph = await glyphAtSize(
    text,
    Math.max(1, Math.round(widthF * sub)),
    Math.max(1, Math.round(heightF * sub)),
    fontStack
  )
  if (!glyph) return null

  const hiW = tileW * sub
  const hiH = tileH * sub
  const hi = await sharp({ create: { width: hiW, height: hiH, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: glyph,
        left: Math.min(hiW - 1, Math.max(0, Math.round(offsetX * sub))),
        top: Math.min(hiH - 1, Math.max(0, Math.round(offsetY * sub)))
      }
    ])
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // SUB×SUB 盒式降采样 = 精确的面积平均（sharp 没有 box 核，手写更可控）
  const rgba = Buffer.alloc(tileW * tileH * 4)
  const area = sub * sub
  const src = hi.data
  const srcW = hi.info.width
  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      let sum = 0
      for (let dy = 0; dy < sub; dy++) {
        const row = (y * sub + dy) * srcW + x * sub
        for (let dx = 0; dx < sub; dx++) sum += src[row + dx]
      }
      const o = (y * tileW + x) * 4
      rgba[o] = 0
      rgba[o + 1] = 0
      rgba[o + 2] = 0
      rgba[o + 3] = 255 - Math.round(sum / area)
    }
  }
  return { data: rgba, width: tileW, height: tileH }
}

/** 从图片元信息推断输出格式与扩展名（尽量保持原格式） */
function resolveOutputFormat(meta: Metadata, srcExt: string): { format: string; ext: string } {
  const ext = srcExt.toLowerCase()
  switch (meta.format) {
    case 'jpeg':
      return { format: 'jpeg', ext: ext === '.jpeg' ? '.jpeg' : '.jpg' }
    case 'png':
      return { format: 'png', ext: '.png' }
    case 'webp':
      return { format: 'webp', ext: '.webp' }
    default:
      return { format: 'png', ext: '.png' }
  }
}

function encodeResult(pipeline: Sharp, format: string, quality: number): Sharp {
  // 4:4:4 不做色度抽样（对应 Python 的 subsampling=0），避免细笔画发虚
  if (format === 'jpeg') return pipeline.jpeg({ quality, chromaSubsampling: '4:4:4' })
  if (format === 'webp') return pipeline.webp({ quality })
  return pipeline.png({ compressionLevel: 9 })
}

/** 前后对比图：文字行上下各留 20px，整幅宽，上下拼一张 */
async function buildCompareSheet(
  before: string,
  after: Buffer,
  box: LabelBox,
  imgW: number,
  imgH: number
): Promise<Buffer | undefined> {
  try {
    const y0 = Math.max(0, box.y0 - 20)
    const y1 = Math.min(imgH, box.y1 + 21)
    const h = y1 - y0
    if (h <= 0 || imgW <= 0) return undefined
    const top = await sharp(before).extract({ left: 0, top: y0, width: imgW, height: h }).toBuffer()
    const bottom = await sharp(after).extract({ left: 0, top: y0, width: imgW, height: h }).toBuffer()
    return await sharp({
      create: { width: imgW, height: h * 2 + 6, channels: 3, background: { r: 255, g: 210, b: 210 } }
    })
      .composite([
        { input: top, left: 0, top: 0 },
        { input: bottom, left: 0, top: h + 6 }
      ])
      .jpeg({ quality: 90 })
      .toBuffer()
  } catch {
    return undefined
  }
}

/**
 * 处理单张图片：定位 -> 亚像素细化 -> 擦除 ->（可选）重绘 -> 自检。
 * 只返回结果 buffer，不写磁盘（落盘由 labelBatch 负责，便于试跑与前置校验）。
 */
export async function processLabelImage(opts: ProcessLabelOptions): Promise<LabelOpResult> {
  const {
    inputPath,
    mode,
    oldPrefix,
    newPrefix,
    fixedText,
    mapping,
    padX = 24,
    padY = 14,
    quality = 95,
    dryRun = false,
    fontStack = DEFAULT_FONT_STACK
  } = opts
  const cfg: DetectConfig = resolveDetect(opts.detect)

  const srcExt = inputPath.slice(inputPath.lastIndexOf('.'))
  const baseMeta = await sharp(inputPath).metadata()
  const W = baseMeta.width ?? 0
  const H = baseMeta.height ?? 0
  if (W <= 0 || H <= 0) throw new Error('无法读取图片尺寸')
  const outFmt = resolveOutputFormat(baseMeta, srcExt)

  const hit = await detectInBuffer(inputPath, cfg)
  const box = hit.box
  if (!box || !hit.edge) {
    return { status: 'not-found', note: '未在底部找到货号文字', outputExt: outFmt.ext }
  }
  // subpixel=false 时退化为整数外框（与原 Python 工具一致）
  const useSubpixel = opts.subpixel !== false
  const edge: EdgeBox = useSubpixel
    ? hit.edge
    : {
        left: box.x0,
        top: box.y0,
        right: box.x1 + 1,
        bottom: box.y1 + 1,
        width: box.x1 + 1 - box.x0,
        height: box.y1 + 1 - box.y0
      }

  const fileName = inputPath.replace(/^.*[\\/]/, '')
  const baseName = stemOf(fileName)
  const code = parseCodeFromFilename(fileName) ?? baseName
  const text = resolveTargetText({ mode, code, baseName, oldPrefix, newPrefix, fixedText, mapping })
  if (text !== null && text.length > 200) throw new Error('新文字过长（>200 字符）')

  if (dryRun) {
    return { status: 'dry', box, edge, text, note: '', outputExt: outFmt.ext }
  }

  // ---------- 背景色：只取外框四周一圈，避免整图读入内存 ----------
  // 裁剪区 = 外框向外扩 pad **再多 1 像素**：采样圈就在 pad 之外的那一圈上，
  // 只扩 pad 的话采样圈全被裁掉，背景色会退化成纯白（浅灰/渐变底会擦出可见白斑）。
  const cPad = Math.max(padX, padY)
  const cx0 = Math.max(0, box.x0 - cPad - 1)
  const cy0 = Math.max(0, box.y0 - cPad - 1)
  const cx1 = Math.min(W, box.x1 + 1 + cPad + 1)
  const cy1 = Math.min(H, box.y1 + 1 + cPad + 1)
  const crop = await sharp(inputPath)
    .extract({ left: cx0, top: cy0, width: Math.max(1, cx1 - cx0), height: Math.max(1, cy1 - cy0) })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const bg = estimateBackgroundColor(
    crop.data,
    { left: cx0, top: cy0, width: crop.info.width, height: crop.info.height },
    { width: W, height: H },
    box,
    cPad
  )

  // ---------- 擦除矩形（整数像素，外扩 pad 后覆盖旧文字） ----------
  const wx0 = Math.max(0, box.x0 - padX)
  const wy0 = Math.max(0, box.y0 - padY)
  const wx1 = Math.min(W, box.x1 + 1 + padX)
  const wy1 = Math.min(H, box.y1 + 1 + padY)
  const eraseSvg =
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="${wx0}" y="${wy0}" width="${Math.max(0, wx1 - wx0)}" height="${Math.max(0, wy1 - wy0)}" ` +
    `fill="rgb(${bg.r},${bg.g},${bg.b})"/></svg>`

  const composites: OverlayOptions[] = [{ input: Buffer.from(eraseSvg), left: 0, top: 0 }]
  if (text) {
    // 合成原点取整（composite 只接受整数坐标），把小数部分交给超采样栅格化
    const gx = useSubpixel ? Math.floor(edge.left) : box.x0
    const gy = useSubpixel ? Math.floor(edge.top) : box.y0
    const tile = useSubpixel
      ? await renderGlyphTile(text, edge.width, edge.height, edge.left - gx, edge.top - gy, fontStack)
      : await renderGlyphRgbaInteger(text, boxWidth(box), boxHeight(box), fontStack)
    if (!tile) throw new Error(`无法渲染文字：${text}`)
    composites.push({
      input: await sharp(tile.data, { raw: { width: tile.width, height: tile.height, channels: 4 } })
        .png()
        .toBuffer(),
      left: gx,
      top: gy
    })
  }

  let pipeline = sharp(inputPath)
  if (baseMeta.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' })
  const outBuf = await encodeResult(pipeline.composite(composites), outFmt.format, quality).toBuffer()

  // ---------- 自检 ----------
  let status: LabelFileStatus = 'ok'
  let note = ''
  const check = await detectInBuffer(outBuf, cfg)
  if (text) {
    const ref = useSubpixel ? check.edge : check.box
    if (!ref) {
      status = 'warn'
      note = '处理后未能重新检测到文字'
    } else {
      const c: EdgeBox = useSubpixel
        ? (check.edge as EdgeBox)
        : {
            left: check.box!.x0,
            top: check.box!.y0,
            right: check.box!.x1 + 1,
            bottom: check.box!.y1 + 1,
            width: 0,
            height: 0
          }
      const dx = Math.abs(c.left - edge.left) + Math.abs(c.right - edge.right)
      const dy = Math.abs(c.top - edge.top) + Math.abs(c.bottom - edge.bottom)
      if (dx > 12 || dy > 8) {
        status = 'warn'
        note = `位置偏差 dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`
      }
    }
  } else {
    // 擦除模式：原文字框内不应再有墨迹
    const x0 = Math.max(0, box.x0 - 4)
    const x1 = Math.min(W, box.x1 + 5)
    const y0 = Math.max(0, box.y0 - 4)
    const y1 = Math.min(H, box.y1 + 5)
    if (x1 > x0 && y1 > y0) {
      // 在原文字框范围内统计**结果图**上还剩多少深色像素
      const { data: g2 } = await sharp(outBuf)
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      let leftover = 0
      for (let i = 0; i < g2.length; i++) if (g2[i] < cfg.inkThreshold) leftover++
      if (leftover > Math.max(30, boxWidth(box) * boxHeight(box) * 0.004)) {
        status = 'warn'
        note = `擦除后仍残留 ${leftover} 个深色像素`
      }
    }
  }

  return {
    status,
    box,
    edge,
    text,
    note,
    buffer: outBuf,
    compareBuffer: await buildCompareSheet(inputPath, outBuf, box, W, H),
    outputExt: outFmt.ext
  }
}

/**
 * 单独导出「检测」能力，供界面上的试跑预览复用。
 */
export async function previewLabelBox(
  input: string | Buffer,
  cfg: Partial<DetectConfig> = {}
): Promise<{ box: LabelBox | null; width: number; height: number }> {
  const hit = await detectInBuffer(input, resolveDetect(cfg))
  return { box: hit.box, width: hit.width, height: hit.height }
}

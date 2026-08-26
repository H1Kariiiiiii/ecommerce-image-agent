import sharp from 'sharp'

export interface TextOverlayOptions {
  /** 目标位置（像素坐标，相对于原图） */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  /** 要渲染的新文字 */
  newText: string
  /** 字体大小（像素） */
  fontSize: number
  /** 文字颜色 RGB */
  color: { r: number; g: number; b: number }
}

/**
 * 在原图的文字区域上叠加新文字。
 * 使用 sharp SVG composite 实现：先用白色矩形覆盖原文字区域，
 * 再在相同位置渲染新文字。
 */
/** 擦除后的图片：文件路径或内存 buffer */
export type ImageInput = string | Buffer

export async function overlayText(
  erasedImage: ImageInput,
  opts: TextOverlayOptions
): Promise<Buffer> {
  const { bbox, newText, fontSize, color } = opts
  const regionW = bbox.x1 - bbox.x0
  const regionH = bbox.y1 - bbox.y0

  if (regionW <= 0 || regionH <= 0) {
    throw new Error('文字区域尺寸无效')
  }

  // 获取擦除后图片的元信息
  const meta = await sharp(erasedImage).metadata()
  const imgW = meta.width!
  const imgH = meta.height!

  // 根据区域大小调整字体大小，确保文字不溢出
  const adjustedFontSize = Math.min(fontSize, regionH * 0.9, regionW * 0.9 / Math.max(1, newText.length))

  // 文字颜色
  const fill = `rgb(${color.r},${color.g},${color.b})`

  // 构建 SVG 覆盖层：在选区位置渲染文字
  // 使用 dominant-baseline 和 text-anchor 实现居中
  const svg = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
    <text
      x="${bbox.x0 + regionW / 2}"
      y="${bbox.y1 - regionH * 0.15}"
      font-size="${adjustedFontSize}"
      fill="${fill}"
      font-family="'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif"
      font-weight="bold"
      text-anchor="middle"
      dominant-baseline="auto"
    >${escapeXml(newText)}</text>
  </svg>`

  return sharp(erasedImage)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

/**
 * 在图片上同时叠加多个文字（用于批量替换场景）。
 */
export async function overlayMultipleTexts(
  erasedImage: ImageInput,
  overlays: TextOverlayOptions[]
): Promise<Buffer> {
  if (overlays.length === 0) {
    return sharp(erasedImage).png().toBuffer()
  }

  const meta = await sharp(erasedImage).metadata()
  const imgW = meta.width!
  const imgH = meta.height!

  const textElements = overlays
    .map((opts) => {
      const { bbox, newText, fontSize, color } = opts
      const regionW = bbox.x1 - bbox.x0
      const regionH = bbox.y1 - bbox.y0
      const adjustedFontSize = Math.min(fontSize, regionH * 0.9, regionW * 0.9 / Math.max(1, newText.length))
      const fill = `rgb(${color.r},${color.g},${color.b})`

      return `<text
        x="${bbox.x0 + regionW / 2}"
        y="${bbox.y1 - regionH * 0.15}"
        font-size="${adjustedFontSize}"
        fill="${fill}"
        font-family="'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif"
        font-weight="bold"
        text-anchor="middle"
        dominant-baseline="auto"
      >${escapeXml(newText)}</text>`
    })
    .join('\n')

  const svg = `<svg width="${imgW}" height="${imgH}" xmlns="http://www.w3.org/2000/svg">
    ${textElements}
  </svg>`

  return sharp(erasedImage)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

/** 转义 XML 特殊字符，防止 SVG 注入 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

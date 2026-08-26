import sharp from 'sharp'
import type { TextRegion } from '../../shared/types'

/**
 * 根据原图尺寸和归一化选区，生成 inpainting 用的 mask 图片。
 * mask 规则：黑色 = 保持不变，白色 = 需要编辑的区域。
 *
 * 会在选区四周额外扩展 padding 比例的边距，让模型有更好的上下文过渡空间。
 */
export async function createMask(
  imagePath: string,
  region: TextRegion,
  paddingRatio = 0.05
): Promise<Buffer> {
  const meta = await sharp(imagePath).metadata()
  const w = meta.width!
  const h = meta.height!

  // 归一化坐标 → 像素坐标，加 padding
  const padX = Math.round(paddingRatio * w)
  const padY = Math.round(paddingRatio * h)
  const rx = Math.max(0, Math.round(region.x * w) - padX)
  const ry = Math.max(0, Math.round(region.y * h) - padY)
  const rw = Math.min(w - rx, Math.round(region.width * w) + padX * 2)
  const rh = Math.min(h - ry, Math.round(region.height * h) + padY * 2)

  // 用 SVG 矩形生成 mask：黑底 + 白色选区
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="black"/>
    <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="white"/>
  </svg>`

  return sharp(Buffer.from(svg)).png().toBuffer()
}

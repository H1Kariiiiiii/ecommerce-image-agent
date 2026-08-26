import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 仅含 PNG 魔数头的伪图片（用于模拟「服务返回了看起来是图片但非解码图」的探测场景） */
export const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 1, 1, 1]

/** 创建临时目录并写入一张最小 PNG 输入图（仅魔数头，可被魔数嗅探识别，但 sharp 无法解码） */
export async function setupInput(): Promise<{ dir: string; inputPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'img-test-'))
  const inputPath = join(dir, 'toy.png')
  await writeFile(inputPath, Buffer.from(PNG_BYTES))
  return { dir, inputPath }
}

/**
 * 创建一个真正可解码的 PNG 图（sharp 可读），用于创建 mask/OCR 等真正解码图片的测试。
 * 默认生成灰色底图，可选在指定区域绘制黑色文字（模拟货号）。
 */
export async function createRealPng(
  opts: {
    width?: number
    height?: number
    background?: { r: number; g: number; b: number }
    /** 在区域内填充黑色像素，模拟文字 */
    textRect?: { x: number; y: number; w: number; h: number }
  } = {}
): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const width = opts.width ?? 200
  const height = opts.height ?? 100
  const bg = opts.background ?? { r: 200, g: 200, b: 200 }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(${bg.r},${bg.g},${bg.b})"/>
    <rect fill="#000000" opacity="0"/>
  </svg>`

  let buf = await sharp(Buffer.from(svg)).png().toBuffer()

  // 绘制文字矩形（黑色块模拟文字区域）
  if (opts.textRect) {
    const t = opts.textRect
    const textSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="#000000" opacity="0"/>
      <text x="${t.x + t.w / 2}" y="${t.y + t.h * 0.8}" font-size="${t.h * 0.7}" fill="black" text-anchor="middle" font-family="Arial">TOY-001</text>
    </svg>`
    buf = await sharp(buf).composite([{ input: Buffer.from(textSvg) }]).png().toBuffer()
  }

  return buf
}

/** 将真实 PNG 写入临时目录，返回路径 */
export async function setupRealImage(opts: Parameters<typeof createRealPng>[0] = {}): Promise<{ dir: string; inputPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'img-test-'))
  const inputPath = join(dir, 'toy.png')
  const buf = await createRealPng(opts)
  await writeFile(inputPath, buf)
  return { dir, inputPath }
}

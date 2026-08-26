import { describe, expect, it } from 'vitest'
import { localErase } from '../src/main/api/localErase'
import { setupRealImage } from './helpers'
import sharp from 'sharp'

describe('localErase 本地擦除', () => {
  it('纯色背景 + 深色文字：擦除后区域颜色接近背景色', async () => {
    // 浅灰背景 + 黑色文字块
    const { inputPath } = await setupRealImage({
      width: 300,
      height: 150,
      background: { r: 230, g: 230, b: 230 },
      textRect: { x: 100, y: 50, w: 100, h: 40 }
    })

    // 文字区域（归一化，粗略覆盖 textRect）
    const region = { x: 100 / 300, y: 50 / 150, width: 100 / 300, height: 40 / 150 }
    const result = await localErase(inputPath, region)

    // 输出为有效 PNG
    const meta = await sharp(result.buffer).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(300)
    expect(meta.height).toBe(150)

    // 采样到的背景色应接近浅灰 (230,230,230)
    const { bgColor } = result
    expect(Math.abs(bgColor.r - 230)).toBeLessThanOrEqual(40)
    expect(Math.abs(bgColor.g - 230)).toBeLessThanOrEqual(40)
    expect(Math.abs(bgColor.b - 230)).toBeLessThanOrEqual(40)

    // 擦除后：文字区域内中心像素应接近背景色（不再是黑色文字）
    const raw = await sharp(result.buffer)
      .extract({ left: 120, top: 55, width: 60, height: 30 })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const ch = raw.info.channels
    // 统计中心区域平均亮度，应显著高于黑色文字（> 180）
    let sum = 0
    let n = 0
    for (let i = 0; i < raw.data.length; i += ch) {
      sum += (raw.data[i] + raw.data[i + 1] + raw.data[i + 2]) / 3
      n += 1
    }
    const avgBrightness = sum / n
    expect(avgBrightness).toBeGreaterThan(180)
  })

  it('区域贴边时兜底采样不抛错', async () => {
    const { inputPath } = await setupRealImage({ width: 100, height: 60, background: { r: 250, g: 250, b: 250 } })
    // 贴左上角的小区域
    const region = { x: 0, y: 0, width: 0.2, height: 0.2 }
    const result = await localErase(inputPath, region)
    const meta = await sharp(result.buffer).metadata()
    expect(meta.format).toBe('png')
  })

  it('羽化轻度扩散：远离区域处的像素基本不变（模糊未大范围污染）', async () => {
    const { inputPath } = await setupRealImage({
      width: 300,
      height: 150,
      background: { r: 230, g: 230, b: 230 },
      textRect: { x: 100, y: 50, w: 100, h: 40 }
    })

    // 文字区域（归一化）
    const region = { x: 100 / 300, y: 50 / 150, width: 100 / 300, height: 40 / 150 }
    // 远离区域取样（区域高 40，blur ≈ 3px；左边缘外 40px 处应不受影响）
    const sampleOutside = { left: 55, top: 15, width: 20, height: 10 }
    const before = await sharp(inputPath).extract(sampleOutside).raw().toBuffer({ resolveWithObject: true })
    const result = await localErase(inputPath, region)
    const after = await sharp(result.buffer).extract(sampleOutside).raw().toBuffer({ resolveWithObject: true })

    const ch = before.info.channels
    let maxDiff = 0
    for (let i = 0; i < before.data.length; i += ch) {
      for (let c = 0; c < ch; c++) {
        maxDiff = Math.max(maxDiff, Math.abs(before.data[i + c] - after.data[i + c]))
      }
    }
    // 远离区域处允许极小色差（羽化边缘的轻微过渡）
    expect(maxDiff).toBeLessThanOrEqual(8)
  })

  it('文字像素被替换为背景色（区域内深色像素明显减少）', async () => {
    const { inputPath } = await setupRealImage({
      width: 300,
      height: 150,
      background: { r: 230, g: 230, b: 230 },
      textRect: { x: 100, y: 50, w: 100, h: 40 }
    })
    const region = { x: 100 / 300, y: 50 / 150, width: 100 / 300, height: 40 / 150 }

    const countDark = async (src: string | Buffer): Promise<number> => {
      const raw = await sharp(src).extract({ left: 100, top: 50, width: 100, height: 40 }).raw().toBuffer({ resolveWithObject: true })
      const ch = raw.info.channels
      let dark = 0
      for (let i = 0; i < raw.data.length; i += ch) {
        const bright = (raw.data[i] + raw.data[i + 1] + raw.data[i + 2]) / 3
        if (bright < 100) dark += 1
      }
      return dark
    }

    const beforeDark = await countDark(inputPath)
    const result = await localErase(inputPath, region)
    const afterDark = await countDark(result.buffer)

    // 深色像素应显著减少（文字被擦掉）
    expect(afterDark).toBeLessThan(beforeDark * 0.3)
  })
})

describe('localEraseText 去掉货号', () => {
  it('OCR 定位失败时抛错', async () => {
    const { localEraseText } = await import('../src/main/api/localErase')
    // 纯白图（无文字）
    const { setupRealImage: setup } = await import('./helpers')
    const { inputPath, dir } = await setup({ width: 100, height: 60, background: { r: 255, g: 255, b: 255 } })
    await expect(localEraseText({ inputPath, outputDir: dir })).rejects.toThrow()
  })

  it('手动框选区域优先：无需 OCR 定位也能擦除', async () => {
    const { localEraseText } = await import('../src/main/api/localErase')
    const { setupRealImage: setup } = await import('./helpers')
    const { mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { inputPath, dir } = await setup({
      width: 300,
      height: 150,
      background: { r: 230, g: 230, b: 230 },
      textRect: { x: 100, y: 50, w: 100, h: 40 }
    })
    const outDir = join(dir, 'out')
    await mkdir(outDir, { recursive: true })

    // 手动区域（归一化）
    const region = { x: 100 / 300, y: 50 / 150, width: 100 / 300, height: 40 / 150 }
    const result = await localEraseText({ inputPath, outputDir: outDir, region })
    expect(result.outputPath).toContain('toy_white')
    // 输出可解码
    const meta = await sharp(result.outputPath).metadata()
    expect(meta.format).toBe('png')
  })
})

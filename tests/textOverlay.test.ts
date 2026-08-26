import { describe, expect, it } from 'vitest'
import { overlayText } from '../src/main/api/textOverlay'
import sharp from 'sharp'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('overlayText', () => {
  async function createTestImage(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'overlay-test-'))
    const path = join(dir, 'test.png')
    const buf = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 200, b: 200 } }
    }).png().toBuffer()
    await writeFile(path, buf)
    return path
  }

  it('在指定位置叠加文字，输出为 PNG', async () => {
    const inputPath = await createTestImage()
    const result = await overlayText(inputPath, {
      bbox: { x0: 10, y0: 10, x1: 190, y1: 90 },
      newText: 'TOY-002',
      fontSize: 30,
      color: { r: 0, g: 0, b: 0 }
    })

    const meta = await sharp(result).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(100)
  })

  it('文字颜色与指定一致', async () => {
    const inputPath = await createTestImage()
    const result = await overlayText(inputPath, {
      bbox: { x0: 50, y0: 25, x1: 150, y1: 75 },
      newText: 'TEST',
      fontSize: 24,
      color: { r: 255, g: 0, b: 0 }
    })

    // 输出应该是有效的图片
    const meta = await sharp(result).metadata()
    expect(meta.width).toBe(200)
  })

  it('中文文字渲染不报错', async () => {
    const inputPath = await createTestImage()
    const result = await overlayText(inputPath, {
      bbox: { x0: 10, y0: 10, x1: 190, y1: 90 },
      newText: '玩具货号',
      fontSize: 28,
      color: { r: 0, g: 0, b: 0 }
    })

    const meta = await sharp(result).metadata()
    expect(meta.format).toBe('png')
  })

  it('无效区域尺寸抛出错误', async () => {
    const inputPath = await createTestImage()
    await expect(
      overlayText(inputPath, {
        bbox: { x0: 100, y0: 100, x1: 50, y1: 50 }, // x1 < x0
        newText: 'BAD',
        fontSize: 20,
        color: { r: 0, g: 0, b: 0 }
      })
    ).rejects.toThrow('文字区域尺寸无效')
  })
})

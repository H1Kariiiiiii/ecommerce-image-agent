import { describe, expect, it } from 'vitest'
import { createMask } from '../src/main/api/mask'
import { setupRealImage } from './helpers'
import sharp from 'sharp'

describe('createMask', () => {
  it('生成与原图同尺寸的 PNG mask', async () => {
    const { inputPath } = await setupRealImage({ width: 200, height: 100 })
    const region = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 }
    const mask = await createMask(inputPath, region)

    const meta = await sharp(mask).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(100)
  })

  it('mask 是黑底白色选区', async () => {
    const { inputPath } = await setupRealImage({ width: 200, height: 100 })
    // 选区覆盖中心 50% 区域
    const region = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    const mask = await createMask(inputPath, region)

    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBeGreaterThanOrEqual(3)

    // 取左上角像素（选区外，应为黑色）
    const topLeft = data[0]
    expect(topLeft).toBe(0)

    // 取中心像素（选区内，应为白色）
    const cx = Math.floor(info.width / 2)
    const cy = Math.floor(info.height / 2)
    const centerIdx = (cy * info.width + cx) * info.channels
    const center = data[centerIdx]
    expect(center).toBe(255)
  })

  it('全图选区 (0,0,1,1) 生成全白 mask', async () => {
    const { inputPath } = await setupRealImage({ width: 200, height: 100 })
    const region = { x: 0, y: 0, width: 1, height: 1 }
    const mask = await createMask(inputPath, region)

    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true })
    // 检查中心像素（channels×width×height 内的中心点）
    const centerPx = Math.floor(info.width * info.height / 2)
    const centerIdx = centerPx * info.channels
    expect(data[centerIdx]).toBe(255)
  })
})

import sharp from 'sharp'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extendCanvas } from '../src/main/api/canvasExtend'
import { setupRealImage } from './helpers'

/** 采样结果图指定像素 */
async function pixelAt(p: string, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await sharp(p)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return [data[0], data[1], data[2]]
}

async function outDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'canvas-out-')), 'processed')
}

describe('extendCanvas 无损画布扩展', () => {
  it('不同参数重新生成 → 输出文件名不同（避免前端缓存显示旧图）', async () => {
    const { inputPath } = await setupRealImage({
      width: 200,
      height: 112,
      background: { r: 200, g: 200, b: 200 }
    })
    const dir = await outDir()
    const r1 = await extendCanvas({
      inputPath,
      outputDir: dir,
      canvas: { ratio: { w: 4, h: 3 }, strategy: 'pad' }
    })
    const r2 = await extendCanvas({
      inputPath,
      outputDir: dir,
      canvas: { ratio: { w: 1, h: 1 }, strategy: 'pad' }
    })
    expect(r1.outputPath).toContain('_canvas_4x3_pad_')
    expect(r2.outputPath).toContain('_canvas_1x1_pad_')
    expect(r1.outputPath).not.toBe(r2.outputPath)
  })

  it('pad 策略：16:9 原图 → 4:3 画布，上下补白边，原图像素不变', async () => {
    // 200x112 (约 16:9)，灰底 + 中央红色块
    const { inputPath } = await setupRealImage({
      width: 200,
      height: 112,
      background: { r: 200, g: 200, b: 200 }
    })
    const result = await extendCanvas({
      inputPath,
      outputDir: await outDir(),
      canvas: { ratio: { w: 4, h: 3 }, strategy: 'pad' }
    })
    expect(result.scaled).toBe(false)
    // 200x112 目标 4:3:候选1 = 200x150,候选2 = 149x112 → 选候选2(面积小) → 149x112?不对!
    // 候选2 = round(112*4/3)=149 x 112 → 149x112 < 原图200x112 → ok2=false!
    // 候选1 = 200x150 → ok1=true → 画布 200x150
    expect(result.size).toEqual({ width: 200, height: 150 })
    // 顶部补白边: y=1 应为白
    expect(await pixelAt(result.outputPath, 100, 1)).toEqual([255, 255, 255])
    // 底部补白边: y=148
    expect(await pixelAt(result.outputPath, 100, 148)).toEqual([255, 255, 255])
    // 原图区域: y=60 灰色仍在(原图 112 高,居中于 150 → y 偏移 19)
    expect(await pixelAt(result.outputPath, 100, 19 + 60)).toEqual([200, 200, 200])
    // 原图区域像素与输入一致(无损): 采样左上角原图区域
    const meta = await sharp(result.outputPath).metadata()
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(150)
  })

  it('pad 策略：目标比原图更宽时左右补边', async () => {
    // 300x200 (3:2) → 目标 4:3? 3:2=1.5, 4:3=1.333 更窄 → 上下补边。
    // 用 200x200 (1:1) → 目标 4:3 (1.333 更宽) → 左右补边
    const { inputPath } = await setupRealImage({
      width: 200,
      height: 200,
      background: { r: 220, g: 120, b: 40 }
    })
    const result = await extendCanvas({
      inputPath,
      outputDir: await outDir(),
      canvas: { ratio: { w: 4, h: 3 }, strategy: 'pad' }
    })
    // 候选1 = 200x150(高小于200 → 不ok),候选2 = round(200*4/3)=267x200 → 画布 267x200
    expect(result.size).toEqual({ width: 267, height: 200 })
    // 左右补白
    expect(await pixelAt(result.outputPath, 1, 100)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 265, 100)).toEqual([255, 255, 255])
    // 中心(原图区域)颜色不变
    expect(await pixelAt(result.outputPath, 133, 100)).toEqual([220, 120, 40])
  })

  it('fit 策略：等比缩放适配，不裁切不拉伸', async () => {
    // 200x100 (2:1) → 1:1 画布: base = min(200/1, 100/1) = 100 → 画布 100x100,原图缩放到 100x50 居中
    const { inputPath } = await setupRealImage({
      width: 200,
      height: 100,
      background: { r: 60, g: 120, b: 200 }
    })
    const result = await extendCanvas({
      inputPath,
      outputDir: await outDir(),
      canvas: { ratio: { w: 1, h: 1 }, strategy: 'fit' }
    })
    expect(result.size).toEqual({ width: 100, height: 100 })
    expect(result.scaled).toBe(true)
    // 上下补白(缩放图铺满宽度)
    expect(await pixelAt(result.outputPath, 50, 1)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 50, 98)).toEqual([255, 255, 255])
    // 中心(原图缩放区域)颜色接近原色(纯色缩放不变)
    expect(await pixelAt(result.outputPath, 50, 50)).toEqual([60, 120, 200])
  })

  it('fit 策略：宽图适配 4:3 画布，上下补白', async () => {
    // 240x120 (2:1) → 4:3: base = min(240/1.333=180, 120/1)=120 → 画布 160x120,原图缩放 240x120→160x80
    const { inputPath } = await setupRealImage({
      width: 240,
      height: 120,
      background: { r: 40, g: 160, b: 80 }
    })
    const result = await extendCanvas({
      inputPath,
      outputDir: await outDir(),
      canvas: { ratio: { w: 4, h: 3 }, strategy: 'fit' }
    })
    expect(result.size).toEqual({ width: 160, height: 120 })
    // 上下补白(缩放图铺满宽度)
    expect(await pixelAt(result.outputPath, 80, 1)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 80, 118)).toEqual([255, 255, 255])
    // 中间(缩放图)绿色仍在
    expect(await pixelAt(result.outputPath, 80, 60)).toEqual([40, 160, 80])
  })

  it('自定义背景色', async () => {
    const { inputPath } = await setupRealImage({
      width: 100,
      height: 100,
      background: { r: 30, g: 30, b: 30 }
    })
    const result = await extendCanvas({
      inputPath,
      outputDir: await outDir(),
      canvas: { ratio: { w: 16, h: 9 }, strategy: 'pad', background: '#ff0000' }
    })
    // 100x100 目标 16:9(更宽):候选1=100x56(ok?56<100 no),候选2=round(100*16/9)=178x100 → 画布178x100
    expect(result.size).toEqual({ width: 178, height: 100 })
    expect(await pixelAt(result.outputPath, 1, 50)).toEqual([255, 0, 0])
  })
})

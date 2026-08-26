import sharp from 'sharp'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeWhiteBackgroundLocal } from '../src/main/api/whiteBgLocal'

/** 用 SVG 生成一张真实测试图并落盘 */
async function writeSvgPng(svg: string, name = 'toy.png'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whitebg-test-'))
  const p = join(dir, name)
  const buf = await sharp(Buffer.from(svg)).png().toBuffer()
  await writeFile(p, buf)
  return p
}

/** 读取结果图指定像素（x, y 为整数坐标） */
async function pixelAt(p: string, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await sharp(p)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return [data[0], data[1], data[2]]
}

describe('makeWhiteBackgroundLocal 纯算法抠白底', () => {
  it('纯色背景 + 中央色块：角变白、产品保留、内部白字不被误删', async () => {
    // 灰底 216，中央红色方块，红块内部有一个白色小方块（模拟产品上的白字/高光）
    const svg = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="rgb(216,216,216)"/>
      <rect x="70" y="45" width="60" height="60" fill="rgb(230,30,30)"/>
      <rect x="92" y="68" width="16" height="14" fill="rgb(255,255,255)"/>
    </svg>`
    const inputPath = await writeSvgPng(svg)

    const outDir = join(await mkdtemp(join(tmpdir(), 'whitebg-out-')), 'processed')
    const result = await makeWhiteBackgroundLocal({ inputPath, outputDir: outDir })

    expect(result.outputPath).toBeTruthy()
    expect(result.bgRatio).toBeGreaterThan(0.3)
    expect(result.size).toEqual({ width: 200, height: 150 })

    // 四角：纯白
    expect(await pixelAt(result.outputPath, 2, 2)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 197, 2)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 2, 147)).toEqual([255, 255, 255])
    expect(await pixelAt(result.outputPath, 197, 147)).toEqual([255, 255, 255])
    // 产品中心（避开内部白块）：红色保留
    const center = await pixelAt(result.outputPath, 78, 52)
    expect(center[0]).toBeGreaterThan(200)
    expect(center[1]).toBeLessThan(80)
    expect(center[2]).toBeLessThan(80)
    // 产品内部的白色小块：连通性保护，不能变透明（flatten 后仍为白）
    const inner = await pixelAt(result.outputPath, 100, 75)
    expect(inner[0]).toBeGreaterThan(230)
    expect(inner[1]).toBeGreaterThan(230)
    expect(inner[2]).toBeGreaterThan(230)
  })

  it('渐变背景：白→浅灰，中央蓝色块保留，角变白', async () => {
    const svg = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="100%" stop-color="#c8c8c8"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect x="70" y="45" width="60" height="60" fill="rgb(20,60,230)"/>
    </svg>`
    const inputPath = await writeSvgPng(svg)
    const outDir = join(await mkdtemp(join(tmpdir(), 'whitebg-out-')), 'processed')
    const result = await makeWhiteBackgroundLocal({ inputPath, outputDir: outDir })

    expect(result.bgRatio).toBeGreaterThan(0.3)
    expect(await pixelAt(result.outputPath, 2, 2)).toEqual([255, 255, 255])
    const center = await pixelAt(result.outputPath, 100, 75)
    expect(center[2]).toBeGreaterThan(180) // 蓝色通道高
    expect(center[0]).toBeLessThan(100)
  })

  it('带透明通道的输入：直接合成白底（透明像素变白）', async () => {
    // 半透明红色矩形（60% 不透明度）+ 全透明背景
    const svg = `<svg width="120" height="90" xmlns="http://www.w3.org/2000/svg">
      <rect x="30" y="20" width="60" height="50" fill="rgb(255,0,0)" fill-opacity="0.6"/>
    </svg>`
    const inputPath = await writeSvgPng(svg)
    const outDir = join(await mkdtemp(join(tmpdir(), 'whitebg-out-')), 'processed')
    const result = await makeWhiteBackgroundLocal({ inputPath, outputDir: outDir })

    // 角落（透明区域）→ 纯白
    expect(await pixelAt(result.outputPath, 1, 1)).toEqual([255, 255, 255])
    // 中心：红 60% 叠加白 40% → ≈ (255,102,102)
    const center = await pixelAt(result.outputPath, 60, 45)
    expect(center[0]).toBeGreaterThan(230)
    expect(center[1]).toBeGreaterThan(80)
    expect(center[1]).toBeLessThan(130)
  })

  it('彩色背景 + 被主体包围的封闭口袋：口袋被清理为白（手臂与身体之间的空隙场景）', async () => {
    // 蓝底 + 大红圆（主体）+ 圆内一个蓝色小矩形（封闭口袋，与外部蓝色背景不连通）
    const svg = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="rgb(70,140,220)"/>
      <circle cx="100" cy="75" r="55" fill="rgb(230,60,60)"/>
      <rect x="92" y="67" width="16" height="16" fill="rgb(70,140,220)"/>
    </svg>`
    const inputPath = await writeSvgPng(svg)
    const outDir = join(await mkdtemp(join(tmpdir(), 'whitebg-out-')), 'processed')
    const result = await makeWhiteBackgroundLocal({ inputPath, outputDir: outDir })

    // 角：蓝底 → 白
    expect(await pixelAt(result.outputPath, 2, 2)).toEqual([255, 255, 255])
    // 主体：红色保留
    const body = await pixelAt(result.outputPath, 60, 40)
    expect(body[0]).toBeGreaterThan(200)
    expect(body[1]).toBeLessThan(100)
    // 封闭口袋：蓝色被清理 → 白
    expect(await pixelAt(result.outputPath, 100, 75)).toEqual([255, 255, 255])
  })
})

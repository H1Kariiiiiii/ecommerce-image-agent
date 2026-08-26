import { describe, expect, it } from 'vitest'
import { recognizeRegionText } from '../src/main/api/ppocrRec'
import { detectGoodsNumberV2 } from '../src/main/api/ppocrDetect'
import { createRealPng } from './helpers'
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('PP-OCR rec 识别', () => {
  it('识别大号英文字母数字（TOY-001）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ppocr-'))
    const inputPath = join(dir, 'toy.png')
    // 白底黑字大号文本
    const svg = `<svg width="400" height="120" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="200" y="80" font-size="56" fill="black" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold">TOY-001</text>
    </svg>`
    const sharp = (await import('sharp')).default
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    await writeFile(inputPath, buf)

    const res = await recognizeRegionText(inputPath, { x: 0, y: 0, width: 1, height: 1 })
    expect(res.text.replace(/[\s_]/g, '')).toContain('TOY')
    expect(res.text).toMatch(/001|OO1|00I/i)
    expect(res.confidence).toBeGreaterThan(0.5)
  })

  it('识别 NO.JT888-10G（点号+字母数字）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ppocr-'))
    const inputPath = join(dir, 'no.png')
    const svg = `<svg width="500" height="100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="250" y="72" font-size="52" fill="black" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold">NO.JT888-10G</text>
    </svg>`
    const sharp = (await import('sharp')).default
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    await writeFile(inputPath, buf)

    const res = await recognizeRegionText(inputPath, { x: 0, y: 0, width: 1, height: 1 })
    const compact = res.text.replace(/[\s_]/g, '')
    expect(compact).toMatch(/NO/i)
    expect(compact).toMatch(/JT/i)
    expect(compact).toMatch(/888/)
    expect(res.confidence).toBeGreaterThan(0.5)
  })
})

describe('PP-OCR 自动定位货号', () => {
  it('无锚点：从底部条带定位到货号', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ppocr-detect-'))
    const inputPath = join(dir, 'box.png')
    const svg = `<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#e8e4da"/>
      <text x="300" y="200" font-size="48" fill="#333" text-anchor="middle" font-family="Arial">FUN TIC-TAC-TOE</text>
      <text x="300" y="300" font-size="36" fill="#333" text-anchor="middle" font-family="Arial">6 MODES</text>
      <text x="300" y="740" font-size="40" fill="#222" text-anchor="middle" font-family="Arial" font-weight="bold">NO.JT888-10G</text>
      <text x="300" y="780" font-size="24" fill="#666" text-anchor="middle" font-family="Arial">MADE IN CHINA</text>
    </svg>`
    const sharp = (await import('sharp')).default
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    await writeFile(inputPath, buf)

    const found = await detectGoodsNumberV2(inputPath)
    expect(found).not.toBeNull()
    expect(found!.region.y).toBeGreaterThan(0.7) // 底部
    expect(found!.text.toUpperCase()).toContain('JT')
  })

  it('锚点 NO：命中 NO.JT888-10G', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ppocr-detect-'))
    const inputPath = join(dir, 'box2.png')
    const svg = `<svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0ead6"/>
      <text x="300" y="740" font-size="40" fill="#222" text-anchor="middle" font-family="Arial" font-weight="bold">NO.JT888-10H</text>
    </svg>`
    const sharp = (await import('sharp')).default
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    await writeFile(inputPath, buf)

    const found = await detectGoodsNumberV2(inputPath, 'NO')
    expect(found).not.toBeNull()
    expect(found!.text.toUpperCase()).toContain('NO')
    expect(found!.text.toUpperCase()).toContain('JT')
  })
})

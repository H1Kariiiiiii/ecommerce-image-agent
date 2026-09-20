import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 集成验证：在**注册了打包字体之后**跑完整条货号流水线。
 *
 * fontconfig 每进程只初始化一次，所以这个文件刻意把 setupBundledFonts()
 * 放在任何一次文字渲染之前（模块顶层 await），跑在自己的 worker 里，
 * 用来证明「自定义 fonts.conf 不会把渲染搞坏」。
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'fontint-userdata'),
    getAppPath: () => process.cwd()
  }
}))

const fontSetup = await import('../src/main/fontSetup')
const setup = fontSetup.setupBundledFonts()

const { processLabelImage } = await import('../src/main/api/labelOps')
const sharp = (await import('sharp')).default

describe('注册打包字体后，货号流水线仍正常工作', () => {
  it('fontconfig 已生效', () => {
    expect(setup.ok).toBe(true)
    expect(process.env.FONTCONFIG_FILE).toBe(setup.confPath)
  })

  it('渲染 / 检测 / 擦除 / 重绘 全链路正常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fontint-'))
    const W = 1200
    const H = 1000
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${H}" fill="#f2f2f0"/>
      <ellipse cx="600" cy="430" rx="360" ry="300" fill="#ffd166"/>
      <text x="601" y="966" font-family="Arial" font-size="48" font-weight="bold"
            fill="#111111" text-anchor="middle">NO.JT666-5</text>
    </svg>`
    const src = join(dir, 'JT666-5.jpg')
    await writeFile(src, await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer())

    const r = await processLabelImage({ inputPath: src, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(r.status).toBe('ok')
    expect(r.text).toBe('NO.TJ666-5')
    expect(r.box).toBeTruthy()
    expect(r.buffer!.length).toBeGreaterThan(1000)

    // 重绘后的新文字应能被重新检测到（说明字体真的渲染出了笔画，不是空白/方块）
    const after = await sharp(r.buffer!).greyscale().raw().toBuffer()
    let ink = 0
    for (const v of after) if (v < 110) ink++
    expect(ink).toBeGreaterThan(100)

    // 擦除模式同样正常
    const e = await processLabelImage({ inputPath: src, mode: 'erase', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(e.status).toBe('ok')
    expect(e.text).toBeNull()
  }, 120000)

  it('中文货号在打包字体配置下也能渲染（走系统中文字体）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fontint-cjk-'))
    const W = 1200
    const H = 1000
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      <text x="600" y="966" font-family="Microsoft YaHei" font-size="48" font-weight="bold"
            fill="#000000" text-anchor="middle">NO.JT666-5</text>
    </svg>`
    const src = join(dir, 'JT666-5.jpg')
    await writeFile(src, await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer())
    const r = await processLabelImage({
      inputPath: src,
      mode: 'custom',
      oldPrefix: 'JT',
      newPrefix: 'TJ',
      fixedText: '货号T-1',
      fontStack: 'Microsoft YaHei, SimHei, sans-serif'
    })
    expect(r.status).toBe('ok')
    const after = await sharp(r.buffer!).greyscale().raw().toBuffer()
    let ink = 0
    for (const v of after) if (v < 110) ink++
    // 中文没被渲染成空白
    expect(ink).toBeGreaterThan(100)
  }, 120000)
})

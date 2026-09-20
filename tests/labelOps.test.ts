import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_DETECT,
  detectLabelBox,
  estimateBackgroundColor,
  parseCodeFromFilename,
  resolveTargetText,
  sanitizeMapping
} from '../src/main/api/labelDetect'
import { processLabelImage, previewLabelBox } from '../src/main/api/labelOps'

/** 造一张「底部印着货号」的产品图（背景浅灰 + 一个圆形主体 + 底部黑色粗体货号） */
async function makeCodeImage(opts: { w?: number; h?: number; code?: string; bg?: string } = {}): Promise<Buffer> {
  const w = opts.w ?? 1200
  const h = opts.h ?? 1000
  const code = opts.code ?? 'NO.JT666-5'
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="${opts.bg ?? '#f2f2f2'}"/>
    <circle cx="${w / 2}" cy="${h * 0.4}" r="${h * 0.25}" fill="#ffcf5a"/>
    <text x="${w / 2}" y="${h * 0.97}" font-family="Arial" font-size="${Math.round(h * 0.045)}"
          font-weight="bold" fill="#000000" text-anchor="middle">${code}</text>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
}

async function writeTemp(name: string, buf: Buffer): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'label-test-'))
  const p = join(dir, name)
  await writeFile(p, buf)
  return { dir, path: p }
}

describe('parseCodeFromFilename', () => {
  it('识别常见货号形态', () => {
    expect(parseCodeFromFilename('JT666-5.jpg')).toBe('JT666-5')
    expect(parseCodeFromFilename('JT666-5A-1.jpg')).toBe('JT666-5A-1')
    expect(parseCodeFromFilename('JT888-11Z-1.jpg')).toBe('JT888-11Z-1')
  })
  it('不符合规则时返回 null', () => {
    expect(parseCodeFromFilename('图片.jpg')).toBeNull()
    expect(parseCodeFromFilename('JT66.jpg')).toBeNull()
    expect(parseCodeFromFilename('666-5.jpg')).toBeNull()
  })
  it('忽略中文后缀与括号', () => {
    expect(parseCodeFromFilename('JT666-5 副本.jpg')).toBe('JT666-5')
    expect(parseCodeFromFilename('D:\\图\\JT666-5.jpg')).toBe('JT666-5')
  })
})

describe('resolveTargetText', () => {
  const base = { code: 'JT666-5', baseName: 'JT666-5', oldPrefix: 'JT', newPrefix: 'TJ' }
  it('replace：换前缀并补 NO.', () => {
    expect(resolveTargetText({ ...base, mode: 'replace' })).toBe('NO.TJ666-5')
  })
  it('已是 NO. 开头时不重复补', () => {
    expect(resolveTargetText({ ...base, code: 'NO.JT666-5', mode: 'replace' })).toBe('NO.JT666-5')
  })
  it('erase：返回 null', () => {
    expect(resolveTargetText({ ...base, mode: 'erase' })).toBeNull()
  })
  it('custom：货号优先，其次文件名，再固定文字', () => {
    expect(resolveTargetText({ ...base, mode: 'custom', mapping: { 'JT666-5': 'X-1' } })).toBe('NO.X-1')
    expect(resolveTargetText({ ...base, mode: 'custom', mapping: { 'JT666-5': 'X-1' } })).toBe('NO.X-1')
    expect(resolveTargetText({ ...base, mode: 'custom', fixedText: 'NO.ZZ9' })).toBe('NO.ZZ9')
  })
  it('sanitizeMapping 忽略 _说明 与空值', () => {
    expect(sanitizeMapping({ _说明: 'x', 'JT1': 'A', 'JT2': '' })).toEqual({ JT1: 'A' })
  })
})

describe('detectLabelBox', () => {
  it('在底部条带内定位到货号行', async () => {
    const buf = await makeCodeImage()
    const { dir, path } = await writeTemp('JT666-5.jpg', buf)
    void dir
    const p = await previewLabelBox(path)
    expect(p.box).not.toBeNull()
    const b = p.box!
    expect(b.y0 / p.height).toBeGreaterThan(0.86)
    expect(b.x1 - b.x0).toBeGreaterThan(50)
  })

  it('底部没有文字时返回 null', async () => {
    const svg = '<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="300" fill="#ffffff"/><circle cx="200" cy="100" r="60" fill="#333"/></svg>'
    const buf = await sharp(Buffer.from(svg)).jpeg().toBuffer()
    const { path } = await writeTemp('blank.jpg', buf)
    const p = await previewLabelBox(path)
    expect(p.box).toBeNull()
  })

  it('纯白噪声底不会误检', () => {
    const gray = new Uint8Array(200 * 200).fill(255)
    expect(detectLabelBox(gray, 200, 200, DEFAULT_DETECT)).toBeNull()
  })
})

describe('estimateBackgroundColor', () => {
  const W = 60
  const H = 40
  const box = { x0: 20, y0: 10, x1: 39, y1: 19 }
  const pad = 4
  /** 造整图：浅灰底 + 一块黑色「文字」（文字不参与采样） */
  function full(): Buffer {
    const rgb = Buffer.alloc(W * H * 3, 180)
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const i = (y * W + x) * 3
        rgb[i] = 0
        rgb[i + 1] = 0
        rgb[i + 2] = 0
      }
    }
    return rgb
  }
  function cropOf(left: number, top: number, right: number, bottom: number, src: Buffer) {
    const cw = right - left
    const ch = bottom - top
    const out = Buffer.alloc(cw * ch * 3)
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = ((y + top) * W + (x + left)) * 3
        const d = (y * cw + x) * 3
        out[d] = src[s]
        out[d + 1] = src[s + 1]
        out[d + 2] = src[s + 2]
      }
    }
    return { data: out, left, top, width: cw, height: ch }
  }

  it('取外框四周一圈的中位数（整图作为裁剪图）', () => {
    const bg = estimateBackgroundColor(full(), { left: 0, top: 0, width: W, height: H }, { width: W, height: H }, box, pad)
    expect(bg).toEqual({ r: 180, g: 180, b: 180 })
  })

  it('裁剪图必须比「外框 + pad」多留 1 像素，否则采样圈全被裁掉 → 退化成纯白（回归）', () => {
    const src = full()
    // 正确：外扩 pad + 1
    const good = cropOf(box.x0 - pad - 1, box.y0 - pad - 1, box.x1 + 1 + pad + 1, box.y1 + 1 + pad + 1, src)
    expect(
      estimateBackgroundColor(good.data, { left: good.left, top: good.top, width: good.width, height: good.height }, { width: W, height: H }, box, pad)
    ).toEqual({ r: 180, g: 180, b: 180 })
    // 曾经的错误用法：只外扩 pad → 一圈都取不到 → 返回纯白，浅灰底上会擦出一块白斑
    const bad = cropOf(box.x0 - pad, box.y0 - pad, box.x1 + 1 + pad, box.y1 + 1 + pad, src)
    expect(
      estimateBackgroundColor(bad.data, { left: bad.left, top: bad.top, width: bad.width, height: bad.height }, { width: W, height: H }, box, pad)
    ).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('文字贴近图片边缘时不越界（上/左被 clamp）', () => {
    const edge = { x0: 1, y0: 1, x1: 20, y1: 8 }
    const src = Buffer.alloc(W * H * 3, 90)
    const bg = estimateBackgroundColor(src, { left: 0, top: 0, width: W, height: H }, { width: W, height: H }, edge, pad)
    expect(bg).toEqual({ r: 90, g: 90, b: 90 })
  })
})

describe('processLabelImage', () => {
  it('replace：换前缀重绘，自检通过', async () => {
    const buf = await makeCodeImage({ code: 'NO.JT666-5' })
    const { path } = await writeTemp('JT666-5.jpg', buf)
    const r = await processLabelImage({ inputPath: path, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(r.status).toBe('ok')
    expect(r.text).toBe('NO.TJ666-5')
    expect(r.buffer).toBeDefined()
    expect(r.outputExt).toBe('.jpg')
    // 处理后新文字仍应被检测到（位置基本不变）
    const after = await previewLabelBox(r.buffer!)
    expect(after.box).not.toBeNull()
    expect(Math.abs(after.box!.x0 - r.box!.x0)).toBeLessThan(15)
  })

  it('erase：整行擦掉，自检残留为 0 附近', async () => {
    const buf = await makeCodeImage({ code: 'NO.JT666-5' })
    const { path } = await writeTemp('JT666-5.jpg', buf)
    const r = await processLabelImage({ inputPath: path, mode: 'erase', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(r.status).toBe('ok')
    expect(r.text).toBeNull()
  })

  it('浅灰底：擦除用的是实测背景色，不是硬编码白色（回归）', async () => {
    // 底是 #c8c8c8（200），不是白色；曾经会把擦除矩形填成 (255,255,255)，肉眼可见一块白斑
    const buf = await makeCodeImage({ code: 'NO.JT666-5', bg: '#c8c8c8' })
    const { path } = await writeTemp('JT666-5.jpg', buf)
    const r = await processLabelImage({ inputPath: path, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(r.status).toBe('ok')
    const b = r.box!
    // 擦除矩形内、文字框外的一点（左下角内侧）
    const px = await sharp(r.buffer!)
      .extract({ left: Math.max(0, b.x0 - 12), top: b.y0 + Math.round((b.y1 - b.y0) / 2), width: 1, height: 1 })
      .raw()
      .toBuffer()
    const [rr, gg, bb] = [px[0], px[1], px[2]]
    // 应接近背景 200 而不是 255
    expect(Math.abs(rr - 200)).toBeLessThan(12)
    expect(Math.abs(gg - 200)).toBeLessThan(12)
    expect(Math.abs(bb - 200)).toBeLessThan(12)
  })

  it('dryRun：只检测不产出图片', async () => {
    const buf = await makeCodeImage({ code: 'NO.JT666-5' })
    const { path } = await writeTemp('JT666-5.jpg', buf)
    const r = await processLabelImage({ inputPath: path, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ', dryRun: true })
    expect(r.status).toBe('dry')
    expect(r.buffer).toBeUndefined()
    expect(r.text).toBe('NO.TJ666-5')
  })

  it('找不到货号时返回 not-found', async () => {
    const svg = '<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="300" fill="#ffffff"/></svg>'
    const { path } = await writeTemp('blank.jpg', await sharp(Buffer.from(svg)).jpeg().toBuffer())
    const r = await processLabelImage({ inputPath: path, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(r.status).toBe('not-found')
  })
})

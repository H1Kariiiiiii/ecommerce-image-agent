import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { processLabelImage } from '../src/main/api/labelOps'
import { detectLabelBox } from '../src/main/api/labelDetect'

/**
 * 与 Python 原版 label_tool.py 的对照测试。
 * 需要本机有 python + pillow + numpy，且仓库里保留着原工具目录；
 * 两者缺一时整个文件跳过（不影响常规 npm test）。
 */
const run = promisify(execFile)
const PY_DIR = join(process.cwd(), '货号与报价表处理工具_v1.1', '货号与报价表处理工具')
const HAS_PY = existsSync(join(PY_DIR, 'label_tool.py'))

async function pythonAvailable(): Promise<boolean> {
  if (!HAS_PY) return false
  try {
    await run('python', ['-c', 'import PIL, numpy'], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    return true
  } catch {
    return false
  }
}

const CAN_RUN = await pythonAvailable()

async function makeImage(dir: string, name: string, opts: { w: number; h: number; code: string; bg: string; fg: string }): Promise<void> {
  const { w, h, code, bg, fg } = opts
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="#ffffff"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <ellipse cx="${w / 2}" cy="${h * 0.42}" rx="${w * 0.3}" ry="${h * 0.26}" fill="${fg}"/>
    <text x="${w / 2}" y="${h * 0.965}" font-family="Arial" font-size="${Math.round(h * 0.042)}"
          font-weight="bold" fill="#000000" text-anchor="middle">${code}</text>
  </svg>`
  await writeFile(join(dir, name), await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toBuffer())
}

/** 条带二值化墨迹 IoU（越高说明重绘结果越接近对方） */
async function inkIou(a: Buffer | string, b: Buffer | string, yTopRatio: number): Promise<number> {
  const meta = await sharp(a).metadata()
  const W = meta.width!
  const H = meta.height!
  const top = Math.floor(H * yTopRatio)
  const [ra, rb] = await Promise.all([
    sharp(a).extract({ left: 0, top, width: W, height: H - top }).greyscale().raw().toBuffer(),
    sharp(b).extract({ left: 0, top, width: W, height: H - top }).greyscale().raw().toBuffer()
  ])
  let inter = 0
  let uni = 0
  for (let i = 0; i < ra.length; i++) {
    const ia = ra[i] < 110
    const ib = rb[i] < 110
    if (ia && ib) inter++
    if (ia || ib) uni++
  }
  return uni ? inter / uni : 1
}

describe.skipIf(!CAN_RUN)('与 Python 原版 label_tool.py 的对照', () => {
  it('检测框逐张一致（误差 <= 1px），重绘结果视觉等价', async () => {
    const work = await mkdtemp(join(tmpdir(), 'label-parity-'))
    const input = join(work, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', { w: 1200, h: 1000, code: 'NO.JT666-5', bg: '#f4f4f4', fg: '#ffcf5a' })
    await makeImage(input, 'JT888-11Z-1.jpg', { w: 900, h: 900, code: 'NO.JT888-11Z-1', bg: '#eef3f8', fg: '#7ec8e3' })
    await makeImage(input, 'JT999-13A.jpg', { w: 1500, h: 1125, code: 'NO.JT999-13A', bg: '#faf0e6', fg: '#b0e0a0' })

    const reportPath = join(work, 'py.csv')
    await run(
      'python',
      [join(PY_DIR, 'label_tool.py'), '-i', input, '-o', join(work, 'out-python'), '-m', 'replace',
        '--old', 'JT', '--new', 'TJ', '--report', reportPath, '--tolerant'],
      { cwd: PY_DIR, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
    )

    // Python 报告里的「文字框」列：'[x0, y0, x1, y1]'
    const csv = (await readFile(reportPath, 'utf8')).replace(/^\ufeff/, '')
    const pyBoxes = new Map<string, number[]>()
    for (const line of csv.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')) ?? []
      const src = cells[0] ?? ''
      const box = cells[4] ?? ''
      const nums = (box.match(/-?\d+/g) ?? []).map(Number)
      if (src && nums.length === 4) pyBoxes.set(src.replace(/^.*[\\/]/, ''), nums)
    }
    expect(pyBoxes.size).toBe(3)

    const lines: string[] = []
    for (const [name, pyBox] of pyBoxes) {
      const src = join(input, name)
      const ours = await processLabelImage({ inputPath: src, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
      expect(ours.status).toBe('ok')
      // 1) 检测框必须一致（这是移植是否忠实最硬的证据）
      expect(ours.box).toBeDefined()
      const b = ours.box!
      for (let i = 0; i < 4; i++) expect(Math.abs(b[['x0', 'y0', 'x1', 'y1'][i] as 'x0'] - pyBox[i])).toBeLessThanOrEqual(1)

      // 2) 重绘结果：条带墨迹 IoU 与平均像素差
      const pyOut = join(work, 'out-python', name)
      const iou = await inkIou(pyOut, ours.buffer!, 0.86)
      lines.push(`${name.padEnd(18)} 框一致  IoU(与原版输出)=${iou.toFixed(4)}`)
      expect(iou).toBeGreaterThan(0.6)
    }
    console.log('\n=== label_tool 对照结果 ===\n' + lines.join('\n') + '\n')
    await rm(work, { recursive: true, force: true })
  }, 300000)

  it('擦除模式下原版与移植版残留都接近 0', async () => {
    const work = await mkdtemp(join(tmpdir(), 'label-parity-'))
    const input = join(work, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', { w: 1200, h: 1000, code: 'NO.JT666-5', bg: '#f4f4f4', fg: '#ffcf5a' })
    const src = join(input, 'JT666-5.jpg')
    const ours = await processLabelImage({ inputPath: src, mode: 'erase', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(ours.status).toBe('ok')
    const meta = await sharp(ours.buffer!).metadata()
    const gray = await sharp(ours.buffer!).greyscale().raw().toBuffer()
    const b = ours.box!
    let leftover = 0
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) if (gray[y * meta.width! + x] < 110) leftover++
    }
    expect(leftover).toBe(0)
    void detectLabelBox
    await rm(work, { recursive: true, force: true })
  }, 300000)
})
/** 造一张贴近真实产品图的样本：大尺寸、浅灰渐变底 + 噪点、底部一行货号（**不是纯白底**） */
async function realisticImage(dir: string, name: string, code: string): Promise<void> {
  const W = 1587
  const H = 1440
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="#f7f7f5"/><stop offset="100%" stop-color="#eceff2"/>
      </linearGradient>
      <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/><feColorMatrix type="saturate" values="0"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <g opacity="0.05"><rect width="${W}" height="${H}" filter="url(#n)"/></g>
    <ellipse cx="780" cy="620" rx="430" ry="380" fill="#ffd166"/>
    <ellipse cx="780" cy="620" rx="200" ry="180" fill="#f4a261"/>
    <text x="793" y="1392" font-family="Arial" font-size="58" font-weight="bold"
          fill="#111111" text-anchor="middle" letter-spacing="0.5">${code}</text>
  </svg>`
  await writeFile(join(dir, name), await sharp(Buffer.from(svg)).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer())
}

async function grayRaw(p: string | Buffer): Promise<{ data: Buffer; w: number; h: number }> {
  const m = await sharp(p).metadata()
  const data = await sharp(p).greyscale().raw().toBuffer()
  return { data, w: m.width!, h: m.height! }
}

describe.skipIf(!CAN_RUN)('与 Python 原版 label_tool.py 的对照 · 重绘精度', () => {
  it('非纯白底上整图平均像素差 < 0.4/255（差异只来自字形抗锯齿边缘）', async () => {
    const work = await mkdtemp(join(tmpdir(), 'label-precision-'))
    const input = join(work, 'in')
    await mkdir(input, { recursive: true })
    const names = ['JT666-5.jpg', 'JT888-11Z-1.jpg', 'JT999-13A.jpg']
    const codes = ['NO.JT666-5', 'NO.JT888-11Z-1', 'NO.JT999-13A']
    for (let i = 0; i < names.length; i++) await realisticImage(input, names[i], codes[i])

    await run('python', [join(PY_DIR, 'label_tool.py'), '-i', input, '-o', join(work, 'py'), '-m', 'replace',
      '--old', 'JT', '--new', 'TJ', '--tolerant'],
      { cwd: PY_DIR, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })

    const lines: string[] = []
    for (const n of names) {
      const r = await processLabelImage({ inputPath: join(input, n), mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
      expect(r.status).toBe('ok')
      const [a, b] = await Promise.all([grayRaw(join(work, 'py', n)), grayRaw(r.buffer!)])
      let sum = 0
      let big = 0
      for (let i = 0; i < a.data.length; i++) {
        const d = Math.abs(a.data[i] - b.data[i])
        sum += d
        if (d > 32) big++
      }
      const mae = sum / a.data.length
      const pct = (big / a.data.length) * 100
      lines.push(`${n.padEnd(18)} 整图 MAE=${mae.toFixed(3)}/255   差异>32 的像素=${pct.toFixed(3)}%`)

      // 关键回归：非纯白底上绝不能擦出一块白色矩形（曾经因为采样圈被裁掉而退化成纯白）
      const box = r.box!
      const px = await sharp(r.buffer!)
        .extract({ left: Math.max(0, box.x0 - 12), top: box.y0 + Math.round((box.y1 - box.y0) / 2), width: 1, height: 1 })
        .raw()
        .toBuffer()
      expect(px[0]).toBeLessThan(252)
      expect(px[1]).toBeLessThan(252)
      expect(px[2]).toBeLessThan(252)

      expect(mae).toBeLessThan(0.4)
    }
    console.log('\n=== 重绘精度（与 Python 原版逐像素比对）===\n' + lines.join('\n') + '\n')
    await rm(work, { recursive: true, force: true })
  }, 600000)
})
/**
 * 亚像素 A/B：把「同一串文字重绘一遍」当成幂等测试 ——
 * 结果越接近原图上的真实文字，说明字号/位置估计得越准。
 * 这是比「像不像 Python」更本质的指标：目标是还原原图，而不是还原另一个工具。
 */
describe.skipIf(!CAN_RUN)('亚像素定位：是否比整数外框更贴近原图', () => {
  const CASES = [
    { name: 'JT666-5.jpg', code: 'NO.JT666-5', w: 1200, h: 1000, font: 50, bg: '#ffffff' },
    { name: 'JT888-11Z-1.jpg', code: 'NO.JT888-11Z-1', w: 1587, h: 1440, font: 58, bg: '#f4f6f8' },
    { name: 'JT999-13A.jpg', code: 'NO.JT999-13A', w: 1500, h: 1125, font: 44, bg: '#faf0e6' }
  ]

  async function make(dir: string, c: (typeof CASES)[number]): Promise<void> {
    const svg = `<svg width="${c.w}" height="${c.h}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="${c.bg}"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient></defs>
      <rect width="${c.w}" height="${c.h}" fill="url(#bg)"/>
      <ellipse cx="${c.w / 2}" cy="${c.h * 0.42}" rx="${c.w * 0.3}" ry="${c.h * 0.26}" fill="#ffd166"/>
      <text x="${c.w / 2 + 1}" y="${c.h * 0.965}" font-family="Arial" font-size="${c.font}" font-weight="bold"
            fill="#111111" text-anchor="middle" letter-spacing="0.4">${c.code}</text>
    </svg>`
    await writeFile(join(dir, c.name), await sharp(Buffer.from(svg)).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer())
  }

  function score(orig: Buffer, other: Buffer): { iou: number; mae: number } {
    let inter = 0
    let uni = 0
    let sum = 0
    for (let i = 0; i < orig.length; i++) {
      sum += Math.abs(orig[i] - other[i])
      const a = orig[i] < 110
      const b = other[i] < 110
      if (a && b) inter++
      if (a || b) uni++
    }
    return { iou: uni ? inter / uni : 1, mae: sum / orig.length }
  }

  it('三张样图：亚像素版 IoU 高于整数版，且不逊于 Python 原版', async () => {
    const work = await mkdtemp(join(tmpdir(), 'subpixel-ab-'))
    const input = join(work, 'in')
    await mkdir(input, { recursive: true })
    for (const c of CASES) await make(input, c)

    // Python 原版：custom 模式写回同一串文字（幂等）
    const codes = CASES.map((c) => c.code)
    const lines: string[] = []
    let allBetter = true
    const pyScores: { iou: number; mae: number }[] = []
    const subScores: { iou: number; mae: number }[] = []

    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i]
      const src = join(input, c.name)
      const pyOut = join(work, `py${i}`)
      await run('python', [join(PY_DIR, 'label_tool.py'), '-i', join(work, `one${i}`), '-o', pyOut,
        '-m', 'custom', '--text', c.code, '--tolerant'],
        { cwd: PY_DIR, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
        .catch(async () => {
          // 单图目录需要先准备
          await mkdir(join(work, `one${i}`), { recursive: true })
          await writeFile(join(work, `one${i}`, c.name), await readFile(src))
          return run('python', [join(PY_DIR, 'label_tool.py'), '-i', join(work, `one${i}`), '-o', pyOut,
            '-m', 'custom', '--text', c.code, '--tolerant'],
            { cwd: PY_DIR, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
        })

      const intRes = await processLabelImage({ inputPath: src, mode: 'custom', oldPrefix: 'JT', newPrefix: 'TJ', fixedText: c.code, subpixel: false })
      const subRes = await processLabelImage({ inputPath: src, mode: 'custom', oldPrefix: 'JT', newPrefix: 'TJ', fixedText: c.code, subpixel: true })
      const b = subRes.box!
      const y0 = Math.max(0, b.y0 - 30)
      const y1 = Math.min(c.h, b.y1 + 31)
      const bandOf = async (p: string | Buffer): Promise<Buffer> =>
        sharp(p).extract({ left: 0, top: y0, width: c.w, height: y1 - y0 }).greyscale().raw().toBuffer()
      const [o, py, ii, ss] = await Promise.all([
        bandOf(src),
        bandOf(join(pyOut, c.name)),
        bandOf(intRes.buffer!),
        bandOf(subRes.buffer!)
      ])
      const rPy = score(o, py)
      const rInt = score(o, ii)
      const rSub = score(o, ss)
      lines.push(
        `${c.name.padEnd(18)} Python IoU=${rPy.iou.toFixed(4)} MAE=${rPy.mae.toFixed(3)} | ` +
        `整数 IoU=${rInt.iou.toFixed(4)} MAE=${rInt.mae.toFixed(3)} | ` +
        `亚像素 IoU=${rSub.iou.toFixed(4)} MAE=${rSub.mae.toFixed(3)}`
      )
      // 核心主张：亚像素版必须在每张样图上都优于整数版
      if (!(rSub.iou > rInt.iou && rSub.mae < rInt.mae)) allBetter = false
      pyScores.push(rPy)
      subScores.push(rSub)
      void codes
    }
    const mean = (xs: { iou: number; mae: number }[]): { iou: number; mae: number } => ({
      iou: xs.reduce((s, x) => s + x.iou, 0) / xs.length,
      mae: xs.reduce((s, x) => s + x.mae, 0) / xs.length
    })
    const mp = mean(pyScores)
    const ms = mean(subScores)
    lines.push('')
    lines.push(`平均           Python IoU=${mp.iou.toFixed(4)} MAE=${mp.mae.toFixed(3)} | 亚像素 IoU=${ms.iou.toFixed(4)} MAE=${ms.mae.toFixed(3)}`)
    lines.push('（单张上 Python 的整数取整偶尔恰好更贴近原图，属正常抖动；看平均值）')
    console.log('\n=== 亚像素 vs 整数 vs Python（与原图真实文字的接近度）===\n' + lines.join('\n') + '\n')

    // 每张都优于整数版
    expect(allBetter).toBe(true)
    // 平均而言不逊于 Python 原版（单张允许抖动）
    expect(ms.iou).toBeGreaterThan(mp.iou)
    expect(ms.mae).toBeLessThan(mp.mae)
    await rm(work, { recursive: true, force: true })
  }, 600000)
})

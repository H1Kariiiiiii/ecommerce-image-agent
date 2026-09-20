import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { collectImages, runLabelBatch } from '../src/main/api/labelBatch'

async function makeImage(dir: string, name: string, code: string | null, opts: { w?: number; h?: number } = {}): Promise<void> {
  const w = opts.w ?? 900
  const h = opts.h ?? 800
  const text = code
    ? `<text x="${w / 2}" y="${h * 0.965}" font-family="Arial" font-size="${Math.round(h * 0.045)}"
        font-weight="bold" fill="#000000" text-anchor="middle">${code}</text>`
    : ''
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#f3f3f3"/><circle cx="${w / 2}" cy="${h * 0.4}" r="${h * 0.2}" fill="#88bbff"/>
    ${text}</svg>`
  await writeFile(join(dir, name), await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer())
}

describe('runLabelBatch（文件夹级流水线）', () => {
  it('换前缀 + 改名 + 对比图 + CSV 报告', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-test-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', 'NO.JT666-5')
    await makeImage(input, 'JT888-11Z-1.jpg', 'NO.JT888-11Z-1')
    await makeImage(input, 'notacode.jpg', 'NO.ABC123')  // 文件名不是货号 -> 回退用文件名

    const res = await runLabelBatch({
      inputDir: input,
      mode: 'replace',
      oldPrefix: 'JT',
      newPrefix: 'TJ',
      rename: true,
      compare: true
    })

    expect(res.ok).toBe(true)
    expect(res.total).toBe(3)
    const outDir = res.outputDir
    const names = (await readdir(outDir)).sort()
    expect(names).toContain('TJ666-5.jpg')
    expect(names).toContain('TJ888-11Z-1.jpg')
    expect(names).toContain('处理报告.csv')
    expect(names).toContain('_对比图')
    expect(res.renamedCount).toBe(2)

    const csv = await readFile(join(outDir, '处理报告.csv'), 'utf8')
    expect(csv.charCodeAt(0)).toBe(0xfeff) // BOM：Excel 打开不乱码
    expect(csv).toContain('TJ666-5')
    expect(csv).toContain('文字框')
    const cmp = await readdir(join(outDir, '_对比图'))
    expect(cmp.length).toBe(3)
  }, 120000)

  it('试跑：只检测不写任何文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-dry-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', 'NO.JT666-5')

    const res = await runLabelBatch({
      inputDir: input,
      mode: 'replace',
      oldPrefix: 'JT',
      newPrefix: 'TJ',
      dryRun: true
    })
    expect(res.dryRun).toBe(true)
    expect(res.okCount).toBe(1)
    expect(res.items[0].status).toBe('dry')
    expect(res.items[0].text).toBe('NO.TJ666-5')
    expect(res.reportPath).toBeUndefined()
    expect(existsSync(res.outputDir)).toBe(false)
  }, 120000)

  it('输出目录 = 输入目录时直接拒绝（不覆盖原图）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-same-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', 'NO.JT666-5')
    const res = await runLabelBatch({ inputDir: input, outputDir: input, mode: 'erase', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/不能和输入文件夹相同/)
    expect(res.total).toBe(0)
  }, 120000)

  it('整行擦除后原文字框内不再有墨迹', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-erase-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', 'NO.JT666-5')
    const res = await runLabelBatch({ inputDir: input, mode: 'erase', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(res.okCount).toBe(1)
    const out = res.items[0].dst
    const box = res.items[0].box!
    const meta = await sharp(out).metadata()
    const gray = await sharp(out).greyscale().raw().toBuffer()
    let leftover = 0
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) if (gray[y * meta.width! + x] < 110) leftover++
    expect(leftover).toBe(0)
  }, 120000)

  it('底部没有文字的图记为「没找到货号」，不影响其它图', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-miss-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT666-5.jpg', 'NO.JT666-5')
    await makeImage(input, 'blank.jpg', null)
    const res = await runLabelBatch({ inputDir: input, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ', tolerant: true })
    expect(res.total).toBe(2)
    expect(res.okCount).toBe(1)
    expect(res.notFoundCount).toBe(1)
  }, 120000)

  it('递归时不会把自己的输出目录（_已处理）再处理一遍', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-selfout-'))
    const input = join(dir, 'input')
    await mkdir(input, { recursive: true })
    await makeImage(input, 'JT111-1.jpg', 'NO.JT111-1')
    // 第一次：输出到默认的 input/_已处理
    const first = await runLabelBatch({ inputDir: input, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(first.total).toBe(1)
    expect(existsSync(join(input, '_已处理', 'JT111-1.jpg'))).toBe(true)
    // 第二次递归：_已处理 必须被跳过，否则会把自己的产物当成新素材
    const second = await runLabelBatch({ inputDir: input, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ', recursive: true })
    expect(second.total).toBe(1)
  }, 120000)

  it('递归子文件夹', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-rec-'))
    const input = join(dir, 'input')
    const sub = join(input, 'sub')
    await mkdir(sub, { recursive: true })
    await makeImage(input, 'JT111-1.jpg', 'NO.JT111-1')
    await makeImage(sub, 'JT222-2.jpg', 'NO.JT222-2')
    expect((await collectImages(input, false)).length).toBe(1)
    expect((await collectImages(input, true)).length).toBe(2)
    const res2 = await runLabelBatch({ inputDir: input, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ', recursive: true, rename: true })
    expect(res2.total).toBe(2)
    expect(existsSync(join(res2.outputDir, 'sub', 'TJ222-2.jpg'))).toBe(true)
  }, 120000)
})

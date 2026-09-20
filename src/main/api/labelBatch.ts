/**
 * 货号批量处理调度（纯算法，零 API 成本）
 * ======================================
 * 对应原 Python 工具 label_tool.py 的 run_batch：
 *
 *   扫文件夹 -> 逐张定位/擦除/重绘 ->（可选）改名 ->（可选）对比图 -> CSV 报告
 *
 * 与 Python 版的差异（都是修正）：
 *   - 默认不覆盖原图：输出文件夹与输入文件夹相同时直接报错，避免误删素材；
 *   - 保留原图格式（Python 版一律存 JPEG，.png 输入会写成像 JPEG 的 .png）。
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { LabelFileResult, LabelOptions, LabelProgress, LabelRunResult } from '../../shared/types'
import { sanitizeMapping } from './labelDetect'
import { processLabelImage } from './labelOps'

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp']

/**
 * 收集图片（不递归时只看当前层，与 Python 版一致）。
 *
 * @param excludeDirs 递归时跳过的目录。默认输出目录 `_已处理` 就在输入目录里面，
 *   不排除的话「递归 + 再跑一次」会把自己的上次输出当成新素材重复处理
 *   （Python 原版有这个问题，这里修掉了）。
 */
export async function collectImages(
  dir: string,
  recursive: boolean,
  excludeDirs: string[] = []
): Promise<string[]> {
  if (!recursive) {
    const names = await readdir(dir)
    return names
      .filter((f) => IMAGE_EXTS.includes(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(dir, f))
  }
  const exclude = new Set(excludeDirs.filter(Boolean).map((d) => resolve(d)))
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    if (exclude.has(resolve(d))) return
    const entries = await readdir(d, { withFileTypes: true })
    const files: string[] = []
    const dirs: string[] = []
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) dirs.push(join(d, e.name))
      else if (e.isFile() && IMAGE_EXTS.includes(extname(e.name).toLowerCase())) files.push(join(d, e.name))
    }
    out.push(...files)
    for (const sub of dirs) await walk(sub)
  }
  await walk(dir)
  return out
}

/** 把相对路径里的旧前缀全部换成新前缀（与 Python 的 str.replace 行为一致） */
function applyRename(rel: string, oldPrefix: string, newPrefix: string): string {
  if (!oldPrefix) return rel
  return rel.split(oldPrefix).join(newPrefix)
}

/** 换掉文件扩展名（保留其余部分），仅当扩展名确实需要变时才换 */
function withExt(p: string, ext: string): string {
  const cur = extname(p)
  if (cur.toLowerCase() === ext.toLowerCase()) return p
  return p.slice(0, p.length - cur.length) + ext
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

export interface RunLabelBatchOptions extends LabelOptions {
  /** 每张处理完的回调（用于主进程把进度推给界面） */
  onProgress?: (p: LabelProgress) => void
  /** 返回 true 时中止后续处理 */
  shouldAbort?: () => boolean
}

export async function runLabelBatch(opts: RunLabelBatchOptions): Promise<LabelRunResult> {
  const inputDir = resolve(opts.inputDir)
  const outputDir = resolve(opts.outputDir?.trim() || join(inputDir, '_已处理'))
  const dryRun = opts.dryRun === true
  const oldPrefix = opts.oldPrefix ?? ''
  const newPrefix = opts.newPrefix ?? ''
  const quality = opts.quality ?? 95
  const rename = opts.rename === true
  const compare = opts.compare === true
  const mapping = sanitizeMapping(opts.mapping)

  const empty: LabelRunResult = {
    ok: true,
    outputDir,
    total: 0,
    okCount: 0,
    warnCount: 0,
    notFoundCount: 0,
    errorCount: 0,
    renamedCount: 0,
    items: [],
    dryRun
  }

  if (inputDir === outputDir) {
    return { ...empty, ok: false, error: '输出文件夹不能和输入文件夹相同（会覆盖原图），请换一个目录或留空用默认的 _已处理' }
  }
  if (inputDir.startsWith(outputDir + sep)) {
    return { ...empty, ok: false, error: '输出文件夹不能是输入文件夹的上级目录' }
  }

  let images: string[]
  try {
    images = await collectImages(inputDir, opts.recursive === true, [outputDir])
  } catch (err) {
    return { ...empty, ok: false, error: '无法读取输入文件夹：' + (err instanceof Error ? err.message : String(err)) }
  }
  if (images.length === 0) {
    return { ...empty, ok: false, error: '输入文件夹里没有找到图片（支持 jpg / jpeg / png / bmp / webp）' }
  }

  const detect = {
    bandTop: opts.bandTop,
    bandBottom: opts.bandBottom,
    inkThreshold: opts.inkThreshold
  }
  const items: LabelFileResult[] = []
  let aborted = false

  for (const src of images) {
    if (opts.shouldAbort?.()) {
      aborted = true
      break
    }
    const rel = relative(inputDir, src)
    const relOut = rename ? applyRename(rel, oldPrefix, newPrefix) : rel
    const name = basename(src)
    let item: LabelFileResult
    try {
      const r = await processLabelImage({
        inputPath: src,
        mode: opts.mode,
        oldPrefix,
        newPrefix,
        fixedText: opts.fixedText,
        mapping,
        detect,
        padX: opts.padX,
        padY: opts.padY,
        quality,
        dryRun,
        fontStack: opts.fontFamily?.trim() || undefined,
        subpixel: opts.subpixel !== false
      })
      const dst = join(outputDir, withExt(relOut, r.outputExt))
      item = {
        src,
        dst,
        name,
        status: r.status,
        text: r.text === null ? undefined : r.text,
        box: r.box ? [r.box.x0, r.box.y0, r.box.x1, r.box.y1] : undefined,
        note: r.note,
        renamed: rel !== relOut
      }
      if (!dryRun && r.buffer) {
        await mkdir(dirname(dst), { recursive: true })
        await writeFile(dst, r.buffer)
        if (compare && r.compareBuffer) {
          const cmpPath = join(outputDir, '_对比图', withExt(relOut, '') + '_对比.jpg')
          await mkdir(dirname(cmpPath), { recursive: true })
          await writeFile(cmpPath, r.compareBuffer)
        }
      }
    } catch (err) {
      item = {
        src,
        dst: join(outputDir, relOut),
        name,
        status: 'error',
        note: err instanceof Error ? err.message : String(err),
        renamed: rel !== relOut
      }
    }
    items.push(item)
    opts.onProgress?.({ done: items.length, total: images.length, current: item })
  }

  const okCount = items.filter((i) => i.status === 'ok' || i.status === 'dry').length
  const warnCount = items.filter((i) => i.status === 'warn').length
  const notFoundCount = items.filter((i) => i.status === 'not-found').length
  const errorCount = items.filter((i) => i.status === 'error').length
  const renamedCount = items.filter((i) => i.renamed).length

  let reportPath: string | undefined
  if (!dryRun) {
    try {
      await mkdir(outputDir, { recursive: true })
      reportPath = join(outputDir, '处理报告.csv')
      const head = ['源文件', '输出文件', '状态', '新货号', '文字框', '文字尺寸', '备注']
      const rows = items.map((i) => {
        const w = i.box ? i.box[2] - i.box[0] + 1 : ''
        const h = i.box ? i.box[3] - i.box[1] + 1 : ''
        return [
          i.src,
          i.dst,
          i.status,
          i.text ?? '',
          i.box ? `[${i.box.join(', ')}]` : '',
          i.box ? `${w}x${h}` : '',
          i.note
        ]
      })
      // BOM + CRLF：Excel 双击打开不乱码
      const csv =
        '\ufeff' +
        [head, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\r\n') +
        '\r\n'
      await writeFile(reportPath, csv, 'utf8')
    } catch {
      reportPath = undefined
    }
  }

  return {
    ok: errorCount === 0,
    outputDir,
    total: items.length,
    okCount,
    warnCount,
    notFoundCount,
    errorCount,
    renamedCount,
    items,
    reportPath,
    dryRun,
    aborted
  }
}

/**
 * 报价表换图 + 改货号（.xlsx 专用，纯算法，不用 Office）
 * ====================================================
 * 对应原 Python 工具 quote_tool.py。.xlsx 本质是个 zip，本模块只替换三个部分，
 * 其余部件按原始字节复制（见 zip.ts），因此列宽、行高、字体、边框、对齐、
 * 合并单元格、下拉筛选、图片锚点全部原样保留：
 *
 *   1. xl/media/*            换成新图（先缩放到原图同样的像素尺寸再编码，排版不变）
 *   2. xl/drawings/drawing*.xml  图片名称/描述里的旧货号改成新货号（descr 与 name 两种写法）
 *   3. xl/sharedStrings.xml  货号列的文字改掉
 *
 * 不支持老式 .xls（OLE2 二进制）：靠「包里有没有工作表部件」判断，
 * 而不是只看扩展名 —— .xls 内部也含一个小 zip，只改扩展名会被误判。
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import sharp from 'sharp'
import type { QuotePlan, QuotePlanItem } from '../../shared/types'
import { ZipArchive } from './zip'

const DRAWING_RE = /^xl\/drawings\/drawing\d+\.xml$/
const SHEET_RE = /^xl\/worksheets\/sheet\d+\.xml$/
const CONTENT_TYPES = '[Content_Types].xml'
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp']

// --------------------------------------------------------------------------- XML 小工具

/**
 * XML 良构性检查（标签配对 + 引号 + 实体），返回错误描述或 null。
 * 不追求完整 XML 语义，只用于写完后的兜底校验。
 */
export function xmlError(src: string): string | null {
  const stack: string[] = []
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4)
      if (e < 0) return '注释未闭合'
      i = e + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9)
      if (e < 0) return 'CDATA 未闭合'
      i = e + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2)
      if (e < 0) return '处理指令未闭合'
      i = e + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      const e = src.indexOf('>', lt + 2)
      if (e < 0) return '声明未闭合'
      i = e + 1
      continue
    }
    // 找出标签结束的 '>'（跳过属性值引号里的 '>'）
    let j = lt + 1
    let quote: string | null = null
    while (j < src.length) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      j++
    }
    if (j >= src.length) return '标签未闭合'
    const inner = src.slice(lt + 1, j)
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      const top = stack.pop()
      if (top !== name) return `标签不匹配：</${name}> 对应 <${top ?? '空'}>`
    } else if (!inner.endsWith('/')) {
      const m = /^([^\s/>]+)/.exec(inner)
      if (!m) return '标签名为空'
      stack.push(m[1])
    }
    i = j + 1
  }
  if (stack.length > 0) return `标签未闭合：<${stack[stack.length - 1]}>`
  return null
}

/** 取标签内所有属性（保持出现顺序） */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z0-9_.:-]+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2]
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// --------------------------------------------------------------------------- 结构解析

export interface Picture {
  /** 绘图部件路径 */
  drawing: string
  /** 图片部件路径 */
  media: string
  /** 货号（来自 descr 或 name） */
  code: string
  /** 货号写在哪个属性上 */
  kind: 'descr' | 'name'
  /** 原图片扩展名（小写，不含点） */
  ext: string
  /** 匹配到的新图文件路径 */
  newFile?: string
}

interface PicNode {
  start: number
  end: number
  rId: string
  code: string
  kind: 'descr' | 'name'
}

/** 找出 drawing XML 里所有 <pic> 区块及其 rId / 货号 */
function findPicNodes(xml: string): PicNode[] {
  const out: PicNode[] = []
  const re = /<([A-Za-z0-9_.-]+:)?pic\b[^>]*>[\s\S]*?<\/([A-Za-z0-9_.-]+:)?pic>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[0]
    const embed = /(?:[A-Za-z0-9_.-]+:)?embed\s*=\s*"([^"]+)"/.exec(block)
    if (!embed) continue
    const cnv = /<([A-Za-z0-9_.-]+:)?cNvPr\b[^>]*>/.exec(block)
    if (!cnv) continue
    const attrs = attrsOf(cnv[0])
    let code: string | undefined
    let kind: 'descr' | 'name' = 'descr'
    if (attrs['descr']) {
      code = attrs['descr'].trim()
    } else if (attrs['name']) {
      code = attrs['name'].trim()
      kind = 'name'
    }
    if (!code) continue
    out.push({ start: m.index, end: m.index + block.length, rId: embed[1], code, kind })
  }
  return out
}

/** 相对路径归一化（Target 可能是 /xl/media/... 或 ../media/...） */
function normMedia(drawing: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '')
  return posix.normalize(posix.join(posix.dirname(drawing), target))
}

function readPictures(z: ZipArchive): Picture[] {
  const out: Picture[] = []
  for (const name of z.names()) {
    if (!DRAWING_RE.test(name)) continue
    const relsPath = name.replace('drawings/', 'drawings/_rels/') + '.rels'
    const relMap = new Map<string, string>()
    if (z.has(relsPath)) {
      const rels = z.read(relsPath, 'utf8')
      const re = /<([A-Za-z0-9_.-]+:)?Relationship\b[^>]*>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(rels)) !== null) {
        const a = attrsOf(m[0])
        if ((a['Type'] ?? '').endsWith('/image') && a['Id'] && a['Target']) {
          relMap.set(a['Id'], decodeXmlEntities(a['Target']))
        }
      }
    }
    const xml = z.read(name, 'utf8')
    for (const node of findPicNodes(xml)) {
      const target = relMap.get(node.rId)
      if (!target) continue
      const media = normMedia(name, target)
      out.push({
        drawing: name,
        media,
        code: node.code,
        kind: node.kind,
        ext: extname(media).toLowerCase().replace(/^\./, '')
      })
    }
  }
  return out
}

/** 给一个货号，列出可能的新货号（按优先级）：映身前缀 -> 原名 -> 去掉 NO. 再试 */
export function mappingCandidates(code: string, oldPrefix: string, newPrefix: string): string[] {
  const c = code.trim()
  const out: string[] = []
  if (oldPrefix && c.startsWith(oldPrefix)) out.push(newPrefix + c.slice(oldPrefix.length))
  out.push(c)
  if (c.toUpperCase().startsWith('NO.')) {
    const body = c.slice(3)
    if (oldPrefix && body.startsWith(oldPrefix)) out.push(newPrefix + body.slice(oldPrefix.length))
  }
  return out
}

/** 是不是真正的 xlsx（老式 .xls 内部也含 zip，必须看有没有工作表） */
export function looksLikeXlsx(z: ZipArchive): { ok: boolean; why: string } {
  if (!z.names().some((n) => SHEET_RE.test(n))) {
    if (z.names().some((n) => n.includes('/media/')) || z.names().length < 20) {
      return { ok: false, why: '里面没有工作表，这是老式 .xls 改了扩展名（.xls 内部含一个小 zip，容易误判）' }
    }
    return { ok: false, why: '里面没有工作表，可能不是 Excel 文件' }
  }
  return { ok: true, why: '' }
}

// --------------------------------------------------------------------------- 计划

export interface BuildPlanOptions {
  oldPrefix: string
  newPrefix: string
  /** 图片库：文件名（不含扩展名）-> 完整路径 */
  lib: Map<string, string>
}

export interface BuiltPlan {
  plan: QuotePlan
  /** 解析出的图片引用（已带 newFile 匹配结果），打补丁时直接复用 */
  pictures: Picture[]
}

export async function buildPlan(z: ZipArchive, opts: BuildPlanOptions): Promise<BuiltPlan> {
  const { oldPrefix, newPrefix, lib } = opts
  const plan: QuotePlan = {
    pictures: [],
    codeStrings: [],
    warnings: [],
    picturesPlanned: 0,
    codesPlanned: 0
  }
  const pics = readPictures(z)
  if (pics.length === 0) plan.warnings.push('这个 xlsx 里没有找到浮动图片（drawing 引用）')

  for (const p of pics) {
    let hit: string | undefined
    for (const cand of mappingCandidates(p.code, oldPrefix, newPrefix)) {
      const f = lib.get(cand)
      if (f) {
        hit = f
        break
      }
    }
    if (!hit) {
      plan.warnings.push(`找不到图片: 货号 ${JSON.stringify(p.code)}（图片文件夹里没有对应文件）`)
    } else {
      p.newFile = hit
      try {
        await sharp(hit).metadata()
      } catch (err) {
        plan.warnings.push(`图片打不开 ${hit}: ${err instanceof Error ? err.message : String(err)}`)
        p.newFile = undefined
      }
    }
    const newCode =
      oldPrefix && p.code.startsWith(oldPrefix) ? newPrefix + p.code.slice(oldPrefix.length) : p.code
    const item: QuotePlanItem = { code: p.code, newCode, media: p.media }
    if (p.newFile) item.newFile = p.newFile
    plan.pictures.push(item)
  }
  plan.picturesPlanned = plan.pictures.filter((p) => p.newFile).length

  // 货号列文字
  if (z.has('xl/sharedStrings.xml')) {
    const xml = z.read('xl/sharedStrings.xml', 'utf8')
    const seen = new Set<string>()
    const re = /<t(\s[^>]*)?>([^<]*)<\/t>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const body = decodeXmlEntities(m[2])
      const trimmed = body.trim()
      if (!trimmed || seen.has(trimmed)) continue
      if (oldPrefix && trimmed.startsWith(oldPrefix)) {
        seen.add(trimmed)
        plan.codeStrings.push({ from: trimmed, to: newPrefix + trimmed.slice(oldPrefix.length) })
      } else if (trimmed.toUpperCase().startsWith('NO.' + oldPrefix.toUpperCase())) {
        seen.add(trimmed)
        plan.codeStrings.push({ from: trimmed, to: trimmed.replace(oldPrefix, newPrefix) })
      }
    }
    plan.codesPlanned = plan.codeStrings.length
  } else {
    plan.warnings.push('没有 sharedStrings.xml，跳过货号文字替换')
  }
  return { plan, pictures: pics }
}

/** 收集图片库：文件名（不含扩展名）-> 路径 */
export async function collectImageLib(dir: string, recursive: boolean): Promise<Map<string, string>> {
  const lib = new Map<string, string>()
  const add = (root: string, files: string[]): void => {
    for (const f of files) {
      if (!IMAGE_EXTS.includes(extname(f).toLowerCase())) continue
      const stem = basename(f, extname(f))
      if (!lib.has(stem)) lib.set(stem, posix.join(root.replace(/\\/g, '/'), f))
    }
  }
  if (recursive) {
    const walk = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true })
      add(d, entries.filter((e) => e.isFile()).map((e) => e.name))
      for (const e of entries) if (e.isDirectory()) await walk(posix.join(d, e.name))
    }
    await walk(dir)
  } else {
    const entries = await readdir(dir, { withFileTypes: true })
    add(dir, entries.filter((e) => e.isFile()).map((e) => e.name))
  }
  return lib
}

// --------------------------------------------------------------------------- 打补丁

export interface PatchXlsxOptions {
  xlsxPath: string
  imageDir: string
  oldPrefix: string
  newPrefix: string
  recursive?: boolean
  /** 图片重编码质量 */
  quality?: number
  dryRun?: boolean
}

export interface PatchXlsxResult {
  plan: QuotePlan
  /** dryRun 时不产出 */
  buffer?: Buffer
  /** 实际替换的部件数 */
  mediaReplaced: number
}

/** 把新图缩放到目标像素尺寸后按原格式编码 */
async function encodeLike(file: string, targetSize: { w: number; h: number }, fmt: string, quality: number): Promise<Buffer> {
  let im = sharp(file).flatten({ background: '#ffffff' })
  const meta = await sharp(file).metadata()
  if (meta.width !== targetSize.w || meta.height !== targetSize.h) {
    im = sharp(await im.toBuffer()).resize(targetSize.w, targetSize.h, { fit: 'fill', kernel: 'lanczos3' })
  }
  if (fmt === 'png') return im.png({ compressionLevel: 9 }).toBuffer()
  if (fmt === 'webp') return im.webp({ quality }).toBuffer()
  return im.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer()
}

export async function patchXlsx(opts: PatchXlsxOptions): Promise<PatchXlsxResult> {
  const { xlsxPath, imageDir, oldPrefix, newPrefix, recursive = false, quality = 92, dryRun = false } = opts
  const buf = await readFile(xlsxPath)
  const z = ZipArchive.open(buf)
  const like = looksLikeXlsx(z)
  if (!like.ok) throw new Error(like.why)

  const lib = await collectImageLib(imageDir, recursive)
  const { plan, pictures } = await buildPlan(z, { oldPrefix, newPrefix, lib })

  if (dryRun) return { plan, mediaReplaced: 0 }

  // 新图逐张编码（尺寸对齐原嵌入图，锚点与排版才不变）
  const mods = new Map<string, Buffer>()
  const pics = pictures.filter((p) => p.newFile)
  for (const p of pics) {
    const orig = z.read(p.media)
    let target = { w: 0, h: 0 }
    try {
      const m = await sharp(orig).metadata()
      target = { w: m.width ?? 0, h: m.height ?? 0 }
    } catch {
      /* 原图不可解码时退回新图自身尺寸 */
    }
    if (!target.w || !target.h) {
      const m = await sharp(p.newFile!).metadata()
      target = { w: m.width ?? 1, h: m.height ?? 1 }
    }
    const fmt = (p.ext || 'jpeg').toLowerCase()
    mods.set(p.media, await encodeLike(p.newFile!, target, fmt, quality))
  }

  // drawing XML：改 cNvPr 的 descr / name
  const touched = new Set(pics.map((p) => p.drawing))
  for (const dname of touched) {
    let xml = z.read(dname, 'utf8')
    const nodes = findPicNodes(xml)
    const mine = pics.filter((p) => p.drawing === dname)
    // 从后往前替换，避免位置偏移
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]
      const p = mine.find((x) => x.code === node.code && x.kind === node.kind && x.newFile)
      if (!p) continue
      const newCode = oldPrefix && p.code.startsWith(oldPrefix) ? newPrefix + p.code.slice(oldPrefix.length) : p.code
      if (newCode === p.code) continue
      const block = xml.slice(node.start, node.end)
      // 与 Python 版一致：直接做属性串替换（比正则拼接安全，且作用域更精确）
      const attr = p.kind === 'descr' ? 'descr' : 'name'
      const needle = `${attr}="${p.code}"`
      const at = block.indexOf(needle)
      if (at < 0) continue
      const rewritten = block.slice(0, at) + `${attr}="${newCode}"` + block.slice(at + needle.length)
      xml = xml.slice(0, node.start) + rewritten + xml.slice(node.end)
    }
    mods.set(dname, Buffer.from(xml, 'utf8'))
  }

  // sharedStrings：货号列文字
  if (plan.codeStrings.length > 0 && z.has('xl/sharedStrings.xml')) {
    const xml = z.read('xl/sharedStrings.xml', 'utf8')
    const pairs = new Map(plan.codeStrings.map((c) => [c.from, c.to]))
    const out = xml.replace(/<t(\s[^>]*)?>([^<]*)<\/t>/g, (full, attrs: string | undefined, raw: string) => {
      const trimmed = decodeXmlEntities(raw).trim()
      const to = pairs.get(trimmed)
      if (to === undefined) return full
      return `<t${attrs ?? ''}>${escapeXml(to)}</t>`
    })
    mods.set('xl/sharedStrings.xml', Buffer.from(out, 'utf8'))
  }

  return { plan, buffer: z.rebuild(mods), mediaReplaced: mods.size }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// --------------------------------------------------------------------------- 写后校验

/** 打开结果文件做一致性检查，返回问题列表（空 = 通过） */
export function verifyXlsxBuffer(buf: Buffer, oldPrefix: string, newPrefix: string): string[] {
  const issues: string[] = []
  let z: ZipArchive
  try {
    z = ZipArchive.open(buf)
  } catch (err) {
    return [`打不开: ${err instanceof Error ? err.message : String(err)}`]
  }
  issues.push(...z.verify())

  for (const n of z.names()) {
    if (!n.endsWith('.xml') && !n.endsWith('.rels')) continue
    const err = xmlError(z.read(n, 'utf8'))
    if (err) issues.push(`${n} XML 解析失败: ${err}`)
  }

  // 关系目标都必须存在
  for (const n of z.names()) {
    if (!n.endsWith('.rels')) continue
    const base = posix.dirname(posix.dirname(n))
    const re = /<([A-Za-z0-9_.-]+:)?Relationship\b[^>]*>/g
    let m: RegExpExecArray | null
    const xml = z.read(n, 'utf8')
    while ((m = re.exec(xml)) !== null) {
      const a = attrsOf(m[0])
      if (a['TargetMode'] === 'External') continue
      const t = posix.normalize(posix.join(base, decodeXmlEntities(a['Target'] ?? '')))
      if (!z.has(t)) issues.push(`${n} 指向不存在的部件 ${t}`)
    }
  }

  const left = readPictures(z)
    .map((p) => p.code)
    .filter((c) => oldPrefix && c.startsWith(oldPrefix))
  if (left.length > 0) issues.push(`图片名称里仍有旧前缀 ${oldPrefix}: ${left.slice(0, 5).join(', ')}`)

  if (z.has('xl/sharedStrings.xml')) {
    const xml = z.read('xl/sharedStrings.xml', 'utf8')
    const residual: string[] = []
    const re = /<t(\s[^>]*)?>([^<]*)<\/t>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const t = decodeXmlEntities(m[2]).trim()
      if (oldPrefix && t.startsWith(oldPrefix)) residual.push(t)
    }
    if (residual.length > 0) issues.push(`货号文字里仍有旧前缀 ${oldPrefix}: ${residual.slice(0, 5).join(', ')}`)
  }

  // 内容类型覆盖：每个部件要么有 Override，要么扩展名在 Default 里
  if (z.has(CONTENT_TYPES)) {
    const ct = z.read(CONTENT_TYPES, 'utf8')
    const defaults = new Set<string>()
    const overrides = new Set<string>()
    const re = /<([A-Za-z0-9_.-]+:)?(Default|Override)\b[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(ct)) !== null) {
      const a = attrsOf(m[0])
      if (m[2] === 'Default' && a['Extension']) defaults.add(a['Extension'].toLowerCase())
      if (m[2] === 'Override' && a['PartName']) overrides.add(a['PartName'])
    }
    for (const n of z.names()) {
      if (n === CONTENT_TYPES || n.endsWith('/')) continue
      const base = posix.basename(n)
      const dot = base.lastIndexOf('.')
      const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
      if (overrides.has('/' + n) || defaults.has(ext)) continue
      issues.push(`缺少内容类型声明: ${n}`)
    }
  }
  return issues
}

export { readPictures as _readPicturesForTest }

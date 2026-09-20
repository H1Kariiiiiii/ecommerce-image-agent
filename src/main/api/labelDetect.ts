/**
 * 货号定位（纯几何投影，零 API 成本）
 * ============================================
 * 原 Python 工具 label_tool.py 检测部分的 TypeScript 移植，行为 1:1 对齐：
 *
 *   1. 在图片底部 bandTop~bandBottom 区域做灰度二值化（阈值 inkThreshold）；
 *   2. 按行统计墨量，去掉墨量不足 minRowInk 的噪点行；
 *   3. 把连续的行合并成「行段」（间隙 <= runGap、高度 >= minRunHeight）；
 *   4. 取最下面那一段作为货号行，再紧贴文字取外框。
 *
 * 纯几何投影 —— 不用模型、不联网、结果完全可复现，也不消耗任何额度。
 */

import type { LabelMode } from '../../shared/types'

/** 紧贴文字的外框（x1 / y1 为闭区间，与 PIL 的像素坐标一致） */
export interface LabelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface DetectConfig {
  /** 搜索区上边界（图高比例） */
  bandTop: number
  /** 搜索区下边界（图高比例） */
  bandBottom: number
  /** 文字像素灰度阈值（灰度 < 阈值视为文字） */
  inkThreshold: number
  /** 一行至少要有这么多深色像素才算文字行 */
  minRowInk: number
  /** 行段最少高度（像素） */
  minRunHeight: number
  /** 合并相邻行段的间隙（像素） */
  runGap: number
}

export const DEFAULT_DETECT: DetectConfig = {
  bandTop: 0.86,
  bandBottom: 0.999,
  inkThreshold: 110,
  minRowInk: 8,
  minRunHeight: 12,
  runGap: 4
}

/**
 * 把可能残缺的检测参数并入默认值。
 * 注意不能直接用 `{ ...DEFAULT_DETECT, ...partial }` —— 显式的 undefined
 * 会把默认值覆盖掉（调用方只填了 bandTop 时 bandBottom 会变成 undefined）。
 */
export function resolveDetect(partial?: Partial<DetectConfig>): DetectConfig {
  const cfg: DetectConfig = { ...DEFAULT_DETECT }
  if (partial) {
    for (const k of Object.keys(DEFAULT_DETECT) as (keyof DetectConfig)[]) {
      const v = partial[k]
      if (typeof v === 'number' && Number.isFinite(v)) cfg[k] = v
    }
  }
  return cfg
}

export function boxWidth(b: LabelBox): number {
  return b.x1 - b.x0 + 1
}

export function boxHeight(b: LabelBox): number {
  return b.y1 - b.y0 + 1
}

/** 把「有文字的行」标记合并成连续行段（对应 Python 的 _row_runs） */
function rowRuns(keep: Uint8Array, gap: number, minHeight: number): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, keep.length - 1])

  const merged: Array<[number, number]> = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] <= gap) last[1] = r[1]
    else merged.push([r[0], r[1]])
  }
  return merged.filter(([a, b]) => b - a + 1 >= minHeight)
}

/**
 * 在图片底部定位货号行，返回紧贴文字的外框。
 *
 * @param gray 单通道灰度像素（长度必须 >= width*height，行优先）
 * @returns 未找到时返回 null
 */
export function detectLabelBox(
  gray: Uint8Array | Buffer,
  width: number,
  height: number,
  cfg: DetectConfig = DEFAULT_DETECT
): LabelBox | null {
  if (width <= 0 || height <= 0) return null
  const yTop = Math.floor(height * cfg.bandTop)
  const yBottom = Math.floor(height * cfg.bandBottom)
  const bandRows = yBottom - yTop
  if (bandRows <= 0) return null

  const rowInk = new Int32Array(bandRows)
  let totalInk = 0
  for (let y = 0; y < bandRows; y++) {
    const base = (yTop + y) * width
    let n = 0
    for (let x = 0; x < width; x++) {
      if (gray[base + x] < cfg.inkThreshold) n++
    }
    rowInk[y] = n
    totalInk += n
  }
  // 整条带几乎无墨迹：这张图底部没有印刷文字
  if (totalInk < 50) return null

  // 只保留墨量足够的行，避免孤立噪点被当成文字
  const keep = new Uint8Array(bandRows)
  for (let y = 0; y < bandRows; y++) if (rowInk[y] >= cfg.minRowInk) keep[y] = 1

  const runs = rowRuns(keep, cfg.runGap, cfg.minRunHeight)
  if (runs.length === 0) return null

  // 取最下面那一段（下方通常还有整片空白）
  let run = runs[0]
  for (const r of runs) if (r[0] > run[0]) run = r

  // 该行段内所有墨迹像素的列范围
  let minX = width
  let maxX = -1
  for (let y = run[0]; y <= run[1]; y++) {
    const base = (yTop + y) * width
    for (let x = 0; x < width; x++) {
      if (gray[base + x] < cfg.inkThreshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  if (maxX < 0) return null
  return { x0: minX, y0: run[0] + yTop, x1: maxX, y1: run[1] + yTop }
}

/** 裁剪图在整图中的位置与尺寸 */
export interface CropGeometry {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 估计文字周围的背景色：取外框四周一圈像素的**中位数**。
 * 不写死白色，所以浅色渐变底也适用（对应 Python 的 background_color）。
 *
 * ⚠️ 采样区是「外框向外扩 pad」之后的**再外面一圈**（y0-1 / y1 / x0-1 / x1），
 * 所以裁剪图必须比「外框 + pad」再向外多留 1 像素 —— 否则一圈全落在裁剪图之外，
 * 函数会退化成返回纯白，在浅灰/渐变底上擦出一块肉眼可见的白斑。
 * （这个坑真踩过：调用方按 pad 精确裁剪，导致所有非纯白底都被擦成白色。）
 *
 * @param rgb  裁剪图的 RGB 像素（3 通道，行优先）
 * @param crop 裁剪图在整图中的位置与尺寸
 * @param full 整图尺寸（用来判断「这一圈是否真的存在于原图里」）
 * @param box  文字外框，**整图坐标**
 * @param pad  外框四周留白
 */
export function estimateBackgroundColor(
  rgb: Uint8Array | Buffer,
  crop: CropGeometry,
  full: { width: number; height: number },
  box: LabelBox,
  pad: number
): { r: number; g: number; b: number } {
  const x0 = Math.max(0, box.x0 - pad)
  const y0 = Math.max(0, box.y0 - pad)
  const x1 = Math.min(full.width, box.x1 + 1 + pad)
  const y1 = Math.min(full.height, box.y1 + 1 + pad)
  if (x1 <= x0 || y1 <= y0 || crop.width <= 0 || crop.height <= 0) return { r: 255, g: 255, b: 255 }

  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const push = (fx: number, fy: number): void => {
    const lx = fx - crop.left
    const ly = fy - crop.top
    if (lx < 0 || ly < 0 || lx >= crop.width || ly >= crop.height) return
    const i = (ly * crop.width + lx) * 3
    rs.push(rgb[i])
    gs.push(rgb[i + 1])
    bs.push(rgb[i + 2])
  }

  if (y0 > 0) for (let x = x0; x < x1; x++) push(x, y0 - 1)
  if (y1 < full.height) for (let x = x0; x < x1; x++) push(x, y1)
  if (x0 > 0) for (let y = y0; y < y1; y++) push(x0 - 1, y)
  if (x1 < full.width) for (let y = y0; y < y1; y++) push(x1, y)
  if (rs.length === 0) return { r: 255, g: 255, b: 255 }
  return { r: median(rs), g: median(gs), b: median(bs) }
}

/** 与 numpy.median + int() 一致：偶数个取中间两个的均值后截断 */
function median(values: number[]): number {
  values.sort((a, b) => a - b)
  const n = values.length
  const mid = n >> 1
  return n % 2 === 1 ? values[mid] : Math.floor((values[mid - 1] + values[mid]) / 2)
}

/**
 * 从文件名取出货号，如 JT666-5A-1.jpg -> JT666-5A-1。
 * 规则：2~4 个字母 + 3 位以上数字 + 可选字母数字后缀。
 * 不符合规则的返回 null（调用方回退用整个文件名）。
 */
export function parseCodeFromFilename(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, '')
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim()
  let cand = ''
  for (const ch of stem) {
    if (/[0-9A-Za-z]/.test(ch) || ch === '-' || ch === '_') cand += ch
  }
  const m = /^([A-Za-z]{2,4}\d{3,}[0-9A-Za-z\-]*)$/.exec(cand)
  return m ? m[1] : null
}

/** 文件名（不含扩展名），用于 custom 映射表按文件名匹配 */
export function stemOf(name: string): string {
  const base = name.replace(/^.*[\\/]/, '')
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export interface ResolveTextOptions {
  mode: LabelMode
  /** 从文件名解析出的货号（失败时由调用方传入文件名） */
  code: string
  /** 文件名（不含扩展名） */
  baseName: string
  oldPrefix: string
  newPrefix: string
  fixedText?: string
  mapping?: Record<string, string>
}

/**
 * 算出要写进图片的新文字；返回 null 表示「擦除，不写文字」。
 * 对应 Python 的 process_one 里的目标文字推导。
 */
export function resolveTargetText(opts: ResolveTextOptions): string | null {
  const { mode, code, baseName, oldPrefix, newPrefix, fixedText, mapping } = opts
  let text: string | null

  if (mode === 'erase') {
    text = null
  } else if (mode === 'custom') {
    const map = mapping ?? {}
    if (map[code] !== undefined) text = map[code]
    else if (map[baseName] !== undefined) text = map[baseName]
    else if (fixedText !== undefined) text = fixedText
    else text = code
  } else {
    text = code
    if (oldPrefix && text.startsWith(oldPrefix)) text = newPrefix + text.slice(oldPrefix.length)
    else if (fixedText !== undefined) text = fixedText
  }

  if (text !== null && !text.toUpperCase().startsWith('NO.')) text = 'NO.' + text
  return text
}

/**
 * 清理映射表：忽略以 _ 开头的说明键与空值。
 * （mapping.example.json 里的 "_说明" 会被自动跳过）
 */
export function sanitizeMapping(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

// --------------------------------------------------------------------------- 亚像素细化

/**
 * 亚像素文字外框：连续坐标，right / bottom 为**开区间**边界
 * （即墨迹覆盖 [left, right) × [top, bottom)）。
 */
export interface EdgeBox {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 把整数外框细化到亚像素精度。
 * =================================
 * 整数外框来自「灰度 < 阈值」的二值化，边界天然带 ±1px 的量化误差：
 * 一个灰度正好卡在阈值附近的像素，真实墨迹覆盖率可能是 0.05，也可能是 0.95。
 *
 * 做法（覆盖率模型）：
 *
 *   1. 背景亮度 bg = 框外一圈灰度的中位数；墨迹亮度 fg = 框内灰度的 2% 分位；
 *   2. 像素覆盖率 c = clamp((bg - g) / (bg - fg), 0, 1) —— 该像素被笔画盖住的比例；
 *   3. 沿 x 累加得到列质量 P(j) = Σ c(j, ·)（≈ 该列被墨迹盖住的高度）；
 *      若真实左边界落在列 j 内，则 P(j) = (j + 1 - 左边界) × 笔画高度，
 *      取紧邻列的高度作参照 → 左边界 = j + 1 - P(j) / max(P(j), P(j+1))。
 *      右边界对称：右边界 = j + P(j) / max(P(j), P(j-1))。
 *   4. 上下边界用行质量 Q(i) 同理。
 *
 * ⚠️ 搜索范围必须比二值化外框**各向外多 1 像素**：真实边界所在的那一列
 * 覆盖率可能低于阈值（比如 0.5），二值化时被排除在外，只看框内那一列会算偏。
 *
 * 结果一定落在整数框的 ±1px 之内（不会比二值化更差）；背景与墨迹对比度
 * 不足（span < 16）时直接返回整数框。
 */
export function refineBoxSubpixel(
  gray: Uint8Array | Buffer,
  width: number,
  height: number,
  box: LabelBox,
  cfg: DetectConfig = DEFAULT_DETECT
): EdgeBox {
  const intBox: EdgeBox = {
    left: box.x0,
    top: box.y0,
    right: box.x1 + 1,
    bottom: box.y1 + 1,
    width: box.x1 + 1 - box.x0,
    height: box.y1 + 1 - box.y0
  }
  const { x0, y0, x1, y1 } = box
  if (x1 < x0 || y1 < y0 || width <= 0 || height <= 0) return intBox

  // 搜索范围：二值化外框各向外扩 1 像素（再往外不可能有真实边界）
  const sx0 = Math.max(0, x0 - 1)
  const sy0 = Math.max(0, y0 - 1)
  const sx1 = Math.min(width - 1, x1 + 1)
  const sy1 = Math.min(height - 1, y1 + 1)
  if (sx1 < sx0 || sy1 < sy0) return intBox

  // ---------- 背景亮度：框外一圈的灰度中位数 ----------
  const ring: number[] = []
  const pad = Math.max(2, Math.round((y1 - y0 + 1) * 0.5))
  const rx0 = Math.max(0, x0 - pad)
  const ry0 = Math.max(0, y0 - pad)
  const rx1 = Math.min(width, x1 + 1 + pad)
  const ry1 = Math.min(height, y1 + 1 + pad)
  if (ry0 > 0) for (let x = rx0; x < rx1; x++) ring.push(gray[(ry0 - 1) * width + x])
  if (ry1 < height) for (let x = rx0; x < rx1; x++) ring.push(gray[ry1 * width + x])
  if (rx0 > 0) for (let y = ry0; y < ry1; y++) ring.push(gray[y * width + rx0 - 1])
  if (rx1 < width) for (let y = ry0; y < ry1; y++) ring.push(gray[y * width + rx1])
  if (ring.length === 0) return intBox
  ring.sort((a, b) => a - b)
  const bg = ring[ring.length >> 1]

  // ---------- 墨迹亮度：框内灰度的 2% 分位（比 min 抗噪） ----------
  const inside: number[] = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) inside.push(gray[y * width + x])
  if (inside.length === 0) return intBox
  inside.sort((a, b) => a - b)
  const fg = inside[Math.floor(inside.length * 0.02)]
  const span = bg - fg
  if (span < 16) return intBox

  // ---------- 列质量 P(j)：搜索范围内每列的覆盖率总和 ----------
  const colCount = sx1 - sx0 + 1
  const P = new Float64Array(colCount)
  for (let j = 0; j < colCount; j++) {
    let s = 0
    for (let y = sy0; y <= sy1; y++) s += clamp((bg - gray[y * width + (sx0 + j)]) / span, 0, 1)
    P[j] = s
  }
  let jL = -1
  for (let j = 0; j < colCount; j++) if (P[j] > 0) { jL = j; break }
  let jR = -1
  for (let j = colCount - 1; j >= 0; j--) if (P[j] > 0) { jR = j; break }
  if (jL < 0 || jR < 0) return intBox

  const pL = P[jL]
  const pLnext = jL + 1 < colCount ? P[jL + 1] : pL
  const leftAbs = sx0 + jL
  const left = clamp(leftAbs + 1 - pL / Math.max(pL, pLnext), leftAbs, leftAbs + 1)

  const pR = P[jR]
  const pRprev = jR - 1 >= 0 ? P[jR - 1] : pR
  const rightAbs = sx0 + jR
  const right = clamp(rightAbs + pR / Math.max(pR, pRprev), rightAbs, rightAbs + 1)

  // ---------- 行质量 Q(i)：在左右边界围出的列范围内统计 ----------
  const qx0 = Math.max(0, leftAbs)
  const qx1 = Math.min(width - 1, rightAbs)
  const rowCount = sy1 - sy0 + 1
  const Q = new Float64Array(rowCount)
  for (let i = 0; i < rowCount; i++) {
    let s = 0
    const base = (sy0 + i) * width
    for (let x = qx0; x <= qx1; x++) s += clamp((bg - gray[base + x]) / span, 0, 1)
    Q[i] = s
  }
  let iT = -1
  for (let i = 0; i < rowCount; i++) if (Q[i] > 0) { iT = i; break }
  let iB = -1
  for (let i = rowCount - 1; i >= 0; i--) if (Q[i] > 0) { iB = i; break }
  if (iT < 0 || iB < 0) return intBox

  const qT = Q[iT]
  const qTnext = iT + 1 < rowCount ? Q[iT + 1] : qT
  const topAbs = sy0 + iT
  const top = clamp(topAbs + 1 - qT / Math.max(qT, qTnext), topAbs, topAbs + 1)

  const qB = Q[iB]
  const qBprev = iB - 1 >= 0 ? Q[iB - 1] : qB
  const bottomAbs = sy0 + iB
  const bottom = clamp(bottomAbs + qB / Math.max(qB, qBprev), bottomAbs, bottomAbs + 1)

  return { left, top, right, bottom, width: right - left, height: bottom - top }
}
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'

/**
 * 纯算法抠白底（零 API 成本，全部本地像素处理）
 *
 * 思路：
 * 1. 从图像四周边界采样颜色，逐通道取中位数得到背景色 bg
 * 2. 从边界做泛洪填充（连通性判定，保护主体内部与背景相近的区域）：
 *    - 硬阈值（HARD）：与 bg 色差小 → 直接并入背景
 *    - 软阈值（SOFT）：与 bg 色差中等且邻接背景 → 并入（吸收渐变背景/落影）
 * 3. 封闭色块清理（v0.6.1 新增）：主体之间的「口袋」区域（如手臂与身体间的空隙）
 *    与边界不连通，泛洪永远填不到 —— 对未标记且颜色接近 bg 的像素做连通分量分析，
 *    小分量直接标记为背景（仅彩色背景下启用，浅色背景保护主体内部白字）
 * 4. 前景 alpha：边缘带按色差线性过渡（反锯齿）；去污染：半透明边缘像素按
 *    fg = (px - (1-a)*bg)/a 反解真实前景色，消除背景色晕边
 * 5. 合成 RGBA 后 flatten 到纯白背景，输出 PNG
 *
 * 已知边界：背景色与产品主体颜色非常接近时（如纯白产品在纯白底）效果有限；
 * 建议用于「背景为纯色/浅灰/渐变浅色」的产品图。
 */

export interface WhiteBgLocalResult {
  /** 结果图片本地路径 */
  outputPath: string
  /** 采样到的背景色（RGB） */
  bgColor: { r: number; g: number; b: number }
  /** 判定为背景的像素占比（0~1），可用于诊断（过低说明产品占满边界或背景复杂） */
  bgRatio: number
  /** 输入的尺寸（宽 / 高） */
  size: { width: number; height: number }
}

export async function makeWhiteBackgroundLocal(opts: {
  inputPath: string
  outputDir: string
  /** 容差 0~100（默认 32）：越大越激进（背景判定阈值越高），越小越保守 */
  tolerance?: number
  /** 边缘羽化 sigma（默认 0.8）：0 关闭 */
  feather?: number
}): Promise<WhiteBgLocalResult> {
  const { inputPath, outputDir } = opts
  const tolerance = clamp(opts.tolerance ?? 32, 0, 100)
  const feather = Math.max(0, opts.feather ?? 0.8)

  // ensureAlpha：统一转 RGBA，避免部分 PNG 即使全不透明也带 hasAlpha 标记
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const width = info.width
  const height = info.height
  const size = { width, height }
  const n = width * height

  // 真的存在透明像素（半透明/透明底图）：直接合成白底就是最精确的结果
  let hasTransparent = false
  for (let i = 3; i < n * 4; i += 4) {
    if (data[i] < 255) {
      hasTransparent = true
      break
    }
  }
  if (hasTransparent) {
    const png = await sharp(inputPath).flatten({ background: '#ffffff' }).png().toBuffer()
    const outputPath = await saveResult(png, inputPath, outputDir)
    return { outputPath, bgColor: { r: 255, g: 255, b: 255 }, bgRatio: 1, size }
  }

  // ---------- 1. 边界采样 -> 背景色（主色簇投票 + 降采样试填验证，抗黑框/暗角/贴边主体） ----------
  // 1a. 边界像素量化投票（16 级/通道），取 top 簇
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>()
  const addBorder = (pix: number): void => {
    const r = data[pix * 4]
    const g = data[pix * 4 + 1]
    const b = data[pix * 4 + 2]
    const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
    const e = buckets.get(key)
    if (e) {
      e.r += r
      e.g += g
      e.b += b
      e.count++
    } else {
      buckets.set(key, { r, g, b, count: 1 })
    }
  }
  for (let x = 0; x < width; x++) {
    addBorder(x)
    addBorder((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    addBorder(y * width)
    addBorder(y * width + width - 1)
  }
  const topClusters = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 5)
  const clusterColors = topClusters.map((c) => ({
    r: Math.round(c.r / c.count),
    g: Math.round(c.g / c.count),
    b: Math.round(c.b / c.count),
    votes: c.count
  }))

  // 1b. 多色背景建模：在降采样图上对「候选色组合」做快速试填，贪心选择填充面积最大的 1~3 色集合
  //     —— 黑框、橙色光斑、渐变暗角等背景杂色都会被纳入背景集合一起清除；
  //       主体颜色（不接触边界的簇）不会进入集合，不会误删主体
  const pickBgColors = (): Array<{ r: number; g: number; b: number }> => {
    const step = Math.max(1, Math.floor(Math.min(width, height) / 64))
    const gw = Math.max(2, Math.floor(width / step))
    const gh = Math.max(2, Math.floor(height / step))
    const gn = gw * gh
    const sample = (pix: number): { r: number; g: number; b: number } => {
      const src = ((pix % gw) * step + Math.floor(pix / gw) * step * width) * 4
      return { r: data[src], g: data[src + 1], b: data[src + 2] }
    }
    const d2 = (a: { r: number; g: number; b: number }, c: { r: number; g: number; b: number }): number =>
      (a.r - c.r) ** 2 + (a.g - c.g) ** 2 + (a.b - c.b) ** 2
    const trialSoft = (32 * 1.25 * 2.2) ** 2
    const fillRatio = (colors: Array<{ r: number; g: number; b: number }>): number => {
      const st = new Uint8Array(gn)
      const q = new Int32Array(gn)
      let qh = 0
      let qt = 0
      let cnt = 0
      const push = (p: number): void => {
        if (st[p] !== 0) return
        st[p] = 1
        q[qt++] = p
        cnt++
      }
      const closeToBg = (p: number): boolean => {
        const s = sample(p)
        for (const c of colors) {
          if (d2(s, c) <= trialSoft) return true
        }
        return false
      }
      for (let x = 0; x < gw; x++) {
        if (closeToBg(x)) push(x)
        const p = (gh - 1) * gw + x
        if (closeToBg(p)) push(p)
      }
      for (let y = 1; y < gh - 1; y++) {
        const p1 = y * gw
        if (closeToBg(p1)) push(p1)
        const p2 = y * gw + gw - 1
        if (closeToBg(p2)) push(p2)
      }
      while (qh < qt) {
        const p = q[qh++]
        const x = p % gw
        const y = (p / gw) | 0
        const add = (np: number): void => {
          if (st[np] !== 0) return
          if (closeToBg(np)) push(np)
        }
        if (y > 0) add(p - gw)
        if (y < gh - 1) add(p + gw)
        if (x > 0) add(p - 1)
        if (x < gw - 1) add(p + 1)
      }
      return cnt / gn
    }
    // 暗色候选（如黑框）与主体暗部（头发/深色皮肤/阴影）颜色几乎相同，颜色算法无法区分；
    // 主体优先：默认过滤暗色簇，避免误删主体的头发/暗部。仅当所有候选都偏暗时（纯黑背景场景）才退回。
    const lum = (c: { r: number; g: number; b: number }): number => (c.r * 3 + c.g * 6 + c.b) / 10
    let candidates = clusterColors.filter((c) => lum(c) >= 55)
    if (candidates.length === 0) candidates = clusterColors
    // 贪心：每次加入「让填充面积增长最多」的候选色；增长 < 5% 或已达 3 色则停止
    const chosen: Array<{ r: number; g: number; b: number }> = []
    let prev = 0
    for (let k = 0; k < 3; k++) {
      let bestNew: { r: number; g: number; b: number } | null = null
      let bestR = prev
      for (const c of candidates) {
        if (chosen.includes(c)) continue
        const r = fillRatio([...chosen, c])
        if (r > bestR) {
          bestR = r
          bestNew = c
        }
      }
      if (!bestNew || bestR - prev < 0.05) break
      chosen.push(bestNew)
      prev = bestR
    }
    if (chosen.length === 0) chosen.push(candidates[0] ?? clusterColors[0] ?? { r: 0, g: 0, b: 0 })
    return chosen
  }
  const bgColors = pickBgColors()
  const bgColor = bgColors[0] // 主背景色（用于展示）
  // 浅色背景（如白/浅灰）：主体内部白字/高光与背景同色，靠连通性保护 → 不启用封闭色块清理
  const bgIsLight = bgColors.every((c) => c.r > 210 && c.g > 210 && c.b > 210)

  // ---------- 2. 泛洪填充：连通性判定背景 ----------
  const HARD = tolerance * 1.25
  const SOFT = HARD * 1.6 // 吸收渐变/暗角/落影带（过大会吞掉与背景色接近的主体细节，如球衣蓝描边）
  const SEC = HARD * 0.9 // 封闭色块清理：仅清与背景色几乎相同（色差 < 0.9*HARD）的残块/缝隙；避免误伤主体上与背景同色系的细节（如球衣蓝描边）
  const HARD2 = HARD * HARD
  const SOFT2 = SOFT * SOFT
  const SEC2 = SEC * SEC
  // 到「最近背景色」的色距（平方，避免 sqrt）
  const dist2 = (pix: number): number => {
    const r = data[pix * 4]
    const g = data[pix * 4 + 1]
    const b = data[pix * 4 + 2]
    let m = Infinity
    for (const c of bgColors) {
      const dr = r - c.r
      const dg = g - c.g
      const db = b - c.b
      const d = dr * dr + dg * dg + db * db
      if (d < m) m = d
    }
    return m
  }

  // 0 = 未知，1 = 背景，2 = 前景
  const state = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  let bgCount = 0

  const pushBg = (pix: number): void => {
    if (state[pix] !== 0) return
    state[pix] = 1
    queue[tail++] = pix
    bgCount++
  }

  // 种子：四条边（含偏暗的边角/落影用 SOFT 收进来）
  for (let x = 0; x < width; x++) {
    if (dist2(x) <= SOFT2) pushBg(x)
    const bottom = (height - 1) * width + x
    if (dist2(bottom) <= SOFT2) pushBg(bottom)
  }
  for (let y = 1; y < height - 1; y++) {
    const left = y * width
    if (dist2(left) <= SOFT2) pushBg(left)
    const right = y * width + width - 1
    if (dist2(right) <= SOFT2) pushBg(right)
  }

  // BFS：与任一背景色色差 <= SOFT 即并入（相邻背景隐含于扩展方向）
  function growBg(): void {
    while (head < tail) {
      const pix = queue[head++]
      const x = pix % width
      const y = (pix / width) | 0
      const tryBg = (nbPix: number): void => {
        if (state[nbPix] !== 0) return
        if (dist2(nbPix) <= SOFT2) pushBg(nbPix)
      }
      if (y > 0) tryBg(pix - width)
      if (y < height - 1) tryBg(pix + width)
      if (x > 0) tryBg(pix - 1)
      if (x < width - 1) tryBg(pix + 1)
    }
  }
  growBg()

  // ---------- 3. 封闭色块清理（彩色背景）：被主体包围的背景口袋 + 残留色斑 ----------
  // 仅彩色背景启用：浅色背景上主体内部的白色区域会与背景同色，不能靠颜色消掉
  if (!bgIsLight) {
    const maxClean = Math.max(1500, Math.floor(0.05 * n))
    const cand = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      if (state[i] === 0 && dist2(i) <= SEC2) cand[i] = 1
    }
    for (let i = 0; i < n; i++) {
      if (cand[i] !== 1) continue
      // BFS 该连通分量
      const comp = new Int32Array(n)
      let cHead = 0
      let cTail = 0
      let size = 0
      comp[cTail++] = i
      cand[i] = 2
      while (cHead < cTail) {
        const p = comp[cHead++]
        size++
        const x = p % width
        const y = (p / width) | 0
        const nb = (q: number): void => {
          if (q >= 0 && q < n && cand[q] === 1) {
            cand[q] = 2
            comp[cTail++] = q
          }
        }
        if (y > 0) nb(p - width)
        if (y < height - 1) nb(p + width)
        if (x > 0) nb(p - 1)
        if (x < width - 1) nb(p + 1)
      }
      if (size <= maxClean) {
        for (let k = 0; k < size; k++) pushBg(comp[k])
      }
    }
    // 口袋清理后再次软生长（吸收口袋边缘的渐变色带）
    if (head < tail) growBg()
  }

  const bgRatio = bgCount / n

  // ---------- 4. 前景 alpha：边缘带线性过渡（反锯齿），内部保持不透明 ----------
  const alpha = new Uint8Array(n)
  const EDGE = HARD * 1.8
  const EDGE2 = EDGE * EDGE
  for (let i = 0; i < n; i++) {
    if (state[i] === 1) continue
    const x = i % width
    const y = (i / width) | 0
    const nearBg =
      (x > 0 && state[i - 1] === 1) ||
      (x < width - 1 && state[i + 1] === 1) ||
      (y > 0 && state[i - width] === 1) ||
      (y < height - 1 && state[i + width] === 1)
    if (!nearBg) {
      alpha[i] = 255
      continue
    }
    const d2 = dist2(i)
    if (d2 >= EDGE2) {
      alpha[i] = 255
    } else {
      alpha[i] = Math.round(((Math.sqrt(d2) - HARD) / (EDGE - HARD)) * 255)
    }
  }

  // ---------- 5. 羽化（轻模糊，软化锯齿边缘；JS 盒式模糊避免 sharp 单通道扩展问题） ----------
  const finalAlpha = feather >= 0.6 ? boxBlurAlpha(alpha, width, height, 1) : alpha

  // ---------- 6. 合成 RGBA -> 白底 PNG（半透明边缘做去污染，消除背景色晕边） ----------
  const nearestBg = (pix: number): { r: number; g: number; b: number } => {
    const r = data[pix * 4]
    const g = data[pix * 4 + 1]
    const b = data[pix * 4 + 2]
    let m = Infinity
    let best = bgColors[0]
    for (const c of bgColors) {
      const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2
      if (d < m) {
        m = d
        best = c
      }
    }
    return best
  }
  const rgba = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const src = i * 4
    let r = data[src]
    let g = data[src + 1]
    let b = data[src + 2]
    const a0 = alpha[i]
    if (a0 > 0 && a0 < 255 && a0 >= 60) {
      // 边缘像素：px = a*fg + (1-a)*bg → 反解 fg（线性近似），使用最近的背景色，去除晕边
      const bgc = nearestBg(i)
      const t = a0 / 255
      const inv = 1 - t
      r = clamp(Math.round((r - inv * bgc.r) / t), 0, 255)
      g = clamp(Math.round((g - inv * bgc.g) / t), 0, 255)
      b = clamp(Math.round((b - inv * bgc.b) / t), 0, 255)
    }
    rgba[src] = r
    rgba[src + 1] = g
    rgba[src + 2] = b
    rgba[src + 3] = finalAlpha[i]
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4, premultiplied: false } })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer()

  const outputPath = await saveResult(png, inputPath, outputDir)
  return { outputPath, bgColor, bgRatio, size }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 可分离盒式模糊（半径 1，近似 gaussian sigma~0.8），用于 alpha 边缘羽化 */
function boxBlurAlpha(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const n = width * height
  const win = radius * 2 + 1
  const tmp = new Float64Array(n)
  const out = new Uint8Array(n)
  // 水平
  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x++) {
      const xx = Math.min(width - 1, Math.max(0, x))
      sum += src[row + xx]
    }
    tmp[row] = sum / win
    for (let x = 1; x < width; x++) {
      sum += src[row + Math.min(width - 1, x + radius)] - src[row + Math.max(0, x - radius - 1)]
      tmp[row + x] = sum / win
    }
  }
  // 垂直
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let y = -radius; y <= radius; y++) {
      const yy = Math.min(height - 1, Math.max(0, y))
      sum += tmp[yy * width + x]
    }
    out[x] = sum / win
    for (let y = 1; y < height; y++) {
      sum += tmp[Math.min(height - 1, y + radius) * width + x] - tmp[Math.max(0, y - radius - 1) * width + x]
      out[y * width + x] = sum / win
    }
  }
  return out
}

/** 保存结果（确保输出目录存在） */
async function saveResult(png: Buffer, inputPath: string, outputDir: string): Promise<string> {
  const { uniqueResultPath } = await import('./util')
  await mkdir(outputDir, { recursive: true })
  const finalPath = uniqueResultPath(outputDir, inputPath, '.png')
  await writeFile(finalPath, png)
  return finalPath
}

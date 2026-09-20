import { describe, expect, it } from 'vitest'
import { DEFAULT_DETECT, detectLabelBox, refineBoxSubpixel } from '../src/main/api/labelDetect'

/**
 * 亚像素细化的精度验证。
 *
 * 做法：构造一块**已知连续边界**的合成墨迹 —— 先按「像素覆盖率 = 面积重叠」
 * 算出每个像素的灰度（这正是真实栅格化器在做的事），再让检测/细化去还原边界。
 * 这样真值是精确已知的，能直接量误差，而不是互相猜。
 */
function paint(
  W: number,
  H: number,
  rect: { left: number; top: number; right: number; bottom: number },
  bgGray = 255,
  fgGray = 0
): Buffer {
  const g = Buffer.alloc(W * H, bgGray)
  for (let y = 0; y < H; y++) {
    const oy = Math.min(y + 1, rect.bottom) - Math.max(y, rect.top)
    if (oy <= 0) continue
    for (let x = 0; x < W; x++) {
      const ox = Math.min(x + 1, rect.right) - Math.max(x, rect.left)
      if (ox <= 0) continue
      const cov = ox * oy
      g[y * W + x] = Math.round(bgGray + (fgGray - bgGray) * cov)
    }
  }
  return g
}

const W = 200
const H = 100
/** 放在底部条带内（86%~99.9%）、高度 >= minRunHeight 的一块墨迹 */
const TRUTH = { left: 40.5, top: 86.5, right: 130.25, bottom: 99.5 }

describe('refineBoxSubpixel（覆盖率法亚像素边界）', () => {
  it('能还原已知的连续边界（误差 < 0.05px）', () => {
    const gray = paint(W, H, TRUTH)
    const box = detectLabelBox(gray, W, H, DEFAULT_DETECT)
    expect(box).not.toBeNull()
    // 二值化只能给到整数边界
    expect(box).toEqual({ x0: 41, y0: 87, x1: 129, y1: 98 })

    const e = refineBoxSubpixel(gray, W, H, box!, DEFAULT_DETECT)
    expect(Math.abs(e.left - TRUTH.left)).toBeLessThan(0.05)
    expect(Math.abs(e.top - TRUTH.top)).toBeLessThan(0.05)
    expect(Math.abs(e.right - TRUTH.right)).toBeLessThan(0.05)
    expect(Math.abs(e.bottom - TRUTH.bottom)).toBeLessThan(0.05)
    // 尺寸精度同样重要：整数框会把它算成 89×12，真值是 89.75×13
    expect(Math.abs(e.width - (TRUTH.right - TRUTH.left))).toBeLessThan(0.05)
    expect(Math.abs(e.height - (TRUTH.bottom - TRUTH.top))).toBeLessThan(0.05)
  })

  it('边界正好落在像素栅格上时，不会把框撑大或缩小', () => {
    const aligned = { left: 41, top: 87, right: 130, bottom: 99 }
    const gray = paint(W, H, aligned)
    const box = detectLabelBox(gray, W, H, DEFAULT_DETECT)!
    const e = refineBoxSubpixel(gray, W, H, box, DEFAULT_DETECT)
    expect(e.left).toBeCloseTo(41, 1)
    expect(e.top).toBeCloseTo(87, 1)
    expect(e.right).toBeCloseTo(130, 1)
    expect(e.bottom).toBeCloseTo(99, 1)
    expect(e.width).toBeCloseTo(89, 1)
    expect(e.height).toBeCloseTo(12, 1)
  })

  it('半像素偏移能被稳定还原（0.5 / 0.25 / 0.75 三档）', () => {
    for (const [dx, dy] of [
      [0.5, 0.5],
      [0.25, 0.75],
      [0.75, 0.25]
    ]) {
      const t = { left: 40 + dx, top: 86 + dy, right: 130 + dx, bottom: 99 + dy }
      const gray = paint(W, H, t)
      const box = detectLabelBox(gray, W, H, DEFAULT_DETECT)!
      const e = refineBoxSubpixel(gray, W, H, box, DEFAULT_DETECT)
      expect(Math.abs(e.left - t.left)).toBeLessThan(0.06)
      expect(Math.abs(e.top - t.top)).toBeLessThan(0.06)
      expect(Math.abs(e.width - 90)).toBeLessThan(0.06)
      expect(Math.abs(e.height - 13)).toBeLessThan(0.06)
    }
  })

  it('对比度不足（浅灰底 + 浅灰字）时退回整数框', () => {
    const gray = paint(W, H, TRUTH, 200, 190) // span 只有 10 < 16
    const box = detectLabelBox(gray, W, H, { ...DEFAULT_DETECT, inkThreshold: 195 })!
    expect(box).not.toBeNull()
    const e = refineBoxSubpixel(gray, W, H, box, DEFAULT_DETECT)
    expect(e).toEqual({
      left: box.x0,
      top: box.y0,
      right: box.x1 + 1,
      bottom: box.y1 + 1,
      width: box.x1 + 1 - box.x0,
      height: box.y1 + 1 - box.y0
    })
  })

  it('细化结果永远落在整数框 ±1px 之内（不会比二值化更差）', () => {
    for (const dx of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const t = { left: 40 + dx, top: 86 + dx, right: 130 + dx, bottom: 99 + dx }
      const gray = paint(W, H, t)
      const box = detectLabelBox(gray, W, H, DEFAULT_DETECT)!
      const e = refineBoxSubpixel(gray, W, H, box, DEFAULT_DETECT)
      expect(e.left).toBeGreaterThanOrEqual(box.x0 - 1)
      expect(e.left).toBeLessThanOrEqual(box.x0 + 1)
      expect(e.right).toBeGreaterThanOrEqual(box.x1)
      expect(e.right).toBeLessThanOrEqual(box.x1 + 2)
      expect(e.width).toBeGreaterThan(0)
      expect(e.height).toBeGreaterThan(0)
    }
  })
})

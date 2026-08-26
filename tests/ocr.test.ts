import { describe, expect, it } from 'vitest'
import { matchTextInRegion, selectGoodsCandidate } from '../src/main/api/ocr'
import type { DetectedText } from '../src/main/api/ocr'

describe('selectGoodsCandidate 货号候选筛选', () => {
  const words = [
    { text: '玩具', confidence: 92, bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } },
    { text: 'TOY-001', confidence: 88, bbox: { x0: 30, y0: 5, x1: 90, y1: 25 } },
    { text: '2026', confidence: 97, bbox: { x0: 100, y0: 5, x1: 140, y1: 25 } }
  ]

  it('无锚点：选中含字母+数字的货号（排除纯数字和纯中文）', () => {
    const best = selectGoodsCandidate(words)
    expect(best?.text).toBe('TOY-001')
  })

  it('有锚点：只匹配以锚点开头的文字', () => {
    const best = selectGoodsCandidate(words, 'TOY')
    expect(best?.text).toBe('TOY-001')
  })

  it('锚点不匹配时返回 null', () => {
    const best = selectGoodsCandidate(words, 'BAN')
    expect(best).toBeNull()
  })

  it('空结果返回 null', () => {
    expect(selectGoodsCandidate([])).toBeNull()
  })

  it('支持点号分隔货号：NO.JT888-10 直接匹配', () => {
    const best = selectGoodsCandidate([
      { text: 'FUN', confidence: 90, bbox: { x0: 0, y0: 0, x1: 30, y1: 15 } },
      { text: 'NO.JT888-10', confidence: 85, bbox: { x0: 40, y0: 5, x1: 140, y1: 25 } }
    ])
    expect(best?.text).toBe('NO.JT888-10')
  })

  it('同行拼接：NO. 和 JT888-10 被切碎时合并命中', () => {
    const best = selectGoodsCandidate([
      { text: 'NO.', confidence: 95, bbox: { x0: 40, y0: 5, x1: 70, y1: 25 } },
      { text: 'JT888-10', confidence: 90, bbox: { x0: 75, y0: 5, x1: 145, y1: 25 } }
    ])
    expect(best?.text).toBe('NO.JT888-10')
    // 合并 bbox 覆盖两个词
    expect(best!.bbox.x0).toBe(40)
    expect(best!.bbox.x1).toBe(145)
  })

  it('不同行的词不拼接', () => {
    const best = selectGoodsCandidate([
      { text: 'NO.', confidence: 95, bbox: { x0: 40, y0: 5, x1: 70, y1: 25 } },
      { text: 'JT888-10', confidence: 90, bbox: { x0: 75, y0: 100, x1: 145, y1: 120 } }
    ])
    // 第二行单独匹配成功（JT888-10 自身含字母数字）
    expect(best?.text).toBe('JT888-10')
  })

  it('间隙过大的同行词不拼接（避免误拼无关文字）', () => {
    // FUN 与 TOY-001 之间间隙很大（> 行高*0.6）
    const best = selectGoodsCandidate([
      { text: 'FUN', confidence: 92, bbox: { x0: 0, y0: 5, x1: 30, y1: 25 } },
      { text: 'TOY-001', confidence: 90, bbox: { x0: 200, y0: 5, x1: 280, y1: 25 } }
    ])
    // 不拼接 FUNTOY-001；单词级命中 TOY-001
    expect(best?.text).toBe('TOY-001')
  })

  it('支持斜杠分隔：ABC/12345 匹配', () => {
    const best = selectGoodsCandidate([
      { text: 'ABC/12345', confidence: 88, bbox: { x0: 10, y0: 5, x1: 100, y1: 25 } }
    ])
    expect(best?.text).toBe('ABC/12345')
  })

  it('line 级优先：整行文本 NO.JT888-10（含空格）直接命中', () => {
    const best = selectGoodsCandidate(
      [
        // word 级都不完整（被切碎）
        { text: 'NO.', confidence: 95, bbox: { x0: 40, y0: 5, x1: 70, y1: 25 } },
        { text: 'JT888-10', confidence: 90, bbox: { x0: 75, y0: 5, x1: 145, y1: 25 } }
      ],
      undefined,
      [
        { text: 'NO. JT888-10', confidence: 96, bbox: { x0: 40, y0: 5, x1: 145, y1: 25 } },
        { text: 'FUN TIC-TAC-TOE', confidence: 98, bbox: { x0: 0, y0: 60, x1: 200, y1: 80 } }
      ]
    )
    expect(best?.text).toBe('NO. JT888-10')
    expect(best?.bbox.x1).toBe(145)
  })

  it('line 级匹配支持锚点', () => {
    const best = selectGoodsCandidate(
      [{ text: 'NO.', confidence: 95, bbox: { x0: 40, y0: 5, x1: 70, y1: 25 } }],
      'NO',
      [{ text: 'NO.JT888-10', confidence: 96, bbox: { x0: 40, y0: 5, x1: 145, y1: 25 } }]
    )
    expect(best?.text).toBe('NO.JT888-10')
  })
})

describe('matchTextInRegion', () => {
  const mockDetected: DetectedText[] = [
    {
      text: 'TOY-001',
      confidence: 95,
      bbox: { x0: 10, y0: 10, x1: 100, y1: 40 },
      fontSize: 24,
      color: { r: 0, g: 0, b: 0 }
    },
    {
      text: '玩具',
      confidence: 90,
      bbox: { x0: 110, y0: 10, x1: 180, y1: 40 },
      fontSize: 20,
      color: { r: 50, g: 50, b: 50 }
    }
  ]

  it('精确匹配返回对应项', () => {
    const result = matchTextInRegion(mockDetected, 'TOY-001')
    expect(result?.text).toBe('TOY-001')
  })

  it('包含匹配返回对应项', () => {
    const result = matchTextInRegion(mockDetected, 'TOY')
    expect(result?.text).toBe('TOY-001')
  })

  it('无匹配时返回第一项', () => {
    const result = matchTextInRegion(mockDetected, 'NOTEXIST')
    expect(result?.text).toBe('TOY-001')
  })

  it('空 oldText 返回第一项', () => {
    const result = matchTextInRegion(mockDetected, '')
    expect(result?.text).toBe('TOY-001')
  })

  it('空数组返回 null', () => {
    const result = matchTextInRegion([], 'TOY-001')
    expect(result).toBeNull()
  })
})

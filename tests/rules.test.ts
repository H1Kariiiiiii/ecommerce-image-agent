import { describe, expect, it } from 'vitest'
import { buildGoodsNumberPattern } from '../src/shared/rules'

describe('buildGoodsNumberPattern', () => {
  it('无锚点：匹配通用货号形态', () => {
    const p = buildGoodsNumberPattern()
    p.lastIndex = 0
    expect(p.test('TOY-001')).toBe(true)
    p.lastIndex = 0
    expect(p.test('ABC123')).toBe(true)
    p.lastIndex = 0
    expect(p.test('毛绒玩具')).toBe(false)
  })

  it('有锚点：匹配以锚点开头的货号', () => {
    const p = buildGoodsNumberPattern('TOY')
    p.lastIndex = 0
    expect(p.test('TOY-001')).toBe(true)
    p.lastIndex = 0
    expect(p.test('BAN-001')).toBe(false)
  })

  it('支持点号分隔：NO.JT888-10', () => {
    const p = buildGoodsNumberPattern()
    p.lastIndex = 0
    expect(p.test('NO.JT888-10')).toBe(true)
  })

  it('支持斜杠分隔：ABC/12345', () => {
    const p = buildGoodsNumberPattern()
    p.lastIndex = 0
    expect(p.test('ABC/12345')).toBe(true)
  })

  it('纯数字不匹配', () => {
    const p = buildGoodsNumberPattern()
    p.lastIndex = 0
    expect(p.test('2026')).toBe(false)
    p.lastIndex = 0
    expect(p.test('6 MODES')).toBe(false)
  })

  it('锚点 + 点号：NO 锚点匹配 NO.JT888-10', () => {
    const p = buildGoodsNumberPattern('NO')
    p.lastIndex = 0
    expect(p.test('NO.JT888-10')).toBe(true)
  })
})

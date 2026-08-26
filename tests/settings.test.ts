// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

let settings: typeof import('../src/main/settings')

beforeEach(async () => {
  state.userData = mkdtempSync(join(tmpdir(), 'settings-test-'))
  vi.resetModules()
  settings = await import('../src/main/settings')
})

afterEach(() => {
  vi.resetModules()
})

describe('settings 额度统计', () => {
  it('默认额度：不限、本月已用 0', async () => {
    const q = await settings.getQuota()
    expect(q.limit).toBe(0)
    expect(q.used).toBe(0)
    expect(q.yearMonth).toMatch(/^\d{4}-\d{2}$/)
  })

  it('setQuotaLimit 保存上限并持久化到 settings.json', async () => {
    const q = await settings.setQuotaLimit(100)
    expect(q.limit).toBe(100)
    expect(q.used).toBe(0)
    const raw = JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8'))
    expect(raw.quota.monthlyLimit).toBe(100)
  })

  it('bumpQuotaUsage 每次生成 +1 用量', async () => {
    await settings.setQuotaLimit(3)
    expect((await settings.bumpQuotaUsage()).used).toBe(1)
    expect((await settings.bumpQuotaUsage()).used).toBe(2)
    const q = await settings.getQuota()
    expect(q.used).toBe(2)
    expect(q.limit).toBe(3)
  })

  it('isQuotaExhausted：达到上限拦截，未达/不限放行', async () => {
    await settings.setQuotaLimit(2)
    await settings.bumpQuotaUsage()
    expect(await settings.isQuotaExhausted()).toBe(false)
    await settings.bumpQuotaUsage()
    expect(await settings.isQuotaExhausted()).toBe(true)
    // 不限额度永不拦截
    await settings.setQuotaLimit(0)
    expect(await settings.isQuotaExhausted()).toBe(false)
  })

  it('setQuotaLimit 忽略非法值（负数/NaN 归零）', async () => {
    const q = await settings.setQuotaLimit(-5)
    expect(q.limit).toBe(0)
    const q2 = await settings.setQuotaLimit(Number.NaN)
    expect(q2.limit).toBe(0)
  })

  it('重启（重新加载）后用量保留', async () => {
    await settings.setQuotaLimit(10)
    await settings.bumpQuotaUsage()
    await settings.bumpQuotaUsage()
    vi.resetModules()
    settings = await import('../src/main/settings')
    const q = await settings.getQuota()
    expect(q.used).toBe(2)
    expect(q.limit).toBe(10)
  })
})

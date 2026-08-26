// @vitest-environment node
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => join(state.userData) } }))

let cache: typeof import('../src/main/cache')

beforeEach(async () => {
  state.userData = mkdtempSync(join(tmpdir(), 'cache-test-'))
  vi.resetModules()
  cache = await import('../src/main/cache')
})

afterEach(() => {
  vi.resetModules()
})

describe('结果缓存管理', () => {
  it('getResultCacheInfo 统计文件数与大小', async () => {
    const dir = join(state.userData, 'processed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(100))
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(200))
    const info = await cache.getResultCacheInfo()
    expect(info.fileCount).toBe(2)
    expect(info.sizeBytes).toBe(300)
  })

  it('cleanResultCache 只删除超过期限的旧文件', async () => {
    const dir = join(state.userData, 'processed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.png'), Buffer.alloc(100))
    writeFileSync(join(dir, 'new.png'), Buffer.alloc(50))
    // 把 old.png 改成 10 天前
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    utimesSync(join(dir, 'old.png'), oldTime, oldTime)
    const r = await cache.cleanResultCache(7 * 24 * 60 * 60 * 1000)
    expect(r.removedCount).toBe(1)
    expect(r.freedBytes).toBe(100)
    const info = await cache.getResultCacheInfo()
    expect(info.fileCount).toBe(1)
  })

  it('clearAllResultCache 清空全部', async () => {
    const dir = join(state.userData, 'processed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(100))
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(200))
    const r = await cache.clearAllResultCache()
    expect(r.removedCount).toBe(2)
    expect(r.freedBytes).toBe(300)
    const info = await cache.getResultCacheInfo()
    expect(info.fileCount).toBe(0)
    expect(info.sizeBytes).toBe(0)
  })

  it('目录不存在时所有操作安全返回零', async () => {
    const info = await cache.getResultCacheInfo()
    expect(info.fileCount).toBe(0)
    expect((await cache.cleanResultCache(1000)).removedCount).toBe(0)
    expect((await cache.clearAllResultCache()).removedCount).toBe(0)
  })

  it('处理中任务存在时清空缓存被拒绝，释放后可正常清理（竞态保护）', async () => {
    const dir = join(state.userData, 'processed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(10))
    // 模拟 processImage 处理中（beginActiveTask 登记后未释放）
    const release = cache.beginActiveTask()
    await expect(cache.clearAllResultCache()).rejects.toThrow(/处理中/)
    // 释放后清理恢复正常
    release()
    const r = await cache.clearAllResultCache()
    expect(r.removedCount).toBe(1)
  })

  it('多个 beginActiveTask 嵌套：全部释放后才允许清空', async () => {
    const release1 = cache.beginActiveTask()
    const release2 = cache.beginActiveTask()
    await expect(cache.clearAllResultCache()).rejects.toThrow(/处理中/)
    release1()
    await expect(cache.clearAllResultCache()).rejects.toThrow(/处理中/)
    release2()
    expect((await cache.clearAllResultCache()).removedCount).toBe(0)
  })

  it('统计与清理并发调用串行执行，结果一致（TOCTOU 修复）', async () => {
    const dir = join(state.userData, 'processed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(100))
    // 三个操作并发发起：串行队列保证 统计(1 个) → 清空 → 统计(0 个) 的顺序与结果一致
    const [info1, r, info2] = await Promise.all([
      cache.getResultCacheInfo(),
      cache.clearAllResultCache(),
      cache.getResultCacheInfo()
    ])
    expect(info1.fileCount).toBe(1)
    expect(r.removedCount).toBe(1)
    expect(info2.fileCount).toBe(0)
    expect(info2.sizeBytes).toBe(0)
  })
})

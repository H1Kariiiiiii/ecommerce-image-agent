import { app } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CacheInfo, CleanResult } from '../shared/types'

function resultDir(): string {
  return join(app.getPath('userData'), 'processed')
}

// ---------- 并发保护 ----------

/**
 * 处理中的任务数：processImage 期间置位，防止「清空缓存」误删正在生成的结果文件
 * （清理发生在 readdir 快照之后、下载完成之前时，会把正在写入的文件删掉，导致结果丢失/预览 404）。
 */
let activeTaskCount = 0

/** 登记一个处理中任务；返回释放函数，任务成功/失败结束时必须调用 */
export function beginActiveTask(): () => void {
  activeTaskCount += 1
  return () => {
    activeTaskCount -= 1
  }
}

/** 是否有处理中任务（清空全部缓存时用于拒绝执行） */
export function hasActiveTask(): boolean {
  return activeTaskCount > 0
}

/**
 * 模块内串行队列：统计 / 清理互斥执行，消除 getResultCacheInfo 与清理操作
 * 交错导致的 TOCTOU 窗口（readdir 快照与 stat/rm 之间文件被并发操作删除或替换）。
 */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 扫描结果缓存：文件数与总大小 */
export function getResultCacheInfo(): Promise<CacheInfo> {
  return serial(async (): Promise<CacheInfo> => {
    const dir = resultDir()
    let fileCount = 0
    let sizeBytes = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        fileCount += 1
        try {
          const s = await stat(join(dir, e.name))
          sizeBytes += s.size
        } catch {
          /* 文件可能刚好被删 */
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return { fileCount, sizeBytes }
  })
}

/** 清理超过 maxAgeMs 的旧结果文件（应用启动时调用），返回清理统计 */
export function cleanResultCache(maxAgeMs: number): Promise<CleanResult> {
  return serial(async (): Promise<CleanResult> => {
    const dir = resultDir()
    const now = Date.now()
    let removedCount = 0
    let freedBytes = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        const full = join(dir, e.name)
        try {
          const s = await stat(full)
          if (now - s.mtimeMs > maxAgeMs) {
            await rm(full, { force: true })
            removedCount += 1
            freedBytes += s.size
          }
        } catch {
          /* 跳过 */
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return { removedCount, freedBytes }
  })
}

/** 清空全部结果缓存（用户手动触发），返回清理统计；有处理中任务时拒绝执行 */
export function clearAllResultCache(): Promise<CleanResult> {
  return serial(async (): Promise<CleanResult> => {
    if (hasActiveTask()) {
      throw new Error('有图片正在处理中，请稍后再清理缓存')
    }
    const dir = resultDir()
    let removedCount = 0
    let freedBytes = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile()) continue
        const full = join(dir, e.name)
        try {
          const s = await stat(full)
          await rm(full, { force: true })
          removedCount += 1
          freedBytes += s.size
        } catch {
          /* 跳过 */
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return { removedCount, freedBytes }
  })
}

import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, QuotaInfo } from '../shared/types'
import { writeJsonAtomic } from './api/util'

const DEFAULT_SETTINGS: AppSettings = { theme: 'system' }

let cache: AppSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 读取应用设置（userData/settings.json），损坏或缺失时回退默认值 */
export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

/** 合并保存应用设置并返回最新值 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch }
  await writeJsonAtomic(settingsFile(), next)
  cache = next
  return next
}

/** 写操作串行队列：保证额度 bump 不会并发读-改-写（跨调用原子性） */
let writeChain: Promise<unknown> = Promise.resolve()
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}

/** 当前统计月份（YYYY-MM） */
function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 读取当前额度信息（跨月自动重置已用量） */
export async function getQuota(): Promise<QuotaInfo> {
  const s = await getSettings()
  const ym = currentMonth()
  const q = s.quota ?? { monthlyLimit: 0, used: 0, yearMonth: ym }
  if (q.yearMonth !== ym) {
    q.yearMonth = ym
    q.used = 0
  }
  return { used: q.used, limit: q.monthlyLimit ?? 0, yearMonth: ym }
}

/** 设置每月额度上限（0 = 不限），保留本月已用量 */
export async function setQuotaLimit(monthlyLimit: number): Promise<QuotaInfo> {
  const s = await getSettings()
  const ym = currentMonth()
  const q = s.quota ?? { monthlyLimit: 0, used: 0, yearMonth: ym }
  q.monthlyLimit = Math.max(0, Math.floor(monthlyLimit) || 0)
  if (q.yearMonth !== ym) {
    q.yearMonth = ym
    q.used = 0
  }
  await saveSettings({ quota: q })
  return { used: q.used, limit: q.monthlyLimit, yearMonth: ym }
}

/** 本月额度是否已用完（limit=0 表示不限） */
export async function isQuotaExhausted(): Promise<boolean> {
  const q = await getQuota()
  return q.limit > 0 && q.used >= q.limit
}

/** 生成成功后记录一次用量（跨月重置），返回最新额度；串行执行避免并发漏记/超发 */
export function bumpQuotaUsage(): Promise<QuotaInfo> {
  return enqueueWrite(async (): Promise<QuotaInfo> => {
    const s = await getSettings()
    const ym = currentMonth()
    const q = s.quota ?? { monthlyLimit: 0, used: 0, yearMonth: ym }
    if (q.yearMonth !== ym) {
      q.yearMonth = ym
      q.used = 0
    }
    q.used += 1
    await saveSettings({ quota: q })
    return { used: q.used, limit: q.monthlyLimit ?? 0, yearMonth: ym }
  })
}

import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderConfig } from '../shared/types'
import { writeJsonAtomic } from './api/util'

const FILE = 'providers.json'

function filePath(): string {
  return join(app.getPath('userData'), FILE)
}

/** 首次启动预置的 provider 模板（字段留待用户在设置面板填写） */
export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: randomUUID(),
      name: '火山方舟 Ark（OpenAI 兼容）',
      type: 'openai-compatible',
      active: true,
      role: 'both',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      requestStyle: 'json',
      model: '',
      size: '',
      aspectRatio: '1:1',
      apiKey: '',
      prompt: ''
    }
  ]
}

let cache: ProviderConfig[] | null = null

export async function loadProviders(): Promise<ProviderConfig[]> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as ProviderConfig[]
    // 迁移：volcano-cv 类型已从 UI 移除，自动过滤旧配置（保留 OpenAI 兼容项）
    const list = Array.isArray(parsed) ? parsed.filter((p) => p.type !== 'volcano-cv') : []
    // 迁移：比例与 size 二选一——老版本默认配置残留 size='2048x2048'，
    // 清掉残留让「生成比例」生效（用户无需手动重新保存）
    for (const p of list) {
      if (p.aspectRatio && p.size) p.size = ''
    }
    cache = list.length > 0 ? list : defaultProviders()
  } catch {
    cache = defaultProviders()
    await persist(cache)
  }
  return cache
}

export async function getActiveProvider(): Promise<ProviderConfig | undefined> {
  const all = await loadProviders()
  return all.find((p) => p.active) ?? all[0]
}

/**
 * 按用途选择 provider：
 * - role 匹配（white-bg / erase / both 覆盖目标用途）且 active 的优先；
 * - 无 active 匹配时取 role 匹配的第一个；
 * - 都没有则回退到 active 的第一个 / 列表第一个（兼容旧配置无 role）。
 */
export async function getProviderForRole(role: 'white-bg' | 'erase'): Promise<ProviderConfig | undefined> {
  const all = await loadProviders()
  const match = (p: ProviderConfig): boolean =>
    p.role === role || p.role === 'both' || p.role === undefined
  const active = all.find((p) => p.active && match(p))
  if (active) return active
  const any = all.find(match)
  if (any) return any
  return all.find((p) => p.active) ?? all[0]
}

/**
 * 比例与 size 二选一归一化：选了生成比例时清空残留的 size，避免 size 优先于比例
 * （UI 已保证联动，这里是兜底旧配置/异常状态，确保「切换比例」必定生效）。
 */
function normalizeSizeRatio(config: ProviderConfig): ProviderConfig {
  if (config.aspectRatio && config.size) {
    return { ...config, size: '' }
  }
  return config
}

export async function saveProvider(config: ProviderConfig): Promise<ProviderConfig[]> {
  const all = await loadProviders()
  const idx = all.findIndex((p) => p.id === config.id)
  const normalized = normalizeSizeRatio(config)
  if (idx >= 0) {
    all[idx] = { ...normalized }
  } else {
    all.push({ ...normalized, id: normalized.id || randomUUID() })
  }
  await persist(all)
  return all
}

export async function deleteProvider(id: string): Promise<ProviderConfig[]> {
  let all = await loadProviders()
  const wasActive = all.find((p) => p.id === id)?.active
  all = all.filter((p) => p.id !== id)
  if (wasActive && all.length > 0) all[0].active = true
  await persist(all)
  return all
}

export async function setActiveProvider(id: string): Promise<ProviderConfig[]> {
  const all = await loadProviders()
  for (const p of all) p.active = p.id === id
  await persist(all)
  return all
}

async function persist(list: ProviderConfig[]): Promise<void> {
  cache = list
  await writeJsonAtomic(filePath(), list)
}

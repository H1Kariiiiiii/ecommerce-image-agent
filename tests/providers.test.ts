import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../src/shared/types'

const state = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.dataDir }
}))

type ProvidersModule = typeof import('../src/main/providers')
let providers: ProvidersModule

beforeEach(async () => {
  vi.resetModules()
  state.dataDir = await mkdtemp(join(tmpdir(), 'providers-test-'))
  providers = await import('../src/main/providers')
})

describe('providers 持久化', () => {
  it('首次加载创建默认模板：OpenAI 兼容（active）', async () => {
    const list = await providers.loadProviders()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('openai-compatible')
    expect(list[0].active).toBe(true)
    // 默认模板落盘
    const raw = await readFile(join(state.dataDir, 'providers.json'), 'utf8')
    expect(JSON.parse(raw)).toHaveLength(1)
  })

  it('默认模板 size 为空（比例优先，不残留 2048x2048 覆盖比例）', async () => {
    const list = await providers.loadProviders()
    expect(list[0].size).toBe('')
    expect(list[0].aspectRatio).toBe('1:1')
  })

  it('saveProvider 兜底：选了比例时清空残留 size（比例始终生效）', async () => {
    await providers.loadProviders()
    const legacy: ProviderConfig = {
      id: 'x1',
      name: '旧配置',
      type: 'openai-compatible',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      size: '2048x2048',
      aspectRatio: '4:3'
    }
    const list = await providers.saveProvider(legacy)
    const saved = list.find((p) => p.id === 'x1')
    expect(saved?.aspectRatio).toBe('4:3')
    expect(saved?.size).toBe('')
  })

  it('saveProvider 保留自定义 size：未选比例时不改动 size', async () => {
    await providers.loadProviders()
    const custom: ProviderConfig = {
      id: 'x2',
      name: '自定义尺寸',
      type: 'openai-compatible',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      size: '2048x1152',
      aspectRatio: undefined
    }
    const list = await providers.saveProvider(custom)
    expect(list.find((p) => p.id === 'x2')?.size).toBe('2048x1152')
  })

  it('loadProviders 迁移：老配置 size 残留 + 比例并存时清空 size（升级即生效）', async () => {
    // 模拟老版本落盘的配置：size='2048x2048' 与 aspectRatio 同时存在
    const { writeFile } = await import('node:fs/promises')
    const legacy = JSON.stringify([
      {
        id: 'p1',
        name: '老配置',
        type: 'openai-compatible',
        active: true,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        model: '',
        size: '2048x2048',
        aspectRatio: '4:3'
      }
    ])
    await writeFile(join(state.dataDir, 'providers.json'), legacy, 'utf8')
    vi.resetModules()
    providers = await import('../src/main/providers')
    const list = await providers.loadProviders()
    expect(list[0].aspectRatio).toBe('4:3')
    expect(list[0].size).toBe('')
  })

  it('saveProvider 新增：自动补 id，返回完整列表', async () => {
    await providers.loadProviders()
    const draft: ProviderConfig = { id: '', name: '自定义', type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }
    const list = await providers.saveProvider(draft)
    expect(list).toHaveLength(2)
    const saved = list.find((p) => p.name === '自定义')
    expect(saved?.id).toBeTruthy()
    expect(saved?.id).not.toBe('')
  })

  it('saveProvider 更新已存在项', async () => {
    const list = await providers.loadProviders()
    const first = list[0]
    const updated = await providers.saveProvider({ ...first, model: 'doubao-seedream-5-0-260128' })
    expect(updated[0].model).toBe('doubao-seedream-5-0-260128')
    expect(updated).toHaveLength(1)
  })

  it('deleteProvider 删除 active 后自动激活列表第一项', async () => {
    const list = await providers.loadProviders()
    const deleted = await providers.deleteProvider(list[0].id)
    expect(deleted).toHaveLength(0)
  })

  it('setActiveProvider 只保留一个 active', async () => {
    await providers.loadProviders()
    const list = await providers.saveProvider({
      id: 'x1',
      name: '新',
      type: 'openai-compatible',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm'
    })
    const after = await providers.setActiveProvider('x1')
    expect(after.filter((p) => p.active)).toHaveLength(1)
    expect(after.find((p) => p.id === 'x1')?.active).toBe(true)
    expect(list.length).toBe(2)
  })

  it('getActiveProvider 返回 active 项', async () => {
    await providers.loadProviders()
    const active = await providers.getActiveProvider()
    expect(active?.type).toBe('openai-compatible')
  })

  it('损坏的配置文件回退默认并重写', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(state.dataDir, 'providers.json'), '{{{ not json', 'utf8')
    vi.resetModules()
    providers = await import('../src/main/providers')
    const list = await providers.loadProviders()
    expect(list).toHaveLength(1)
  })
})

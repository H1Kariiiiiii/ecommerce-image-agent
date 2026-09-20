// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal'
import type { ProviderConfig } from '../../src/shared/types'

const volcanoProvider: ProviderConfig = {
  id: 'p1',
  name: '方舟测试',
  type: 'openai-compatible',
  active: true,
  endpoint: 'https://visual.volcengineapi.com',
  accessKey: 'AK',
  secretKey: 'SK',
  region: 'cn-north-1',
  service: 'cv',
  version: '2022-08-31',
  action: 'CVSubmitTask',
  pollAction: 'CVGetResult',
  reqKey: 'seedream_x'
}

const saveProvider = vi.fn(async (c: ProviderConfig): Promise<ProviderConfig[]> => [c])
const deleteProvider = vi.fn(async (_id: string): Promise<ProviderConfig[]> => [])

/** 点击「删除」并在应用内确认弹层里确认（替代原生 confirm） */
async function clickDeleteAndConfirm(): Promise<void> {
  fireEvent.click(screen.getByText('删除'))
  fireEvent.click(await screen.findByText('确认删除'))
}

beforeEach(() => {
  // mockReset 清除其他测试残留的 mockImplementation，避免测试间泄漏
  saveProvider.mockReset()
  deleteProvider.mockReset()
  saveProvider.mockImplementation(async (c: ProviderConfig): Promise<ProviderConfig[]> => [c])
  deleteProvider.mockImplementation(async (_id: string): Promise<ProviderConfig[]> => [])
  window.api = {
    getPathForFile: () => '',
    getPathsForFiles: vi.fn(() => []),
    getProviders: vi.fn(async () => []),
    saveProvider,
    deleteProvider,
    setActiveProvider: vi.fn(async () => []),
    testProvider: vi.fn(async () => ({ ok: true, message: 'ok' })),
    queryBalance: vi.fn(async () => ({ ok: false, message: '不支持' })),
    processImage: vi.fn(),
    pickImage: vi.fn(),
    pickImages: vi.fn(async () => []),
    exportImage: vi.fn(),
    exportImagesToDir: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ theme: 'system' } as const)),
    saveSettings: vi.fn(async () => ({ theme: 'system' } as const)),
    getQuota: vi.fn(async () => ({ used: 0, limit: 0, yearMonth: '2026-08' } as const)),
    setQuotaLimit: vi.fn(async (n: number) => ({ used: 0, limit: n, yearMonth: '2026-08' })),
    getCacheInfo: vi.fn(async () => ({ fileCount: 0, sizeBytes: 0 })),
    cleanCache: vi.fn(async () => ({ removedCount: 0, freedBytes: 0 })),
    clearCache: vi.fn(async () => ({ removedCount: 0, freedBytes: 0 })),
    // 批量改货号 / 报价表（本次新增）
    pickFolder: vi.fn(async () => null),
    pickXlsx: vi.fn(async () => null),
    pickMapping: vi.fn(async () => null),
    labelPreview: vi.fn(async () => ({ ok: true, outputDir: '', total: 0, okCount: 0, warnCount: 0, notFoundCount: 0, errorCount: 0, renamedCount: 0, items: [], dryRun: true })),
    labelRun: vi.fn(async () => ({ ok: true, outputDir: '', total: 0, okCount: 0, warnCount: 0, notFoundCount: 0, errorCount: 0, renamedCount: 0, items: [], dryRun: false })),
    labelCancel: vi.fn(async () => true),
    onLabelProgress: vi.fn(() => () => {}),
    quotePreview: vi.fn(async () => ({ ok: true, dryRun: true })),
    quoteRun: vi.fn(async () => ({ ok: true, dryRun: false })),
    openPath: vi.fn(async () => ({ ok: true })),
    exportText: vi.fn(async () => null),
  }
})

async function addAndEdit(): Promise<ProviderConfig> {
  fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
  // 新 provider 的表单应出现
  const modelInput = await screen.findByPlaceholderText('seedream-5-0-lite')
  fireEvent.change(modelInput, { target: { value: 'my-model' } })
  // 名称也应可编辑
  const nameInput = screen.getByDisplayValue('新 API')
  fireEvent.change(nameInput, { target: { value: '我的 API' } })
  fireEvent.click(screen.getByText('保存'))
  await screen.findByText('已保存 ✓')
  return saveProvider.mock.calls[0][0]
}

describe('SettingsModal：空/单预设列表时新增并编辑', () => {
  it('providers 为空数组时，新增 provider 可编辑字段并保存', async () => {
    render(<SettingsModal providers={[]} onClose={vi.fn()} onSaved={vi.fn()} />)
    const saved = await addAndEdit()
    expect(saved.type).toBe('openai-compatible')
    expect(saved.model).toBe('my-model')
    expect(saved.name).toBe('我的 API')
    expect(saved.id).toBeTruthy()
  })

  it('只剩一个预设时，新增 provider 可编辑字段并保存', async () => {
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    const saved = await addAndEdit()
    expect(saved.model).toBe('my-model')
    expect(saved.name).toBe('我的 API')
  })

  it('预设模板：OpenAI gpt-image-2 与硅基流动 Qwen-Image', async () => {
    render(<SettingsModal providers={[]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const presetField = await screen.findByText('预设模板（可选，自动填充下面三项）')
    const preset = presetField.closest('.field')?.querySelector('select') as HTMLSelectElement

    // OpenAI 官方 · gpt-image-2
    fireEvent.change(preset, { target: { value: 'openai' } })
    expect((screen.getByPlaceholderText('https://ark.cn-beijing.volces.com/api/v3') as HTMLInputElement).value).toBe(
      'https://api.openai.com/v1'
    )
    expect((screen.getByPlaceholderText('seedream-5-0-lite') as HTMLInputElement).value).toBe('gpt-image-2')
    expect(screen.getByDisplayValue(/images\/generations/)).toBeTruthy()

    // 智谱 GLM-Image（json 风格）
    fireEvent.change(preset, { target: { value: 'zhipu' } })
    expect((screen.getByPlaceholderText('https://ark.cn-beijing.volces.com/api/v3') as HTMLInputElement).value).toBe(
      'https://open.bigmodel.cn/api/paas/v4'
    )
    expect((screen.getByPlaceholderText('seedream-5-0-lite') as HTMLInputElement).value).toBe('glm-image')
    expect(screen.getByDisplayValue(/images\/generations/)).toBeTruthy()
  })

  it('删除全部后（模拟 onSaved 空数组）再新增，仍可编辑', async () => {
    // 模拟：删除全部后 App 层 providers 为空，SettingsModal 用空数组重新挂载
    const { unmount } = render(
      <SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />
    )
    unmount()
    render(<SettingsModal providers={[]} onClose={vi.fn()} onSaved={vi.fn()} />)
    const saved = await addAndEdit()
    expect(saved.model).toBe('my-model')
  })

  it('完整操作序列：删旧预设 → 添加新的 → 再删旧 → 编辑新并保存', async () => {
    // 与用户报告一致：2 个默认预设 → 删除第 1 个 → 添加新的 → 删除第 2 个旧预设 → 编辑新预设
    const p2: ProviderConfig = { ...volcanoProvider, id: 'p2', name: '方舟 Ark', type: 'openai-compatible', active: false }
    // 模拟主进程行为：mockList 保存真实列表，delete/save 都在其上操作
    const mockList: ProviderConfig[] = [JSON.parse(JSON.stringify(volcanoProvider)), JSON.parse(JSON.stringify(p2))]
    deleteProvider.mockImplementation(async (id: string) => {
      const i = mockList.findIndex((p) => p.id === id)
      if (i >= 0) mockList.splice(i, 1)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    saveProvider.mockImplementation(async (c: ProviderConfig) => {
      const i = mockList.findIndex((p) => p.id === c.id)
      if (i >= 0) mockList[i] = c
      else mockList.push(c)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    render(<SettingsModal providers={[volcanoProvider, p2]} onClose={vi.fn()} onSaved={vi.fn()} />)

    // 删除第 1 个预设（默认选中第 1 个）
    await clickDeleteAndConfirm()
    await screen.findByText('方舟 Ark')

    // 添加新的并编辑 model，先保存（持久化到 mockList）
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const modelInput = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(modelInput, { target: { value: 'my-model' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    expect(mockList).toHaveLength(2)

    // 选中方舟并删除（删光旧预设）
    fireEvent.click(screen.getByText('方舟 Ark'))
    await clickDeleteAndConfirm()
    await screen.findByText('新 API')

    // 删除后新预设自动被选中，直接编辑并保存
    const modelInput2 = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(modelInput2, { target: { value: 'edited-model' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    const saved = saveProvider.mock.calls[saveProvider.mock.calls.length - 1][0]
    expect(saved.model).toBe('edited-model')
    expect(mockList).toHaveLength(1)
    expect(mockList[0].model).toBe('edited-model')
  })

  it('允许删除到 0 个预设（删除按钮不再因数量禁用），空列表时表单提示', async () => {
    deleteProvider.mockResolvedValue([])
    const { unmount } = render(
      <SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />
    )
    // 仅剩 1 个预设时删除按钮可用
    const delBtn = screen.getByText('删除') as HTMLButtonElement
    expect(delBtn.disabled).toBe(false)
    fireEvent.click(delBtn)
    fireEvent.click(await screen.findByText('确认删除'))
    expect(await screen.findByText('从左侧选择或新增一个 API')).toBeTruthy()
    unmount()
  })

  it('同一实例删到 0 后再新增，仍可编辑并保存', async () => {
    // 覆盖 review 建议：不重新挂载，直接在同实例内删光 → 新增 → 编辑
    deleteProvider.mockResolvedValue([])
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)

    await clickDeleteAndConfirm()
    expect(await screen.findByText('从左侧选择或新增一个 API')).toBeTruthy()

    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const modelInput = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(modelInput, { target: { value: 'after-empty' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    expect(saveProvider.mock.calls[0][0].model).toBe('after-empty')
  })

  it('空 id 预设（旧版脏数据）选中后编辑字段仍生效', async () => {
    // 直接覆盖 updateSelected 守卫修复：id==='' 的项不被 !selectedId 拦截
    const dirty: ProviderConfig = { ...volcanoProvider, id: '' }
    render(<SettingsModal providers={[dirty]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 空 id 项应被选中且表单可编辑
    const modelInput = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(modelInput, { target: { value: 'dirty_model' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    expect(saveProvider.mock.calls[0][0].model).toBe('dirty_model')
  })

  it('切换/新增/删除后不残留「已保存」提示（notice 残留修复）', async () => {
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 保存当前项 → 显示「已保存 ✓」
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    // 新增一项（自动选中）→「已保存」应被清空（handleAdd 清 notice）
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    await screen.findByPlaceholderText('seedream-5-0-lite')
    expect(screen.queryByText('已保存 ✓')).toBeNull()
    // 切回已保存项 → 再次保存 →「已保存」出现
    fireEvent.click(screen.getByText('方舟测试'))
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    // 切到未保存的新项 → 提示被清空（onClick 清 notice）
    fireEvent.click(screen.getByText('新 API'))
    expect(screen.queryByText('已保存 ✓')).toBeNull()
    // 删除已保存项后 → 提示保持清空（handleDelete 清 notice）
    deleteProvider.mockResolvedValue([])
    fireEvent.click(screen.getByText('方舟测试'))
    await clickDeleteAndConfirm()
    await screen.findByText('从左侧选择或新增一个 API')
    expect(screen.queryByText('已保存 ✓')).toBeNull()
  })

  it('保存返回期间新增的未保存项不被覆盖（handleSave 竞态回归）', async () => {
    // 模拟：保存挂起期间用户又添加了一个新项，保存回调返回旧列表时新项必须保留
    const mockList: ProviderConfig[] = [JSON.parse(JSON.stringify(volcanoProvider))]
    let releaseSave!: (v: ProviderConfig[]) => void
    saveProvider.mockImplementationOnce(
      () => new Promise<ProviderConfig[]>((resolve) => { releaseSave = resolve })
    )
    saveProvider.mockImplementation(async (c: ProviderConfig) => {
      const i = mockList.findIndex((p) => p.id === c.id)
      if (i >= 0) mockList[i] = c
      else mockList.push(c)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)

    // 添加 OpenAI 项并改名
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const nameInput = await screen.findByDisplayValue('新 API')
    fireEvent.change(nameInput, { target: { value: '我的A' } })
    // 点保存（挂起）
    fireEvent.click(screen.getByText('保存'))
    // 保存挂起期间再添加一个 OpenAI 项
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    await screen.findByPlaceholderText('seedream-5-0-lite')
    // 释放保存回调（返回旧列表，不含两个新项）
    releaseSave!([...mockList])
    await screen.findByText('已保存 ✓')
    // 两个未保存的新增项必须仍在列表中（不被旧列表覆盖）
    expect(screen.getByText('我的A')).toBeTruthy()
    expect(screen.getAllByText('新 API')).toHaveLength(1)
  })

  it('空 id 脏数据保存后收敛为新 id 项，不累积幽灵项', async () => {
    // 模拟主进程：空 id 保存时分配新 id 并返回
    const dirty: ProviderConfig = { ...volcanoProvider, id: '' }
    const mockList: ProviderConfig[] = []
    saveProvider.mockImplementation(async (c: ProviderConfig) => {
      const idx = mockList.findIndex((p) => p.id === c.id)
      if (idx >= 0) mockList[idx] = c
      else mockList.push({ ...c, id: c.id || 'new-id-1' })
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    const { container } = render(<SettingsModal providers={[dirty]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByPlaceholderText('seedream-5-0-lite'), {
      target: { value: 'x' }
    })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    // 空 id 项被丢弃，列表只剩新 id 项（不累积）
    expect(container.querySelectorAll('.provider-item')).toHaveLength(1)
    expect(saveProvider.mock.calls[0][0].id).toBe('')
    expect(mockList[0].id).toBe('new-id-1')
  })
})

describe('SettingsModal：添加 → 删除 → 再添加 全变体（真实主进程过滤逻辑）', () => {
  const p2: ProviderConfig = { ...volcanoProvider, id: 'p2', name: '方舟 Ark', type: 'openai-compatible', active: false }

  /** 用真实主进程语义模拟 delete/save：都在共享列表上操作 */
  function setupRealMock(initial: readonly ProviderConfig[]): ProviderConfig[] {
    const mockList: ProviderConfig[] = initial.map((p) => JSON.parse(JSON.stringify(p)))
    deleteProvider.mockImplementation(async (id: string) => {
      const i = mockList.findIndex((p) => p.id === id)
      if (i >= 0) mockList.splice(i, 1)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    saveProvider.mockImplementation(async (c: ProviderConfig) => {
      const i = mockList.findIndex((p) => p.id === c.id)
      if (i >= 0) mockList[i] = c
      else mockList.push(c)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    return mockList
  }

  async function addDeleteAdd(initial: readonly ProviderConfig[], saveBeforeDelete: boolean): Promise<ProviderConfig> {
    const mockList: ProviderConfig[] = setupRealMock(initial)
    render(<SettingsModal providers={[...initial]} onClose={vi.fn()} onSaved={vi.fn()} />)

    // 第 1 次添加（OpenAI 类型），编辑并可选保存
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const input1 = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(input1, { target: { value: 'first-model' } })
    if (saveBeforeDelete) {
      fireEvent.click(screen.getByText('保存'))
      await screen.findByText('已保存 ✓')
    }

    // 删除刚添加的（当前选中），然后直接再添加（findBy 隐式等待状态更新）
    fireEvent.click(screen.getByText('删除'))
    fireEvent.click(await screen.findByText('确认删除'))
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    const input2 = await screen.findByPlaceholderText('seedream-5-0-lite')
    fireEvent.change(input2, { target: { value: 'second-model' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    // 防幽灵项盲区：列表长度 = 初始 + 净增 1（删 1 加 2）
    expect(mockList.length).toBe(initial.length + 1)
    return saveProvider.mock.calls[saveProvider.mock.calls.length - 1][0]
  }

  it.each([
    ['0 个已保存预设', [], false],
    ['1 个已保存预设', [volcanoProvider], false],
    ['2 个已保存预设', [volcanoProvider, p2], false],
    ['0 个已保存预设（先保存再删）', [], true],
    ['1 个已保存预设（先保存再删）', [volcanoProvider], true]
  ] as const)('%s：添加→删除→再添加→编辑生效', async (label, initial, saveFirst) => {
    const saved = await addDeleteAdd(initial, saveFirst)
    expect(saved.model).toBe('second-model')
    expect(saved.id).toBeTruthy()
  })
})

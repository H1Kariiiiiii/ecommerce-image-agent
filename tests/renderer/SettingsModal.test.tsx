// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
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

const arkProvider: ProviderConfig = {
  id: 'p2',
  name: '方舟 Ark',
  type: 'openai-compatible',
  active: false,
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: 'KEY',
  model: 'seedream-5-0-lite',
  requestStyle: 'json',
  aspectRatio: '1:1'
}

const saveProvider = vi.fn(async (c: ProviderConfig) => [c])
const deleteProvider = vi.fn(async () => [arkProvider])
const setActiveProvider = vi.fn(async (_id: string) => [arkProvider])
const testProvider = vi.fn(async () => ({ ok: true, message: 'ok' }))

beforeEach(() => {
  vi.clearAllMocks()
  window.api = {
    getPathForFile: () => '',
    getPathsForFiles: vi.fn(() => []),
    getProviders: vi.fn(async () => [volcanoProvider, arkProvider]),
    saveProvider,
    deleteProvider,
    setActiveProvider,
    testProvider,
    queryBalance: vi.fn(async () => ({ ok: false, message: "不支持" })),
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

describe('SettingsModal', () => {
  it('渲染 provider 列表与激活标记', () => {
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByText('方舟测试')).toBeTruthy()
    expect(screen.getByText('方舟 Ark')).toBeTruthy()
    expect(screen.getByText('使用中')).toBeTruthy()
  })

  it('选中不同 provider 显示对应表单', () => {
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 默认选中第一个：显示 baseUrl 字段（OpenAI 兼容表单）
    expect(screen.getByPlaceholderText('https://ark.cn-beijing.volces.com/api/v3')).toBeTruthy()
    // 切换到 Ark
    fireEvent.click(screen.getByText('方舟 Ark'))
    expect(screen.getByDisplayValue('https://ark.cn-beijing.volces.com/api/v3')).toBeTruthy()
    expect(screen.getByPlaceholderText('seedream-5-0-lite')).toBeTruthy()
  })

  it('size 输入 * 与 × 时自动归一化为 x（2048*1152 → 2048x1152）', () => {
    render(<SettingsModal providers={[arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    const sizeInput = screen.getByPlaceholderText(/如 2048x2048/)
    fireEvent.change(sizeInput, { target: { value: '2048*1152' } })
    expect((sizeInput as HTMLInputElement).value).toBe('2048x1152')
    fireEvent.change(sizeInput, { target: { value: '1024×2048' } })
    expect((sizeInput as HTMLInputElement).value).toBe('1024x2048')
  })

  it('新增 openai-compatible provider 并保存', async () => {
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    fireEvent.change(screen.getByPlaceholderText('seedream-5-0-lite'), { target: { value: 'my-model' } })
    fireEvent.click(screen.getByText('保存'))
    expect(await screen.findByText('已保存 ✓')).toBeTruthy()
    expect(saveProvider).toHaveBeenCalledTimes(1)
    const saved = saveProvider.mock.calls[0][0]
    expect(saved.type).toBe('openai-compatible')
    expect(saved.model).toBe('my-model')
    // 默认生成比例为 1:1
    expect(saved.aspectRatio).toBe('1:1')
  })

  it('修改生成比例后保存生效', async () => {
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('+ 添加 OpenAI 兼容模型'))
    // 默认 1:1，改为 16:9
    const ratioSelect = screen.getByLabelText(/生成比例/) as HTMLSelectElement
    expect(ratioSelect.value).toBe('1:1')
    fireEvent.change(ratioSelect, { target: { value: '16:9' } })
    fireEvent.click(screen.getByText('保存'))
    expect(await screen.findByText('已保存 ✓')).toBeTruthy()
    expect(saveProvider.mock.calls[0][0].aspectRatio).toBe('16:9')
  })

  it('删除 provider 有应用内确认弹层，确认后调用删除', async () => {
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('删除'))
    // 出现应用内确认弹层（不再使用原生 confirm）
    expect(await screen.findByRole('dialog', { name: '删除确认' })).toBeTruthy()
    expect(screen.queryByText(/确定删除 API「方舟测试」/)).toBeTruthy()
    // 取消不删除
    fireEvent.click(screen.getByText('取消'))
    expect(deleteProvider).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // 再次删除并确认
    fireEvent.click(screen.getByText('删除'))
    fireEvent.click(await screen.findByText('确认删除'))
    expect(deleteProvider).toHaveBeenCalledWith('p1')
  })

  it('测试连接调用 testProvider 并展示结果', async () => {
    render(<SettingsModal providers={[volcanoProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByText('测试连接'))
    expect(testProvider).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/✅ ok/)).toBeTruthy()
  })

  it('ESC 关闭', () => {
    const onClose = vi.fn()
    render(<SettingsModal providers={[volcanoProvider]} onClose={onClose} onSaved={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('有未保存修改时关闭弹确认，可继续编辑或放弃并关闭', async () => {
    const onClose = vi.fn()
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={onClose} onSaved={vi.fn()} />)
    // 编辑当前项（默认选中方舟测试）的 model
    fireEvent.change(screen.getByPlaceholderText('seedream-5-0-lite'), { target: { value: 'unsaved-model' } })
    fireEvent.click(screen.getByTitle('关闭'))
    // 未直接关闭：弹出放弃修改确认（不再静默丢弃）
    expect(onClose).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: '放弃修改确认' })).toBeTruthy()
    // 继续编辑：弹层关闭，窗口不关闭
    fireEvent.click(screen.getByText('继续编辑'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // 再次关闭：确认放弃后关闭
    fireEvent.click(screen.getByTitle('关闭'))
    fireEvent.click(await screen.findByText('放弃修改并关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('无未保存修改时关闭直接生效（含 ESC）', () => {
    const onClose = vi.fn()
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={onClose} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('编辑 A 未保存 → 切换并保存 B → A 的未保存编辑保留（不再静默丢弃）', async () => {
    // 模拟主进程：mockList 保存真实列表，save 在其上操作
    const mockList: ProviderConfig[] = [
      JSON.parse(JSON.stringify(volcanoProvider)),
      JSON.parse(JSON.stringify(arkProvider))
    ]
    saveProvider.mockImplementation(async (c: ProviderConfig) => {
      const i = mockList.findIndex((p) => p.id === c.id)
      if (i >= 0) mockList[i] = c
      else mockList.push(c)
      return mockList.map((p) => JSON.parse(JSON.stringify(p)))
    })
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 编辑 A（方舟测试，默认选中）的 model，不保存
    fireEvent.change(screen.getByPlaceholderText('seedream-5-0-lite'), { target: { value: 'edited-a' } })
    // 切到 B（方舟 Ark）并保存
    fireEvent.click(screen.getByText('方舟 Ark'))
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    // 切回 A：未保存的编辑仍在（修复前会被主进程返回列表覆盖丢弃）
    fireEvent.click(screen.getByText('方舟测试'))
    expect((screen.getByPlaceholderText('seedream-5-0-lite') as HTMLInputElement).value).toBe('edited-a')
  })

  it('「设为使用中」不丢失当前项的未保存编辑', async () => {
    // 模拟主进程：setActive 返回的列表里 active 标记更新，其他字段保持旧值
    setActiveProvider.mockImplementation(async (id: string) => {
      const list = [volcanoProvider, arkProvider].map((p) => ({
        ...JSON.parse(JSON.stringify(p)),
        active: p.id === id
      }))
      return list
    })
    render(<SettingsModal providers={[volcanoProvider, arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 编辑 A 的 model（未保存）
    fireEvent.change(screen.getByPlaceholderText('seedream-5-0-lite'), { target: { value: 'unsaved-a' } })
    fireEvent.click(screen.getByText('设为使用中'))
    await screen.findByText('已设为当前使用的 API ✓')
    // 编辑仍在，且 active 标记同步为主进程值
    expect((screen.getByPlaceholderText('seedream-5-0-lite') as HTMLInputElement).value).toBe('unsaved-a')
    expect(screen.getByText('使用中')).toBeTruthy()
  })

  it('老配置 size 残留 2048x2048 时，切换比例后保存会清空 size（比例生效修复）', async () => {
    // 模拟老版本保存的配置：size 残留 2048x2048，aspectRatio 1:1
    const legacy: ProviderConfig = { ...arkProvider, size: '2048x2048', aspectRatio: '1:1' }
    render(<SettingsModal providers={[legacy]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 切到 4:3（选比例自动清空 size）
    const ratioSelect = screen.getByText('生成比例').closest('label')!.querySelector('select') as HTMLSelectElement
    fireEvent.change(ratioSelect, { target: { value: '4:3' } })
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    const saved = saveProvider.mock.calls[0][0]
    expect(saved.aspectRatio).toBe('4:3')
    expect(saved.size).toBe('')
  })

  it('切换比例后显示「有未保存的修改」提示，保存后消失', async () => {
    render(<SettingsModal providers={[arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    // 初始无提示
    expect(screen.queryByText(/有未保存的修改/)).toBeNull()
    // 切比例 → 提示出现
    const ratioSelect = screen.getByText('生成比例').closest('label')!.querySelector('select') as HTMLSelectElement
    fireEvent.change(ratioSelect, { target: { value: '16:9' } })
    expect(await screen.findByText(/有未保存的修改/)).toBeTruthy()
    // 保存 → 提示消失
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('已保存 ✓')
    expect(screen.queryByText(/有未保存的修改/)).toBeNull()
  })

  it('比例与自定义 size 二选一联动：选比例清空 size，填 size 切回自定义', () => {
    render(<SettingsModal providers={[arkProvider]} onClose={vi.fn()} onSaved={vi.fn()} />)
    const ratioSelect = screen.getByText('生成比例').closest('label')!.querySelector('select') as HTMLSelectElement
    const sizeInput = screen.getByText(/size（像素/).closest('label')!.querySelector('input') as HTMLInputElement
    // 初始：比例 1:1，size 为空（默认走比例换算）
    expect(ratioSelect.value).toBe('1:1')
    expect(sizeInput.value).toBe('')

    // 选 16:9 → size 保持为空
    fireEvent.change(ratioSelect, { target: { value: '16:9' } })
    expect(ratioSelect.value).toBe('16:9')
    expect(sizeInput.value).toBe('')

    // 填自定义 size → 比例切回「自定义」
    fireEvent.change(sizeInput, { target: { value: '2048*1152' } })
    expect(sizeInput.value).toBe('2048x1152') // * 归一化为 x
    expect(ratioSelect.value).toBe('')

    // 再选比例 → size 被清空（二选一真正生效）
    fireEvent.change(screen.getByText('生成比例').closest('label')!.querySelector('select') as HTMLSelectElement, {
      target: { value: '9:16' }
    })
    expect(sizeInput.value).toBe('')
    expect(ratioSelect.value).toBe('9:16')
  })
})

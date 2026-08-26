// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import type { ProcessImageResponse, ProviderConfig } from '../../src/shared/types'

const provider: ProviderConfig = {
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

const pickImages = vi.fn(async () => ['C:/in/toy1.png'])
const getPathsForFiles = vi.fn(() => ['C:/drop/toy2.png'])
const processImage = vi.fn(async (): Promise<ProcessImageResponse> => ({ ok: true, outputPath: 'C:/out/toy_white.png' }))
const exportImage = vi.fn(async () => 'C:/saved/white.png')
const exportImagesToDir = vi.fn(async () => 'C:/saved/dir')

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom 无 matchMedia：提供最小 stub（浅色 + 可注册监听）
  window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia
  window.api = {
    getPathForFile: vi.fn(() => ''),
    getPathsForFiles,
    getProviders: vi.fn(async () => [provider]),
    saveProvider: vi.fn(async (c) => [c]),
    deleteProvider: vi.fn(async () => []),
    setActiveProvider: vi.fn(async () => [provider]),
    testProvider: vi.fn(async () => ({ ok: true, message: 'ok' })),
    queryBalance: vi.fn(async () => ({ ok: false, message: "不支持" })),
    processImage,
    ocrDetect: vi.fn(async () => ({ ok: true, text: 'NO.JT888-10', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } })),
    ocrRecognize: vi.fn(async () => ({ ok: true, text: 'NO.JT888-10' })),
    eraseTextAI: vi.fn(async () => ({ ok: true, outputPath: 'C:/out/toy_erased_ai.png', detectedText: 'NO.JT888-10' })),
    eraseTextLocal: vi.fn(async () => ({ ok: true, outputPath: 'C:/out/toy_erased.png', detectedText: 'NO.JT888-10' })),
    pickImage: vi.fn(async () => null),
    pickImages,
    exportImage,
    exportImagesToDir,
    getSettings: vi.fn(async () => ({ theme: 'system' } as const)),
    saveSettings: vi.fn(async (patch: { theme?: 'system' | 'light' | 'dark' }) => ({
      theme: patch.theme ?? 'system'
    })),
    getQuota: vi.fn(async () => ({ used: 0, limit: 0, yearMonth: '2026-08' } as const)),
    setQuotaLimit: vi.fn(async (n: number) => ({ used: 0, limit: n, yearMonth: '2026-08' })),
    getCacheInfo: vi.fn(async () => ({ fileCount: 0, sizeBytes: 0 })),
    cleanCache: vi.fn(async () => ({ removedCount: 0, freedBytes: 0 })),
    clearCache: vi.fn(async () => ({ removedCount: 0, freedBytes: 0 })),
  }
})

describe('App 批量主流程', () => {
  it('初始状态：显示当前 API，生成按钮禁用', async () => {
    render(<App />)
    expect(await screen.findByText(/白底：方舟测试/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /批量生成/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByText('处理结果将显示在这里')).toBeTruthy()
  })

  it('active 的无 role provider 应优先于 role=both 的旧项（如切换到阿里云后顶栏显示阿里云）', async () => {
    // 模拟用户配置：active 的阿里云(无 role) + role=both 的火山方舟
    const aliyun: ProviderConfig = {
      id: 'a1',
      name: '阿里云百炼',
      type: 'dashscope',
      active: true,
      baseUrl: 'https://dashscope.aliyuncs.com',
      model: 'qwen-image-3.0-pro',
      apiKey: 'sk-test',
      role: undefined
    }
    const volc: ProviderConfig = {
      ...provider,
      id: 'p9',
      name: '火山方舟',
      role: 'both',
      active: false
    }
    vi.mocked(window.api.getProviders).mockResolvedValueOnce([volc, aliyun])
    render(<App />)
    // 顶栏应显示「白底：阿里云百炼」而不是火山方舟
    expect(await screen.findByText(/白底：阿里云百炼/)).toBeTruthy()
    expect(screen.queryByText(/白底：火山方舟/)).toBeNull()
  })

  it('点击上传区选择图片 → 列表出现缩略图 → 批量生成按钮可用', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    expect(pickImages).toHaveBeenCalledTimes(1)
    const thumbs = await screen.findAllByRole('img')
    expect(thumbs[0].getAttribute('src')).toContain('toy1.png')
    const btn = screen.getByRole('button', { name: /批量生成/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('拖拽多文件 → getPathsForFiles 生效并全部加入列表', async () => {
    getPathsForFiles.mockReturnValueOnce(['C:/drop/toy2.png', 'C:/drop/toy3.png'])
    render(<App />)
    const zone = (await screen.findByText(/点击选择/)).closest('.upload-zone')!
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'toy2.png'), new File(['x'], 'toy3.png')] }
    })
    expect(getPathsForFiles).toHaveBeenCalledTimes(1)
    const thumbs = await screen.findAllByRole('img')
    // 上传区占位图 + 2 张缩略图
    expect(thumbs.length).toBe(3)
    const btn = screen.getByRole('button', { name: /批量生成（2 张）/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('批量生成 → 全部完成 → 对比视图与导出按钮出现', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成/ }))
    expect(processImage).toHaveBeenCalledWith({ inputPath: 'C:/in/toy1.png', method: 'ai' })

    expect(await screen.findByText('💾 导出')).toBeTruthy()
    expect(await screen.findByText('✓ 全部完成（1 张）')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /导出全部/ })).toBeTruthy()
  })

  it('批量运行中清空列表 → 中止后续付费调用（只处理当前张）', async () => {
    // 第一张挂起（deferred），第二张永远不应被调用
    let release!: (r: ProcessImageResponse) => void
    processImage.mockImplementationOnce(
      () => new Promise<ProcessImageResponse>((resolve) => { release = resolve })
    )
    pickImages.mockResolvedValueOnce(['C:/in/a.png', 'C:/in/b.png'])
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成（2 张）/ }))
    await screen.findByText(/处理中…/)
    // 清空列表 → 中止标记生效
    fireEvent.click(screen.getByRole('button', { name: /清空/ }))
    release({ ok: true, outputPath: 'C:/out/a_white.png' })
    await screen.findByText('等待处理')
    expect(processImage).toHaveBeenCalledTimes(1)
  })

  it('生成完成后点「重新生成」→ 用当前配置再次调用 API（无需重新上传）', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成/ }))
    await screen.findByText('✓ 全部完成（1 张）')
    expect(processImage).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    await screen.findByText('✓ 全部完成（1 张）')
    expect(processImage).toHaveBeenCalledTimes(2)
    expect(processImage).toHaveBeenLastCalledWith({ inputPath: 'C:/in/toy1.png', method: 'ai' })
  })

  it('部分失败时「导出全部」按钮仍可用（导出成功部分）', async () => {
    pickImages.mockResolvedValueOnce(['C:/in/a.png', 'C:/in/b.png'])
    processImage
      .mockResolvedValueOnce({ ok: true, outputPath: 'C:/out/a_white.png' })
      .mockResolvedValueOnce({ ok: false, error: '余额不足' })
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成（2 张）/ }))
    // 批量完成后（1 成功 1 失败）导出按钮仍可用，导出成功部分
    expect(await screen.findByRole('button', { name: /导出全部（1）/ })).toBeTruthy()
  })

  it('assetUrl 对含特殊字符文件名编码（# % 不破坏 URL 解析）', async () => {
    const { assetUrl } = await import('../../src/renderer/src/lib')
    expect(assetUrl('C:/in/50% 图#1.png')).toBe(
      'asset:///C%3A/in/50%25%20%E5%9B%BE%231.png'
    )
  })

  it('导出当前项调用 exportImage 并传入结果路径', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成/ }))
    fireEvent.click(await screen.findByText('💾 导出'))
    await screen.findByText('✓ 全部完成（1 张）')
    expect(exportImage).toHaveBeenCalledWith('C:/out/toy_white.png')
  })

  it('批量导出调用 exportImagesToDir 并传入全部结果路径', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成/ }))
    fireEvent.click(await screen.findByRole('button', { name: /导出全部/ }))
    await screen.findByText('✓ 全部完成（1 张）')
    expect(exportImagesToDir).toHaveBeenCalledWith(['C:/out/toy_white.png'])
  })

  it('切到纯算法：无需 API 也能生成（processImage 带 method=local，按钮标注免费）', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')
    // 切到纯算法抠图
    fireEvent.click(await screen.findByRole('button', { name: /纯算法抠图/ }))
    const localBtn = (await screen.findByRole('button', { name: /批量抠图（1 张，免费）/ })) as HTMLButtonElement
    expect(localBtn.disabled).toBe(false)
    fireEvent.click(localBtn)
    await waitFor(() =>
      expect(processImage).toHaveBeenCalledWith({ inputPath: 'C:/in/toy1.png', method: 'local' })
    )
    // 不消耗额度：quota 保持 0
    expect(await screen.findByText('✓ 全部完成（1 张）')).toBeTruthy()
  })

  it('切到画布扩展：processImage 带 canvas 参数（比例+策略），按钮标注免费', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')
    // 切到画布扩展
    fireEvent.click(await screen.findByRole('button', { name: /画布扩展/ }))
    // 默认比例 4:3、pad 策略
    const canvasBtn = (await screen.findByRole('button', { name: /批量扩展（1 张，免费）/ })) as HTMLButtonElement
    expect(canvasBtn.disabled).toBe(false)
    // 切换目标比例 1:1
    fireEvent.change(screen.getByLabelText('目标比例'), { target: { value: '1:1' } })
    // 切换放置方式为等比缩放
    fireEvent.change(screen.getByLabelText('放置方式'), { target: { value: 'fit' } })
    fireEvent.click(canvasBtn)
    await waitFor(() =>
      expect(processImage).toHaveBeenCalledWith({
        inputPath: 'C:/in/toy1.png',
        method: 'local',
        canvas: { ratio: { w: 1, h: 1 }, strategy: 'fit', background: '#ffffff' }
      })
    )
    expect(await screen.findByText('✓ 全部完成（1 张）')).toBeTruthy()
  })

  it('画布扩展：自定义背景色传给 processImage', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')
    fireEvent.click(await screen.findByRole('button', { name: /画布扩展/ }))
    // 选预设黑色
    fireEvent.click(screen.getByLabelText('背景色 #000000'))
    fireEvent.click(await screen.findByRole('button', { name: /批量扩展（1 张，免费）/ }))
    await waitFor(() =>
      expect(processImage).toHaveBeenCalledWith({
        inputPath: 'C:/in/toy1.png',
        method: 'local',
        canvas: { ratio: { w: 4, h: 3 }, strategy: 'pad', background: '#000000' }
      })
    )
    expect(await screen.findByText('✓ 全部完成（1 张）')).toBeTruthy()
  })

  it('画布扩展：生成后切换比例再点「重新生成」→ 使用新比例', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')
    fireEvent.click(await screen.findByRole('button', { name: /画布扩展/ }))
    // 默认 4:3 生成
    fireEvent.click(await screen.findByRole('button', { name: /批量扩展（1 张，免费）/ }))
    await screen.findByText('✓ 全部完成（1 张）')
    expect(processImage).toHaveBeenLastCalledWith({
      inputPath: 'C:/in/toy1.png',
      method: 'local',
      canvas: { ratio: { w: 4, h: 3 }, strategy: 'pad', background: '#ffffff' }
    })
    // 切换比例 16:9 → 重新生成 → 应带新比例
    fireEvent.change(screen.getByLabelText('目标比例'), { target: { value: '16:9' } })
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    await waitFor(() =>
      expect(processImage).toHaveBeenLastCalledWith({
        inputPath: 'C:/in/toy1.png',
        method: 'local',
        canvas: { ratio: { w: 16, h: 9 }, strategy: 'pad', background: '#ffffff' }
      })
    )
  })

  it('处理失败时该项标记错误并显示错误信息', async () => {
    processImage.mockResolvedValueOnce({ ok: false, error: '任务失败：状态 = failed' })
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    fireEvent.click(await screen.findByRole('button', { name: /批量生成/ }))
    expect(await screen.findByText('处理失败')).toBeTruthy()
    expect(await screen.findByText(/任务失败：状态 = failed/)).toBeTruthy()
  })

  it('删除图片后该项从列表移除，选中项回到上一个', async () => {
    getPathsForFiles.mockReturnValueOnce(['C:/drop/a.png', 'C:/drop/b.png'])
    render(<App />)
    const zone = (await screen.findByText(/点击选择/)).closest('.upload-zone')!
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'a.png'), new File(['x'], 'b.png')] }
    })
    // 删除选中项（b 是最后添加自动选中；先选中 a 再删 a）
    const thumbs = await screen.findAllByRole('img')
    expect(thumbs.length).toBe(3)
    // 点击第一张缩略图（a）选中，然后删除它
    fireEvent.click(screen.getByTitle('a.png'))
    fireEvent.click(screen.getByRole('button', { name: '删除 a.png' }))
    // 只剩 b 一张，仍选中
    const remain = await screen.findAllByRole('img')
    expect(remain.length).toBe(2) // 上传区 + b
    expect(screen.getByText('b.png')).toBeTruthy()
  })

  it('打开设置面板并渲染', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/API 设置/))
    expect(await screen.findByText('API 设置')).toBeTruthy()
    expect(await screen.findByText('方舟测试')).toBeTruthy()
  })

  it('打开使用帮助并显示说明书', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/使用帮助/))
    expect(await screen.findByRole('dialog', { name: '使用帮助' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: /安装应用/ })).toBeTruthy()
  })

  it('深色主题设置应用到 html data-theme 并持久化', async () => {
    // 覆盖 getSettings 返回深色偏好
    const getSettings = window.api.getSettings as ReturnType<typeof vi.fn>
    getSettings.mockResolvedValueOnce({ theme: 'dark' } as const)
    render(<App />)
    // getSettings 异步加载后应用主题
    await screen.findByText(/白底：方舟测试/)
    expect(document.documentElement.dataset.theme).toBe('dark')
    // 顶栏主题下拉改为浅色 → 立即应用并调用 saveSettings 持久化
    const themeSelect = (await screen.findByLabelText('主题')) as HTMLSelectElement
    fireEvent.change(themeSelect, { target: { value: 'light' } })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.api.saveSettings).toHaveBeenCalledWith({ theme: 'light' })
  })
})

describe('App 擦除货号', () => {
  it('单张 AI 擦除（默认 AI 方式）：调用 eraseTextAI', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')

    fireEvent.click(await screen.findByText('🏷️ 擦除货号'))
    fireEvent.click(await screen.findByText('✂️ 擦除货号'))

    await waitFor(() => {
      expect(window.api.eraseTextAI).toHaveBeenCalled()
    })
    const call = (window.api.eraseTextAI as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.inputPath).toContain('toy1.png')
  })

  it('切到纯本地：单张擦除调用 eraseTextLocal（不依赖 API）', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')

    fireEvent.click(await screen.findByText('🏷️ 擦除货号'))
    fireEvent.click(await screen.findByText('💯 纯本地（免费）'))
    fireEvent.click(await screen.findByText('✂️ 擦除货号'))

    await waitFor(() => {
      expect(window.api.eraseTextLocal).toHaveBeenCalled()
    })
    // AI 擦除不应被调用
    expect(window.api.eraseTextAI).not.toHaveBeenCalled()
  })

  it('批量擦除（本地方式）：每张图调 eraseTextLocal', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')

    fireEvent.click(await screen.findByText('🏷️ 擦除货号'))
    fireEvent.click(await screen.findByText('💯 纯本地（免费）'))
    fireEvent.click(await screen.findByRole('button', { name: /🗑️ 批量擦除/ }))

    await waitFor(() => {
      expect(window.api.eraseTextLocal).toHaveBeenCalled()
    })
  })

  it('区域复用：某张 OCR 定位失败时复用同批成功图的区域（位置一致场景）', async () => {
    const ocrDetect = window.api.ocrDetect as ReturnType<typeof vi.fn>
    const eraseLocal = window.api.eraseTextLocal as ReturnType<typeof vi.fn>
    ocrDetect
      .mockResolvedValueOnce({ ok: false, error: '未识别到货号' })
      .mockResolvedValueOnce({ ok: true, text: 'NO.JT888-10', region: { x: 0.2, y: 0.3, width: 0.4, height: 0.15 } })

    render(<App />)
    ;(window.api.pickImages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'C:/in/toy1.png',
      'C:/in/toy2.png'
    ])
    fireEvent.click(await screen.findByText(/点击选择/))
    await screen.findAllByRole('img')

    fireEvent.click(await screen.findByText('🏷️ 擦除货号'))
    fireEvent.click(await screen.findByText('💯 纯本地（免费）'))
    fireEvent.click(await screen.findByRole('button', { name: /🗑️ 批量擦除/ }))

    await waitFor(() => {
      expect(eraseLocal).toHaveBeenCalledTimes(2)
    })
    const calls = eraseLocal.mock.calls.map((c) => c[0])
    const failedCall = calls.find((c) => c.inputPath.includes('toy1'))
    expect(failedCall.region).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.15 })
    expect(window.api.ocrRecognize).toHaveBeenCalled()
  })
})

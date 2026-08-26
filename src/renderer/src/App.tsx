import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProcessImageResponse, ProviderConfig, QuotaInfo, TextRegion } from '../../shared/types'
import { applyTheme, assetUrl, type Theme } from './lib'
import { UploadZone } from './components/UploadZone'
import { CompareView } from './components/CompareView'
import { RegionSelector } from './components/RegionSelector'
import { SettingsModal } from './components/SettingsModal'
import { HelpModal } from './components/HelpModal'

/** 批量任务中的一张图片 */
export interface JobItem {
  id: string
  inputPath: string
  name: string
  status: 'pending' | 'processing' | 'done' | 'error'
  outputPath?: string
  sourceUrl?: string
  error?: string
}

let jobSeq = 0

function newJobId(): string {
  jobSeq += 1
  return `job_${Date.now().toString(36)}_${jobSeq}`
}

export default function App(): JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [items, setItems] = useState<JobItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('system')
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  /** 当前模式：白底图 / 擦除货号 */
  const [mode, setMode] = useState<'white-bg' | 'edit-text'>('white-bg')
  /** 白底图方式：ai = API 生成（消耗额度）/ local = 纯算法抠白底（免费）/ canvas = 无损画布扩展（免费） */
  const [whiteBgMethod, setWhiteBgMethod] = useState<'ai' | 'local' | 'canvas'>('ai')
  /** 画布扩展：目标比例（宽/高） */
  const [canvasRatio, setCanvasRatio] = useState<{ w: number; h: number }>({ w: 4, h: 3 })
  /** 画布扩展：pad = 原图不变四周补边 / fit = 等比缩放适配 */
  const [canvasStrategy, setCanvasStrategy] = useState<'pad' | 'fit'>('pad')
  /** 画布扩展：背景色（CSS 颜色，默认纯白） */
  const [canvasBackground, setCanvasBackground] = useState('#ffffff')
  /** 擦除货号：框选区域 */
  const [editRegion, setEditRegion] = useState<TextRegion | null>(null)
  /** 擦除货号：原文字锚点（可选，帮助 OCR 定位） */
  const [oldText, setOldText] = useState('')
  /** 擦除货号：处理中 */
  const [editProcessing, setEditProcessing] = useState(false)
  /** 擦除方式：ai = AI inpainting（独立 key）/ local = 纯本地免费 */
  const [eraseMethod, setEraseMethod] = useState<'ai' | 'local'>('ai')
  /** 擦除货号：OCR 识别到的原文字（供用户核对） */
  const [ocrResult, setOcrResult] = useState<string | null>(null)
  /** 批量擦除：旧前缀锚点（可选，如 NO，帮助 OCR 定位） */
  const [batchAnchor, setBatchAnchor] = useState('')
  /** 批量擦除：执行中 */
  const [batchEditRunning, setBatchEditRunning] = useState(false)
  /** 单张擦除：处理中 */
  const [eraseProcessing, setEraseProcessing] = useState(false)
  /** 批量生成中止标记：清空/删除列表后停止后续付费调用 */
  const abortRef = useRef(false)

  /** 当前激活 provider（通用 或 默认） */
  const activeProvider = providers.find((p) => p.active) ?? providers[0] ?? null
  /**
   * 白底图 provider：「使用中」优先（除非它被显式设为仅擦除），
   * 否则回退到 role 标记为仅白底/通用的 provider，再回退到任意（非仅擦除）项。
   * 修复：active 的阿里云（无 role）被 role='both' 的旧项压过的问题。
   */
  const whiteBgProvider =
    activeProvider && activeProvider.role !== 'erase'
      ? activeProvider
      : providers.find((p) => p.role === 'white-bg' || p.role === 'both') ??
        activeProvider ??
        providers.find((p) => p.role !== 'erase') ??
        null
  /** 擦除货号 provider：「使用中」优先（除非它被显式设为仅白底），否则回退 role 标记 */
  const eraseProvider =
    activeProvider && activeProvider.role !== 'white-bg'
      ? activeProvider
      : providers.find((p) => p.role === 'erase' || p.role === 'both') ??
        activeProvider ??
        providers.find((p) => p.role !== 'white-bg') ??
        null
  const selected = items.find((i) => i.id === selectedId) ?? null
  const doneCount = items.filter((i) => i.status === 'done').length
  const pendingCount = items.filter((i) => i.status === 'pending' || i.status === 'error').length
  const inFlightCount = items.filter((i) => i.status === 'pending' || i.status === 'processing').length

  useEffect(() => {
    window.api.getProviders().then(setProviders)
    window.api.getSettings().then((s) => setTheme(s.theme))
    window.api.getQuota().then(setQuota).catch(() => {})
  }, [])

  // 应用主题；跟随系统时监听系统切换实时同步
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const handleThemeChange = useCallback((t: Theme) => {
    setTheme(t)
    window.api.saveSettings({ theme: t }).catch(() => {})
  }, [])

  /** 追加新上传的图片（去重 + 图片扩展名过滤），并选中第一张新图 */
  const addPaths = useCallback((paths: string[]) => {
    const isImage = (p: string): boolean => /\.(png|jpe?g|webp|bmp|gif)$/i.test(p)
    const unique = paths.filter((p, i, arr) => p && isImage(p) && arr.indexOf(p) === i)
    if (unique.length === 0) return
    setItems((prev) => {
      const existing = new Set(prev.map((i) => i.inputPath))
      const fresh = unique.filter((p) => !existing.has(p))
      const jobs: JobItem[] = fresh.map((p) => ({
        id: newJobId(),
        inputPath: p,
        name: p.split(/[\\/]/).pop() || p,
        status: 'pending'
      }))
      if (jobs.length > 0) setSelectedId(jobs[0].id)
      return [...prev, ...jobs]
    })
    // 新图加入：清空擦除货号编辑态
    setEditRegion(null)
    setOldText('')
    setOcrResult(null)
    setError(null)
  }, [])

  const handlePick = useCallback(async () => {
    const paths = await window.api.pickImages()
    addPaths(paths)
  }, [addPaths])

  const handleFiles = useCallback(
    (paths: string[]) => {
      addPaths(paths)
    },
    [addPaths]
  )

  const handleRemoveItem = useCallback((id: string) => {
    // 批量运行中删除图片：中止后续未开始的付费调用（当前张跑完即停）
    abortRef.current = true
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id)
      const next = prev.filter((i) => i.id !== id)
      setSelectedId((cur) => {
        if (cur !== id) return cur
        // 删除的是当前选中项：优先选中同位置的下一个，否则上一个
        const candidate = next[Math.min(idx, next.length - 1)]
        // 同步清空擦除货号编辑态，避免残留到其他图
        setEditRegion(null)
        setOldText('')
        setOcrResult(null)
        return candidate ? candidate.id : null
      })
      return next
    })
  }, [])

  const handleClearAll = useCallback(() => {
    abortRef.current = true
    setItems([])
    setSelectedId(null)
    setError(null)
    setEditRegion(null)
    setOldText('')
    setOcrResult(null)
  }, [])

  /** 处理单张图片并更新任务状态 */
  const runOne = useCallback(async (job: JobItem): Promise<void> => {
    setItems((prev) => prev.map((i) => (i.id === job.id ? { ...i, status: 'processing', error: undefined } : i)))
    try {
      const req: { inputPath: string; method: 'ai' | 'local'; canvas?: { ratio: { w: number; h: number }; background?: string; strategy: 'pad' | 'fit' } } = {
        inputPath: job.inputPath,
        method: whiteBgMethod === 'canvas' ? 'local' : whiteBgMethod
      }
      if (whiteBgMethod === 'canvas') {
        req.canvas = { ratio: canvasRatio, strategy: canvasStrategy, background: canvasBackground }
      }
      const res = await window.api.processImage(req)
      if (res.quota) setQuota(res.quota)
      setItems((prev) =>
        prev.map((i) =>
          i.id === job.id
            ? {
                ...i,
                status: res.ok ? 'done' : 'error',
                outputPath: res.ok ? res.outputPath : undefined,
                sourceUrl: res.ok ? res.sourceUrl : undefined,
                error: res.ok ? undefined : (res.error ?? '处理失败')
              }
            : i
        )
      )
    } catch (err) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === job.id
            ? { ...i, status: 'error', error: err instanceof Error ? err.message : String(err) }
            : i
        )
      )
    }
  }, [whiteBgMethod, canvasRatio, canvasStrategy, canvasBackground])

  /** 批量生成：顺序处理所有待处理/失败项；列表被清空/删除时中止后续项 */
  const handleGenerateAll = useCallback(async () => {
    if (batchRunning) return
    setBatchRunning(true)
    setError(null)
    abortRef.current = false
    try {
      const targets = items.filter((i) => i.status === 'pending' || i.status === 'error')
      for (const job of targets) {
        if (abortRef.current) break
        await runOne(job)
      }
    } finally {
      setBatchRunning(false)
      abortRef.current = false
    }
  }, [batchRunning, items, runOne])

  /** 导出当前选中项的结果 */
  const handleExportSelected = useCallback(async () => {
    if (!selected?.outputPath) return
    try {
      await window.api.exportImage(selected.outputPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [selected])

  /** 用当前 API 配置重新生成选中的图片（修改参数后无需重新上传） */
  const handleRegenerate = useCallback(() => {
    if (!selected || selected.status !== 'done' || !selected.outputPath) return
    const job: JobItem = { ...selected, status: 'pending', error: undefined }
    void runOne(job)
  }, [selected, runOne])

  /** 批量导出所有成功结果到所选文件夹 */
  const handleExportAll = useCallback(async () => {
    const outputs = items.filter((i) => i.status === 'done' && i.outputPath).map((i) => i.outputPath!)
    if (outputs.length === 0) return
    try {
      const dir = await window.api.exportImagesToDir(outputs)
      if (dir) setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [items])

  /** 单张擦除货号：AI inpainting（erase 专用 provider）或纯本地（免费） */
  const handleEraseText = useCallback(async () => {
    if (!selected || eraseProcessing) return
    setEditProcessing(true)
    setError(null)
    setOcrResult(null)
    setItems((prev) => prev.map((i) => (i.id === selected.id ? { ...i, status: 'processing', error: undefined } : i)))
    try {
      let outputPath: string | undefined
      let quota: QuotaInfo | undefined
      if (eraseMethod === 'ai') {
        const res = await window.api.eraseTextAI({
          inputPath: selected.inputPath,
          anchor: oldText.trim() || undefined,
          region: editRegion ?? undefined
        })
        if (!res.ok) throw new Error(res.error ?? '擦除失败')
        outputPath = res.outputPath
        quota = res.quota
        if (res.detectedText) setOcrResult(`识别到货号：${res.detectedText}`)
      } else {
        const res = await window.api.eraseTextLocal({
          inputPath: selected.inputPath,
          anchor: oldText.trim() || undefined,
          region: editRegion ?? undefined
        })
        if (!res.ok) throw new Error(res.error ?? '擦除失败')
        outputPath = res.outputPath
        if (res.detectedText) setOcrResult(`识别到货号：${res.detectedText}`)
      }
      if (quota) setQuota(quota)
      setItems((prev) =>
        prev.map((i) =>
          i.id === selected.id
            ? { ...i, status: 'done', outputPath, sourceUrl: undefined }
            : i
        )
      )
    } catch (err) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === selected.id
            ? { ...i, status: 'error', error: err instanceof Error ? err.message : String(err) }
            : i
        )
      )
    } finally {
      setEditProcessing(false)
    }
  }, [selected, editRegion, oldText, eraseMethod, eraseProcessing])

  /** 批量去掉货号：预定位（失败图复用同批成功图区域）→ 本地擦除（纯免费） */
  const handleBatchEraseText = useCallback(async () => {
    if (batchEditRunning) return
    const targets = items.filter((i) => i.status === 'pending' || i.status === 'error')
    if (targets.length === 0) return

    setBatchEditRunning(true)
    setError(null)
    setOcrResult(null)
    abortRef.current = false

    // 阶段 1：预定位所有目标图（本地 OCR 快），收集区域；失败图暂记为 null
    // 同批次产品图货号位置通常一致：有一张定位成功，其余可直接复用
    const regionMap = new Map<string, TextRegion | null>()
    const textMap = new Map<string, string>()
    let firstGoodRegion: TextRegion | null = null

    for (const job of targets) {
      if (abortRef.current) break
      // 当前选中图已手动框选 → 直接用框选区域
      if (job.id === selectedId && editRegion) {
        regionMap.set(job.id, editRegion)
        if (!firstGoodRegion) firstGoodRegion = editRegion
        continue
      }
      try {
        setItems((prev) => prev.map((i) => (i.id === job.id ? { ...i, status: 'processing', error: undefined } : i)))
        const detect = await window.api.ocrDetect({
          inputPath: job.inputPath,
          anchor: batchAnchor.trim() || undefined
        })
        if (detect.ok && detect.region) {
          regionMap.set(job.id, detect.region)
          if (detect.text) textMap.set(job.id, detect.text)
          if (!firstGoodRegion) {
            firstGoodRegion = detect.region
          }
        } else {
          regionMap.set(job.id, null)
        }
      } catch {
        regionMap.set(job.id, null)
      }
    }

    // 阶段 1.5：定位失败的图，复用同批第一张成功图的区域（位置一致场景）
    if (firstGoodRegion) {
      for (const job of targets) {
        if (abortRef.current) break
        if (regionMap.get(job.id) === undefined) continue
        if (regionMap.get(job.id) === null) {
          regionMap.set(job.id, firstGoodRegion)
          // 尝试识别该区域文字（辅助后续显示；失败不影响擦除）
          try {
            const rec = await window.api.ocrRecognize({ inputPath: job.inputPath, region: firstGoodRegion })
            if (rec.ok && rec.text) textMap.set(job.id, rec.text)
          } catch {
            /* 忽略 */
          }
        }
      }
    }

    // 阶段 2：逐张处理（有区域就擦除，无区域报错；按 eraseMethod 走 AI 或本地）
    for (const job of targets) {
      if (abortRef.current) break
      const region = regionMap.get(job.id)
      if (region === undefined || region === null) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === job.id
              ? { ...i, status: 'error', error: '未识别到货号，且批次内无可用参考区域（可手动框选）' }
              : i
          )
        )
        continue
      }
      setItems((prev) => prev.map((i) => (i.id === job.id ? { ...i, status: 'processing', error: undefined } : i)))
      try {
        let outputPath: string | undefined
        let quota: QuotaInfo | undefined
        if (eraseMethod === 'ai') {
          const res = await window.api.eraseTextAI({
            inputPath: job.inputPath,
            anchor: batchAnchor.trim() || undefined,
            region
          })
          if (!res.ok) throw new Error(res.error ?? '擦除失败')
          outputPath = res.outputPath
          quota = res.quota
        } else {
          const res = await window.api.eraseTextLocal({
            inputPath: job.inputPath,
            anchor: batchAnchor.trim() || undefined,
            region
          })
          if (!res.ok) throw new Error(res.error ?? '擦除失败')
          outputPath = res.outputPath
        }
        if (quota) setQuota(quota)
        setItems((prev) =>
          prev.map((i) => (i.id === job.id ? { ...i, status: 'done', outputPath, sourceUrl: undefined } : i))
        )
      } catch (err) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === job.id
              ? { ...i, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : i
          )
        )
      }
    }

    setBatchEditRunning(false)
    abortRef.current = false
  }, [items, batchEditRunning, batchAnchor, selectedId, editRegion, eraseMethod])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">🧸</span>
          <h1>玩具白底图 Agent</h1>
          <div className="mode-switcher">
            <button
              className={`mode-btn${mode === 'white-bg' ? ' active' : ''}`}
              onClick={() => setMode('white-bg')}
            >
              ✨ 白底图
            </button>
            <button
              className={`mode-btn${mode === 'edit-text' ? ' active' : ''}`}
              onClick={() => setMode('edit-text')}
            >
              🏷️ 擦除货号
            </button>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`provider-state ${whiteBgProvider || eraseProvider ? 'ok' : 'warn'}`}>
            {whiteBgProvider || eraseProvider
              ? `白底：${whiteBgProvider?.name ?? '未配'} · 擦除：${eraseProvider?.name ?? '未配'}`
              : '未配置 API'}
          </span>
          {quota && quota.limit > 0 && (
            <span
              className={`quota-badge${quota.used >= quota.limit ? ' exhausted' : ''}`}
              title={`本月额度：已用 ${quota.used} / 上限 ${quota.limit}（${quota.yearMonth}）`}
            >
              📊 {quota.used}/{quota.limit}
            </span>
          )}
          <label className="theme-pick topbar-theme" title="主题">
            <span className="theme-icon" aria-hidden="true">
              {theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🖥️'}
            </span>
            <select
              aria-label="主题"
              value={theme}
              onChange={(e) => handleThemeChange(e.target.value as Theme)}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <button className="btn-secondary" onClick={() => { setHelpOpen(true); setSettingsOpen(false) }} title="使用帮助">
            ❓ 使用帮助
          </button>
          <button className="btn-secondary" onClick={() => { setSettingsOpen(true); setHelpOpen(false) }}>
            ⚙️ API 设置
          </button>
        </div>
      </header>

      {/* 批量图片列表 */}
      <div className="batch-bar">
        <button className="btn-secondary batch-add" onClick={handlePick}>
          + 添加图片
        </button>
        <div className="batch-thumbs">
          {items.map((item) => (
            <div
              key={item.id}
              className={`batch-thumb${item.id === selectedId ? ' selected' : ''}${item.status === 'processing' ? ' processing' : ''}`}
              onClick={() => {
                setSelectedId(item.id)
                // 切换图片：清空擦除货号编辑态（区域/锚点属于上一张图）
                setEditRegion(null)
                setOldText('')
                setOcrResult(null)
              }}
              title={item.name}
            >
              <img src={assetUrl(item.inputPath)} alt={item.name} />
              <span className={`batch-status s-${item.status}`}>
                {item.status === 'done' ? '✓' : item.status === 'error' ? '✕' : item.status === 'processing' ? '⏳' : ''}
              </span>
              <button
                className="batch-remove"
                aria-label={`删除 ${item.name}`}
                title="删除这张图片"
                onClick={(e) => {
                  e.stopPropagation()
                  handleRemoveItem(item.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {items.length === 0 && (
            <span className="batch-empty dim">还没有图片，点击「+ 添加图片」或拖拽到下方区域</span>
          )}
        </div>
        {items.length > 0 && (
          <button className="chip danger batch-clear" onClick={handleClearAll} title="清空全部图片">
            清空
          </button>
        )}
      </div>

      <main className={`main${mode === 'edit-text' ? ' main-edit' : ''}`}>
        {mode === 'white-bg' ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <h2>原图</h2>
                {selected && (
                  <span className="file-name" title={selected.inputPath}>
                    {selected.name}
                  </span>
                )}
              </div>
              {selected ? (
                <div className="preview">
                  <button
                    className="preview-clear"
                    onClick={() => handleRemoveItem(selected.id)}
                    title="删除这张图片"
                    aria-label="删除图片"
                  >
                    ✕
                  </button>
                  <img src={assetUrl(selected.inputPath)} alt="原图" />
                </div>
              ) : (
                <UploadZone inputPath={null} onPick={handlePick} onFiles={handleFiles} />
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>白底图</h2>
                {selected?.status === 'done' && selected.outputPath && (
                  <div className="panel-head-actions">
                    <button
                      className="btn-secondary small"
                      onClick={handleRegenerate}
                      title="修改 API 设置（提示词 / 比例等）后，用当前配置重新生成"
                    >
                      🔄 重新生成
                    </button>
                    <button className="btn-primary small" onClick={handleExportSelected}>
                      💾 导出
                    </button>
                  </div>
                )}
              </div>
              <div className="edit-method-switcher whitebg-method">
                <button
                  className={`chip${whiteBgMethod === 'ai' ? ' active' : ''}`}
                  onClick={() => setWhiteBgMethod('ai')}
                  title="调用 AI 生图模型重绘白底图（消耗 API 额度，1~3 分钟）"
                >
                  ✨ AI 生成
                </button>
                <button
                  className={`chip${whiteBgMethod === 'local' ? ' active' : ''}`}
                  onClick={() => setWhiteBgMethod('local')}
                  title="本地纯算法抠白底（免费、秒级，保留产品真实细节）"
                >
                  🧹 纯算法抠图（免费）
                </button>
                <button
                  className={`chip${whiteBgMethod === 'canvas' ? ' active' : ''}`}
                  onClick={() => setWhiteBgMethod('canvas')}
                  title="无损扩展画布到目标比例，四周补纯色边（原图不变或等比适配）"
                >
                  📐 画布扩展（免费）
                </button>
              </div>
              {whiteBgMethod === 'canvas' && (
                <div className="canvas-options">
                  <label className="canvas-opt">
                    目标比例
                    <select
                      aria-label="目标比例"
                      value={`${canvasRatio.w}:${canvasRatio.h}`}
                      onChange={(e) => {
                        const [w, h] = e.target.value.split(':').map(Number)
                        setCanvasRatio({ w, h })
                      }}
                    >
                      <option value="1:1">1:1</option>
                      <option value="4:3">4:3</option>
                      <option value="3:4">3:4</option>
                      <option value="16:9">16:9</option>
                      <option value="9:16">9:16</option>
                      <option value="3:2">3:2</option>
                      <option value="2:3">2:3</option>
                    </select>
                  </label>
                  <label className="canvas-opt">
                    放置方式
                    <select
                      aria-label="放置方式"
                      value={canvasStrategy}
                      onChange={(e) => setCanvasStrategy(e.target.value as 'pad' | 'fit')}
                    >
                      <option value="pad">保持原图大小，四周补边</option>
                      <option value="fit">等比缩放适配画布</option>
                    </select>
                  </label>
                  <label className="canvas-opt">
                    背景色
                    <span className="canvas-colors" role="group" aria-label="背景色">
                      {(['#ffffff', '#000000', '#f5f5f5', '#ffeb3b', '#4caf50', '#2196f3', '#f44336', '#9e9e9e'] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={`背景色 ${c}`}
                          className={`canvas-color${canvasBackground === c ? ' active' : ''}`}
                          style={{ background: c }}
                          onClick={() => setCanvasBackground(c)}
                        />
                      ))}
                      <input
                        type="color"
                        aria-label="自定义背景色"
                        value={canvasBackground}
                        onChange={(e) => setCanvasBackground(e.target.value)}
                        title="自定义颜色"
                      />
                    </span>
                  </label>
                </div>
              )}
              {selected?.status === 'processing' ? (
                <div className="processing">
                  <div className="spinner" />
                  <p>
                    {whiteBgMethod === 'local'
                      ? '本地算法抠图中…'
                      : whiteBgMethod === 'canvas'
                        ? '本地画布扩展中…'
                        : 'AI 正在生成白底图，可能需要 1~3 分钟…'}
                  </p>
                  {whiteBgMethod === 'ai' && (
                    <p className="dim">当前：{whiteBgProvider?.name ?? '未配置'}</p>
                  )}
                </div>
              ) : selected?.status === 'done' && selected.outputPath ? (
                <CompareView inputPath={selected.inputPath} outputPath={selected.outputPath} />
              ) : selected?.status === 'error' ? (
                <div className="placeholder">
                  <span>⚠️</span>
                  <p>处理失败</p>
                  <p className="dim">{selected.error}</p>
                </div>
              ) : (
                <div className="placeholder">
                  <span>⚪</span>
                  <p>处理结果将显示在这里</p>
                  {!selected && <p className="dim">请先上传玩具产品图</p>}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="panel">
              <div className="panel-head">
                <h2>框选货号区域</h2>
                {selected && (
                  <span className="file-name" title={selected.inputPath}>
                    {selected.name}
                  </span>
                )}
              </div>
              {selected ? (
                <RegionSelector
                  inputPath={selected.inputPath}
                  region={editRegion}
                  onRegionChange={setEditRegion}
                />
              ) : (
                <UploadZone inputPath={null} onPick={handlePick} onFiles={handleFiles} />
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>擦除结果</h2>
                {selected?.status === 'done' && selected.outputPath && (
                  <div className="panel-head-actions">
                    <button className="btn-primary small" onClick={handleExportSelected}>
                      💾 导出
                    </button>
                  </div>
                )}
              </div>
              {editProcessing ? (
                <div className="processing">
                  <div className="spinner" />
                  <p>正在擦除货号文字…</p>
                  <p className="dim">当前：{eraseMethod === 'ai' ? (eraseProvider?.name ?? '未配置') : '纯本地（免费）'}</p>
                </div>
              ) : selected?.status === 'done' && selected.outputPath ? (
                <CompareView inputPath={selected.inputPath} outputPath={selected.outputPath} />
              ) : selected?.status === 'error' ? (
                <div className="placeholder">
                  <span>⚠️</span>
                  <p>处理失败</p>
                  <p className="dim">{selected.error}</p>
                </div>
              ) : (
                <div className="placeholder">
                  <span>🏷️</span>
                  <p>擦除结果将显示在这里</p>
                  {!selected && <p className="dim">请先上传玩具产品图</p>}
                  {selected && !editRegion && <p className="dim">可框选货号区域，或直接自动定位擦除</p>}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {mode === 'edit-text' && (
        <div className="edit-bar">
          <div className="edit-method-switcher">
            <button
              className={`chip${eraseMethod === 'ai' ? ' active' : ''}`}
              onClick={() => setEraseMethod('ai')}
              title="AI inpainting 擦除货号（用「擦除专用」API，效果最好）"
            >
              🤖 AI 擦除
            </button>
            <button
              className={`chip${eraseMethod === 'local' ? ' active' : ''}`}
              onClick={() => setEraseMethod('local')}
              title="纯本地擦除（免费，适合纯色/浅色背景）"
            >
              💯 纯本地（免费）
            </button>
          </div>
          <label className="edit-field edit-field-main">
            <span>原货号（可选，作为锚点帮助定位）</span>
            <input
              type="text"
              value={oldText}
              onChange={(e) => setOldText(e.target.value)}
              placeholder="如 NO.JT888-10"
              spellCheck={false}
            />
          </label>
          <button
            className="btn-primary"
            onClick={handleEraseText}
            disabled={
              !selected ||
              editProcessing ||
              (eraseMethod === 'ai' && !eraseProvider)
            }
            title={
              eraseMethod === 'ai' && !eraseProvider
                ? '请先在 ⚙️ API 设置 中配置「擦除专用」或「通用」API'
                : undefined
            }
          >
            {editProcessing ? '⏳ 擦除中…' : '✂️ 擦除货号'}
          </button>
          {ocrResult && <span className="ocr-note" title="OCR 识别结果仅供参考">{ocrResult}</span>}
        </div>
      )}

      {mode === 'edit-text' && (
        <div className="batch-edit-bar">
          <div className="batch-edit-head">
            <span className="batch-edit-title">⚡ 批量擦除（自动定位）</span>
            <span className="dim batch-edit-tip">无需框选：每张图自动 OCR 识别货号位置，同批位置可复用</span>
          </div>
          <div className="batch-edit-controls">
            <label className="edit-field">
              <span>旧前缀锚点（可选）</span>
              <input
                type="text"
                value={batchAnchor}
                onChange={(e) => setBatchAnchor(e.target.value)}
                placeholder="如 NO"
                spellCheck={false}
              />
            </label>
            <span className="dim batch-edit-preview">
              {eraseMethod === 'ai' ? 'AI inpainting 擦除（用擦除专用 API）' : '纯本地擦除（免费）'}
            </span>
            <button
              className="btn-primary"
              onClick={handleBatchEraseText}
              disabled={items.length === 0 || batchEditRunning || (eraseMethod === 'ai' && !eraseProvider)}
              title={eraseMethod === 'ai' && !eraseProvider ? '请先配置「擦除专用」或「通用」API' : undefined}
            >
              {batchEditRunning
                ? `⏳ 批量擦除中… ${items.filter((i) => i.status === 'done').length}/${pendingCount + items.filter((i) => i.status === 'done').length}`
                : eraseMethod === 'ai'
                  ? `🗑️ 批量擦除（${pendingCount} 张）`
                  : `🗑️ 批量擦除（${pendingCount} 张，免费）`}
            </button>
          </div>
        </div>
      )}

      <footer className="bottombar">
        {error && <div className="error-banner">⚠️ {error}</div>}
        <div className="bottombar-inner">
          <span className="dim">
            {mode === 'white-bg' ? (
              items.length === 0
                ? '等待处理'
                : batchRunning
                  ? `处理中… ${doneCount}/${items.length}`
                  : doneCount === items.length && doneCount > 0
                    ? `✓ 全部完成（${doneCount} 张）`
                    : `待处理 ${pendingCount} 张，已完成 ${doneCount} 张`
            ) : (
              selected ? `当前：${selected.name}` : '等待处理'
            )}
          </span>
          {mode === 'white-bg' && doneCount > 0 && inFlightCount === 0 && (
            <button className="btn-secondary" onClick={handleExportAll} disabled={batchRunning}>
              💾 导出全部（{doneCount}）
            </button>
          )}
          {mode === 'white-bg' && (
            <button
              className="btn-primary"
              onClick={handleGenerateAll}
              disabled={items.length === 0 || pendingCount === 0 || batchRunning || (whiteBgMethod === 'ai' && !whiteBgProvider)}
              title={whiteBgMethod === 'ai' && !whiteBgProvider ? '请先在 ⚙️ API 设置 中配置白底图 API' : undefined}
            >
              {batchRunning
                ? '⏳ 批量生成中…'
                : items.length === 0
                  ? whiteBgMethod === 'local'
                    ? '🧹 批量抠图'
                    : whiteBgMethod === 'canvas'
                      ? '📐 批量扩展'
                      : '✨ 批量生成'
                  : pendingCount > 0
                    ? whiteBgMethod === 'local'
                      ? `🧹 批量抠图（${pendingCount} 张，免费）`
                      : whiteBgMethod === 'canvas'
                        ? `📐 批量扩展（${pendingCount} 张，免费）`
                        : `✨ 批量生成（${pendingCount} 张）`
                    : '✨ 全部完成'}
            </button>
          )}
        </div>
      </footer>

      {settingsOpen && (
        <SettingsModal
          providers={providers}
          onClose={() => setSettingsOpen(false)}
          onSaved={setProviders}
          quota={quota}
          onQuotaChange={setQuota}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

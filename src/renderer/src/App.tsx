import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProcessImageResponse, ProviderConfig, QuotaInfo } from '../../shared/types'
import { applyTheme, assetUrl, type Theme } from './lib'
import { UploadZone } from './components/UploadZone'
import { CompareView } from './components/CompareView'
import { SettingsModal } from './components/SettingsModal'
import { HelpModal } from './components/HelpModal'
import { LabelBatchPanel } from './components/LabelBatchPanel'
import { QuotePanel } from './components/QuotePanel'

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
  /** 当前模式：白底图 / 批量改货号 / 报价表 */
  const [mode, setMode] = useState<'white-bg' | 'label-batch' | 'quote'>('white-bg')
  /** 白底图方式：ai = API 生成（消耗额度）/ local = 纯算法抠白底（免费）/ canvas = 无损画布扩展（免费） */
  const [whiteBgMethod, setWhiteBgMethod] = useState<'ai' | 'local' | 'canvas'>('ai')
  /** 画布扩展：目标比例（宽/高） */
  const [canvasRatio, setCanvasRatio] = useState<{ w: number; h: number }>({ w: 4, h: 3 })
  /** 画布扩展：pad = 原图不变四周补边 / fit = 等比缩放适配 */
  const [canvasStrategy, setCanvasStrategy] = useState<'pad' | 'fit'>('pad')
  /** 画布扩展：背景色（CSS 颜色，默认纯白） */
  const [canvasBackground, setCanvasBackground] = useState('#ffffff')
  /** 批量生成中止标记：清空/删除列表后停止后续付费调用 */
  const abortRef = useRef(false)

  /**
   * 当前使用的 provider。
   * 擦除货号模式已移除，AI 现在只服务于「抠白底图」这一个用途，
   * 所以不再需要按 role 分流 —— 「使用中」那个就是它。
   */
  const activeProvider = providers.find((p) => p.active) ?? providers[0] ?? null
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">🧸</span>
          <h1>玩具白底图 Agent</h1>
          <span className="app-version" title="当前运行的版本（取自 package.json）">
            v{__APP_VERSION__}
          </span>
          <div className="mode-switcher">
            <button
              className={`mode-btn${mode === 'white-bg' ? ' active' : ''}`}
              onClick={() => setMode('white-bg')}
            >
              ✨ 白底图
            </button>
            <button
              className={`mode-btn${mode === 'label-batch' ? ' active' : ''}`}
              onClick={() => setMode('label-batch')}
              title="整个文件夹批量改货号（纯算法，免费）"
            >
              🔢 批量改货号
            </button>
            <button
              className={`mode-btn${mode === 'quote' ? ' active' : ''}`}
              onClick={() => setMode('quote')}
              title="把报价表里的旧图换成新图，货号列同步改前缀"
            >
              📊 报价表
            </button>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`provider-state ${activeProvider ? 'ok' : 'warn'}`}>
            {activeProvider ? `白底图 API：${activeProvider.name}` : '未配置 API'}
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

      {/* 批量图片列表：仅「白底图」使用（后两个模式是文件夹级流水线） */}
      {mode === 'white-bg' && (
      <div className="batch-bar">
        <button className="btn-secondary batch-add" onClick={handlePick}>
          + 添加图片
        </button>
        <div className="batch-thumbs">
          {items.map((item) => (
            <div
              key={item.id}
              className={`batch-thumb${item.id === selectedId ? ' selected' : ''}${item.status === 'processing' ? ' processing' : ''}`}
              onClick={() => setSelectedId(item.id)}
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
      )}

      {mode === 'label-batch' ? (
        <LabelBatchPanel />
      ) : mode === 'quote' ? (
        <QuotePanel />
      ) : (
      <main className="main">
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
                    <p className="dim">当前：{activeProvider?.name ?? '未配置'}</p>
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
      </main>
      )}

      {mode === 'white-bg' && (
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
              disabled={items.length === 0 || pendingCount === 0 || batchRunning || (whiteBgMethod === 'ai' && !activeProvider)}
              title={whiteBgMethod === 'ai' && !activeProvider ? '请先在 ⚙️ API 设置 中配置白底图 API' : undefined}
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
      )}

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
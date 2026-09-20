import { useCallback, useEffect, useState } from 'react'
import type { LabelFileResult, LabelMode, LabelOptions, LabelProgress, LabelRunResult } from '../../../shared/types'
import { assetUrl } from '../lib'

/**
 * 「批量改货号」面板（模式三）
 * ==========================
 * 整条流水线在原 Python 工具里是命令行/独立 GUI，这里搬进 Agent：
 *   选文件夹 -> 试跑 -> 正式处理 -> 逐张状态 + 对比图 + CSV 报告
 * 全程纯算法：不联网、不调用任何图像模型，不消耗 API 额度。
 */

const STATUS_META: Record<string, { icon: string; label: string; cls: string }> = {
  ok: { icon: '✓', label: '成功', cls: 's-ok' },
  dry: { icon: '·', label: '试跑', cls: 's-ok' },
  warn: { icon: '!', label: '有警告', cls: 's-warn' },
  'not-found': { icon: '?', label: '没找到货号', cls: 's-warn' },
  error: { icon: '×', label: '出错', cls: 's-err' }
}

/** 结果筛选。批量排查时最常用的就是「只看有问题的」。 */
type LabelFilter = 'all' | 'problem' | 'ok' | 'warn' | 'not-found' | 'error'

const FILTERS: { key: LabelFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'problem', label: '只看有问题的' },
  { key: 'ok', label: '成功' },
  { key: 'warn', label: '有警告' },
  { key: 'not-found', label: '没找到' },
  { key: 'error', label: '出错' }
]

function matchesFilter(it: LabelFileResult, f: LabelFilter): boolean {
  if (f === 'all') return true
  // 试跑时所有条目的状态都是 dry，必须和 ok 归为一类 —— 否则试跑结果里
  // 「成功」永远是 0、按钮被禁用，筛选等于没有（这个错被渲染层测试抓出来过一次）。
  if (f === 'ok') return it.status === 'ok' || it.status === 'dry'
  if (f === 'problem') return it.status === 'warn' || it.status === 'not-found' || it.status === 'error'
  return it.status === f
}

/** 结果行右侧那列文字：优先显示写入的货号，否则按状态给个准确的说法 */
function resultText(it: LabelFileResult): string {
  if (it.text) return it.text
  if (it.status === 'not-found') return '未检测到'
  if (it.status === 'error') return it.note || '出错'
  return '擦除'
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

/** 把筛选出的条目拼成 CSV（带 BOM，Excel 双击打开不乱码） */
function buildItemsCsv(items: LabelFileResult[]): string {
  const head = ['源文件', '输出文件', '状态', '新货号', '文字框', '备注']
  const rows = items.map((i) => [
    i.src,
    i.dst,
    STATUS_META[i.status]?.label ?? i.status,
    i.text ?? '',
    i.box ? `[${i.box.join(', ')}]` : '',
    i.note
  ])
  return '\ufeff' + [head, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\r\n') + '\r\n'
}

export function LabelBatchPanel(): JSX.Element {
  const [inputDir, setInputDir] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [mode, setMode] = useState<LabelMode>('replace')
  const [oldPrefix, setOldPrefix] = useState('JT')
  const [newPrefix, setNewPrefix] = useState('TJ')
  const [fixedText, setFixedText] = useState('')
  const [mappingName, setMappingName] = useState('')
  const [mapping, setMapping] = useState<Record<string, string> | null>(null)
  const [recursive, setRecursive] = useState(false)
  const [rename, setRename] = useState(true)
  const [compare, setCompare] = useState(true)
  const [quality, setQuality] = useState('95')
  const [bandTop, setBandTop] = useState('0.86')
  const [bandBottom, setBandBottom] = useState('0.999')
  const [inkThreshold, setInkThreshold] = useState('110')
  const [fontFamily, setFontFamily] = useState('')
  const [subpixel, setSubpixel] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [running, setRunning] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [result, setResult] = useState<LabelRunResult | null>(null)
  const [progress, setProgress] = useState<LabelProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<LabelFileResult | null>(null)
  /** 结果筛选 */
  const [filter, setFilter] = useState<LabelFilter>('all')
  /** 问题清单导出中 */
  const [exporting, setExporting] = useState(false)
  /** 最近一次导出的落盘路径 */
  const [exportedTo, setExportedTo] = useState<string | null>(null)

  // 主进程逐张推送进度
  useEffect(() => {
    return window.api.onLabelProgress((p) => setProgress(p))
  }, [])

  const pickInput = useCallback(async () => {
    const dir = await window.api.pickFolder({ title: '选择要处理的图片文件夹' })
    if (!dir) return
    setInputDir(dir)
    // 输出目录留空 = 自动输出到 输入文件夹\_已处理（无需再选一次）
    setResult(null)
    setPicked(null)
    setError(null)
  }, [])

  const pickOutput = useCallback(async () => {
    const dir = await window.api.pickFolder({ title: '选择结果输出文件夹', defaultPath: inputDir || undefined })
    if (dir) setOutputDir(dir)
  }, [inputDir])

  const pickMapping = useCallback(async () => {
    const res = await window.api.pickMapping()
    if (!res) return
    if (res.error) {
      setError('映射表读取失败：' + res.error)
      return
    }
    setMapping(res.data ?? null)
    setMappingName(res.path)
    setError(null)
  }, [])

  const buildOptions = useCallback(
    (dry: boolean): LabelOptions => ({
      inputDir: inputDir.trim(),
      outputDir: outputDir.trim() || undefined,
      mode,
      oldPrefix: oldPrefix.trim(),
      newPrefix: newPrefix.trim(),
      fixedText: fixedText.trim() || undefined,
      mapping: mapping ?? undefined,
      recursive,
      rename,
      compare,
      quality: Number(quality) || 95,
      bandTop: Number(bandTop) || 0.86,
      bandBottom: Number(bandBottom) || 0.999,
      inkThreshold: Number(inkThreshold) || 110,
      tolerant: true,
      dryRun: dry,
      fontFamily: fontFamily.trim() || undefined,
      subpixel
    }),
    [inputDir, outputDir, mode, oldPrefix, newPrefix, fixedText, mapping, recursive, rename, compare, quality, bandTop, bandBottom, inkThreshold, fontFamily, subpixel]
  )

  const start = useCallback(
    async (dry: boolean) => {
      if (running) return
      if (!inputDir.trim()) {
        setError('请先选择要处理的图片文件夹')
        return
      }
      setRunning(true)
      setDryRun(dry)
      setError(null)
      setResult(null)
      setPicked(null)
      setProgress(null)
      setFilter('all')
      setExportedTo(null)
      try {
        const res = dry
          ? await window.api.labelPreview(buildOptions(true))
          : await window.api.labelRun(buildOptions(false))
        if (!res.ok && res.error) setError(res.error)
        setResult(res)
        setPicked(res.items.find((i) => i.status === 'warn') ?? res.items[0] ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setRunning(false)
        setProgress(null)
      }
    },
    [running, inputDir, buildOptions]
  )

  const stop = useCallback(async () => {
    await window.api.labelCancel()
  }, [])

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const outDir = result?.outputDir || (outputDir.trim() || (inputDir ? inputDir + '\\_已处理' : ''))

  const visibleItems = result ? result.items.filter((i) => matchesFilter(i, filter)) : []
  const problemCount = result ? result.items.filter((i) => matchesFilter(i, 'problem')).length : 0
  const countOf = (f: LabelFilter): number => (result ? result.items.filter((i) => matchesFilter(i, f)).length : 0)

  /** 导出「问题清单」：只含警告 / 没找到 / 出错三类，用来逐张排查 */
  const exportProblems = useCallback(async () => {
    if (!result) return
    const problems = result.items.filter((i) => matchesFilter(i, 'problem'))
    if (problems.length === 0) return
    setExporting(true)
    setError(null)
    try {
      const stamp = new Date().toISOString().slice(0, 10)
      const path = await window.api.exportText({
        defaultName: `问题清单_${stamp}_${problems.length}张.csv`,
        content: buildItemsCsv(problems)
      })
      if (path) setExportedTo(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [result])

  return (
    <main className="main main-batch">
      <section className="panel">
        <div className="panel-head">
          <h2>批量改货号 · 配置</h2>
          <span className="dim" style={{ fontSize: 11 }}>
            纯算法 · 不联网 · 不消耗额度
          </span>
        </div>
        <div className="panel-body">
          <div className="field">
            <span className="field-label">输入文件夹（图片所在目录）</span>
            <div className="row-input">
              <input type="text" value={inputDir} onChange={(e) => setInputDir(e.target.value)} placeholder="点击右侧「选择…」" spellCheck={false} />
              <button className="btn-secondary" onClick={pickInput}>选择…</button>
            </div>
            <span className="field-hint">支持 jpg / jpeg / png / bmp / webp；原图不会被修改</span>
          </div>

          <div className="field">
            <span className="field-label">输出文件夹（留空 = 输入文件夹下的 _已处理）</span>
            <div className="row-input">
              <input type="text" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="留空则输出到 _已处理 子目录" spellCheck={false} />
              <button className="btn-secondary" onClick={pickOutput}>选择…</button>
            </div>
          </div>

          <div className="field">
            <span className="field-label">处理方式</span>
            <div className="seg">
              <button className={`chip${mode === 'replace' ? ' active' : ''}`} onClick={() => setMode('replace')} title="只换前缀，其余字符不变">🔤 只换前缀</button>
              <button className={`chip${mode === 'erase' ? ' active' : ''}`} onClick={() => setMode('erase')} title="整行擦掉，不留任何货号">🗑️ 整行擦除</button>
              <button className={`chip${mode === 'custom' ? ' active' : ''}`} onClick={() => setMode('custom')} title="按映射表或固定文字写">🗂️ 按映射表</button>
            </div>
          </div>

          {mode !== 'erase' && (
            <div className="field">
              <span className="field-label">{mode === 'custom' ? '默认文字（映射表未命中时使用）' : '货号前缀替换'}</span>
              <div className="seg">
                <input type="text" className="pfx" value={oldPrefix} onChange={(e) => setOldPrefix(e.target.value)} placeholder="JT" spellCheck={false} />
                <span className="arrow">→</span>
                <input type="text" className="pfx" value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} placeholder="TJ" spellCheck={false} />
                <span className="field-hint" style={{ marginLeft: 8 }}>
                  例：JT666-5 → TJ666-5，图片里写成 NO.TJ666-5
                </span>
              </div>
            </div>
          )}

          {mode === 'custom' && (
            <>
              <div className="field">
                <span className="field-label">固定文字（可选，如 NO.TJ666-5）</span>
                <input type="text" value={fixedText} onChange={(e) => setFixedText(e.target.value)} placeholder="留空则用文件名里的货号" spellCheck={false} />
              </div>
              <div className="field">
                <span className="field-label">映射表 JSON（可选）</span>
                <div className="row-input">
                  <input type="text" value={mappingName} readOnly placeholder="未选择（键可为货号或文件名）" />
                  <button className="btn-secondary" onClick={pickMapping}>选择…</button>
                </div>
                {mapping && <span className="field-hint">已载入 {Object.keys(mapping).length} 条映射</span>}
              </div>
            </>
          )}

          <div className="field checks">
            <label><input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} /> 同时改文件名（JT666-5.jpg → TJ666-5.jpg）</label>
            <label><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> 生成前后对比图（输出目录下的 _对比图）</label>
            <label><input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> 包含子文件夹</label>
          </div>

          <button className="link-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
            {advancedOpen ? '▾' : '▸'} 高级参数（货号不在底部、擦除留白不够时再动）
          </button>
          {advancedOpen && (
            <div className="adv-grid">
              <label>
                <span>搜索区上边界</span>
                <input type="text" value={bandTop} onChange={(e) => setBandTop(e.target.value)} />
              </label>
              <label>
                <span>搜索区下边界</span>
                <input type="text" value={bandBottom} onChange={(e) => setBandBottom(e.target.value)} />
              </label>
              <label>
                <span>文字灰度阈值</span>
                <input type="text" value={inkThreshold} onChange={(e) => setInkThreshold(e.target.value)} />
              </label>
              <label>
                <span>JPEG 质量</span>
                <input type="text" value={quality} onChange={(e) => setQuality(e.target.value)} />
              </label>
            </div>
          )}
          {advancedOpen && (
            <div className="adv-grid">
              <label className="check-line" style={{ gridColumn: '1 / -1' }}>
                <input type="checkbox" checked={subpixel} onChange={(e) => setSubpixel(e.target.checked)} />
                亚像素定位（默认开）：用灰度覆盖率把文字框从 ±1px 收敛到 ±0.05px，字号更准。关掉则退回整数外框（与 Python 原版行为一致）
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                <span>字体（留空 = Arial Bold，与原图字体实测 IoU 0.934；中文货号请填中文字体，如 Microsoft YaHei）</span>
                <input
                  type="text"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  placeholder='留空用内置链：Arial, "Arial Bold", "Liberation Sans", Helvetica, "DejaVu Sans"'
                  spellCheck={false}
                />
              </label>
            </div>
          )}
        </div>

        <div className="panel-actions">
          <button className="btn-secondary" onClick={() => start(true)} disabled={running || !inputDir.trim()}>
            ① 先试跑（只看计划）
          </button>
          <button className="btn-primary" onClick={() => start(false)} disabled={running || !inputDir.trim()}>
            {running && !dryRun ? '⏳ 处理中…' : '② 开始处理'}
          </button>
          {running && !dryRun && (
            <button className="chip danger" onClick={stop}>
              停止
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>处理结果</h2>
          {outDir && (
            <div className="panel-head-actions">
              <button className="btn-secondary small" onClick={() => window.api.openPath(outDir)} title="在文件管理器中打开输出目录">
                📂 打开输出位置
              </button>
            </div>
          )}
        </div>

        {error && <div className="error-banner">⚠️ {error}</div>}

        {running && dryRun && (
          <div className="processing">
            <div className="spinner" />
            <p>正在逐张检测货号位置…</p>
            <p className="dim">只读不写，不会改动任何文件</p>
          </div>
        )}

        {result && result.total > 0 && (
          <>
            <div className="summary">
              <span className="stat-chip">共 {result.total} 张</span>
              <span className="stat-chip ok">成功 {result.okCount}</span>
              {result.warnCount > 0 && <span className="stat-chip warn">警告 {result.warnCount}</span>}
              {result.notFoundCount > 0 && <span className="stat-chip warn">没找到货号 {result.notFoundCount}</span>}
              {result.errorCount > 0 && <span className="stat-chip err">出错 {result.errorCount}</span>}
              {result.renamedCount > 0 && <span className="stat-chip">改名 {result.renamedCount}</span>}
              {result.aborted && <span className="stat-chip warn">已中止</span>}
              {result.dryRun && <span className="stat-chip">试跑</span>}
            </div>
            <div className="filter-bar">
              <div className="filter-chips" role="group" aria-label="按状态筛选">
                {FILTERS.map((f) => {
                  const n = countOf(f.key)
                  return (
                    <button
                      key={f.key}
                      className={`chip${filter === f.key ? ' active' : ''}`}
                      onClick={() => setFilter(f.key)}
                      disabled={f.key !== 'all' && n === 0}
                      title={f.key === 'all' ? '显示全部' : `只看「${f.label}」的 ${n} 张`}
                    >
                      {f.label}
                      <span className="chip-count">{n}</span>
                    </button>
                  )
                })}
              </div>
              <button
                className="btn-secondary small"
                onClick={exportProblems}
                disabled={exporting || problemCount === 0}
                title={problemCount === 0 ? '本次没有需要排查的图' : `把 ${problemCount} 张有问题的图导出成 CSV`}
              >
                {exporting ? '⏳ 导出中…' : `📋 导出问题清单（${problemCount}）`}
              </button>
            </div>
            {progress && (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: pct + '%' }} />
              </div>
            )}
            <div className="result-split">
              <div className="result-list">
                {visibleItems.length === 0 && <div className="result-row dim">这个筛选下没有条目</div>}
                {visibleItems.map((it) => {
                  const meta = STATUS_META[it.status] ?? STATUS_META.error
                  return (
                    <div
                      key={it.src + it.status}
                      className={`result-row${picked?.src === it.src ? ' active' : ''}`}
                      onClick={() => setPicked(it)}
                      title={it.note || it.dst}
                    >
                      <span className={`result-icon ${meta.cls}`}>{meta.icon}</span>
                      <span className="result-name">{it.name}</span>
                      <span className="result-text">{resultText(it)}</span>
                    </div>
                  )
                })}
              </div>
              <div className="result-preview">
                {picked ? (
                  <>
                    <div className="preview-pair">
                      <figure>
                        <img src={assetUrl(picked.src)} alt="原图" />
                        <figcaption>原图</figcaption>
                      </figure>
                      {!result.dryRun && picked.status !== 'not-found' && picked.status !== 'error' && (
                        <figure>
                          <img src={assetUrl(picked.dst)} alt="处理后" />
                          <figcaption>处理后</figcaption>
                        </figure>
                      )}
                    </div>
                    <div className="preview-meta">
                      <div>
                        <span className="k">文件</span>
                        <span className="v">{picked.name}</span>
                      </div>
                      <div>
                        <span className="k">状态</span>
                        <span className="v">{(STATUS_META[picked.status] ?? STATUS_META.error).label}{picked.note ? ' · ' + picked.note : ''}</span>
                      </div>
                      {picked.box && (
                        <div>
                          <span className="k">文字框</span>
                          <span className="v">
                            [{picked.box.join(', ')}] · {picked.box[2] - picked.box[0] + 1}×{picked.box[3] - picked.box[1] + 1}px
                          </span>
                        </div>
                      )}
                      {picked.text && (
                        <div>
                          <span className="k">写入文字</span>
                          <span className="v">{picked.text}</span>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="placeholder">
                    <span>🔎</span>
                    <p>左侧点一条看原图 / 处理后的对比</p>
                  </div>
                )}
              </div>
            </div>
            {exportedTo && <div className="report-note">📋 问题清单已保存：{exportedTo}</div>}
            {result.reportPath && <div className="report-note">📄 完整报告已写入：{result.reportPath}</div>}
          </>
        )}

        {!result && !running && !error && (
          <div className="placeholder">
            <span>🔢</span>
            <p>批量改货号（免费）</p>
            <p className="dim">几何投影定位图片底部的货号行 → 擦除 → 用 Arial Bold 重绘新货号</p>
            <p className="dim">先点「① 先试跑」看清检测结果，再点「② 开始处理」</p>
          </div>
        )}
      </section>
    </main>
  )
}

import { useCallback, useState } from 'react'
import type { QuoteOptions, QuoteRunResult } from '../../../shared/types'

/**
 * 「报价表」面板（模式四）
 * ======================
 * .xlsx 本质是个 zip：只替换「图片部件 / 绘图部件里的货号 / 共享字符串」三处，
 * 其余部件按原始字节复制 —— 列宽、行高、字体、边框、合并单元格、图片锚点全部不变。
 * 写完自动校验（zip 完整性 / XML 良构 / 关系目标 / 内容类型 / 旧前缀残留）。
 */

export function QuotePanel(): JSX.Element {
  const [xlsxPath, setXlsxPath] = useState('')
  const [imageDir, setImageDir] = useState('')
  const [oldPrefix, setOldPrefix] = useState('JT')
  const [newPrefix, setNewPrefix] = useState('TJ')
  const [outputPath, setOutputPath] = useState('')
  const [inplace, setInplace] = useState(false)
  const [quality, setQuality] = useState('92')
  const [recursiveImgs, setRecursiveImgs] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QuoteRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pickXlsx = useCallback(async () => {
    const p = await window.api.pickXlsx()
    if (!p) return
    setXlsxPath(p)
    setOutputPath('')
    setResult(null)
    setError(null)
  }, [])

  const pickImages = useCallback(async () => {
    const d = await window.api.pickFolder({ title: '选择新图片文件夹（文件名 = 新货号）' })
    if (d) {
      setImageDir(d)
      setResult(null)
      setError(null)
    }
  }, [])

  const buildOptions = useCallback(
    (dry: boolean): QuoteOptions => ({
      xlsxPath: xlsxPath.trim(),
      imageDir: imageDir.trim(),
      oldPrefix: oldPrefix.trim(),
      newPrefix: newPrefix.trim(),
      outputPath: outputPath.trim() || undefined,
      inplace,
      recursive: recursiveImgs,
      quality: Number(quality) || 92
    }),
    [xlsxPath, imageDir, oldPrefix, newPrefix, outputPath, inplace, recursiveImgs, quality]
  )

  const start = useCallback(
    async (dry: boolean) => {
      if (running) return
      if (!xlsxPath.trim()) return setError('请先选择报价表 .xlsx 文件')
      if (!imageDir.trim()) return setError('请先选择新图片文件夹')
      setRunning(true)
      setError(null)
      setResult(null)
      try {
        const res = dry ? await window.api.quotePreview(buildOptions(true)) : await window.api.quoteRun(buildOptions(false))
        setResult(res)
        if (!res.ok && res.error) setError(res.error)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setRunning(false)
      }
    },
    [running, xlsxPath, imageDir, buildOptions]
  )

  const plan = result?.plan
  const missing = plan?.pictures.filter((p) => !p.newFile).length ?? 0

  return (
    <main className="main main-batch">
      <section className="panel">
        <div className="panel-head">
          <h2>报价表换图改货号</h2>
          <span className="dim" style={{ fontSize: 11 }}>
            只改三处 · 格式零改动
          </span>
        </div>
        <div className="panel-body">
          <div className="field">
            <span className="field-label">报价表文件（必须是 .xlsx）</span>
            <div className="row-input">
              <input type="text" value={xlsxPath} onChange={(e) => setXlsxPath(e.target.value)} placeholder="点击右侧「选择…」" spellCheck={false} />
              <button className="btn-secondary" onClick={pickXlsx}>选择…</button>
            </div>
            <span className="field-hint">
              老式 .xls 请先在 Excel/WPS 里「另存为」→「Excel 工作簿 (*.xlsx)」；只改扩展名不行
            </span>
          </div>

          <div className="field">
            <span className="field-label">新图片文件夹（文件名 = 新货号，如 TJ666-5.jpg）</span>
            <div className="row-input">
              <input type="text" value={imageDir} onChange={(e) => setImageDir(e.target.value)} placeholder="通常选「批量改货号」的输出目录" spellCheck={false} />
              <button className="btn-secondary" onClick={pickImages}>选择…</button>
            </div>
          </div>

          <div className="field">
            <span className="field-label">货号前缀</span>
            <div className="seg">
              <input type="text" className="pfx" value={oldPrefix} onChange={(e) => setOldPrefix(e.target.value)} placeholder="JT" spellCheck={false} />
              <span className="arrow">→</span>
              <input type="text" className="pfx" value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} placeholder="TJ" spellCheck={false} />
              <span className="field-hint" style={{ marginLeft: 8 }}>
                图片名称与货号列一起改
              </span>
            </div>
          </div>

          <div className="field">
            <span className="field-label">输出</span>
            <div className="row-input">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder={inplace ? '（覆盖原表）' : '留空 = 原表同目录下的 「原表名_新.xlsx」'}
                disabled={inplace}
                spellCheck={false}
              />
            </div>
            <label className="check-line">
              <input type="checkbox" checked={inplace} onChange={(e) => setInplace(e.target.checked)} />
              直接覆盖原报价表（会先自动备份成 同名.xlsx.bak）
            </label>
          </div>

          <div className="field checks">
            <label><input type="checkbox" checked={recursiveImgs} onChange={(e) => setRecursiveImgs(e.target.checked)} /> 新图片在子文件夹里</label>
          </div>

          <div className="adv-grid" style={{ marginTop: 4 }}>
            <label>
              <span>图片重编码质量</span>
              <input type="text" value={quality} onChange={(e) => setQuality(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="panel-actions">
          <button className="btn-secondary" onClick={() => start(true)} disabled={running || !xlsxPath.trim() || !imageDir.trim()}>
            ① 先试跑（只看计划）
          </button>
          <button className="btn-primary" onClick={() => start(false)} disabled={running || !xlsxPath.trim() || !imageDir.trim()}>
            {running ? '⏳ 处理中…' : '② 开始处理'}
          </button>
          {result?.outputPath && (
            <button className="btn-secondary" onClick={() => window.api.openPath(result.outputPath!)}>
              📂 打开结果位置
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{result?.dryRun ? '试跑计划' : '处理结果'}</h2>
          {result?.bytes !== undefined && <span className="dim" style={{ fontSize: 11 }}>{(result.bytes / 1024).toFixed(0)} KB</span>}
        </div>

        {error && <div className="error-banner">⚠️ {error}</div>}

        {plan && (
          <>
            <div className="summary">
              <span className="stat-chip">图片 {plan.picturesPlanned}/{plan.pictures.length}</span>
              <span className="stat-chip">货号文字 {plan.codesPlanned} 处</span>
              {missing > 0 && <span className="stat-chip warn">缺图 {missing}</span>}
              {!result?.dryRun && result?.issues && result.issues.length === 0 && (
                <span className="stat-chip ok">写后校验通过</span>
              )}
            </div>

            {plan.warnings.length > 0 && (
              <div className="warn-list">
                {plan.warnings.map((w) => (
                  <div key={w}>· {w}</div>
                ))}
              </div>
            )}

            {result && !result.dryRun && result.issues && result.issues.length > 0 && (
              <div className="warn-list err">
                {result.issues.map((w) => (
                  <div key={w}>✗ {w}</div>
                ))}
              </div>
            )}

            <div className="result-list tall">
              {plan.pictures.map((p) => (
                <div key={p.media + p.code} className={`result-row${p.newFile ? '' : ' missing'}`} title={p.newFile ?? '图片文件夹里没有对应文件'}>
                  <span className={`result-icon ${p.newFile ? 's-ok' : 's-err'}`}>{p.newFile ? '✓' : '×'}</span>
                  <span className="result-name">{p.code}</span>
                  <span className="result-text">→ {p.newCode}</span>
                  <span className="result-file">{p.newFile ? p.newFile.split(/[\\/]/).pop() : '(缺失)'}</span>
                </div>
              ))}
              {plan.pictures.length === 0 && <div className="result-row dim">这份报价表里没有找到浮动图片</div>}
            </div>

            {plan.codeStrings.length > 0 && (
              <div className="report-note">
                📄 货号列文字：{plan.codeStrings.map((c) => `${c.from} → ${c.to}`).join('，')}
              </div>
            )}
          </>
        )}

        {!plan && !running && !error && (
          <div className="placeholder">
            <span>📊</span>
            <p>把报价表里的旧图换成新图，货号列同步改前缀</p>
            <p className="dim">列宽 / 行高 / 字体 / 边框 / 合并单元格 / 图片锚点全部保持原样</p>
            <p className="dim">先点「① 先试跑」看清逐条对应，再点「② 开始处理」</p>
          </div>
        )}

        {running && (
          <div className="processing">
            <div className="spinner" />
            <p>正在重新打包 xlsx…</p>
          </div>
        )}
      </section>
    </main>
  )
}

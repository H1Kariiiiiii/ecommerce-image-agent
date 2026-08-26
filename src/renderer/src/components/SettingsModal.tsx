import { useEffect, useMemo, useState } from 'react'
import type { ProviderConfig, ProviderType, QuotaInfo } from '../../../shared/types'

interface Props {
  providers: ProviderConfig[]
  onClose: () => void
  onSaved: (providers: ProviderConfig[]) => void
  /** 当前额度（用于展示），缺省时组件自行加载 */
  quota?: QuotaInfo | null
  onQuotaChange?: (quota: QuotaInfo) => void
}

/** 字节数 → 可读大小 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${Math.round(v * 10) / 10} ${units[i]}`
}

const TYPE_LABEL: Partial<Record<ProviderType, string>> = {
  'openai-compatible': 'OpenAI 兼容',
  dashscope: '阿里百炼 DashScope'
}

/** 市面主流生图模型的 OpenAI 兼容预设（选择后自动填充 baseUrl/model/请求风格，均可再改） */
interface ProviderPreset {
  key: string
  label: string
  baseUrl: string
  model: string
  requestStyle: ProviderConfig['requestStyle']
  sizeProfile?: string
  note: string
}

const PRESETS: ProviderPreset[] = [
  {
    key: 'ark',
    label: '火山方舟 Ark · 豆包 Seedream 5.0',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-260128',
    requestStyle: 'json',
    note: 'images/generations，比例 / 水印参数均支持；总像素 ≥ 3686400'
  },
  {
    key: 'openai',
    label: 'OpenAI 官方 · gpt-image-2',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2',
    requestStyle: 'json',
    sizeProfile: 'gpt-image-2',
    note: '支持任意尺寸（16 的倍数、比例 1:3~3:1），images/generations'
  },
  {
    key: 'zhipu',
    label: '智谱 AI · GLM-Image 生图',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-image',
    requestStyle: 'json',
    sizeProfile: 'glm-image',
    note: 'images/generations；边长 1024~2048、32 的倍数、≤ 4194304 像素'
  },
  {
    key: 'siliconflow',
    label: '硅基流动 · 开源生图（Qwen-Image）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen-Image',
    requestStyle: 'json',
    sizeProfile: 'siliconflow-qwen',
    note: 'images/generations，尺寸参数为 image_size（推荐档位）'
  },
  {
    key: 'siliconflow-kontext',
    label: '硅基流动 · FLUX.1 Kontext（图像编辑·无需 mask）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'black-forest-labs/FLUX.1-Kontext-dev',
    requestStyle: 'json',
    note: '上下文感知编辑：一句话擦除/修改指定区域，不需要遮罩；适合货号擦除/局部修改'
  },
  {
    key: 'siliconflow-fill',
    label: '硅基流动 · FLUX.1 Fill（inpainting·遮罩填充）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'black-forest-labs/FLUX.1-Fill-dev',
    requestStyle: 'json',
    note: '区域填充 inpainting；配合 mask 精确局部抹除/填充'
  }
]

/** 阿里百炼 DashScope 预设（走原生接口，不走 OpenAI 兼容） */
const DASHSCOPE_PRESETS: Array<{ key: string; label: string; model: string; note: string }> = [
  {
    key: 'aliyun-qwen-image-3-0-pro',
    label: '阿里云百炼 · Qwen-Image 3.0 Pro（推荐）',
    model: 'qwen-image-3.0-pro',
    note: '千问图像 3.0 旗舰：文生图 + 图生图/编辑，文本渲染强；电商白底图推荐'
  },
  {
    key: 'aliyun-qwen-image-edit',
    label: '阿里云百炼 · Qwen-Image-Edit（图像编辑）',
    model: 'qwen-image-edit',
    note: '专用图像编辑：精确修改图内文字、增删/移动物体、风格迁移；中文文字擦除/替换最强，货号处理首选'
  },
  {
    key: 'aliyun-qwen-image-3-0',
    label: '阿里云百炼 · Qwen-Image 3.0',
    model: 'qwen-image-3.0',
    note: '3.0 标准版，性价比档'
  },
  {
    key: 'aliyun-qwen-image-2-0-pro',
    label: '阿里云百炼 · Qwen-Image 2.0 Pro',
    model: 'qwen-image-2.0-pro',
    note: '2.0 增强版'
  },
  {
    key: 'aliyun-qwen-image-2-0',
    label: '阿里云百炼 · Qwen-Image 2.0',
    model: 'qwen-image-2.0',
    note: '2.0 标准版'
  },
  {
    key: 'aliyun-qwen-image',
    label: '阿里云百炼 · Qwen-Image（旧版）',
    model: 'qwen-image',
    note: '旧版（可能已下线，若不可用请选 2.0/3.0 系列）'
  },
  {
    key: 'aliyun-qwen-image-plus',
    label: '阿里云百炼 · Qwen-Image-Plus',
    model: 'qwen-image-plus',
    note: '旧版增强（可能已下线）'
  },
  {
    key: 'aliyun-qwen-image-max',
    label: '阿里云百炼 · Qwen-Image-Max',
    model: 'qwen-image-max',
    note: '旧版旗舰（可能已下线）'
  }
]

function blankDraft(type: ProviderType): ProviderConfig {
  const isDashscope = type === 'dashscope'
  return {
    id: '',
    name: isDashscope ? '阿里云百炼' : '新 API',
    type,
    prompt: '',
    erasePrompt: '',
    baseUrl: isDashscope ? 'https://dashscope.aliyuncs.com' : 'https://ark.cn-beijing.volces.com/api/v3',
    requestStyle: 'json',
    model: isDashscope ? 'qwen-image-3.0-pro' : '',
    size: '',
    aspectRatio: '1:1'
  }
}

/** 生成唯一 id：优先 Web Crypto，不可用时降级到时间戳+随机数（保证任何环境可用） */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* 降级 */
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function SettingsModal({
  providers,
  onClose,
  onSaved,
  quota: quotaProp,
  onQuotaChange
}: Props): JSX.Element {
  const [drafts, setDrafts] = useState<ProviderConfig[]>(() =>
    providers.map((p) => JSON.parse(JSON.stringify(p)))
  )
  /** 最近一次持久化成功的 provider 快照（按 id），用于判断当前表单是否有未保存修改 */
  const [savedById, setSavedById] = useState<Map<string, ProviderConfig>>(() =>
    new Map(providers.map((p) => [p.id, JSON.parse(JSON.stringify(p))]))
  )
  // 初始选中「使用中(active)」的 provider；没有则选第一个（避免重开面板跳回列表第一项）
  const [selectedId, setSelectedId] = useState<string | null>(
    () => providers.find((p) => p.active)?.id ?? providers[0]?.id ?? null
  )
  const [quota, setQuota] = useState<QuotaInfo | null>(quotaProp ?? null)
  const [limitText, setLimitText] = useState('')
  const [savingLimit, setSavingLimit] = useState(false)
  const [queryingBalance, setQueryingBalance] = useState(false)
  const [balanceResult, setBalanceResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [cacheInfo, setCacheInfo] = useState<{ fileCount: number; sizeBytes: number } | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [confirmClearCache, setConfirmClearCache] = useState(false)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)

  // 加载额度信息（优先使用父组件传入的最新值）
  useEffect(() => {
    setQuota((cur) => {
      if (quotaProp) {
        if (quotaProp !== cur) setLimitText(String(quotaProp.limit))
        return quotaProp
      }
      return cur
    })
  }, [quotaProp])

  useEffect(() => {
    window.api.getQuota().then((q) => {
      setQuota(q)
      setLimitText(String(q.limit))
    }).catch(() => {})
    window.api.getCacheInfo().then(setCacheInfo).catch(() => {})
  }, [])
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 应用内删除确认弹层（替代 window.confirm，避免原生模态对话框破坏键盘输入）
  const [confirmDelete, setConfirmDelete] = useState<{ deletedId: string; name: string } | null>(null)
  // 关闭确认弹层：当前项有未保存修改时关闭会静默丢弃，先让用户确认
  const [confirmDiscardClose, setConfirmDiscardClose] = useState(false)

  /** 当前选中项是否有未保存修改（与最近一次持久化快照比较） */
  function isDirty(id: string): boolean {
    const d = drafts.find((x) => x.id === id)
    if (!d) return false
    const s = savedById.get(id)
    if (!s) return true // 未保存过的新增项
    return JSON.stringify(d) !== JSON.stringify(s)
  }

  /** 查询当前服务商余额（OpenAI 官方或支持 billing 端点的兼容服务） */
  const handleQueryBalance = useMemo(
    () => async (): Promise<void> => {
      setQueryingBalance(true)
      setBalanceResult(null)
      try {
        const r = await window.api.queryBalance()
        setBalanceResult(r)
      } catch (err) {
        setBalanceResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
      } finally {
        setQueryingBalance(false)
      }
    },
    []
  )

  /** 清理 7 天前的过期结果缓存 */
  const handleCleanCache = useMemo(
    () => async (): Promise<void> => {
      setCacheBusy(true)
      setCacheNotice(null)
      try {
        const r = await window.api.cleanCache()
        setCacheNotice(r.removedCount > 0 ? `已清理 ${r.removedCount} 个文件（${fmtBytes(r.freedBytes)}）` : '没有超过 7 天的过期文件')
        setCacheInfo(await window.api.getCacheInfo())
      } catch (err) {
        setCacheNotice(`清理失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setCacheBusy(false)
      }
    },
    []
  )

  /** 清空全部结果缓存（两次点击确认） */
  const handleClearCache = useMemo(
    () => async (): Promise<void> => {
      if (!confirmClearCache) {
        setConfirmClearCache(true)
        setTimeout(() => setConfirmClearCache(false), 3000)
        return
      }
      setConfirmClearCache(false)
      setCacheBusy(true)
      setCacheNotice(null)
      try {
        const r = await window.api.clearCache()
        setCacheNotice(`已清空 ${r.removedCount} 个文件，释放 ${fmtBytes(r.freedBytes)}`)
        setCacheInfo(await window.api.getCacheInfo())
      } catch (err) {
        setCacheNotice(`清理失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setCacheBusy(false)
      }
    },
    [confirmClearCache]
  )

  const selected = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  )

  /** 保存每月额度上限 */
  const handleSaveLimit = useMemo(
    () => async (): Promise<void> => {
      const n = parseInt(limitText, 10)
      if (Number.isNaN(n) || n < 0) return
      setSavingLimit(true)
      try {
        const q = await window.api.setQuotaLimit(n)
        setQuota(q)
        setLimitText(String(q.limit))
        onQuotaChange?.(q)
        setNotice('额度上限已保存 ✓')
      } catch (err) {
        setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setSavingLimit(false)
      }
    },
    [limitText, onQuotaChange]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 关闭确认弹层已打开时，Escape 先关弹层而不是直接关闭窗口
      if (confirmDiscardClose) setConfirmDiscardClose(false)
      else requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDiscardClose, requestClose])

  function updateSelected(patch: Partial<ProviderConfig>): void {
    if (selectedId === null) return
    setDrafts((ds) => ds.map((d) => (d.id === selectedId ? { ...d, ...patch } : d)))
    setTestResult(null)
  }

  /**
   * 合并主进程返回列表与当前 drafts：
   * - 主进程已保存项全部保留（含空 id 保存后新分配的 id 项）；
   * - drafts 中未保存的新增项保留编辑态；
   * - 除本次保存项（saveId）外，已保存项在 drafts 中的未保存编辑不被覆盖（避免切换后保存其他项时静默丢弃），
   *   但 active 状态始终以主进程为准（编辑态不持有 active）。
   */
  function mergeWithPending(
    saved: ProviderConfig[],
    opts: { saveId?: string; excludeId?: string } = {}
  ): (ds: ProviderConfig[]) => ProviderConfig[] {
    return (ds) => {
      const savedMap = new Map(saved.map((p) => [p.id, JSON.parse(JSON.stringify(p))]))
      const { saveId, excludeId } = opts
      const out: ProviderConfig[] = []
      // 1) 主进程已保存项（含空 id 保存后收敛出的新 id 项）
      for (const p of saved) out.push(JSON.parse(JSON.stringify(p)))
      // 2) drafts 中未保存的新增项（不在主进程列表、非空 id、非被删项）
      for (const d of ds) {
        if (d.id === '' || d.id === excludeId || savedMap.has(d.id)) continue
        out.push(JSON.parse(JSON.stringify(d)))
      }
      // 3) 已保存项的未保存编辑覆盖主进程值（本次保存项除外），active 跟随主进程
      for (const d of ds) {
        if (d.id === '' || d.id === excludeId) continue
        const s = savedMap.get(d.id)
        if (s && d.id !== saveId) {
          const i = out.findIndex((x) => x.id === d.id)
          if (i >= 0) out[i] = { ...JSON.parse(JSON.stringify(d)), active: s.active }
        }
      }
      return out
    }
  }

  /** 持久化操作成功后同步 drafts 与 savedById 快照 */
  function applySaved(saved: ProviderConfig[], opts?: { saveId?: string; excludeId?: string }): void {
    setDrafts(mergeWithPending(saved, opts))
    setSavedById((prev) => {
      const next = new Map(prev)
      if (opts?.excludeId) next.delete(opts.excludeId)
      for (const p of saved) next.set(p.id, JSON.parse(JSON.stringify(p)))
      return next
    })
  }

  /** 关闭设置窗口：有未保存修改时先弹确认，避免静默丢弃 */
  function requestClose(): void {
    if (selectedId !== null && isDirty(selectedId)) {
      setConfirmDiscardClose(true)
      return
    }
    onClose()
  }

  async function handleSave(): Promise<void> {
    if (!selected) return
    setSaving(true)
    setNotice(null)
    try {
      const saved = await window.api.saveProvider(selected)
      applySaved(saved, { saveId: selected.id })
      onSaved(saved)
      setNotice('已保存 ✓')
    } catch (err) {
      setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(): Promise<void> {
    if (!selected) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.api.testProvider(selected))
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  async function handleSetActive(): Promise<void> {
    if (!selected) return
    try {
      const saved = await window.api.setActiveProvider(selected.id)
      applySaved(saved)
      onSaved(saved)
      setNotice('已设为当前使用的 API ✓')
    } catch (err) {
      setNotice(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function doDelete(deletedId: string): Promise<void> {
    try {
      const saved = await window.api.deleteProvider(deletedId)
      // 函数式更新：合并主进程返回列表 + 期间未保存的新增项（排除被删项），
      // 避免删除回调晚于「再添加」执行时把新项与选中状态覆盖掉（异步竞态）
      applySaved(saved, { excludeId: deletedId })
      setSelectedId((cur) => (cur === deletedId ? (saved[0]?.id ?? null) : cur))
      setNotice(null)
      onSaved(saved)
    } catch (err) {
      setNotice(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handleDelete(): void {
    if (!selected) return
    // 用应用内确认弹层替代 window.confirm：
    // 原生模态对话框在 Electron/Windows 上关闭后可能导致键盘输入事件异常（打字失灵，最小化复原才恢复）
    setConfirmDelete({ deletedId: selected.id, name: selected.name })
  }

  async function confirmDeleteNow(): Promise<void> {
    if (!confirmDelete) return
    const { deletedId } = confirmDelete
    setConfirmDelete(null)
    await doDelete(deletedId)
  }

  function handleAdd(type: ProviderType): void {
    // 立即分配唯一 id（带兜底），避免空 id 导致 updateSelected 无法匹配而无法编辑
    const draft = { ...blankDraft(type), id: newId() }
    setDrafts((ds) => [...ds, draft])
    setSelectedId(draft.id)
    setTestResult(null)
    // 新增即切换选中项，清空残留的状态提示（如上一个项的「已保存」）
    setNotice(null)
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal settings">
        <header className="modal-header">
          <h2>API 设置</h2>
          <button className="icon-btn" onClick={requestClose} title="关闭">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <aside className="provider-list">
            {drafts.map((p) => (
              <div
                key={p.id}
                className={`provider-item${p.id === selectedId ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedId(p.id)
                  setTestResult(null)
                  // 切换选中项时清空状态提示，避免「已保存」等残留到其他项
                  setNotice(null)
                }}
              >
                <div className="provider-name">
                  {p.name || '(未命名)'}
                  {p.active && <span className="badge-active">使用中</span>}
                </div>
                <div className="provider-type">{TYPE_LABEL[p.type] ?? '已停用类型'}</div>
              </div>
            ))}
            <div className="provider-add">
              <button onClick={() => handleAdd('openai-compatible')}>+ 添加 OpenAI 兼容模型</button>
              <button onClick={() => handleAdd('dashscope')}>+ 添加阿里云百炼（DashScope）</button>
            </div>
          </aside>

          <section className="provider-form">
            {selected ? (
              <ProviderForm
                key={selected.id}
                draft={selected}
                onChange={updateSelected}
              />
            ) : (
              <p className="empty-tip">从左侧选择或新增一个 API</p>
            )}
          </section>
        </div>

        {/* 额度统计：每月上限与已用量 */}
        <div className="quota-row">
          <span className="quota-info" title={`统计月份：${quota?.yearMonth ?? '—'}`}>
            📊 本月额度：已用 {quota?.used ?? 0} 张
            {quota && quota.limit > 0 ? ` / 上限 ${quota.limit}` : '（未设上限）'}
          </span>
          <button className="chip" onClick={handleQueryBalance} disabled={queryingBalance}>
            {queryingBalance ? '查询中…' : '🔍 查询余额'}
          </button>
          <label className="quota-limit">
            每月上限（0 = 不限）
            <input
              type="number"
              min={0}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
              placeholder="0"
            />
          </label>
          <button className="chip" onClick={handleSaveLimit} disabled={savingLimit}>
            {savingLimit ? '保存中…' : '保存上限'}
          </button>
        </div>
        {balanceResult && (
          <div className={`test-result ${balanceResult.ok ? 'ok' : 'fail'}`}>
            {balanceResult.ok ? '✅ ' : '❌ '}
            {balanceResult.message}
          </div>
        )}

        {/* 存储：结果缓存占用与清理 */}
        <div className="storage-row">
          <span className="quota-info" title="生成的中间结果图片保存位置">
            💾 结果缓存：
            {cacheInfo
              ? `${cacheInfo.fileCount} 个文件 / ${fmtBytes(cacheInfo.sizeBytes)}`
              : '计算中…'}
          </span>
          <button className="chip" onClick={handleCleanCache} disabled={cacheBusy}>
            {cacheBusy ? '清理中…' : '清理 7 天前'}
          </button>
          <button
            className={`chip ${confirmClearCache ? 'danger' : ''}`}
            onClick={handleClearCache}
            disabled={cacheBusy}
          >
            {confirmClearCache ? '再点一次确认清空' : '清空缓存'}
          </button>
          {cacheNotice && <span className="dim storage-notice">{cacheNotice}</span>}
        </div>

        <footer className="modal-footer">
          <span className="notice">{notice ?? ''}</span>
          {selected && isDirty(selected.id) && (
            <span className="dirty-hint" role="status">
              ⚠️ 有未保存的修改，记得点「保存」
            </span>
          )}
          {selected && (
            <>
              <button className="chip" onClick={handleTest} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button className="chip" onClick={handleSetActive}>
                设为使用中
              </button>
              <button className="chip danger" onClick={handleDelete} disabled={!selected}>
                删除
              </button>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          )}
        </footer>
        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? '✅ ' : '❌ '}
            {testResult.message}
          </div>
        )}
        {confirmDelete && (
          <div className="confirm-mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
            <div className="confirm-dialog" role="dialog" aria-label="删除确认">
              <p>确定删除 API「{confirmDelete.name}」？</p>
              <div className="confirm-actions">
                <button className="chip" onClick={() => setConfirmDelete(null)} autoFocus>
                  取消
                </button>
                <button className="chip danger" onClick={confirmDeleteNow}>
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}
        {confirmDiscardClose && (
          <div className="confirm-mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDiscardClose(false)}>
            <div className="confirm-dialog" role="dialog" aria-label="放弃修改确认">
              <p>当前 API 的修改尚未保存，关闭将丢弃这些修改。确定关闭？</p>
              <div className="confirm-actions">
                <button className="chip" onClick={() => setConfirmDiscardClose(false)} autoFocus>
                  继续编辑
                </button>
                <button
                  className="chip danger"
                  onClick={() => {
                    setConfirmDiscardClose(false)
                    onClose()
                  }}
                >
                  放弃修改并关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- 表单 ----------

interface FormProps {
  draft: ProviderConfig
  onChange: (patch: Partial<ProviderConfig>) => void
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  hint
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  required?: boolean
  hint?: string
}): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <em className="req">*</em>}
      </span>
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

function ProviderForm({ draft, onChange }: FormProps): JSX.Element {
  const set = <K extends keyof ProviderConfig>(key: K) => (v: ProviderConfig[K]) => onChange({ [key]: v } as Partial<ProviderConfig>)
  const setStr = (key: keyof ProviderConfig) => set(key as never) as unknown as (v: string) => void

  return (
    <div className="provider-form-inner">
      <div className="form-grid">
        <Field label="名称" value={draft.name ?? ''} onChange={setStr('name')} required />
        <label className="field">
          <span className="field-label">用途 *（决定此 key 用于哪个功能）</span>
          <select
            value={draft.role ?? 'both'}
            onChange={(e) => onChange({ role: e.target.value as ProviderConfig['role'] })}
          >
            <option value="both">通用（白底图 + 擦除货号共用）</option>
            <option value="white-bg">仅白底图</option>
            <option value="erase">仅擦除货号</option>
          </select>
          <span className="field-hint">「仅擦除货号」的 key 只用于 AI 擦除（images/edits）；可与白底图 key 分开，控制各自消耗</span>
        </label>
        {draft.type !== 'dashscope' && (
          <label className="field">
            <span className="field-label">预设模板（可选，自动填充下面三项）</span>
            <select
              value=""
              onChange={(e) => {
                const p = PRESETS.find((x) => x.key === e.target.value)
                if (p) {
                  onChange({
                    baseUrl: p.baseUrl,
                    model: p.model,
                    requestStyle: p.requestStyle,
                    sizeProfile: p.sizeProfile
                  })
                }
              }}
            >
              <option value="">— 选择预设 —</option>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              选择后自动填充 baseUrl / model / 请求风格，均可再修改；模型 ID 以服务商官方最新文档为准
            </span>
          </label>
        )}
      </div>

      <label className="field">
        <span className="field-label">白底提示词（可留空使用默认）</span>
        <textarea
          value={draft.prompt ?? ''}
          rows={2}
          placeholder="例如：将商品完整抠出，替换为纯白色背景，保留细节，无阴影。"
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field-label">擦除货号提示词（可留空使用默认：只擦 NO. 开头货号，其他文字不动）</span>
        <textarea
          value={draft.erasePrompt ?? ''}
          rows={2}
          placeholder="默认提示词：仅擦除指定区域的货号文字（如 NO.JT999-2Q），其余描述文字/产品主体/Logo 一律原样保留。"
          onChange={(e) => onChange({ erasePrompt: e.target.value })}
        />
      </label>

        {draft.type === 'dashscope' ? (
          <>
            <h4 className="form-section">阿里云百炼（DashScope 原生接口）</h4>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">百炼模型预设</span>
                <select
                  value=""
                  onChange={(e) => {
                    const p = DASHSCOPE_PRESETS.find((x) => x.key === e.target.value)
                    if (p) onChange({ model: p.model })
                  }}
                >
                  <option value="">— 选择模型 —</option>
                  {DASHSCOPE_PRESETS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Qwen-Image 走百炼原生接口（不支持 OpenAI 兼容）；模型 ID 以百炼控制台最新为准
                </span>
              </label>
              <Field
                label="API Key（sk- 开头）"
                value={draft.apiKey ?? ''}
                onChange={setStr('apiKey')}
                required
                type="password"
              />
              <Field label="model" value={draft.model ?? ''} onChange={setStr('model')} required placeholder="qwen-image" />
              <label className="field">
                <span className="field-label">生成比例</span>
                <select
                  value={draft.aspectRatio ?? '1:1'}
                  onChange={(e) => onChange({ aspectRatio: e.target.value, size: '' })}
                >
                  <option value="">自定义（按下方像素）</option>
                  {['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <span className="field-hint">比例会换算为百炼支持的尺寸（如 1:1 → 1024*1024）</span>
              </label>
            </div>
            <details className="form-advanced">
              <summary>高级配置（自定义像素尺寸）</summary>
              <div className="form-grid">
                <Field
                  label="size（像素，宽*高，填了以它为准）"
                  value={draft.size ?? ''}
                  onChange={(v) => onChange({ size: v.replace(/[xX×]/g, '*'), aspectRatio: '' })}
                  placeholder="如 1024*1024；留空时按生成比例换算"
                  hint="百炼尺寸格式为 宽*高；可选如 1024*1024 / 1280*720"
                />
              </div>
            </details>
          </>
        ) : (
          <>
            <h4 className="form-section">OpenAI 兼容配置</h4>
            <div className="form-grid">
              <Field label="baseUrl" value={draft.baseUrl ?? ''} onChange={setStr('baseUrl')} required placeholder="https://ark.cn-beijing.volces.com/api/v3" />
              <Field label="API Key" value={draft.apiKey ?? ''} onChange={setStr('apiKey')} required type="password" />
              <Field label="model" value={draft.model ?? ''} onChange={setStr('model')} required placeholder="seedream-5-0-lite" />
              <label className="field">
                <span className="field-label">生成比例</span>
                <select
                  value={draft.aspectRatio ?? ''}
                  onChange={(e) => onChange({ aspectRatio: e.target.value, size: '' })}
                >
                  <option value="">自定义（按下方像素）</option>
                  {['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '21:9'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  比例会换算为模型支持的像素档位发送（如 16:9 → 2560x1440）；选比例会自动清空下方自定义 size（二选一）
                </span>
              </label>
              <label className="field">
                <span className="field-label">请求风格</span>
                <select
                  value={draft.requestStyle ?? 'json'}
                  onChange={(e) => onChange({ requestStyle: e.target.value as ProviderConfig['requestStyle'] })}
                >
                  <option value="json">images/generations（JSON + base64，方舟 Ark / OpenAI / 硅基流动等）</option>
                  <option value="edits">images/edits（multipart，OpenAI 标准）</option>
                  <option value="chat">chat/completions（多模态，部分 OpenAI 兼容图像模型）</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">AI 水印</span>
                <select
                  value={draft.watermark === undefined ? '' : draft.watermark ? 'on' : 'off'}
                  onChange={(e) =>
                    onChange({
                      watermark: e.target.value === '' ? undefined : e.target.value === 'on'
                    })
                  }
                >
                  <option value="">跟随服务商（默认）</option>
                  <option value="off">关闭（无可见水印）</option>
                  <option value="on">开启（可见 AI 标识）</option>
                </select>
                <span className="field-hint">仅部分模型支持；关闭可见水印后服务端仍会保留不可见元数据标识</span>
              </label>
            </div>
            <details className="form-advanced">
              <summary>高级配置（自定义像素尺寸 / 比例与尺寸二选一）</summary>
              <div className="form-grid">
                <Field
                  label="size（像素 WxH，填了以它为准）"
                  value={draft.size ?? ''}
                  onChange={(v) => onChange({ size: v.replace(/[*×X]/g, 'x'), aspectRatio: '' })}
                  placeholder="如 2048x2048；留空时按生成比例发送；支持 2048*2048 / 2048×2048"
                  hint="填写自定义像素会自动切换上方比例为「自定义」；该模型要求至少 1920×1920（3686400 像素），不足会报错"
                />
              </div>
            </details>
          </>
        )}
    </div>
  )
}

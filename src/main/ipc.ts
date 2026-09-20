import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, access, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { IPC, type AppSettings, type ExportTextRequest, type BalanceResult, type CacheInfo, type CleanResult, type EraseTextRequest, type EraseTextResponse, type LabelOptions, type LabelRunResult, type OcrDetectRequest, type OcrDetectResponse, type OcrRecognizeRequest, type OcrRecognizeResponse, type ProcessImageRequest, type ProcessImageResponse, type ProviderConfig, type QuoteOptions, type QuoteRunResult, type QuotaInfo } from '../shared/types'
import { createProvider } from './api'
import { deleteProvider, getActiveProvider, getProviderForRole, loadProviders, saveProvider, setActiveProvider } from './providers'
import { clearAllResultCache, cleanResultCache, getResultCacheInfo, beginActiveTask } from './cache'
import { getQuota, getSettings, isQuotaExhausted, saveSettings, setQuotaLimit, bumpQuotaUsage } from './settings'

/** 目标文件已存在时自动追加序号（如 photo.png → photo (1).png），避免批量导出互相覆盖 */
async function uniqueTargetPath(dir: string, name: string): Promise<string> {
  const base = join(dir, name)
  try {
    await access(base)
  } catch {
    return base
  }
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
}

function resultDir(): string {
  return join(app.getPath('userData'), 'processed')
}

/** 已授权的输入图片路径（来自文件对话框 / 拖拽登记），仅内存保存。统一存归一化后的 key */
const authorizedPaths = new Set<string>()

/**
 * 已授权的目录（来自文件夹对话框）。
 * 批量货号处理 / 报价表是「整个文件夹」级的操作，逐文件授权不现实，
 * 因此用户显式选中的文件夹作为一个可读写的信任根。
 */
const authorizedDirs = new Set<string>()

/**
 * 路径归一化：分隔符统一为 /（asset:// 解码为 C:/... 而对话框/拖拽登记为 C:\...）；
 * Windows 下忽略大小写（NTFS 默认大小写不敏感，C:\Foo.png 与 c:\foo.png 是同一文件）。
 */
function normPath(p: string): string {
  const n = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** 路径是否在授权集合内（含已授权目录、userData/processed 结果目录），供 processImage / exportImage / asset:// 共用 */
export function isAuthorizedInput(path: string): boolean {
  const key = normPath(path)
  if (authorizedPaths.has(key)) return true
  // userData/processed 内的结果文件允许再次处理
  const ndir = normPath(resultDir())
  if (key.startsWith(ndir + '/')) return true
  // 用户显式选过的文件夹：其下所有文件都视为已授权
  for (const dir of authorizedDirs) {
    if (key === dir || key.startsWith(dir + '/')) return true
  }
  return false
}

/** 登记授权目录（文件夹对话框 / 路径框手动输入后由主进程校验时调用） */
export function authorizeDir(path: string): void {
  if (path) authorizedDirs.add(normPath(path))
}

/** 登记授权路径（文件对话框 / 拖拽路径，支持单个或多个） */
export function authorizePath(path: string | string[]): void {
  const add = (p: string): void => {
    if (p) authorizedPaths.add(normPath(p))
  }
  if (typeof path === 'string') {
    add(path)
  } else if (Array.isArray(path)) {
    for (const p of path) {
      if (typeof p === 'string') add(p)
    }
  }
}

function assertHttpEndpoint(url: string | undefined, label: string): void {
  if (!url) return
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`${label} 不是合法 URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label} 协议仅支持 http/https：${u.protocol}`)
  }
}

// --------------------------------------------------------------------------- 货号批量处理 / 报价表

/** 当前正在跑的批量任务（用于「停止」按钮） */
let activeLabelRun: { cancelled: boolean } | null = null

const labelFail = (error: string): LabelRunResult => ({
  ok: false,
  error,
  outputDir: '',
  total: 0,
  okCount: 0,
  warnCount: 0,
  notFoundCount: 0,
  errorCount: 0,
  renamedCount: 0,
  items: [],
  dryRun: false
})

async function handleLabelRun(
  opts: LabelOptions,
  dryRun: boolean,
  onProgress: ((p: import('../shared/types').LabelProgress) => void) | null
): Promise<LabelRunResult> {
  try {
    if (!opts?.inputDir || !isAuthorizedInput(opts.inputDir)) {
      return { ...labelFail('未授权的输入文件夹，请用「选择…」重新指定（或先拖拽导入过该目录的图片）'), dryRun }
    }
    const outputDir = opts.outputDir?.trim() || join(opts.inputDir, '_已处理')
    if (!isAuthorizedInput(outputDir)) {
      return { ...labelFail('未授权的输出文件夹，请用「选择…」指定（留空则输出到 输入文件夹\\_已处理）'), dryRun }
    }
    if (!['replace', 'erase', 'custom'].includes(opts.mode)) {
      return { ...labelFail('未知的处理方式：' + String(opts.mode)), dryRun }
    }
    const token = { cancelled: false }
    if (!dryRun) activeLabelRun = token
    const { runLabelBatch } = await import('./api/labelBatch')
    const result = await runLabelBatch({
      ...opts,
      outputDir,
      dryRun,
      onProgress: onProgress ?? undefined,
      shouldAbort: () => token.cancelled
    })
    return { ...result, dryRun }
  } catch (err) {
    return { ...labelFail(err instanceof Error ? err.message : String(err)), dryRun }
  } finally {
    if (!dryRun) activeLabelRun = null
  }
}

async function handleQuoteRun(opts: QuoteOptions, dryRun: boolean): Promise<QuoteRunResult> {
  try {
    if (!opts?.xlsxPath || !isAuthorizedInput(opts.xlsxPath)) {
      return { ok: false, dryRun, error: '未授权的报价表路径，请用「选择…」重新指定' }
    }
    if (!opts.imageDir || !isAuthorizedInput(opts.imageDir)) {
      return { ok: false, dryRun, error: '未授权的新图片文件夹，请用「选择…」指定' }
    }
    const inplace = opts.inplace === true
    const outputPath = inplace
      ? opts.xlsxPath
      : opts.outputPath?.trim() || join(dirname(opts.xlsxPath), basename(opts.xlsxPath, extname(opts.xlsxPath)) + '_新.xlsx')
    if (!isAuthorizedInput(outputPath)) {
      return { ok: false, dryRun, error: '未授权的输出路径，请用「选择…」指定保存位置' }
    }
    const { patchXlsx, verifyXlsxBuffer } = await import('./api/xlsxPatch')
    const res = await patchXlsx({
      xlsxPath: opts.xlsxPath,
      imageDir: opts.imageDir,
      oldPrefix: opts.oldPrefix ?? '',
      newPrefix: opts.newPrefix ?? '',
      recursive: opts.recursive === true,
      quality: opts.quality ?? 92,
      dryRun
    })
    if (dryRun) return { ok: true, dryRun, plan: res.plan }

    if (inplace) {
      const bk = opts.xlsxPath + '.bak'
      try {
        await access(bk)
      } catch {
        await copyFile(opts.xlsxPath, bk)
      }
    }
    await writeFile(outputPath, res.buffer!)
    const issues = verifyXlsxBuffer(res.buffer!, opts.oldPrefix ?? '', opts.newPrefix ?? '')
    return {
      ok: issues.length === 0,
      dryRun,
      outputPath,
      bytes: res.buffer!.length,
      plan: res.plan,
      issues
    }
  } catch (err) {
    return { ok: false, dryRun, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.providersGetAll, async (): Promise<ProviderConfig[]> => loadProviders())
  ipcMain.handle(IPC.providersSave, async (_e, config: ProviderConfig): Promise<ProviderConfig[]> => saveProvider(config))
  ipcMain.handle(IPC.providersDelete, async (_e, id: string): Promise<ProviderConfig[]> => deleteProvider(id))
  ipcMain.handle(IPC.providersSetActive, async (_e, id: string): Promise<ProviderConfig[]> => setActiveProvider(id))
  ipcMain.handle(IPC.providersTest, async (_e, config: ProviderConfig): Promise<{ ok: boolean; message: string }> => {
    try {
      assertHttpEndpoint(config.baseUrl, 'baseUrl')
      assertHttpEndpoint(config.endpoint, 'endpoint')
      const provider = createProvider(config)
      return provider.testConnection()
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.providersQueryBalance, async (): Promise<BalanceResult> => {
    try {
      const active = await getActiveProvider()
      if (!active) return { ok: false, message: '未配置任何 API provider，请先在设置中配置' }
      return createProvider(active).queryBalance()
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // 拖拽/粘贴导入的路径由 preload 登记授权
  ipcMain.on(IPC.pathsAuthorize, (_e, p: unknown) => {
    authorizePath(p as string)
  })

  ipcMain.handle(IPC.processImage, async (_e, req: ProcessImageRequest): Promise<ProcessImageResponse> => {
    const release = beginActiveTask()
    try {
      if (!isAuthorizedInput(req.inputPath)) {
        return { ok: false, error: '未授权的图片路径，请通过文件选择或拖拽导入图片' }
      }
      // 纯算法：画布扩展 / 抠白底（本地像素处理，无需 API、不消耗额度）
      if (req.method === 'local') {
        if (req.canvas) {
          const { extendCanvas } = await import('./api/canvasExtend')
          const result = await extendCanvas({
            inputPath: req.inputPath,
            outputDir: resultDir(),
            canvas: req.canvas
          })
          return { ok: true, outputPath: result.outputPath }
        }
        const { makeWhiteBackgroundLocal } = await import('./api/whiteBgLocal')
        const result = await makeWhiteBackgroundLocal({
          inputPath: req.inputPath,
          outputDir: resultDir()
        })
        return { ok: true, outputPath: result.outputPath }
      }
      // 白底图走「white-bg」用途的 provider（可与擦除货号分开配置）
      const active = await getProviderForRole('white-bg')
      if (!active) return { ok: false, error: '未配置白底图 API，请先在设置中配置（通用或白底图专用）' }
      // 额度检查：达到本月上限时拦截（limit=0 不限制）
      if (await isQuotaExhausted()) {
        const q = await getQuota()
        return { ok: false, error: `本月额度已用完（${q.used}/${q.limit}），可在 API 设置中调整上限`, quota: q }
      }
      const provider = createProvider(active)
      const result = await provider.makeWhiteBackground({
        inputPath: req.inputPath,
        outputDir: resultDir()
      })
      // 生成成功：记录一次用量并返回最新额度
      const quota = await bumpQuotaUsage()
      return { ok: true, outputPath: result.outputPath, sourceUrl: result.sourceUrl, quota }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      release()
    }
  })


  ipcMain.handle(IPC.dialogPickImage, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: '选择玩具产品图',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const filePath = res.filePaths[0]
    authorizedPaths.add(normPath(filePath))
    return filePath
  })

  ipcMain.handle(IPC.dialogPickImages, async (e): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: '选择玩具产品图（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled) return []
    for (const p of res.filePaths) authorizedPaths.add(normPath(p))
    return res.filePaths
  })

  ipcMain.handle(IPC.exportImagesToDir, async (e, sourcePaths: string[]): Promise<string | null> => {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return null
    // 仅允许导出已授权的处理结果
    if (!sourcePaths.every((p) => isAuthorizedInput(p))) {
      throw new Error('未授权的导出路径')
    }
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    for (const src of sourcePaths) {
      // 目标同名文件自动唯一化（不同目录的同名结果互不覆盖）
      const target = await uniqueTargetPath(dir, basename(src))
      await copyFile(src, target)
    }
    return dir
  })

  ipcMain.handle(IPC.exportImage, async (e, sourcePath: string): Promise<string | null> => {    // 仅允许导出已授权的处理结果，防止任意文件被复制到用户指定位置
    if (!isAuthorizedInput(sourcePath)) {
      throw new Error('未授权的导出路径')
    }
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
      title: '导出白底图',
      defaultPath: `white_bg_${Date.now()}.png`,
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP 图片', extensions: ['webp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return null
    await copyFile(sourcePath, res.filePath)
    return res.filePath
  })

  // ---------------------------------------------------------------- 货号批量处理（纯算法，零 API 成本）

  ipcMain.handle(
    IPC.dialogPickFolder,
    async (e, opts?: { title?: string; defaultPath?: string }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
        title: opts?.title ?? '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
        ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {})
      })
      if (res.canceled || !res.filePaths[0]) return null
      authorizeDir(res.filePaths[0])
      return res.filePaths[0]
    }
  )

  // 映射表：由主进程读文件并解析（渲程不需要通用文件读能力）
  ipcMain.handle(IPC.dialogPickMapping, async (e): Promise<import('../shared/types').MappingPickResult | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: '选择映射表（JSON）',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const p = res.filePaths[0]
    authorizedPaths.add(normPath(p))
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(p, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { path: p, error: '映射表必须是一个 JSON 对象，如 { "JT666-5": "NO.TJ666-5" }' }
      }
      const data: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        // 以 _ 开头的是说明性键（mapping.example.json 里的 "_说明"），不算映射条目
        if (k.startsWith('_')) continue
        if (typeof v === 'string' && v.trim()) data[k] = v
      }
      if (Object.keys(data).length === 0) return { path: p, error: '映射表里没有可用的条目（键不能以 _ 开头，值必须是非空字符串）' }
      return { path: p, data }
    } catch (err) {
      return { path: p, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.dialogPickXlsx, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: '选择报价表',
      properties: ['openFile'],
      filters: [
        { name: 'Excel 工作簿', extensions: ['xlsx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const p = res.filePaths[0]
    authorizedPaths.add(normPath(p))
    // 默认输出是「原表所在目录 / 原表名_新.xlsx」，所以把该目录一并作为信任根，
    // 否则用户选了表却被告知输出路径未授权。
    authorizeDir(dirname(p))
    return p
  })

  // 批量改货号：dryRun 只检测不写文件
  ipcMain.handle(IPC.labelPreview, async (_e, opts: LabelOptions): Promise<LabelRunResult> =>
    handleLabelRun(opts, true, null)
  )
  ipcMain.handle(IPC.labelRun, async (e, opts: LabelOptions): Promise<LabelRunResult> => {
    const sender = e.sender
    return handleLabelRun(opts, false, (p) => {
      try {
        sender.send(IPC.labelProgress, p)
      } catch {
        /* 窗口已关闭 */
      }
    })
  })
  ipcMain.handle(IPC.labelCancel, async (): Promise<boolean> => {
    if (activeLabelRun) activeLabelRun.cancelled = true
    return true
  })

  // ---------------------------------------------------------------- 报价表换图改货号

  ipcMain.handle(IPC.quotePreview, async (_e, opts: QuoteOptions): Promise<QuoteRunResult> =>
    handleQuoteRun(opts, true)
  )
  ipcMain.handle(IPC.quoteRun, async (_e, opts: QuoteOptions): Promise<QuoteRunResult> =>
    handleQuoteRun(opts, false)
  )

  // 导出纯文本（CSV / 报告）：内容由渲染进程生成，落盘位置由用户在弹出的保存框里决定
  ipcMain.handle(IPC.exportText, async (e, req: ExportTextRequest): Promise<string | null> => {
    if (!req || typeof req.content !== 'string' || typeof req.defaultName !== 'string') {
      throw new Error('导出内容无效')
    }
    if (req.content.length > 20 * 1024 * 1024) throw new Error('导出内容过大（上限 20MB）')
    // 只取文件名部分，避免建议路径里带目录分隔符把保存框引到别处
    const safe = basename(req.defaultName).replace(/[\\/:*?"<>|]/g, '_') || 'export.csv'
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
      title: '导出为',
      defaultPath: safe,
      filters: [
        { name: 'CSV 表格', extensions: ['csv'] },
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, req.content, 'utf8')
    return res.filePath
  })

  // 在系统文件管理器里打开结果目录（仅限已授权路径，避免打开任意位置）
  ipcMain.handle(IPC.shellOpenPath, async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (!p || !isAuthorizedInput(p)) return { ok: false, error: '未授权的路径' }
      const { shell } = await import('electron')
      const { stat } = await import('node:fs/promises')
      let target = p
      try {
        const st = await stat(p)
        if (st.isFile()) target = dirname(p)
      } catch {
        return { ok: false, error: '路径不存在' }
      }
      const err = await shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.settingsGet, (): Promise<AppSettings> => getSettings())
  ipcMain.handle(IPC.settingsSave, (_e, patch: Partial<AppSettings>): Promise<AppSettings> => saveSettings(patch))
  ipcMain.handle(IPC.quotaGet, (): Promise<QuotaInfo> => getQuota())
  ipcMain.handle(IPC.quotaSetLimit, (_e, monthlyLimit: number): Promise<QuotaInfo> => setQuotaLimit(monthlyLimit))

  ipcMain.handle(IPC.cacheInfo, (): Promise<CacheInfo> => getResultCacheInfo())
  // 清理 7 天前的过期结果
  ipcMain.handle(IPC.cacheClean, (): Promise<CleanResult> => cleanResultCache(7 * 24 * 60 * 60 * 1000))
  ipcMain.handle(IPC.cacheClearAll, (): Promise<CleanResult> => clearAllResultCache())
}
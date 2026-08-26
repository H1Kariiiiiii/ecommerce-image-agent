import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { copyFile, access } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { IPC, type AppSettings, type BalanceResult, type CacheInfo, type CleanResult, type EraseTextRequest, type EraseTextResponse, type OcrDetectRequest, type OcrDetectResponse, type OcrRecognizeRequest, type OcrRecognizeResponse, type ProcessImageRequest, type ProcessImageResponse, type ProviderConfig, type QuotaInfo } from '../shared/types'
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
 * 路径归一化：分隔符统一为 /（asset:// 解码为 C:/... 而对话框/拖拽登记为 C:\...）；
 * Windows 下忽略大小写（NTFS 默认大小写不敏感，C:\Foo.png 与 c:\foo.png 是同一文件）。
 */
function normPath(p: string): string {
  const n = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** 路径是否在授权集合内（含 userData/processed 结果目录），供 processImage / exportImage / asset:// 共用 */
export function isAuthorizedInput(path: string): boolean {
  const key = normPath(path)
  if (authorizedPaths.has(key)) return true
  // userData/processed 内的结果文件允许再次处理
  const ndir = normPath(resultDir())
  return key.startsWith(ndir + '/')
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

  // AI 擦除货号（走「erase」用途的 provider；本地定位 + AI inpaint 擦除，不叠新文字）
  ipcMain.handle(IPC.eraseTextAI, async (_e, req: EraseTextRequest): Promise<EraseTextResponse> => {
    const release = beginActiveTask()
    try {
      if (!isAuthorizedInput(req.inputPath)) {
        return { ok: false, error: '未授权的图片路径，请通过文件选择或拖拽导入图片' }
      }
      const eraseProvider = await getProviderForRole('erase')
      if (!eraseProvider) return { ok: false, error: '未配置擦除货号 API，请先在设置中配置（通用或擦除专用）' }
      if (!eraseProvider.model) return { ok: false, error: '未配置 model' }
      const provider = createProvider(eraseProvider)
      if (!provider.eraseTextWithAI) {
        return { ok: false, error: '当前 API 不支持区域擦除（需要 images/edits 接口）' }
      }
      if (await isQuotaExhausted()) {
        const q = await getQuota()
        return { ok: false, error: `本月额度已用完（${q.used}/${q.limit}），可在 API 设置中调整上限`, quota: q }
      }
      // 定位区域（手动优先，否则 PP-OCR/Tesseract 自动定位）
      const { resolveRegion } = await import('./api/localErase')
      const { region, detectedText } = await resolveRegion(req.inputPath, {
        anchor: req.anchor,
        manualRegion: req.region
      })
      const result = await provider.eraseTextWithAI({
        inputPath: req.inputPath,
        region,
        outputDir: resultDir()
      })
      const quota = await bumpQuotaUsage()
      return { ok: true, outputPath: result.outputPath, detectedText, quota }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      release()
    }
  })

  // 整图 OCR 检测货号（本地免费，不耗 API 配额；供批量擦除自动定位）
  ipcMain.handle(IPC.ocrDetect, async (_e, req: OcrDetectRequest): Promise<OcrDetectResponse> => {
    try {
      if (!isAuthorizedInput(req.inputPath)) {
        return { ok: false, error: '未授权的图片路径' }
      }
      const { detectGoodsNumberV2 } = await import('./api/ppocrDetect')
      const v2 = await detectGoodsNumberV2(req.inputPath, req.anchor)
      if (v2) {
        return { ok: true, text: v2.text, region: v2.region, confidence: v2.confidence }
      }
      return {
        ok: false,
        error: '未识别到货号。可尝试输入货号开头字母作锚点，或在图片上手动框选货号区域'
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 指定区域文字识别（PP-OCR 本地推理；批量复用区域时取原文字，供前缀替换保留数字）
  ipcMain.handle(IPC.ocrRecognize, async (_e, req: OcrRecognizeRequest): Promise<OcrRecognizeResponse> => {
    try {
      if (!isAuthorizedInput(req.inputPath)) {
        return { ok: false, error: '未授权的图片路径' }
      }
      if (!req.region || req.region.width <= 0 || req.region.height <= 0) {
        return { ok: false, error: '区域无效' }
      }
      const { recognizeRegionText } = await import('./api/ppocrRec')
      const res = await recognizeRegionText(req.inputPath, req.region)
      if (!res.text.trim()) {
        return { ok: false, error: '未识别到文字' }
      }
      return { ok: true, text: res.text.trim(), confidence: res.confidence }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 纯本地改货号（零 API 成本：OCR 定位 + 背景填充擦除 + 文字叠加）
  // 纯本地去掉货号（零 API：OCR 定位 + 背景填充擦除，不叠加新文字）
  ipcMain.handle(IPC.eraseTextLocal, async (_e, req: EraseTextRequest): Promise<EraseTextResponse> => {
    try {
      if (!isAuthorizedInput(req.inputPath)) {
        return { ok: false, error: '未授权的图片路径' }
      }
      const { localEraseText } = await import('./api/localErase')
      const result = await localEraseText({
        inputPath: req.inputPath,
        outputDir: resultDir(),
        anchor: req.anchor || undefined,
        region: req.region
      })
      return { ok: true, outputPath: result.outputPath, detectedText: result.detectedText, quota: await getQuota() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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

  ipcMain.handle(IPC.settingsGet, (): Promise<AppSettings> => getSettings())
  ipcMain.handle(IPC.settingsSave, (_e, patch: Partial<AppSettings>): Promise<AppSettings> => saveSettings(patch))
  ipcMain.handle(IPC.quotaGet, (): Promise<QuotaInfo> => getQuota())
  ipcMain.handle(IPC.quotaSetLimit, (_e, monthlyLimit: number): Promise<QuotaInfo> => setQuotaLimit(monthlyLimit))

  ipcMain.handle(IPC.cacheInfo, (): Promise<CacheInfo> => getResultCacheInfo())
  // 清理 7 天前的过期结果
  ipcMain.handle(IPC.cacheClean, (): Promise<CleanResult> => cleanResultCache(7 * 24 * 60 * 60 * 1000))
  ipcMain.handle(IPC.cacheClearAll, (): Promise<CleanResult> => clearAllResultCache())
}

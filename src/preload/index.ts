import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type AppSettings,
  type BalanceResult,
  type CacheInfo,
  type CleanResult,
  type ExportTextRequest,
  type ProcessImageRequest,
  type LabelOptions,
  type LabelProgress,
  type LabelRunResult,
  type MappingPickResult,
  type ProcessImageResponse,
  type ProviderConfig,
  type QuoteOptions,
  type QuoteRunResult,
  type QuotaInfo
} from '../shared/types'

const api = {
  /** 拖拽/粘贴获得的 File 对象 → 本地绝对路径（Electron 专用），同时向主进程登记授权 */
  getPathForFile: (file: File): string => {
    const p = webUtils.getPathForFile(file)
    if (p) ipcRenderer.send(IPC.pathsAuthorize, p)
    return p
  },
  /** 批量：多个 File → 绝对路径数组，全部登记授权 */
  getPathsForFiles: (files: File[]): string[] => {
    const paths: string[] = []
    for (const f of files) {
      const p = webUtils.getPathForFile(f)
      if (p) paths.push(p)
    }
    if (paths.length > 0) ipcRenderer.send(IPC.pathsAuthorize, paths)
    return paths
  },
  getProviders: (): Promise<ProviderConfig[]> => ipcRenderer.invoke(IPC.providersGetAll),
  saveProvider: (config: ProviderConfig): Promise<ProviderConfig[]> =>
    ipcRenderer.invoke(IPC.providersSave, config),
  deleteProvider: (id: string): Promise<ProviderConfig[]> =>
    ipcRenderer.invoke(IPC.providersDelete, id),
  setActiveProvider: (id: string): Promise<ProviderConfig[]> =>
    ipcRenderer.invoke(IPC.providersSetActive, id),
  testProvider: (config: ProviderConfig): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.providersTest, config),
  queryBalance: (): Promise<BalanceResult> => ipcRenderer.invoke(IPC.providersQueryBalance),
  processImage: (req: ProcessImageRequest): Promise<ProcessImageResponse> =>
    ipcRenderer.invoke(IPC.processImage, req),
  pickImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickImage),
  pickImages: (): Promise<string[]> => ipcRenderer.invoke(IPC.dialogPickImages),
  exportImage: (sourcePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportImage, sourcePath),
  exportImagesToDir: (sourcePaths: string[]): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportImagesToDir, sourcePaths),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSave, patch),
  getQuota: (): Promise<QuotaInfo> => ipcRenderer.invoke(IPC.quotaGet),
  setQuotaLimit: (monthlyLimit: number): Promise<QuotaInfo> =>
    ipcRenderer.invoke(IPC.quotaSetLimit, monthlyLimit),
  getCacheInfo: (): Promise<CacheInfo> => ipcRenderer.invoke(IPC.cacheInfo),
  cleanCache: (): Promise<CleanResult> => ipcRenderer.invoke(IPC.cacheClean),
  clearCache: (): Promise<CleanResult> => ipcRenderer.invoke(IPC.cacheClearAll),

  // ---------- 货号批量处理（纯算法，零 API 成本） ----------
  /** 选择文件夹（自动登记授权，其下文件可用于预览与批量处理） */
  pickFolder: (opts?: { title?: string; defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC.dialogPickFolder, opts),
  /** 选择报价表 .xlsx */
  pickXlsx: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickXlsx),
  /** 选择并解析 custom 模式映射表 JSON */
  pickMapping: (): Promise<MappingPickResult | null> => ipcRenderer.invoke(IPC.dialogPickMapping),
  /** 试跑：只检测不写文件 */
  labelPreview: (opts: LabelOptions): Promise<LabelRunResult> =>
    ipcRenderer.invoke(IPC.labelPreview, opts),
  /** 正式处理（进度通过 onLabelProgress 推送） */
  labelRun: (opts: LabelOptions): Promise<LabelRunResult> => ipcRenderer.invoke(IPC.labelRun, opts),
  /** 请求中止当前批量任务 */
  labelCancel: (): Promise<boolean> => ipcRenderer.invoke(IPC.labelCancel),
  /** 订阅批量进度，返回取消订阅函数 */
  onLabelProgress: (cb: (p: LabelProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: LabelProgress): void => cb(p)
    ipcRenderer.on(IPC.labelProgress, listener)
    return () => ipcRenderer.removeListener(IPC.labelProgress, listener)
  },

  // ---------- 报价表换图改货号 ----------
  quotePreview: (opts: QuoteOptions): Promise<QuoteRunResult> =>
    ipcRenderer.invoke(IPC.quotePreview, opts),
  quoteRun: (opts: QuoteOptions): Promise<QuoteRunResult> => ipcRenderer.invoke(IPC.quoteRun, opts),

  /** 在系统文件管理器里打开结果目录或文件所在目录 */
  openPath: (p: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.shellOpenPath, p),

  /** 导出纯文本（弹保存框，返回实际保存路径；取消返回 null） */
  exportText: (req: ExportTextRequest): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportText, req)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)

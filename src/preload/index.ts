import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type AppSettings,
  type BalanceResult,
  type CacheInfo,
  type CleanResult,
  type EraseTextRequest,
  type EraseTextResponse,
  type OcrDetectRequest,
  type OcrDetectResponse,
  type OcrRecognizeRequest,
  type OcrRecognizeResponse,
  type ProcessImageRequest,
  type ProcessImageResponse,
  type ProviderConfig,
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
  ocrDetect: (req: OcrDetectRequest): Promise<OcrDetectResponse> =>
    ipcRenderer.invoke(IPC.ocrDetect, req),
  ocrRecognize: (req: OcrRecognizeRequest): Promise<OcrRecognizeResponse> =>
    ipcRenderer.invoke(IPC.ocrRecognize, req),
  eraseTextAI: (req: EraseTextRequest): Promise<EraseTextResponse> =>
    ipcRenderer.invoke(IPC.eraseTextAI, req),
  eraseTextLocal: (req: EraseTextRequest): Promise<EraseTextResponse> =>
    ipcRenderer.invoke(IPC.eraseTextLocal, req),
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
  clearCache: (): Promise<CleanResult> => ipcRenderer.invoke(IPC.cacheClearAll)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)

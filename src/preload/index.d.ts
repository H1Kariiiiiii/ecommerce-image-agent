import type {
  AppSettings,
  BalanceResult,
  CacheInfo,
  CleanResult,
  EraseTextRequest,
  EraseTextResponse,
  OcrDetectRequest,
  OcrDetectResponse,
  OcrRecognizeRequest,
  OcrRecognizeResponse,
  ProcessImageRequest,
  ProcessImageResponse,
  ProviderConfig,
  QuotaInfo
} from '../shared/types'

declare global {
  interface Window {
    api: {
      /** 拖拽/粘贴获得的 File 对象 → 本地绝对路径 */
      getPathForFile(file: File): string
      /** 批量：多个 File → 绝对路径数组，全部登记授权 */
      getPathsForFiles(files: File[]): string[]
      getProviders(): Promise<ProviderConfig[]>
      saveProvider(config: ProviderConfig): Promise<ProviderConfig[]>
      deleteProvider(id: string): Promise<ProviderConfig[]>
      setActiveProvider(id: string): Promise<ProviderConfig[]>
      testProvider(config: ProviderConfig): Promise<{ ok: boolean; message: string }>
      queryBalance(): Promise<BalanceResult>
      processImage(req: ProcessImageRequest): Promise<ProcessImageResponse>
      ocrDetect(req: OcrDetectRequest): Promise<OcrDetectResponse>
      ocrRecognize(req: OcrRecognizeRequest): Promise<OcrRecognizeResponse>
      eraseTextAI(req: EraseTextRequest): Promise<EraseTextResponse>
      eraseTextLocal(req: EraseTextRequest): Promise<EraseTextResponse>
      pickImage(): Promise<string | null>
      pickImages(): Promise<string[]>
      exportImage(sourcePath: string): Promise<string | null>
      exportImagesToDir(sourcePaths: string[]): Promise<string | null>
      getSettings(): Promise<AppSettings>
      saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
      getQuota(): Promise<QuotaInfo>
      setQuotaLimit(monthlyLimit: number): Promise<QuotaInfo>
      getCacheInfo(): Promise<CacheInfo>
      cleanCache(): Promise<CleanResult>
      clearCache(): Promise<CleanResult>
    }
  }
}

export {}

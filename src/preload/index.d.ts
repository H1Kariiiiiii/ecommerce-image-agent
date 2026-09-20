import type {
  AppSettings,
  BalanceResult,
  CacheInfo,
  CleanResult,
  ExportTextRequest,
  ProcessImageRequest,
  LabelOptions,
  LabelProgress,
  LabelRunResult,
  MappingPickResult,
  ProcessImageResponse,
  ProviderConfig,
  QuoteOptions,
  QuoteRunResult,
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
      /** 选择文件夹（自动登记授权） */
      pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>
      /** 选择报价表 .xlsx */
      pickXlsx(): Promise<string | null>
      /** 选择并解析 custom 模式映射表 JSON */
      pickMapping(): Promise<MappingPickResult | null>
      /** 批量改货号：试跑（只检测不写文件） */
      labelPreview(opts: LabelOptions): Promise<LabelRunResult>
      /** 批量改货号：正式处理 */
      labelRun(opts: LabelOptions): Promise<LabelRunResult>
      /** 请求中止当前批量任务 */
      labelCancel(): Promise<boolean>
      /** 订阅批量进度，返回取消订阅函数 */
      onLabelProgress(cb: (p: LabelProgress) => void): () => void
      /** 报价表：试跑（只看计划） */
      quotePreview(opts: QuoteOptions): Promise<QuoteRunResult>
      /** 报价表：正式处理 */
      quoteRun(opts: QuoteOptions): Promise<QuoteRunResult>
      /** 在系统文件管理器里打开结果目录 */
      openPath(p: string): Promise<{ ok: boolean; error?: string }>
      /** 导出纯文本（弹保存框，返回实际保存路径；取消返回 null） */
      exportText(req: ExportTextRequest): Promise<string | null>
    }
  }
}

export {}

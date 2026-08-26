/**
 * 共享类型定义：main / preload / renderer 三端共用。
 */

/** Provider 类型：OpenAI 兼容 / 火山视觉智能（旧）/ 阿里百炼 DashScope（原生） */
export type ProviderType = 'volcano-cv' | 'openai-compatible' | 'dashscope'

/** 签名算法版本：官方 SDK 默认旧版 HMAC-SHA256；新版 VOLCENGINE-HMAC-SHA256 用于 2023-12-01 之后的新接口 */
export type SignVersion = 'HMAC-SHA256' | 'VOLCENGINE-HMAC-SHA256'

/** Provider 用途：白底图 / 擦除货号（AI）/ 两者通用 */
export type ProviderRole = 'white-bg' | 'erase' | 'both'

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  /** 是否为当前激活 provider */
  active?: boolean
  /** 用途：白底图专用 / 擦除货号专用 / 通用（默认 both，兼容旧配置） */
  role?: ProviderRole

  // ---------- 通用 ----------
  /** 生成白底图的提示词（针对使用 prompt 的接口） */
  prompt?: string
  /** 擦除货号专用提示词（AI 擦除时使用；留空用内置默认：只擦货号文字，其他描述文字/主体不动） */
  erasePrompt?: string

  // ---------- volcano-cv：签名与请求 ----------
  /** 接口地址，如 https://visual.volcengineapi.com */
  endpoint?: string
  accessKey?: string
  secretKey?: string
  /** 如 cn-north-1 */
  region?: string
  /** 如 cv */
  service?: string
  /** 如 2022-08-31 */
  version?: string
  signVersion?: SignVersion
  /** 提交任务的 Action，如 CVSubmitTask */
  action?: string
  /** 轮询状态的 Action，如 CVGetResult */
  pollAction?: string
  /** 算法 req_key，如 seedream_5_0_lite（按实际文档填写） */
  reqKey?: string
  /**
   * 提交任务的 body JSON 模板（含占位符 {reqKey} {imageBase64} {imageDataUri} {prompt}），
   * 不填时使用视觉智能 CV 接口默认结构。
   */
  submitBodyTemplate?: string
  /** 轮询 body JSON 模板（占位符 {reqKey} {taskId}），不填时使用 CVGetResult 默认结构 */
  pollBodyTemplate?: string
  /** 任务 id 在提交响应中的点分路径，如 Result.Data.TaskId */
  taskIdPath?: string
  /** 任务状态在轮询响应中的点分路径，如 Result.Data.Status */
  statusPath?: string
  /** 视为成功的状态值 */
  successStatus?: string[]
  /** 失败状态值（可选，用于提前终止） */
  failStatus?: string[]
  /** 结果图片 URL 在轮询响应中的点分路径，支持数组索引如 Result.Data.ImageUrls[0] */
  resultUrlPath?: string
  pollIntervalMs?: number
  maxPollAttempts?: number
  timeoutMs?: number

  // ---------- openai-compatible / Ark ----------
  /** Bearer API Key */
  apiKey?: string
  /** 基础地址，如 https://ark.cn-beijing.volces.com/api/v3 或 https://api.openai.com/v1 */
  baseUrl?: string
  /** 模型名，如 seedream-5-0-lite / doubao-seedream-4-0-250828 / gpt-image-1 */
  model?: string
  /** 输出尺寸，如 2048x2048 / 1024x1024 / auto */
  size?: string
  /** 生成比例（方舟 seedream 系列 aspect_ratio 参数）：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 2:3 / 3:2 / 21:9 */
  aspectRatio?: string
  /**
   * 尺寸规则档：决定「比例 → 像素」换算表、尺寸参数名与像素限制。
   * seedream（默认）/ gpt-image-1 / gpt-image-2 / glm-image / cogview-4 / qwen-image-2 / qwen-image-max / siliconflow-qwen / kolors / flux
   */
  sizeProfile?: string
  /** 是否加显式 AI 水印（仅 openai-compatible 生效；缺省跟随服务商默认） */
  watermark?: boolean
  /**
   * 请求风格：
   * - edits    -> POST {baseUrl}/images/edits（multipart/form-data，OpenAI 标准）
   * - json     -> POST {baseUrl}/images/generations（JSON body，image 字段传 base64，兼容火山方舟 Ark）
   */
  /** 请求风格：images/generations（json）/ images/edits（multipart）/ chat/completions（多模态） */
  requestStyle?: 'edits' | 'json' | 'chat'
}

export interface MakeWhiteBackgroundOptions {
  /** 源图片本地路径 */
  inputPath: string
  /** 结果保存目录 */
  outputDir: string
}

export interface MakeWhiteBackgroundResult {
  /** 结果图片本地路径 */
  outputPath: string
  mimeType: string
  /** 结果原始 URL（可选） */
  sourceUrl?: string
}

// ---------- 擦除货号：区域编辑 ----------

/** 图片上的归一化矩形选区（0~1，相对于图片原始尺寸） */
export interface TextRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface BalanceResult {
  ok: boolean
  message: string
  /** 剩余可用（金额，按服务商币种） */
  available?: number
  /** 已用 */
  used?: number
  /** 总额 */
  granted?: number
}

export interface ApiProvider {
  readonly config: ProviderConfig
  makeWhiteBackground(opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult>
  /** AI 擦除指定区域内的文字（inpainting），不叠加新文字 */
  eraseTextWithAI?(opts: {
    inputPath: string
    region: TextRegion
    outputDir: string
  }): Promise<MakeWhiteBackgroundResult>
  /** 轻量连通性测试 */
  testConnection(): Promise<{ ok: boolean; message: string }>
  /** 查询余额/额度（服务商不支持时返回 ok:false 与说明） */
  queryBalance(): Promise<BalanceResult>
}

// ---------- IPC 通道名 ----------
export const IPC = {
  providersGetAll: 'providers:getAll',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  providersSetActive: 'providers:setActive',
  providersTest: 'providers:test',
  providersQueryBalance: 'providers:queryBalance',
  pathsAuthorize: 'paths:authorize',
  processImage: 'process:image',
  eraseTextAI: 'erase:textAI',
  eraseTextLocal: 'erase:textLocal',
  ocrDetect: 'ocr:detect',
  ocrRecognize: 'ocr:recognize',
  dialogPickImage: 'dialog:pickImage',
  dialogPickImages: 'dialog:pickImages',
  exportImage: 'dialog:exportImage',
  exportImagesToDir: 'dialog:exportImagesToDir',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  quotaGet: 'quota:get',
  quotaSetLimit: 'quota:setLimit',
  cacheInfo: 'cache:info',
  cacheClean: 'cache:clean',
  cacheClearAll: 'cache:clearAll'
} as const

/** 应用设置（userData/settings.json） */
export interface AppSettings {
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: 'system' | 'light' | 'dark'
  /** 本地额度统计：每月上限与已用量（0 = 不限） */
  quota?: {
    monthlyLimit: number
    used: number
    /** 统计月份，格式 YYYY-MM */
    yearMonth: string
  }
}

/** 额度信息（返回给渲染进程展示） */
export interface QuotaInfo {
  used: number
  limit: number
  yearMonth: string
}

/** 结果缓存占用信息 */
export interface CacheInfo {
  fileCount: number
  sizeBytes: number
}

/** 清理结果 */
export interface CleanResult {
  removedCount: number
  freedBytes: number
}

export interface ProcessImageRequest {
  inputPath: string
  /** ai = API 生成白底图（消耗额度）；local = 纯算法抠白底（免费，不消耗额度） */
  method?: 'ai' | 'local'
  /** 纯算法无损画布扩展（method=local 时生效；提供后走画布扩展而非抠白底） */
  canvas?: {
    /** 目标比例（宽/高），如 { w: 4, h: 3 } */
    ratio: { w: number; h: number }
    /** 背景色（CSS 颜色，默认纯白） */
    background?: string
    /** pad = 原图不变四周补边 / fit = 等比缩放适配居中 */
    strategy: 'pad' | 'fit'
  }
}

export interface ProcessImageResponse {
  ok: boolean
  /** 结果图片本地路径（临时目录） */
  outputPath?: string
  sourceUrl?: string
  error?: string
  /** 本次处理后的额度信息（有额度上限时用于展示） */
  quota?: QuotaInfo
}

/** OCR 整图货号检测（本地免费，不消耗 API 配额） */
export interface OcrDetectRequest {
  inputPath: string
  /** 可选锚点：优先匹配以该前缀开头的货号（如 TOY） */
  anchor?: string
}

/** 擦除货号请求（ai = AI inpainting 擦除，local = 纯本地色差擦除） */
export interface EraseTextRequest {
  inputPath: string
  /** 旧前缀锚点（可选，帮助 OCR 定位） */
  anchor?: string
  /** 手动框选区域（可选，优先使用，跳过 OCR 定位） */
  region?: TextRegion
}

export interface EraseTextResponse {
  ok: boolean
  outputPath?: string
  detectedText?: string
  error?: string
  quota?: QuotaInfo
}

export interface OcrDetectResponse {
  ok: boolean
  /** 识别到的货号文字（如 TOY-001） */
  text?: string
  /** 归一化选区（0~1），可直接作为编辑 region */
  region?: TextRegion
  confidence?: number
  error?: string
  /** 诊断信息：OCR 识别到的所有词（未命中时供排查） */
  rawWords?: string[]
  /** 诊断信息：OCR 识别到的所有整行文本 */
  rawLines?: string[]
}

/** 指定区域文字识别（PP-OCR，本地免费；批量复用区域时取原文字用） */
export interface OcrRecognizeRequest {
  inputPath: string
  region: TextRegion
}

export interface OcrRecognizeResponse {
  ok: boolean
  text?: string
  confidence?: number
  error?: string
}

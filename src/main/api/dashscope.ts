import { downloadToFile, uniqueResultPath } from './util'
import type {
  ApiProvider,
  BalanceResult,
  MakeWhiteBackgroundOptions,
  MakeWhiteBackgroundResult,
  ProviderConfig,
  TextRegion
} from '../../shared/types'

/**
 * 阿里云百炼（DashScope）原生接口 Provider。
 *
 * 注意：阿里云官方明确 Qwen-Image 等图像生成模型**不支持 OpenAI 兼容模式**，
 * 只能走 DashScope 原生接口，因此单独实现本 Provider。
 *
 * 接口（同步请求，非任务轮询）：
 * POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * Authorization: Bearer sk-xxx
 * {
 *   "model": "qwen-image",
 *   "input": { "prompt": "..." },
 *   "parameters": { "size": "1024*1024", "n": 1 }
 * }
 * 响应：{ "output": { "results": [{ "url": "https://..." }] } }
 */

const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

const DEFAULT_PROMPT = '将商品主体从背景中完整抠出，替换为纯白色背景（#FFFFFF），保持商品形状、颜色与细节不变，边缘干净自然，无阴影无倒影。'

/** Qwen-Image 支持的尺寸（百炼文档：1024*1024 / 720*1280 / 1280*720 等） */
const QWEN_IMAGE_SIZES: Record<string, string> = {
  '1:1': '1024*1024',
  '16:9': '1280*720',
  '9:16': '720*1280',
  '4:3': '1280*960',
  '3:4': '960*1280',
  '3:2': '1280*853',
  '2:3': '853*1280',
  '21:9': '1512*648'
}

export class DashScopeProvider implements ApiProvider {
  readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  private get apiKey(): string {
    const k = this.config.apiKey?.trim()
    if (!k) throw new Error('未配置 API Key（阿里云百炼 sk- 开头）')
    return k
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? 180_000
  }

  /** size（WxH 或 W*H）或比例 → DashScope 的 "宽*高" 格式 */
  private sizeParam(): string {
    const size = this.config.size
    if (size) {
      const m = /^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/.exec(size)
      if (m) return `${m[1]}*${m[2]}`
    }
    const ratio = this.config.aspectRatio ?? '1:1'
    return QWEN_IMAGE_SIZES[ratio] ?? '1024*1024'
  }

  private async request(body: unknown): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(DASHSCOPE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
      const text = await res.text()
      if (!res.ok) {
        // DashScope 错误格式：{ code, message, request_id }
        let detail = text.slice(0, 500)
        let code = ''
        try {
          const j = JSON.parse(text) as { message?: string; code?: string }
          detail = j.message ?? detail
          code = j.code ?? ''
          if (j.code) detail = `[${j.code}] ${detail}`
        } catch {
          /* 非 JSON 错误体 */
        }
        // 常见错误翻译成可读提示
        if (/InvalidApiKey/i.test(code) || /Invalid API-key/i.test(detail)) {
          throw new Error('API Key 无效：请确认已从百炼控制台创建 `sk-` 开头的 API Key，且复制完整、无多余空格')
        }
        if (/ModelNotFound|InvalidParameter.*model|model.*not.*found/i.test(code)) {
          throw new Error(`模型不存在或未开通：${this.config.model?.trim() || '(空)'}，请到百炼控制台「模型管理/开通管理」确认已开通该模型并核对模型 ID`)
        }
        if (/Permission|Forbidden/i.test(code)) {
          throw new Error('权限不足：该 API Key 可能没有本模型权限，请在百炼控制台核对模型授权')
        }
        throw new Error(`HTTP ${res.status}：${detail}`)
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`响应不是合法 JSON：${text.slice(0, 500)}`)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs}ms）：阿里云百炼`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async makeWhiteBackground(opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult> {
    const model = this.config.model?.trim()
    if (!model) throw new Error('未配置 model（如 qwen-image-3.0-pro / qwen-image-2.0 / qwen-image）')

    const prompt = this.config.prompt?.trim() ? this.config.prompt : DEFAULT_PROMPT
    // 新版百炼多模态格式：input.messages，content 数组 = [{ image } | { text }]
    // 原图以 base64 data URI 传入作为参考图（真正图生图/编辑，而非文生图）
    const messagesContent: Array<Record<string, unknown>> = [{ text: prompt }]
    const { fileToBase64, sniffImageMime } = await import('./util')
    const imgB64 = await fileToBase64(opts.inputPath)
    const mime = sniffImageMime(Buffer.from(imgB64, 'base64')) ?? 'image/png'
    messagesContent.unshift({ image: `data:${mime};base64,${imgB64}` })
    const body = {
      model,
      input: {
        messages: [{ role: 'user', content: messagesContent }]
      },
      parameters: {
        size: this.sizeParam(),
        n: 1
      }
    }
    const json = (await this.request(body)) as Record<string, unknown>

    // 解析响应中的图片（兼容多种官方格式）：
    // 1) output.choices[0].message.content: { image: url }（新版对象）
    // 2) output.choices[0].message.content: [{ image_url: {url} } | { text }]（chat 风格数组）
    // 3) output.results[0]: { url | b64_image }（旧版）
    const output = (json.output ?? {}) as {
      results?: Array<{ url?: string; b64_image?: string }>
      choices?: Array<{
        message?: { content?: unknown }
      }>
    }
    let url: string | undefined
    let b64: string | undefined

    const content = output.choices?.[0]?.message?.content
    if (content && typeof content === 'object') {
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          // 新版格式：数组元素直接带 image 字段（字符串 URL）
          if (typeof c.image === 'string' && c.image) {
            url = c.image
            break
          }
          const img = c.image_url as { url?: string } | undefined
          if (typeof img?.url === 'string' && img.url) {
            url = img.url
            break
          }
          if (typeof c.url === 'string' && c.url) {
            url = c.url
            break
          }
        }
      } else {
        const obj = content as Record<string, unknown>
        if (typeof obj.image === 'string') url = obj.image
        else if (typeof obj.url === 'string') url = obj.url
      }
    }

    if (!url) {
      const results = output.results
      const first = results?.[0]
      url = first?.url
      b64 = first?.b64_image
    }

    if (b64) {
      const buf = Buffer.from(b64, 'base64')
      const { mkdir, writeFile } = await import('node:fs/promises')
      const dest = uniqueResultPath(opts.outputDir, opts.inputPath, '.png')
      await mkdir(opts.outputDir, { recursive: true })
      await writeFile(dest, buf)
      return { outputPath: dest, mimeType: 'image/png' }
    }
    if (url) {
      const dest = uniqueResultPath(opts.outputDir, opts.inputPath, '.png')
      const outputPath = await downloadToFile(url, dest)
      return { outputPath, mimeType: 'application/octet-stream', sourceUrl: url }
    }
    throw new Error(`响应中没有图片结果：${JSON.stringify(json).slice(0, 300)}`)
  }

  /** 从百炼响应中提取图片（choices[].message.content[] 的 image / url / image_url） */
  private async extractResult(
    json: Record<string, unknown>,
    opts: { inputPath: string; outputDir: string }
  ): Promise<MakeWhiteBackgroundResult> {
    const output = (json.output ?? {}) as {
      results?: Array<{ url?: string; b64_image?: string }>
      choices?: Array<{ message?: { content?: unknown } }>
    }
    let url: string | undefined
    const content = output.choices?.[0]?.message?.content
    if (content && typeof content === 'object') {
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          if (typeof c.image === 'string' && c.image) { url = c.image; break }
          const img = c.image_url as { url?: string } | undefined
          if (typeof img?.url === 'string' && img.url) { url = img.url; break }
          if (typeof c.url === 'string' && c.url) { url = c.url; break }
        }
      } else {
        const obj = content as Record<string, unknown>
        if (typeof obj.image === 'string') url = obj.image
        else if (typeof obj.url === 'string') url = obj.url
      }
    }
    if (!url) {
      const first = output.results?.[0]
      url = first?.url
    }
    if (!url) throw new Error(`响应中没有图片结果：${JSON.stringify(json).slice(0, 300)}`)
    return this.downloadResult(url, opts)
  }

  /** 下载 URL 到本地结果文件 */
  private async downloadResult(url: string, opts: { inputPath: string; outputDir: string }): Promise<MakeWhiteBackgroundResult> {
    const dest = uniqueResultPath(opts.outputDir, opts.inputPath, '.png')
    const outputPath = await downloadToFile(url, dest)
    return { outputPath, mimeType: 'application/octet-stream', sourceUrl: url }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const model = this.config.model?.trim()
    if (!this.config.apiKey) return { ok: false, message: '缺少 API Key' }
    if (!model) return { ok: false, message: '缺少 model' }
    // 用与真实生成一致的「新版 messages 格式」验证连通性，避免旧格式被拒导致误报
    try {
      const content: Array<Record<string, unknown>> = [{ text: 'test' }]
      // 专用编辑模型（如 qwen-image-edit）要求消息必须带 1~3 张图，否则 400；
      // 测试连接时用一张内置纯色小图作为参考图
      if (/edit/i.test(model)) {
        const sharp = (await import('sharp')).default
        const png = await sharp({
          create: { width: 64, height: 64, channels: 3, background: '#f0f0f0' }
        })
          .png()
          .toBuffer()
        content.unshift({ image: `data:image/png;base64,${png.toString('base64')}` })
      }
      await this.request({
        model,
        input: {
          messages: [{ role: 'user', content }]
        },
        parameters: { size: '1024*1024', n: 1 }
      })
      return { ok: true, message: '连接成功（已通过百炼图像接口验证）' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async queryBalance(): Promise<BalanceResult> {
    return { ok: false, message: '阿里云百炼未开放余额查询接口（可在百炼控制台查看），请使用本地额度统计' }
  }
}

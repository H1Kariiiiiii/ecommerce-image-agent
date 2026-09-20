import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  downloadToFile,
  extFromUrl,
  extOfMime,
  fileToBase64,
  mimeOfFile,
  sniffImageMime,
  uniqueResultPath
} from './util'
import type {
  ApiProvider,
  BalanceResult,
  MakeWhiteBackgroundOptions,
  MakeWhiteBackgroundResult,
  ProviderConfig,
  TextRegion
} from '../../shared/types'

const DEFAULT_PROMPT = '将商品主体从背景中完整抠出，替换为纯白色背景（#FFFFFF），保持商品形状、颜色与细节不变，边缘干净自然，无阴影无倒影。'

/** 尺寸规则档：决定「比例 → 像素」换算表、尺寸参数名与像素限制（依据各服务商官方文档整理） */
export interface SizeProfile {
  /** 尺寸参数名：size（默认）/ image_size（硅基流动）/ none（不发尺寸） */
  param?: 'size' | 'image_size' | 'none'
  /** 比例 → 推荐像素档位 */
  ratioSizes: Record<string, string>
  /** 自定义尺寸最低像素 */
  minPixels?: number
  /** 自定义尺寸最高像素 */
  maxPixels?: number
  /** 宽高须为此数整数倍 */
  multiple?: number
  /** 宽高比（w/h）允许范围 */
  aspectRange?: [number, number]
}

/**
 * 各主流生图模型的尺寸规则（2026-08 官方文档调研）：
 * - seedream 5.0/4.5：总像素 ≥ 3,686,400，宽高比 1:16~16:1（实测）
 * - gpt-image-1：固定三档 1024x1024 / 1536x1024 / 1024x1536
 * - gpt-image-2：任意尺寸，宽高均须 16 的倍数、比例 1:3~3:1、像素 655,360~8,294,400
 * - glm-image：边长 1024~2048、32 的倍数、像素 ≤ 2^22
 * - cogview-4：边长 512~2048、16 的倍数、像素 ≤ 2^21
 * - qwen-image-2.0：像素 262,144~4,194,304，任意尺寸
 * - qwen-image-max/plus：固定 5 档
 * - 硅基流动（Qwen-Image / Kolors / FLUX）：参数名 image_size，FLUX 上限 2,359,296
 */
export const SIZE_PROFILES: Record<string, SizeProfile> = {
  seedream: {
    ratioSizes: {
      '1:1': '2048x2048',
      '16:9': '2560x1440',
      '9:16': '1440x2560',
      '4:3': '2304x1728',
      '3:4': '1728x2304',
      '3:2': '2880x1920',
      '2:3': '1920x2880',
      '21:9': '3584x1536'
    },
    minPixels: 3_686_400
  },
  'gpt-image-1': {
    ratioSizes: {
      '1:1': '1024x1024',
      '16:9': '1536x1024',
      '9:16': '1024x1536',
      '4:3': '1536x1024',
      '3:4': '1024x1536',
      '3:2': '1536x1024',
      '2:3': '1024x1536',
      '21:9': '1536x1024'
    }
  },
  'gpt-image-2': {
    ratioSizes: {
      '1:1': '2048x2048',
      '16:9': '2560x1440',
      '9:16': '1440x2560',
      '4:3': '2304x1728',
      '3:4': '1728x2304',
      '3:2': '2688x1792',
      '2:3': '1792x2688',
      '21:9': '2688x1152'
    },
    minPixels: 655_360,
    maxPixels: 8_294_400,
    multiple: 16,
    aspectRange: [1 / 3, 3]
  },
  'glm-image': {
    ratioSizes: {
      '1:1': '1280x1280',
      '16:9': '1728x960',
      '9:16': '960x1728',
      '4:3': '1472x1088',
      '3:4': '1088x1472',
      '3:2': '1568x1056',
      '2:3': '1056x1568',
      '21:9': '1728x960'
    },
    maxPixels: 4_194_304,
    multiple: 32
  },
  'cogview-4': {
    ratioSizes: {
      '1:1': '1024x1024',
      '16:9': '1440x720',
      '9:16': '720x1440',
      '4:3': '1152x864',
      '3:4': '864x1152',
      '3:2': '1152x864',
      '2:3': '864x1152',
      '21:9': '1440x720'
    },
    maxPixels: 2_097_152,
    multiple: 16
  },
  'qwen-image-2': {
    ratioSizes: {
      '1:1': '2048x2048',
      '16:9': '2048x1152',
      '9:16': '1152x2048',
      '4:3': '2048x1536',
      '3:4': '1536x2048',
      '3:2': '2048x1366',
      '2:3': '1366x2048',
      '21:9': '2048x878'
    },
    minPixels: 262_144,
    maxPixels: 4_194_304
  },
  'qwen-image-max': {
    ratioSizes: {
      '1:1': '1328x1328',
      '16:9': '1664x928',
      '9:16': '928x1664',
      '4:3': '1472x1104',
      '3:4': '1104x1472',
      '3:2': '1664x928',
      '2:3': '928x1664',
      '21:9': '1664x928'
    }
  },
  'siliconflow-qwen': {
    param: 'image_size',
    ratioSizes: {
      '1:1': '1328x1328',
      '16:9': '1664x928',
      '9:16': '928x1664',
      '4:3': '1472x1140',
      '3:4': '1140x1472',
      '3:2': '1584x1056',
      '2:3': '1056x1584',
      '21:9': '1664x928'
    }
  },
  kolors: {
    param: 'image_size',
    ratioSizes: {
      '1:1': '1024x1024',
      '16:9': '1280x720',
      '9:16': '720x1280',
      '4:3': '1280x960',
      '3:4': '960x1280',
      '3:2': '1024x768',
      '2:3': '768x1024',
      '21:9': '1280x720'
    }
  },
  flux: {
    param: 'image_size',
    ratioSizes: {
      '1:1': '1024x1024',
      '16:9': '1280x720',
      '9:16': '720x1280',
      '4:3': '1280x960',
      '3:4': '960x1280',
      '3:2': '1024x768',
      '2:3': '768x1024',
      '21:9': '1280x720'
    },
    maxPixels: 2_359_296
  }
}

/** 兼容导出：默认档（seedream）换算表与最低像素 */
export const RATIO_TO_SIZE = SIZE_PROFILES.seedream.ratioSizes
export const MIN_PIXELS = SIZE_PROFILES.seedream.minPixels ?? 0

/** 解析 WxH 像素字符串为数值，非法返回 null */
export function parseSize(size: string): { w: number; h: number } | null {
  const m = /^\s*(\d+)\s*[xX]\s*(\d+)\s*$/.exec(size)
  if (!m) return null
  return { w: Number(m[1]), h: Number(m[2]) }
}

interface OpenAiErrorBody {
  error?: { message?: string; type?: string; code?: string | number }
  message?: string
  code?: string | number
}

export class OpenAiCompatProvider implements ApiProvider {
  readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? 120_000
  }

  private get baseUrl(): string {
    return (this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  }

  /** size 归一化：*、×、X 一律转为 x（如 2048*1152 → 2048x1152），兼容键盘输入 */
  private get sizeNormalized(): string | undefined {
    return this.config.size?.replace(/[*×X]/g, 'x')
  }

  private get headers(): Record<string, string> {
    if (!this.config.apiKey) throw new Error('未配置 API Key')
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    }
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) {
        let detail = text.slice(0, 500)
        try {
          const j = JSON.parse(text) as OpenAiErrorBody
          detail = j.error?.message ?? j.message ?? detail
          if (j.error?.code !== undefined) detail = `[${String(j.error.code)}] ${detail}`
        } catch {
          /* 非 JSON 错误体，使用原文 */
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
        throw new Error(`请求超时（${this.timeoutMs}ms）：${url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async makeWhiteBackground(opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult> {
    const model = this.config.model ?? ''
    if (!model) throw new Error('未配置 model')
    // 留空（含纯空格）时使用内置默认提示词，避免服务端报 prompt cannot be empty
    const prompt = this.config.prompt?.trim() ? this.config.prompt : DEFAULT_PROMPT

    let json: unknown
    if (this.config.requestStyle === 'edits') {
      json = await this.callEdits(opts, model, prompt)
    } else if (this.config.requestStyle === 'chat') {
      json = await this.callChat(opts, model, prompt)
    } else {
      json = await this.callGenerations(opts, model, prompt)
    }

    return this.extractResult(json, opts)
  }

  /**
   * OpenAI 标准 /images/edits（multipart/form-data），支持可选 mask。
   * @param sendSize 是否发送 size（编辑场景传 false：保持原图尺寸，避免模型缩放输出）
   */
  private async callEdits(
    opts: MakeWhiteBackgroundOptions,
    model: string,
    prompt: string,
    maskBuffer?: Buffer,
    sendSize = true
  ): Promise<unknown> {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('n', '1')
    if (sendSize) {
      const size = this.sizeNormalized
      if (size) form.append('size', size)
    }
    const buf = await readFile(opts.inputPath)
    form.append(
      'image',
      new Blob([new Uint8Array(buf)], { type: mimeOfFile(opts.inputPath) }),
      basename(opts.inputPath)
    )
    if (maskBuffer) {
      form.append('mask', new Blob([new Uint8Array(maskBuffer)], { type: 'image/png' }), 'mask.png')
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` }
    return this.request(`${this.baseUrl}/images/edits`, { method: 'POST', headers, body: form })
  }

  /** JSON /images/generations，image 字段传 data URI（data:<mime>;base64,...）——兼容火山方舟 Ark seedream 系列 */
  private async callGenerations(opts: MakeWhiteBackgroundOptions, model: string, prompt: string): Promise<unknown> {
    const mime = mimeOfFile(opts.inputPath) || 'image/png'
    const imageDataUri = `data:${mime};base64,${await fileToBase64(opts.inputPath)}`
    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      response_format: 'url'
    }
    // size 优先（用户自定义）；否则按生成比例换算为模型支持档位发送
    // 注意：方舟 seedream 5.0 忽略 aspect_ratio 参数，必须换算为 size；各模型规则见 SIZE_PROFILES
    // 用 || 而非 ??：UI 清空 size 后保存为空字符串 ''，空串也应视为「未填」，走比例换算
    const profile = SIZE_PROFILES[this.config.sizeProfile ?? 'seedream'] ?? SIZE_PROFILES.seedream
    const sizeParam = profile.param ?? 'size'
    if (sizeParam !== 'none') {
      const size =
        this.sizeNormalized || (this.config.aspectRatio ? profile.ratioSizes[this.config.aspectRatio] : undefined)
      if (size) {
        const dims = parseSize(size)
        if (!dims) {
          throw new Error(`自定义尺寸格式不正确：${size}（应为 宽x高，如 2048x2048）`)
        }
        const px = dims.w * dims.h
        if (profile.minPixels !== undefined && px < profile.minPixels) {
          throw new Error(
            `自定义尺寸 ${size} 像素不足：该模型要求至少 ${profile.minPixels} 像素。请增大尺寸，或在「生成比例」中选择比例`
          )
        }
        if (profile.maxPixels !== undefined && px > profile.maxPixels) {
          throw new Error(`自定义尺寸 ${size} 超出上限：该模型要求最多 ${profile.maxPixels} 像素。请减小尺寸或选择比例`)
        }
        if (profile.multiple !== undefined && (dims.w % profile.multiple !== 0 || dims.h % profile.multiple !== 0)) {
          throw new Error(`自定义尺寸 ${size} 不符合要求：该模型宽高需为 ${profile.multiple} 的整数倍`)
        }
        if (profile.aspectRange) {
          const ratio = dims.w / dims.h
          if (ratio < profile.aspectRange[0] || ratio > profile.aspectRange[1]) {
            throw new Error(
              `自定义尺寸 ${size} 比例超出范围：该模型宽高比需在 ${profile.aspectRange[0]} ~ ${profile.aspectRange[1]} 之间（当前 ${ratio.toFixed(2)}）`
            )
          }
        }
        body[sizeParam] = size
      }
    }
    // 显式控制 AI 水印（缺省不传，跟随服务商默认策略）
    if (typeof this.config.watermark === 'boolean') body.watermark = this.config.watermark
    // 方舟 seedream 5.0 要求 image 为 data URI 或公网 URL，裸 base64 会被判为 invalid url
    body.image = imageDataUri
    return this.request(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    })
  }

  /** chat/completions 多模态生图（部分 OpenAI 兼容端点的图像模型） */
  private async callChat(opts: MakeWhiteBackgroundOptions, model: string, prompt: string): Promise<unknown> {
    const mime = mimeOfFile(opts.inputPath) || 'image/png'
    const imageDataUri = `data:${mime};base64,${await fileToBase64(opts.inputPath)}`
    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUri } }
          ]
        }
      ]
    }
    return this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    })
  }

  private async extractResult(json: unknown, opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult> {
    // 收集候选结果：images/generations 风格 data[] 与 chat/completions 风格 choices[0].message.content
    const candidates: string[] = []
    const data = (json as { data?: unknown[] })?.data
    if (Array.isArray(data)) {
      for (const item of data) {
        const it = item as { url?: string; b64_json?: string }
        if (typeof it.url === 'string' && it.url) candidates.push(it.url)
        else if (typeof it.b64_json === 'string' && it.b64_json) candidates.push(`data:image/png;base64,${it.b64_json}`)
      }
    }
    const choice = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    const content = choice?.message?.content
    if (Array.isArray(content)) {
      for (const c of content) {
        const cc = c as { type?: string; image_url?: { url?: string } }
        if (cc?.type === 'image_url' && typeof cc.image_url?.url === 'string' && cc.image_url.url) {
          candidates.push(cc.image_url.url)
        }
      }
    } else if (typeof content === 'string' && content.trim()) {
      // 部分服务以 markdown 图片或裸 URL 返回
      const md = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(content)
      if (md) candidates.push(md[1])
      else if (/^https?:\/\//.test(content.trim())) candidates.push(content.trim())
    }

    if (candidates.length === 0) {
      throw new Error(`响应中没有图片结果：${JSON.stringify(json).slice(0, 300)}`)
    }
    const url = candidates[0]

    // data URI 结果（部分服务返回的 base64 图片）直接解码保存
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(url)
      if (!m) throw new Error('无法解析 data URI 结果')
      const buf = Buffer.from(m[2], 'base64')
      const sniffed = sniffImageMime(buf)
      const mime = m[1] || sniffed
      if (!mime) {
        throw new Error('服务返回的 data URI 图片内容无效（魔数校验失败）')
      }
      const dest = uniqueResultPath(opts.outputDir, opts.inputPath, extOfMime(mime))
      await writeFileAtomic(dest, buf)
      return { outputPath: dest, mimeType: mime }
    }

    // http(s) 结果走下载
    const ext = extFromUrl(url)
    const dest = uniqueResultPath(opts.outputDir, opts.inputPath, ext)
    const outputPath = await downloadToFile(url, dest)
    return { outputPath, mimeType: 'application/octet-stream', sourceUrl: url }
  }

  async queryBalance(): Promise<BalanceResult> {
    const c = this.config
    if (!c.baseUrl) return { ok: false, message: '缺少 baseUrl' }
    if (!c.apiKey) return { ok: false, message: '缺少 API Key' }
    try {
      const json = (await this.request(`${this.baseUrl}/dashboard/billing/credit_grants`, {
        method: 'GET',
        headers: this.headers
      })) as {
        total_granted?: number
        total_used?: number
        total_available?: number
      }
      const granted = json?.total_granted
      const used = json?.total_used
      const available = json?.total_available
      if (typeof available !== 'number' && typeof used !== 'number') {
        return { ok: false, message: '该服务商返回了无法识别的余额格式' }
      }
      const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—')
      return {
        ok: true,
        granted,
        used,
        available,
        message: `余额：${typeof available === 'number' ? fmt(available) : '—'}，已用：${typeof used === 'number' ? fmt(used) : '—'}${typeof granted === 'number' ? `，总额：${fmt(granted)}` : ''}`
      }
    } catch (err) {
      return {
        ok: false,
        message: `查询失败（当前服务商可能不支持余额查询）：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const c = this.config
    if (!c.baseUrl) return { ok: false, message: '缺少 baseUrl' }
    if (!c.apiKey) return { ok: false, message: '缺少 API Key' }
    if (!c.model) return { ok: false, message: '缺少 model' }
    try {
      await this.request(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers })
      return { ok: true, message: '连接成功（已通过 /models 验证）' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}

async function writeFileAtomic(p: string, data: Buffer): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))), { recursive: true })
  await writeFile(p, data)
}

import { signRequest } from './signer'
import {
  downloadToFile,
  extFromUrl,
  fileToBase64,
  fillTemplate,
  getByPath,
  uniqueResultPath
} from './util'
import type {
  ApiProvider,
  BalanceResult,
  MakeWhiteBackgroundOptions,
  MakeWhiteBackgroundResult,
  ProviderConfig
} from '../../shared/types'

const DEFAULT_SUBMIT_BODY = JSON.stringify(
  {
    req_key: '{reqKey}',
    image_url: [],
    binary_data_base64: ['{imageBase64}'],
    video_url: '',
    ref_img_url: []
  },
  null,
  2
)

const DEFAULT_POLL_BODY = JSON.stringify({ req_key: '{reqKey}', task_id: '{taskId}' }, null, 2)

interface CvResponse {
  ResponseMetadata?: {
    RequestId?: string
    Error?: { Code?: string; Message?: string; CodeN?: number }
  }
  Result?: Record<string, unknown>
}

function isCvResponse(x: unknown): x is CvResponse {
  return typeof x === 'object' && x !== null && 'ResponseMetadata' in x
}

export class VolcanoCvProvider implements ApiProvider {
  readonly config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? 30_000
  }

  private buildSubmitUrl(): URL {
    const endpoint = this.config.endpoint ?? 'https://visual.volcengineapi.com'
    const url = new URL(endpoint)
    if (this.config.action) url.searchParams.set('Action', this.config.action)
    if (this.config.version) url.searchParams.set('Version', this.config.version)
    return url
  }

  private buildPollUrl(): URL {
    const endpoint = this.config.endpoint ?? 'https://visual.volcengineapi.com'
    const url = new URL(endpoint)
    if (this.config.pollAction) url.searchParams.set('Action', this.config.pollAction)
    if (this.config.version) url.searchParams.set('Version', this.config.version)
    return url
  }

  private async signedPost(url: URL, body: string): Promise<unknown> {
    const cfg = this.config
    if (!cfg.accessKey || !cfg.secretKey || !cfg.region || !cfg.service) {
      throw new Error('火山引擎配置不完整：需要 accessKey / secretKey / region / service')
    }
    const headers = signRequest({
      method: 'POST',
      url,
      body,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
      region: cfg.region ?? 'cn-north-1',
      service: cfg.service ?? 'cv',
      version: cfg.signVersion ?? 'HMAC-SHA256'
    })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), { method: 'POST', headers, body, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}：${text.slice(0, 500)}`)
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`响应不是合法 JSON：${text.slice(0, 500)}`)
      }
      if (isCvResponse(json) && json.ResponseMetadata?.Error) {
        const e = json.ResponseMetadata.Error
        throw new Error(`接口错误 [${e.Code ?? e.CodeN ?? 'unknown'}]：${e.Message ?? '无错误信息'}`)
      }
      return json
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs}ms）：${url.pathname}${url.search}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private pollBody(taskId: string): string {
    const tpl = this.config.pollBodyTemplate ?? DEFAULT_POLL_BODY
    return fillTemplate(tpl, {
      reqKey: this.config.reqKey ?? '',
      taskId
    })
  }

  async makeWhiteBackground(opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult> {
    const imageBase64 = await fileToBase64(opts.inputPath)
    const mime = 'image/png' // base64 输入不区分 mime，统一按二进制处理

    // 提交任务
    const submitTpl = this.config.submitBodyTemplate ?? DEFAULT_SUBMIT_BODY
    const submitBody = fillTemplate(submitTpl, {
      reqKey: this.config.reqKey ?? '',
      imageBase64,
      imageDataUri: `data:${mime};base64,${imageBase64}`,
      prompt: this.config.prompt?.trim() ? this.config.prompt : '将商品主体从背景中完整抠出，替换为纯白色背景，保持细节与边缘干净'
    })
    const submitRes = await this.signedPost(this.buildSubmitUrl(), submitBody)

    const taskId = getByPath(submitRes, this.config.taskIdPath ?? 'Result.Data.TaskId')
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error(`提交任务失败：未在响应中找到任务 id（taskIdPath=${this.config.taskIdPath ?? 'Result.Data.TaskId'}）`)
    }

    // 轮询
    const interval = this.config.pollIntervalMs ?? 5000
    const maxAttempts = this.config.maxPollAttempts ?? 120
    const success = new Set(this.config.successStatus ?? ['done', 'success', 'succeeded'])
    const fail = new Set(this.config.failStatus ?? ['fail', 'failed', 'error'])
    const statusPath = this.config.statusPath ?? 'Result.Data.Status'
    const resultUrlPath = this.config.resultUrlPath ?? 'Result.Data.ImageUrls[0]'

    let lastStatus: unknown = undefined
    let resultUrl: string | undefined
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(interval)
      const pollRes = await this.signedPost(this.buildPollUrl(), this.pollBody(taskId))
      lastStatus = getByPath(pollRes, statusPath)
      const urlVal = getByPath(pollRes, resultUrlPath)
      if (typeof urlVal === 'string' && urlVal) resultUrl = urlVal

      const status = String(lastStatus ?? '').toLowerCase()
      if (success.has(status)) {
        if (!resultUrl) {
          throw new Error(`任务已完成但未找到结果图片 URL（resultUrlPath=${resultUrlPath}）`)
        }
        return this.downloadResult(resultUrl, opts)
      }
      if (fail.has(status)) {
        throw new Error(`任务失败：状态 = ${String(lastStatus)}`)
      }
    }
    throw new Error(`任务轮询超时（${maxAttempts} 次 × ${interval}ms），最后状态 = ${String(lastStatus ?? '(空)')}`)
  }

  private async downloadResult(url: string, opts: MakeWhiteBackgroundOptions): Promise<MakeWhiteBackgroundResult> {
    const ext = extFromUrl(url)
    const dest = uniqueResultPath(opts.outputDir, opts.inputPath, ext)
    const outputPath = await downloadToFile(url, dest)
    return { outputPath, mimeType: 'application/octet-stream', sourceUrl: url }
  }

  async queryBalance(): Promise<BalanceResult> {
    return {
      ok: false,
      message: '火山引擎视觉智能未开放余额/额度查询接口（可在控制台查看），请使用本地额度统计'
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const c = this.config
    const missing: string[] = []
    if (!c.endpoint) missing.push('endpoint')
    if (!c.accessKey) missing.push('accessKey')
    if (!c.secretKey) missing.push('secretKey')
    if (!c.region) missing.push('region')
    if (!c.service) missing.push('service')
    if (!c.action) missing.push('action')
    if (!c.pollAction) missing.push('pollAction')
    if (!c.reqKey) missing.push('reqKey')
    if (missing.length) {
      return { ok: false, message: `缺少必填项：${missing.join(', ')}` }
    }
    return { ok: true, message: '配置完整（签名+任务轮询将在首次处理时真实调用）' }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

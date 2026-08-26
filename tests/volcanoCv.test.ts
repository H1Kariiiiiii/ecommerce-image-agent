import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VolcanoCvProvider } from '../src/main/api/volcanoCv'
import { PNG_BYTES, setupInput } from './helpers'
import type { ProviderConfig } from '../src/shared/types'

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 't1',
    name: 'test',
    type: 'volcano-cv',
    endpoint: 'https://visual.volcengineapi.com',
    accessKey: 'AK',
    secretKey: 'SK',
    region: 'cn-north-1',
    service: 'cv',
    version: '2022-08-31',
    signVersion: 'HMAC-SHA256',
    action: 'CVSubmitTask',
    pollAction: 'CVGetResult',
    reqKey: 'seedream_test',
    pollIntervalMs: 5,
    maxPollAttempts: 5,
    timeoutMs: 1000,
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function pngResponse(): Response {
  return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
}

const realFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = realFetch
})

describe('VolcanoCvProvider.makeWhiteBackground', () => {
  it('完整流程：提交任务 → 轮询到 done → 下载结果', async () => {
    let polls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('Action=CVSubmitTask')) {
        const body = JSON.parse(String(init?.body))
        expect(body.req_key).toBe('seedream_test')
        expect(Array.isArray(body.binary_data_base64)).toBe(true)
        expect(body.binary_data_base64[0]).toBeTypeOf('string')
        expect(body.binary_data_base64[0].length).toBeGreaterThan(4) // base64 图片内容
        // 签名头必须存在
        expect(init?.headers).toMatchObject({ Authorization: expect.stringContaining('HMAC-SHA256 Credential=') })
        expect(init?.headers).toMatchObject({ 'X-Date': expect.stringMatching(/^\d{8}T\d{6}Z$/) })
        return jsonResponse({ ResponseMetadata: { RequestId: 'r1' }, Result: { Data: { TaskId: 'task-1' } } })
      }
      if (url.includes('Action=CVGetResult')) {
        polls += 1
        if (polls === 1) {
          return jsonResponse({ ResponseMetadata: {}, Result: { Data: { Status: 'running' } } })
        }
        return jsonResponse({
          ResponseMetadata: {},
          Result: { Data: { Status: 'done', ImageUrls: ['https://cdn.test/out.png'] } }
        })
      }
      if (url === 'https://cdn.test/out.png') {
        return pngResponse()
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig())
    const result = await provider.makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out')
    })

    expect(result.outputPath).toBe(join(join(dir, 'out'), 'toy_white.png'))
    expect(result.sourceUrl).toBe('https://cdn.test/out.png')
    const buf = await readFile(result.outputPath)
    expect([...buf]).toEqual(PNG_BYTES)
    expect(polls).toBe(2)
  })

  it('任务失败状态抛出明确错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url.includes('Action=CVSubmitTask')) {
          return jsonResponse({ ResponseMetadata: {}, Result: { Data: { TaskId: 'task-1' } } })
        }
        return jsonResponse({ ResponseMetadata: {}, Result: { Data: { Status: 'failed', Error: 'x' } } })
      })
    )
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig({ maxPollAttempts: 10 }))
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/任务失败/)
  })

  it('轮询超时（始终 running）抛出超时错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url.includes('Action=CVSubmitTask')) {
          return jsonResponse({ ResponseMetadata: {}, Result: { Data: { TaskId: 'task-1' } } })
        }
        return jsonResponse({ ResponseMetadata: {}, Result: { Data: { Status: 'running' } } })
      })
    )
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig({ maxPollAttempts: 3 }))
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/轮询超时/)
  })

  it('接口返回 ResponseMetadata.Error 时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url.includes('Action=CVSubmitTask')) {
          return jsonResponse({
            ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'bad signature' } },
            Result: {}
          })
        }
        throw new Error('should not poll')
      })
    )
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/SignatureDoesNotMatch.*bad signature/)
  })

  it('HTTP 非 2xx 抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('oops', { status: 500 }))
    )
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/HTTP 500/)
  })

  it('配置缺少密钥时在提交前抛错', async () => {
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig({ secretKey: undefined, accessKey: undefined }))
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/配置不完整/)
  })

  it('输入图片不存在时给出友好错误', async () => {
    const { dir } = await setupInput()
    const provider = new VolcanoCvProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath: join(dir, 'missing.png'), outputDir: join(dir, 'out') })
    ).rejects.toThrow(/无法读取图片文件/)
  })

  it('自定义模板与路径生效', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('Action=CustomSubmit')) {
        const body = JSON.parse(String(init?.body))
        expect(body.my_model).toBe('m1')
        expect(body.img).toBeTypeOf('string')
        expect(body.prompt).toBe('white')
        return jsonResponse({ job: { id: 'j9' } })
      }
      if (url.includes('Action=CustomPoll')) {
        return jsonResponse({ job: { state: 'succeeded', out: 'https://cdn.test/x.webp' } })
      }
      if (url === 'https://cdn.test/x.webp') return pngResponse()
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new VolcanoCvProvider(
      baseConfig({
        action: 'CustomSubmit',
        pollAction: 'CustomPoll',
        reqKey: 'm1',
        prompt: 'white',
        taskIdPath: 'job.id',
        statusPath: 'job.state',
        resultUrlPath: 'job.out',
        submitBodyTemplate: '{"my_model":"{reqKey}","img":"{imageBase64}","prompt":"{prompt}"}',
        pollBodyTemplate: '{"id":"{taskId}"}'
      })
    )
    const result = await provider.makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out')
    })
    // 下载内容实际是 PNG 字节（URL 声称 .webp），魔数对齐后保存为 .png
    expect(result.outputPath).toBe(join(join(dir, 'out'), 'toy_white.png'))
  })
})

describe('VolcanoCvProvider.testConnection', () => {
  it('缺少必填项时返回失败与缺失列表', async () => {
    const provider = new VolcanoCvProvider(baseConfig({ reqKey: undefined, pollAction: undefined }))
    const r = await provider.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('reqKey')
    expect(r.message).toContain('pollAction')
  })

  it('配置完整时返回 ok', async () => {
    const provider = new VolcanoCvProvider(baseConfig())
    const r = await provider.testConnection()
    expect(r.ok).toBe(true)
  })
})

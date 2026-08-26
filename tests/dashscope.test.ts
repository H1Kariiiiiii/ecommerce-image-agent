import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashScopeProvider } from '../src/main/api/dashscope'
import { PNG_BYTES, setupInput } from './helpers'
import type { ProviderConfig } from '../src/shared/types'

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'd1',
    name: '百炼测试',
    type: 'dashscope',
    apiKey: 'sk-test123',
    model: 'qwen-image',
    aspectRatio: '1:1',
    timeoutMs: 5000,
    ...overrides
  }
}

const realFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = realFetch
})

describe('DashScopeProvider.makeWhiteBackground', () => {
  it('POST 百炼原生端点：正确携带 Bearer、model、messages、size；解析新版 choices 响应', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation') {
        sawGeneration = true
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test123' })
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('qwen-image')
        // 新版格式：input.messages[{content:[{image:dataURI},{text}]}]
        expect(body.input.messages[0].role).toBe('user')
        expect(body.input.messages[0].content[0].image).toMatch(/^data:image\/(png|jpeg);base64,/)
        expect(body.input.messages[0].content[1].text).toContain('白')
        expect(body.parameters.size).toBe('1024*1024')
        expect(body.parameters.n).toBe(1)
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  message: { content: { image: 'https://dashscope-result.test/gen.png' } }
                }
              ]
            },
            request_id: 'r1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://dashscope-result.test/gen.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig())
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
    expect(result.sourceUrl).toBe('https://dashscope-result.test/gen.png')
  })

  it('兼容新版 content 数组元素直接带 image 字段（qwen-image-3.0 实际返回格式）', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('multimodal-generation')) {
        return new Response(
          JSON.stringify({
            output: {
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: [{ image: 'https://dashscope-result.test/new.png' }]
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://dashscope-result.test/new.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig())
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(result.sourceUrl).toBe('https://dashscope-result.test/new.png')
  })

  it('兼容旧版 output.results 响应', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('multimodal-generation')) {
        return new Response(
          JSON.stringify({
            output: { results: [{ url: 'https://dashscope-result.test/old.png' }] }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://dashscope-result.test/old.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig())
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(result.sourceUrl).toBe('https://dashscope-result.test/old.png')
  })

  it('比例 16:9 换算为 1280*720', async () => {
    let sawSize = ''
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('multimodal-generation')) {
        const body = JSON.parse(String(init?.body))
        sawSize = body.parameters.size
        return new Response(
          JSON.stringify({ output: { results: [{ url: 'https://dashscope-result.test/w.png' }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://dashscope-result.test/w.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig({ aspectRatio: '16:9' }))
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawSize).toBe('1280*720')
  })

  it('自定义 size（1024x1024）归一化为 1024*1024', async () => {
    let sawSize = ''
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('multimodal-generation')) {
        const body = JSON.parse(String(init?.body))
        sawSize = body.parameters.size
        return new Response(
          JSON.stringify({ output: { results: [{ url: 'https://dashscope-result.test/c.png' }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://dashscope-result.test/c.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig({ size: '1024x1024', aspectRatio: undefined }))
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawSize).toBe('1024*1024')
  })

  it('b64_image 结果直接解码保存', async () => {
    const b64 = Buffer.from(PNG_BYTES).toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ output: { results: [{ b64_image: b64 }] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig())
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(result.outputPath).toMatch(/\.png$/)
  })

  it('百炼错误格式（code/message）解析到错误信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 'InvalidParameter', message: 'size 参数不合法', request_id: 'r' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new DashScopeProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/InvalidParameter.*size 参数不合法/)
  })
})

describe('DashScopeProvider.testConnection', () => {
  it('缺少 API Key 时报错', async () => {
    const provider = new DashScopeProvider(baseConfig({ apiKey: '' }))
    const r = await provider.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })
})

import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatProvider } from '../src/main/api/openaiCompat'
import { PNG_BYTES, setupInput, setupRealImage } from './helpers'
import type { ProviderConfig } from '../src/shared/types'

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 't2',
    name: 'test',
    type: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'KEY_123',
    model: 'seedream-5-0-lite',
    size: '2048x2048',
    requestStyle: 'json',
    timeoutMs: 2000,
    ...overrides
  }
}

const realFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = realFetch
})

describe('OpenAiCompatProvider.makeWhiteBackground（json 风格，兼容方舟 Ark）', () => {
  it('POST /images/generations：正确携带 Bearer、model、data URI image；下载结果', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer KEY_123' })
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('seedream-5-0-lite')
        expect(body.prompt).toBeTypeOf('string')
        expect(body.n).toBe(1)
        expect(body.size).toBe('2048x2048')
        expect(body.image).toBeTypeOf('string')
        // 方舟 seedream 5.0 要求 data URI 格式（data:<mime>;base64,...），裸 base64 会报 invalid url
        expect(body.image.startsWith('data:image/png;base64,')).toBe(true)
        expect(body.image.length).toBeGreaterThan(30)
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/gen.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/gen.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig())
    const result = await provider.makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out')
    })
    expect(sawGeneration).toBe(true)
    expect(result.sourceUrl).toBe('https://cdn.test/gen.png')
    expect(result.outputPath).toContain('toy_white')
  })

  it('prompt 留空/纯空格时发送内置默认提示词（不报 prompt cannot be empty）', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(typeof body.prompt).toBe('string')
        expect(body.prompt.length).toBeGreaterThan(10)
        expect(body.prompt).not.toBe('')
        expect(body.prompt).toContain('白')
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/dp.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/dp.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig({ prompt: '   ' }))
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('配置 aspectRatio 时发送换算后的 size（16:9 → 2560x1440），不再发送 aspect_ratio', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        // 方舟忽略 aspect_ratio，必须换算为 size 档位发送
        expect(body.aspect_ratio).toBeUndefined()
        expect(body.size).toBe('2560x1440')
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/wide.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/wide.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ aspectRatio: '16:9', size: undefined })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('4:3 比例换算为 2304x1728 发送（size 为空时走比例档位）', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBe('2304x1728')
        expect(body.size).not.toBe('2048x2048')
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/r43.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/r43.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ aspectRatio: '4:3', size: '' })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('size 与比例同时残留时 size 优先（旧配置），发送 2048x2048', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        // 旧配置同时带 size 与比例：size 优先发送（保存时 normalizeSizeRatio 会清掉这种残留）
        expect(body.size).toBe('2048x2048')
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/legacy.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/legacy.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ aspectRatio: '4:3', size: '2048x2048' })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('size 支持 * 与 ×：2048*2048 发送时归一化为 2048x2048', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBe('2048x2048')
        return new Response(JSON.stringify({ code: 0, data: [{ url: 'https://cdn.test/size.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/size.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ size: '2048*2048', aspectRatio: undefined })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('自定义 size 像素不足时友好报错（不请求 API）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ size: '1920x1080', aspectRatio: undefined })
    )
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/像素不足/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gpt-image-2 档位：16:9 换算为 2560x1440（16 的倍数、比例合法）', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://api.openai.com/v1/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBe('2560x1440')
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/g2.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/g2.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-2',
        sizeProfile: 'gpt-image-2',
        size: undefined,
        aspectRatio: '16:9'
      })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('gpt-image-2 档位：自定义尺寸非 16 的倍数时本地报错', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ sizeProfile: 'gpt-image-2', size: '2048x1000', aspectRatio: undefined })
    )
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/16 的整数倍/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('硅基流动档位：尺寸参数名为 image_size（16:9 → 1664x928）', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://api.siliconflow.cn/v1/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBeUndefined()
        expect(body.image_size).toBe('1664x928')
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/sf.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/sf.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen-Image',
        sizeProfile: 'siliconflow-qwen',
        size: undefined,
        aspectRatio: '16:9'
      })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('智谱 glm-image 档位：4:3 换算为 1472x1088', async () => {
    let sawGeneration = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://open.bigmodel.cn/api/paas/v4/images/generations') {
        sawGeneration = true
        const body = JSON.parse(String(init?.body))
        expect(body.size).toBe('1472x1088')
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/glm.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/glm.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-image',
        sizeProfile: 'glm-image',
        size: undefined,
        aspectRatio: '4:3'
      })
    )
    await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawGeneration).toBe(true)
  })

  it('响应缺失 data 数组时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/没有图片结果/)
  })

  it('错误响应解析 error.message（OpenAI 风格）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: 'Insufficient quota', code: 'insufficient_quota' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/HTTP 429.*insufficient_quota.*Insufficient quota/)
  })

  it('错误响应解析 message（方舟 Ark 风格）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 500001, message: 'Model not found' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig())
    await expect(
      provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    ).rejects.toThrow(/Model not found/)
  })

  it('b64_json 结果写入本地 PNG', async () => {
    const b64 = Buffer.from(PNG_BYTES).toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(baseConfig())
    const result = await provider.makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out')
    })
    expect(result.outputPath).toMatch(/\.png$/)
  })
})

describe('OpenAiCompatProvider.makeWhiteBackground（edits 风格）', () => {
  it('POST /images/edits 使用 multipart FormData', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://api.example.com/v1/images/edits') {
        expect(init?.body).toBeInstanceOf(FormData)
        const fd = init?.body as FormData
        expect(fd.get('model')).toBe('gpt-image-1')
        expect(String(fd.get('prompt'))).toBeTypeOf('string')
        expect(fd.get('image')).toBeInstanceOf(Blob)
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/e.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/e.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-image-1',
        requestStyle: 'edits'
      })
    )
    const result = await provider.makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out')
    })
    expect(result.sourceUrl).toBe('https://cdn.test/e.png')
  })
})

describe('OpenAiCompatProvider.testConnection', () => {
  it('配置缺失时返回失败', async () => {
    const provider = new OpenAiCompatProvider(baseConfig({ apiKey: undefined }))
    const r = await provider.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('API Key')
  })

  it('GET /models 成功返回 ok', async () => {    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/models') {
        return new Response(JSON.stringify({ data: [{ id: 'seedream-5-0-lite' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiCompatProvider(baseConfig())
    const r = await provider.testConnection()
    expect(r.ok).toBe(true)
  })

  it('queryBalance：成功解析 credit_grants 余额', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url === 'https://ark.cn-beijing.volces.com/api/v3/dashboard/billing/credit_grants') {
          return new Response(
            JSON.stringify({ object: 'credit_grants', total_granted: 18, total_used: 12.5, total_available: 5.5 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        throw new Error(`unexpected: ${url}`)
      })
    )
    const provider = new OpenAiCompatProvider(baseConfig())
    const r = await provider.queryBalance()
    expect(r.ok).toBe(true)
    expect(r.available).toBe(5.5)
    expect(r.used).toBe(12.5)
    expect(r.granted).toBe(18)
    expect(r.message).toContain('余额：5.5')
  })

  it('queryBalance：服务商不支持（404）时给出明确提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 }))
    )
    const provider = new OpenAiCompatProvider(baseConfig())
    const r = await provider.queryBalance()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('不支持余额查询')
  })

  it('配置 watermark:false 时发送 watermark:false；未配置时不发送', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/wm.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/wm.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    // 显式关闭水印
    await new OpenAiCompatProvider(baseConfig({ watermark: false })).makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out1')
    })
    expect(bodies[0].watermark).toBe(false)
    // 未配置 → 不发送 watermark 字段
    await new OpenAiCompatProvider(baseConfig({ watermark: undefined })).makeWhiteBackground({
      inputPath,
      outputDir: join(dir, 'out2')
    })
    expect('watermark' in bodies[1]).toBe(false)
  })

  it('GET /models 失败时返回错误信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    )
    const provider = new OpenAiCompatProvider(baseConfig())
    const r = await provider.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('401')
  })

  it('缺少 model 时返回失败', async () => {
    const provider = new OpenAiCompatProvider(baseConfig({ model: undefined }))
    const r = await provider.testConnection()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('model')
  })
})

describe('OpenAiCompatProvider.makeWhiteBackground（chat 风格）', () => {
  it('POST /chat/completions：messages 含 text + image_url；解析 choices 中 data URI 图片', async () => {
    const pngBase64 = Buffer.from(PNG_BYTES).toString('base64')
    let sawChat = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://api.example.com/v1/chat/completions') {
        sawChat = true
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer KEY_123' })
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('multimodal-image-model')
        const content = body.messages[0].content
        expect(content[0].type).toBe('text')
        expect(content[1].type).toBe('image_url')
        expect(content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: 'text', text: '已生成' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({
        baseUrl: 'https://api.example.com/v1',
        model: 'multimodal-image-model',
        requestStyle: 'chat'
      })
    )
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(sawChat).toBe(true)
    expect(result.outputPath).toContain('.png')
    // 文件真实存在且是 PNG 内容
    const fs = await import('node:fs')
    expect(fs.existsSync(result.outputPath)).toBe(true)
  })

  it('chat 响应 content 为纯文本 URL 时也能提取', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://api.example.com/v1/chat/completions') {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '![result](https://cdn.test/g.png)' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === 'https://cdn.test/g.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupInput()
    const provider = new OpenAiCompatProvider(
      baseConfig({ baseUrl: 'https://api.example.com/v1', requestStyle: 'chat' })
    )
    const result = await provider.makeWhiteBackground({ inputPath, outputDir: join(dir, 'out') })
    expect(result.sourceUrl).toBe('https://cdn.test/g.png')
  })
})

describe('OpenAiCompatProvider.eraseTextWithAI', () => {
  it('edits 风格：POST /images/edits 携带 image + mask + 擦除 prompt', async () => {
    let sawEdits = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/edits') {
        sawEdits = true
        expect(init?.body).toBeInstanceOf(FormData)
        const fd = init?.body as FormData
        expect(fd.get('model')).toBe('seedream-5-0-lite')
        const prompt = String(fd.get('prompt'))
        expect(prompt).toContain('擦除')
        expect(fd.get('image')).toBeInstanceOf(Blob)
        expect(fd.get('mask')).toBeInstanceOf(Blob)
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/erased.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/erased.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupRealImage()
    const provider = new OpenAiCompatProvider(baseConfig({ requestStyle: 'edits' }))
    const result = await provider.eraseTextWithAI({
      inputPath,
      outputDir: join(dir, 'out'),
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
    })
    expect(sawEdits).toBe(true)
    expect(result.outputPath).toContain('toy_white')
  })

  it('json 风格（火山方舟）：无 /images/edits，走 generations + 参考图 + 擦除 prompt', async () => {
    let sawGenerations = false
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations') {
        sawGenerations = true
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('seedream-5-0-lite')
        expect(body.prompt).toContain('擦除')
        expect(body.image).toMatch(/^data:image\/(png|jpeg);base64,/)
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/erased-json.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/erased-json.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupRealImage()
    const provider = new OpenAiCompatProvider(baseConfig()) // 默认 requestStyle='json'
    const result = await provider.eraseTextWithAI({
      inputPath,
      outputDir: join(dir, 'out'),
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
    })
    expect(sawGenerations).toBe(true)
    expect(result.outputPath).toContain('toy_white')
  })

  it('擦除 prompt：不要求尺寸参数（编辑保持原图尺寸）', async () => {
    let capturedSize: string | null = null
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url.includes('/images/edits')) {
        const fd = init?.body as FormData
        capturedSize = fd.get('size') as string | null
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/e2.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === 'https://cdn.test/e2.png') {
        return new Response(new Blob([new Uint8Array(PNG_BYTES)]), { status: 200 })
      }
      throw new Error(`unexpected: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { dir, inputPath } = await setupRealImage()
    const provider = new OpenAiCompatProvider(baseConfig({ size: '2048x2048', requestStyle: 'edits' }))
    await provider.eraseTextWithAI({
      inputPath,
      outputDir: join(dir, 'out'),
      region: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }
    })
    // 编辑/擦除场景不发送 size，避免模型缩放输出
    expect(capturedSize).toBeNull()
  })
})

import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_DOWNLOAD_BYTES,
  downloadToFile,
  extFromUrl,
  extOfMime,
  fileToBase64,
  fillTemplate,
  getByPath,
  mimeOfFile,
  sniffImageMime,
  uniqueResultPath
} from '../src/main/api/util'

describe('getByPath 点分路径取值', () => {
  const resp = {
    Result: {
      Data: {
        TaskId: 't-123',
        Status: 'done',
        ImageUrls: ['https://a.com/1.png', 'https://a.com/2.png'],
        Nested: [{ Name: 'x' }]
      }
    }
  }

  it('普通点分路径', () => {
    expect(getByPath(resp, 'Result.Data.TaskId')).toBe('t-123')
  })

  it('数组索引路径', () => {
    expect(getByPath(resp, 'Result.Data.ImageUrls[0]')).toBe('https://a.com/1.png')
    expect(getByPath(resp, 'Result.Data.ImageUrls[1]')).toBe('https://a.com/2.png')
  })

  it('中间段数组索引', () => {
    expect(getByPath(resp, 'Result.Data.Nested[0].Name')).toBe('x')
  })

  it('路径缺失返回 undefined，不抛错', () => {
    expect(getByPath(resp, 'Result.Missing')).toBeUndefined()
    expect(getByPath(resp, 'Result.Data.ImageUrls[9]')).toBeUndefined()
    expect(getByPath(resp, '')).toBeUndefined()
    expect(getByPath(null, 'a.b')).toBeUndefined()
  })
})

describe('fillTemplate 模板替换', () => {
  it('替换全部占位符', () => {
    expect(fillTemplate('{"a":"{reqKey}","b":"{taskId}"}', { reqKey: 'x', taskId: 'y' })).toBe(
      '{"a":"x","b":"y"}'
    )
  })

  it('缺失的占位符替换为空串', () => {
    expect(fillTemplate('{"a":"{missing}"}', {})).toBe('{"a":""}')
  })

  it('不匹配的花括号原样保留', () => {
    expect(fillTemplate('{"a":1}', { a: 'x' })).toBe('{"a":1}')
  })
})

describe('扩展名与 MIME 工具', () => {
  it('extFromUrl 从 URL 推断后缀，忽略 query', () => {
    expect(extFromUrl('https://cdn.x.com/out/12345.png?x=1')).toBe('.png')
    expect(extFromUrl('https://cdn.x.com/a.b.c.jpg')).toBe('.jpg')
  })

  it('extFromUrl 对无后缀/非法 URL 回退 .png', () => {
    expect(extFromUrl('https://cdn.x.com/download')).toBe('.png')
    expect(extFromUrl('not a url')).toBe('.png')
  })

  it('extOfMime / mimeOfFile 映射正确且大小写不敏感', () => {
    expect(extOfMime('image/png')).toBe('.png')
    expect(extOfMime('image/jpeg')).toBe('.jpg')
    expect(extOfMime('image/webp')).toBe('.webp')
    expect(extOfMime('application/octet-stream')).toBe('.png')
    expect(mimeOfFile('a.JPG')).toBe('image/jpeg')
    expect(mimeOfFile('a.unknown')).toBe('application/octet-stream')
  })
})

describe('uniqueResultPath', () => {
  it('保留原名并追加 _white 后缀（Windows 与 POSIX 分隔符）', () => {
    const p1 = uniqueResultPath('d', 'C:\\in\\toy.png', '.jpg')
    expect(p1).toBe(join('d', 'toy_white.jpg'))
    const p2 = uniqueResultPath('d', 'C:/in/toy.png', '.jpg')
    expect(p2).toBe(join('d', 'toy_white.jpg'))
  })
})

describe('fileToBase64', () => {
  it('读取文件并返回 base64', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'util-test-'))
    const p = join(dir, 'x.png')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(p, Buffer.from([1, 2, 3, 255]))
    expect(await fileToBase64(p)).toBe(Buffer.from([1, 2, 3, 255]).toString('base64'))
  })

  it('文件不存在时抛出友好中文错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'util-test-'))
    await expect(fileToBase64(join(dir, 'missing.png'))).rejects.toThrow(/无法读取图片文件/)
  })
})

describe('sniffImageMime 魔数嗅探', () => {
  it('识别常见图片格式', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))).toBe('image/png')
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('GIF89a1234', 'ascii'))).toBe('image/gif')
    expect(sniffImageMime(Buffer.from('RIFFxxxxWEBPVP8 ', 'ascii'))).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('BM1234', 'ascii'))).toBe('image/bmp')
  })

  it('非图片内容返回 null', () => {
    expect(sniffImageMime(Buffer.from('hello world'))).toBeNull()
    expect(sniffImageMime(Buffer.from(''))).toBeNull()
    expect(sniffImageMime(Buffer.from([1, 2, 3]))).toBeNull()
  })
})

describe('downloadToFile', () => {
  let server: ReturnType<typeof createServer>
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
      } else if (req.url === '/missing') {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/ok.png' })
        res.end()
      } else if (req.url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('this is not an image')
      } else if (req.url === '/huge') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_DOWNLOAD_BYTES + 1)
        })
        res.end('x')
      } else if (req.url === '/jpeg-as-png') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
      } else if (req.url === '/shortjpeg') {
        // 2 字节 JPEG 头，不足魔数所需长度
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(Buffer.from([0xff, 0xd8]))
      } else if (req.url === '/nocontent') {
        res.writeHead(204)
        res.end()
      } else {
        res.writeHead(500)
        res.end('boom')
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('下载 200 响应并写入文件（自动创建目录）', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'dl-test-')), 'nested')
    const out = await downloadToFile(`${base}/ok.png`, join(dir, 'a.png'))
    const buf = await readFile(out)
    expect([...buf]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  })

  it('非 2xx 响应抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile(`${base}/missing`, join(dir, 'b.png'))).rejects.toThrow(/HTTP 404/)
  })

  it('跟随 302 重定向', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    const out = await downloadToFile(`${base}/redirect`, join(dir, 'c.png'))
    const buf = await readFile(out)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('拒绝非 http/https 协议', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile('file:///C:/x.png', join(dir, 'd.png'))).rejects.toThrow(
      /不支持的结果地址协议/
    )
    await expect(downloadToFile('ftp://x/y.png', join(dir, 'd.png'))).rejects.toThrow(
      /不支持的结果地址协议/
    )
  })

  it('非法 URL 抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile('not a url', join(dir, 'd.png'))).rejects.toThrow(/不是合法 URL/)
  })

  it('下载内容非图片时删除文件并抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    const dest = join(dir, 'evil.png')
    await expect(downloadToFile(`${base}/text`, dest)).rejects.toThrow(/不是有效图片/)
    // 校验失败后文件应被删除
    await expect(readFile(dest)).rejects.toThrow()
  })

  it('Content-Length 超限抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile(`${base}/huge`, join(dir, 'd.png'))).rejects.toThrow(/结果图片过大/)
  })

  it('扩展名与魔数对齐：JPEG 内容按真实格式保存为 .jpg', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    const out = await downloadToFile(`${base}/jpeg-as-png`, join(dir, 'img.png'))
    expect(out).toMatch(/\.jpg$/)
  })

  it('204 无 body 响应抛 HTTP 错误而非 TypeError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile(`${base}/nocontent`, join(dir, 'x.png'))).rejects.toThrow(/HTTP 204/)
  })

  it('不足魔数长度的短文件判为无效图片', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-test-'))
    await expect(downloadToFile(`${base}/shortjpeg`, join(dir, 'short.png'))).rejects.toThrow(
      /不是有效图片/
    )
  })
})

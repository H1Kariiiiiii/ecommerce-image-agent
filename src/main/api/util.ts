import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, basename } from 'node:path'
import { finished } from 'node:stream/promises'
import { once } from 'node:events'

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
/** 结果图片下载超时（秒） */
export const DOWNLOAD_TIMEOUT_MS = 60_000

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif'
}

export function mimeOfFile(p: string): string {
  return MIME_BY_EXT[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

export function extOfMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/bmp':
      return '.bmp'
    case 'image/gif':
      return '.gif'
    default:
      return '.png'
  }
}

/** 原子写入 JSON 文件（临时文件 + rename，避免写一半崩溃损坏配置） */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, filePath)
}

/** 输入图片大小上限（避免误选超大文件导致 base64 内存翻倍） */
export const MAX_INPUT_BYTES = 80 * 1024 * 1024

/** 读取文件并转为 base64；文件不存在/超大时给出友好错误 */
export async function fileToBase64(p: string): Promise<string> {
  try {
    const st = await stat(p)
    if (st.size > MAX_INPUT_BYTES) {
      throw new Error(`图片文件过大（${Math.round(st.size / 1024 / 1024)}MB，上限 ${MAX_INPUT_BYTES / 1024 / 1024}MB）`)
    }
    const buf = await readFile(p)
    return buf.toString('base64')
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES') {
        throw new Error(`无法读取图片文件（不存在或无权限）：${p}`)
      }
    }
    throw err
  }
}

/** 按点分路径取值，支持数组索引，如 Result.Data.ImageUrls[0] / Result.Data.TaskId */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    const m = /^(.+?)\[(\d+)\]$/.exec(seg)
    if (m) {
      cur = (cur as Record<string, unknown>)[m[1]]
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(m[2])]
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

/** 模板替换：{key} -> value（缺失时替换为空串） */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '')
}

/** 常见图片格式魔数嗅探，返回 MIME；非图片返回 null */
export function sniffImageMime(buf: Buffer): string | null {
  const b = buf
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return null
}

/**
 * 下载 URL 到本地文件，返回保存路径。
 * 安全约束：仅允许 http/https、限制响应大小（50MB）、校验图片魔数并按魔数对齐扩展名。
 */
export async function downloadToFile(url: string, destPath: string): Promise<string> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`结果地址不是合法 URL：${url.slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的结果地址协议：${u.protocol}`)
  }
  await mkdir(dirname(destPath), { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      // res.body 在 204/HEAD 响应时为 null，需先判空再 cancel
      if (res.body) await res.body.cancel().catch(() => {})
      throw new Error(`下载结果图片失败：HTTP ${res.status} ${res.statusText}`)
    }
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_DOWNLOAD_BYTES) {
      await res.body.cancel().catch(() => {})
      throw new Error(`结果图片过大（${declared} 字节，上限 ${MAX_DOWNLOAD_BYTES}）`)
    }

    const out = createWriteStream(destPath)
    const reader = res.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_DOWNLOAD_BYTES) {
          throw new Error(`结果图片超过大小上限（${MAX_DOWNLOAD_BYTES} 字节）`)
        }
        if (!out.write(value)) {
          // 背压等待：drain 或 error 任一先到，避免写流出错后永久挂起
          await Promise.race([
            once(out, 'drain'),
            once(out, 'error').then(() => {
              throw new Error('写入结果图片失败（磁盘空间不足或文件被占用）')
            })
          ])
        }
      }
      out.end()
      await finished(out)
    } catch (err) {
      // 先 destroy 并注册 close 监听，再并行 cancel（避免 cancel 挂起时 close 已先触发导致等待永不结束）
      out.destroy()
      const closed = new Promise<void>((resolve) => out.once('close', () => resolve()))
      await Promise.all([reader.cancel().catch(() => {}), closed])
      await rm(destPath, { force: true }).catch(() => {})
      throw err
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`下载结果图片超时（超过 ${DOWNLOAD_TIMEOUT_MS / 1000} 秒）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  // 只读前 16 字节做魔数嗅探（避免 50MB 文件整读翻倍内存），按实际读取量判断
  const fh = await open(destPath, 'r')
  const head = Buffer.alloc(16)
  let bytesRead = 0
  try {
    ({ bytesRead } = await fh.read(head, 0, 16, 0))
  } finally {
    await fh.close()
  }
  const mime = sniffImageMime(head.subarray(0, bytesRead))
  if (!mime) {
    await rm(destPath, { force: true })
    throw new Error('下载的内容不是有效图片（魔数校验失败）')
  }
  // 扩展名与魔数对齐：URL 声称 .png 实为 JPEG 时按真实格式保存
  const wantExt = extOfMime(mime)
  const curExt = extname(destPath)
  if (curExt.toLowerCase() !== wantExt) {
    const fixed = destPath.slice(0, destPath.length - curExt.length) + wantExt
    await rename(destPath, fixed)
    return fixed
  }
  return destPath
}

/** 从 URL 推断文件后缀，失败返回 .png */
export function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = extname(pathname).toLowerCase()
    if (ext && ext.length <= 5 && /^\.[a-z0-9]+$/.test(ext)) return ext
  } catch {
    /* ignore */
  }
  return '.png'
}

/** 生成临时目录里的结果文件名（避免覆盖） */
export function uniqueResultPath(dir: string, baseName: string, ext: string): string {
  return join(dir, `${basename(baseName, extname(baseName))}_white${ext}`)
}

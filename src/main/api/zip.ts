/**
 * 最小 zip 读写（零依赖，只用 node:zlib）
 * ======================================
 * 只实现 xlsx 改写需要的两件事：
 *
 *   1. 读：解析中央目录、按名字取部件内容（并按需校验 CRC）；
 *   2. 重建：**未改动的部件原样复制原始字节**（含 local header 与压缩数据），
 *      只把被替换的部件重新压缩写入，最后重写中央目录与 EOCD。
 *
 * 第 2 点是「报价表格式零改动」的关键：列宽/行高/字体/边框/合并单元格/
 * 图片锚点所在的部件根本没被解码过，压缩流一个字节都没变。
 *
 * 不支持 ZIP64 / 加密 / 多卷 —— 会给出明确报错而不是写出坏文件。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CD = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_DATA_DESC = 0x08074b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const CRC_TABLE = ((): Int32Array => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export interface ZipEntryInfo {
  name: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  modTime: number
  modDate: number
  internalAttr: number
  externalAttr: number
  localHeaderOffset: number
  /** 中央目录原始记录（重建时原样写回，只改局部偏移量） */
  cdRaw: Buffer
  /** 本地记录原始字节（未改动时整段复制） */
  localRaw: Buffer
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + 22 + commentLen === buf.length) return i
  }
  // 少数写入器会在结尾附额外字节，放宽匹配
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

export class ZipArchive {
  private constructor(
    private readonly buf: Buffer,
    readonly entries: ZipEntryInfo[]
  ) {}

  static open(buf: Buffer): ZipArchive {
    if (buf.length < 22) throw new Error('不是有效的 zip（文件过小）')
    const eocd = findEocd(buf)
    if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾记录）')
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
      throw new Error('暂不支持 ZIP64 格式的压缩包（文件过大或部件数超过 65535）')
    }
    const total = buf.readUInt16LE(eocd + 10)
    const cdSize = buf.readUInt32LE(eocd + 12)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    if (cdOffset + cdSize > buf.length) throw new Error('中央目录越界，zip 已损坏')
    if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
      throw new Error('暂不支持分卷压缩的 zip')
    }

    const entries: ZipEntryInfo[] = []
    let p = cdOffset
    for (let i = 0; i < total; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) {
        throw new Error('中央目录记录损坏')
      }
      const flags = buf.readUInt16LE(p + 8)
      const method = buf.readUInt16LE(p + 10)
      const modTime = buf.readUInt16LE(p + 12)
      const modDate = buf.readUInt16LE(p + 14)
      const crc = buf.readUInt32LE(p + 16)
      const compressedSize = buf.readUInt32LE(p + 20)
      const uncompressedSize = buf.readUInt32LE(p + 24)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const internalAttr = buf.readUInt16LE(p + 36)
      const externalAttr = buf.readUInt32LE(p + 38)
      const localHeaderOffset = buf.readUInt32LE(p + 42)
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
      const recLen = 46 + nameLen + extraLen + commentLen
      const cdRaw = Buffer.from(buf.subarray(p, p + recLen))
      p += recLen

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error(`部件 ${name} 使用了 ZIP64 扩展字段，暂不支持`)
      }
      if ((flags & 0x1) !== 0) throw new Error(`部件 ${name} 已加密，无法处理`)
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        throw new Error(`部件 ${name} 使用不支持的压缩方式（method=${method}）`)
      }

      // 本地记录：定位数据区，并把整段原始字节留作「原样复制」用
      if (buf.readUInt32LE(localHeaderOffset) !== SIG_LOCAL) {
        throw new Error(`部件 ${name} 的本地记录损坏`)
      }
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26)
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen
      const dataEnd = dataStart + compressedSize
      let end = dataEnd
      if ((flags & 0x8) !== 0) {
        // 有数据描述符（数据长度写在数据之后）
        end += buf.readUInt32LE(dataEnd) === SIG_DATA_DESC ? 16 : 12
      }
      if (end > buf.length) throw new Error(`部件 ${name} 的数据越界，zip 已损坏`)
      const localRaw = Buffer.from(buf.subarray(localHeaderOffset, end))

      entries.push({
        name,
        method,
        flags,
        crc,
        compressedSize,
        uncompressedSize,
        modTime,
        modDate,
        internalAttr,
        externalAttr,
        localHeaderOffset,
        cdRaw,
        localRaw
      })
    }
    return new ZipArchive(buf, entries)
  }

  names(): string[] {
    return this.entries.map((e) => e.name)
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name)
  }

  /** 取出部件内容（解压） */
  read(name: string, encoding?: 'buffer'): Buffer
  read(name: string, encoding: BufferEncoding): string
  read(name: string, encoding: BufferEncoding | 'buffer' = 'buffer'): Buffer | string {
    const e = this.entries.find((x) => x.name === name)
    if (!e) throw new Error(`压缩包里没有部件：${name}`)
    const dataStart = e.localHeaderOffset + 30 + this.buf.readUInt16LE(e.localHeaderOffset + 26) + this.buf.readUInt16LE(e.localHeaderOffset + 28)
    const raw = this.buf.subarray(dataStart, dataStart + e.compressedSize)
    const out = e.method === METHOD_DEFLATE ? inflateRawSync(raw) : Buffer.from(raw)
    if (encoding === 'buffer') return out
    return out.toString(encoding)
  }

  /**
   * 重建 zip：`mods` 里列出的部件换成新内容，其余部件原样复制原始字节。
   * @returns 新的 zip buffer
   */
  rebuild(mods: Map<string, Buffer> = new Map()): Buffer {
    for (const name of mods.keys()) {
      if (!this.has(name)) throw new Error(`要替换的部件不存在：${name}`)
    }
    const locals: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0

    for (const e of this.entries) {
      const mod = mods.get(e.name)
      if (mod === undefined) {
        locals.push(e.localRaw)
        const cd = Buffer.from(e.cdRaw)
        cd.writeUInt32LE(offset, 42)
        central.push(cd)
        offset += e.localRaw.length
      } else {
        const { record, cdRecord } = buildEntry(e, mod, offset)
        locals.push(record)
        central.push(cdRecord)
        offset += record.length
      }
    }

    const cdOffset = offset
    const cd = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 8)
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xffff), 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)
    eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...locals, cd, eocd])
  }

  /** 逐个部件解压并核对 CRC，返回问题列表（空 = 通过） */
  verify(): string[] {
    const issues: string[] = []
    for (const e of this.entries) {
      if (e.name.endsWith('/')) continue
      let data: Buffer
      try {
        data = this.read(e.name)
      } catch (err) {
        issues.push(`${e.name} 解压失败：${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (data.length !== e.uncompressedSize) {
        issues.push(`${e.name} 长度不符（期望 ${e.uncompressedSize}，实际 ${data.length}）`)
      }
      if (crc32(data) !== e.crc) issues.push(`${e.name} CRC 校验失败`)
    }
    return issues
  }
}

/** 用新的内容构造一条本地记录 + 中央目录记录（复用原条目的时间戳与属性） */
function buildEntry(
  e: ZipEntryInfo,
  data: Buffer,
  offset: number
): { record: Buffer; cdRecord: Buffer } {
  const nameBuf = Buffer.from(e.name, 'utf8')
  const crc = crc32(data)
  const deflated = deflateRawSync(data, { level: 6 })
  const useStore = deflated.length >= data.length
  const body = useStore ? data : deflated
  const method = useStore ? METHOD_STORE : METHOD_DEFLATE
  // 部件名含非 ASCII 时置 UTF-8 标志位（xlsx 部件名都是 ASCII，此处仅为稳妥）
  const flags = /^[\x20-\x7e]*$/.test(e.name) ? 0 : 0x800

  const local = Buffer.alloc(30 + nameBuf.length)
  local.writeUInt32LE(SIG_LOCAL, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(e.modTime, 10)
  local.writeUInt16LE(e.modDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  nameBuf.copy(local, 30)

  const cd = Buffer.alloc(46 + nameBuf.length)
  cd.writeUInt32LE(SIG_CD, 0)
  cd.writeUInt16LE(e.cdRaw.readUInt16LE(0), 4) // 保留原 versionMadeBy
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(flags, 8)
  cd.writeUInt16LE(method, 10)
  cd.writeUInt16LE(e.modTime, 12)
  cd.writeUInt16LE(e.modDate, 14)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(body.length, 20)
  cd.writeUInt32LE(data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(e.internalAttr, 36)
  cd.writeUInt32LE(e.externalAttr, 38)
  cd.writeUInt32LE(offset, 42)
  nameBuf.copy(cd, 46)

  return { record: Buffer.concat([local, body]), cdRecord: cd }
}

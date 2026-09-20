import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ZipArchive, crc32 } from '../src/main/api/zip'

const run = promisify(execFile)

const PY_MAKE = `
import zipfile, sys, json, os
out = sys.argv[1]
parts = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t>JT666-5</t></si><si><t>\u73a9\u5177</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData/></worksheet>',
    'xl/drawings/drawing1.xml': '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="a" xmlns:r="b"><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Picture 1" descr="JT666-5"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:wsDr>',
}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for k, v in parts.items():
        z.writestr(k, v.encode('utf-8'))
    # 一张「图片」：随机二进制 + STORED 方式，验证两种压缩方式都能原样保留
    z.writestr('xl/media/image1.jpeg', bytes(range(256)) * 40, compress_type=zipfile.ZIP_STORED)
    z.writestr('xl/media/image2.jpeg', __import__('os').urandom(3000), compress_type=zipfile.ZIP_DEFLATED)
print(json.dumps({'parts': list(parts.keys())}))
`

const PY_CHECK = `
import zipfile, sys, json, hashlib
p = sys.argv[1]
expect = json.loads(sys.argv[2])
res = {'bad': None, 'names': [], 'hash': {}, 'error': None}
try:
    with zipfile.ZipFile(p) as z:
        res['bad'] = z.testzip()
        res['names'] = z.namelist()
        for n in z.namelist():
            res['hash'][n] = hashlib.sha256(z.read(n)).hexdigest()
except Exception as e:
    res['error'] = repr(e)
print(json.dumps(res))
`

async function py(script: string, args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pyscript-'))
  const f = join(dir, 's.py')
  await writeFile(f, script, 'utf8')
  const { stdout } = await run('python', [f, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  return stdout.trim()
}

describe('zip.ts（零依赖最小实现）', () => {
  it('crc32 与标准实现一致', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686)
    expect(crc32(Buffer.from(''))).toBe(0)
  })

  it('能读 Python zipfile 写出的包，并逐部件还原内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    const src = join(dir, 'in.zip')
    await py(PY_MAKE, [src])

    const buf = await readFile(src)
    const z = ZipArchive.open(buf)
    expect(z.verify()).toEqual([])
    expect(z.names()).toContain('xl/media/image1.jpeg')
    expect(z.read('xl/sharedStrings.xml', 'utf8')).toContain('JT666-5')
    // 随机二进制部件必须逐字节还原
    const img = z.read('xl/media/image1.jpeg')
    expect(img.length).toBe(256 * 40)
    expect(img[0]).toBe(0)
    expect(img[255]).toBe(255)
  })

  it('重建后：未改动的部件保持原始压缩字节，改动的部件内容正确', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    const src = join(dir, 'in.zip')
    await py(PY_MAKE, [src])
    const buf = await readFile(src)
    const z = ZipArchive.open(buf)

    const before = new Map(z.entries.map((e) => [e.name, e.localRaw]))

    const mods = new Map<string, Buffer>()
    mods.set('xl/sharedStrings.xml', Buffer.from('<?xml version="1.0"?><sst><si><t>TJ666-5</t></si></sst>', 'utf8'))
    mods.set('xl/media/image1.jpeg', Buffer.from('NEW-IMAGE-BYTES'))
    const out = z.rebuild(mods)

    const z2 = ZipArchive.open(out)
    expect(z2.verify()).toEqual([])
    expect(z2.names()).toEqual(z.names())
    expect(z2.read('xl/sharedStrings.xml', 'utf8')).toContain('TJ666-5')
    expect(z2.read('xl/sharedStrings.xml', 'utf8')).not.toContain('JT666-5')
    expect(z2.read('xl/media/image1.jpeg').toString()).toBe('NEW-IMAGE-BYTES')
    // 没动过的部件：压缩流一个字节都不能变
    for (const e of z2.entries) {
      if (mods.has(e.name)) continue
      expect(e.localRaw.equals(before.get(e.name)!)).toBe(true)
      expect(z2.read(e.name).equals(z.read(e.name))).toBe(true)
    }

    // 交给 Python zipfile 验证（最权威的裁判）
    const outPath = join(dir, 'out.zip')
    await writeFile(outPath, out)
    const res = JSON.parse(await py(PY_CHECK, [outPath, '{}'])) as {
      bad: string | null
      names: string[]
      hash: Record<string, string>
    }
    expect(res.bad).toBeNull()
    expect(res.names).toEqual(z.names())
    expect(res.hash['xl/sharedStrings.xml']).toBe(
      (await import('node:crypto')).createHash('sha256')
        .update(Buffer.from('<?xml version="1.0"?><sst><si><t>TJ666-5</t></si></sst>', 'utf8'))
        .digest('hex')
    )
  })

  it('原样重建（不替换任何部件）后仍是合法 zip 且内容一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    const src = join(dir, 'in.zip')
    await py(PY_MAKE, [src])
    const z = ZipArchive.open(await readFile(src))
    const out = z.rebuild()
    const z2 = ZipArchive.open(out)
    expect(z2.verify()).toEqual([])
    for (const n of z.names()) expect(z2.read(n).equals(z.read(n))).toBe(true)
  })

  it('损坏的 zip 给出明确报错', async () => {
    expect(() => ZipArchive.open(Buffer.from('not a zip at all, definitely'))).toThrow(/zip/)
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    const src = join(dir, 'in.zip')
    await py(PY_MAKE, [src])
    const buf = await readFile(src)
    const broken = Buffer.from(buf)
    broken.writeUInt32LE(0, broken.length - 22) // 破坏 EOCD 签名
    expect(() => ZipArchive.open(broken)).toThrow(/zip/)
  })

  it('替换不存在的部件时报错，不会写出坏包', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-test-'))
    const src = join(dir, 'in.zip')
    await py(PY_MAKE, [src])
    const z = ZipArchive.open(await readFile(src))
    expect(() => z.rebuild(new Map([['nope.xml', Buffer.from('x')]]))).toThrow(/不存在/)
  })
})

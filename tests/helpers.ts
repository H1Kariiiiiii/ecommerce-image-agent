import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 仅含 PNG 魔数头的伪图片（用于模拟「服务返回了看起来是图片但非解码图」的探测场景） */
export const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 1, 1, 1]

/** 创建临时目录并写入一张最小 PNG 输入图（仅魔数头，可被魔数嗅探识别，但 sharp 无法解码） */
export async function setupInput(): Promise<{ dir: string; inputPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'img-test-'))
  const inputPath = join(dir, 'toy.png')
  await writeFile(inputPath, Buffer.from(PNG_BYTES))
  return { dir, inputPath }
}

/**
 * 创建一个真正可解码的 PNG 图（sharp 可读），用于创建 mask/OCR 等真正解码图片的测试。
 * 默认生成灰色底图，可选在指定区域绘制黑色文字（模拟货号）。
 */
export async function createRealPng(
  opts: {
    width?: number
    height?: number
    background?: { r: number; g: number; b: number }
    /** 在区域内填充黑色像素，模拟文字 */
    textRect?: { x: number; y: number; w: number; h: number }
  } = {}
): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const width = opts.width ?? 200
  const height = opts.height ?? 100
  const bg = opts.background ?? { r: 200, g: 200, b: 200 }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(${bg.r},${bg.g},${bg.b})"/>
    <rect fill="#000000" opacity="0"/>
  </svg>`

  let buf = await sharp(Buffer.from(svg)).png().toBuffer()

  // 绘制文字矩形（黑色块模拟文字区域）
  if (opts.textRect) {
    const t = opts.textRect
    const textSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="#000000" opacity="0"/>
      <text x="${t.x + t.w / 2}" y="${t.y + t.h * 0.8}" font-size="${t.h * 0.7}" fill="black" text-anchor="middle" font-family="Arial">TOY-001</text>
    </svg>`
    buf = await sharp(buf).composite([{ input: Buffer.from(textSvg) }]).png().toBuffer()
  }

  return buf
}

/** 将真实 PNG 写入临时目录，返回路径 */
export async function setupRealImage(opts: Parameters<typeof createRealPng>[0] = {}): Promise<{ dir: string; inputPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'img-test-'))
  const inputPath = join(dir, 'toy.png')
  const buf = await createRealPng(opts)
  await writeFile(inputPath, buf)
  return { dir, inputPath }
}
/**
 * 造一份最小但结构完整的 .xlsx（内容类型 / 关系 / 绘图 / 共享字符串 / 嵌入图俱全），
 * 用于报价表改写测试。用 Python 的 zipfile 写，保证是「外部工具产出的真实 zip」，
 * 而不是我们自己实现的 zip 写出来的（那样就成了自证）。
 */
export async function makeXlsxFixture(
  dir: string,
  opts: { codes: string[]; images: Buffer[] } = { codes: ['JT666-5'], images: [] }
): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const out = join(dir, '报价表.xlsx')
  const mediaPaths: string[] = []
  for (let i = 0; i < opts.images.length; i++) {
    const p = join(dir, `media${i}.jpg`)
    await writeFile(p, opts.images[i])
    mediaPaths.push(p)
  }
  const script = `
import zipfile, sys, json
out = sys.argv[1]
codes = json.loads(sys.argv[2])
medias = sys.argv[3:]
CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' \
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' \
  '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>' \
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' \
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' \
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' \
  '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
ROOT = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
WB = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>'
WBRELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="drawings/drawing1.xml"/></Relationships>'
SST = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">%s</sst>' % (len(codes), len(codes), ''.join('<si><t>%s</t></si>' % c for c in codes))
SHEET = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="14.5"/></cols><sheetData/></worksheet>'
SHRELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'
pics = ''
for i, c in enumerate(codes):
    pics += '<xdr:twoCellAnchor><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="%d" name="Picture %d" descr="%s"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId%d"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>' % (i + 2, i + 1, c, i + 1)
DRAW = '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">%s</xdr:wsDr>' % pics
DRELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>' % ''.join(
    '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image%d.jpeg"/>' % (i + 1, i + 1) for i in range(len(medias)))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT)
    z.writestr('_rels/.rels', ROOT)
    z.writestr('xl/workbook.xml', WB)
    z.writestr('xl/_rels/workbook.xml.rels', WBRELS)
    z.writestr('xl/sharedStrings.xml', SST)
    z.writestr('xl/worksheets/sheet1.xml', SHEET)
    z.writestr('xl/worksheets/_rels/sheet1.xml.rels', SHRELS)
    z.writestr('xl/drawings/drawing1.xml', DRAW)
    z.writestr('xl/drawings/_rels/drawing1.xml.rels', DRELS)
    for i, p in enumerate(medias):
        z.write(p, 'xl/media/image%d.jpeg' % (i + 1))
print(out)
`
  const { stdout } = await run('python', ['-c', script, out, JSON.stringify(opts.codes), ...mediaPaths], {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  return stdout.trim() || out
}

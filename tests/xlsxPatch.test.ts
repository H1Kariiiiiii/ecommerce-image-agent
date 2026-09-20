import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ZipArchive } from '../src/main/api/zip'
import { looksLikeXlsx, mappingCandidates, patchXlsx, verifyXlsxBuffer, xmlError } from '../src/main/api/xlsxPatch'

const run = promisify(execFile)
const PY_DIR = join(process.cwd(), '货号与报价表处理工具_v1.1', '货号与报价表处理工具')

const PY_FIXTURE = `
import zipfile, sys
out, jpg1, jpg2 = sys.argv[1], sys.argv[2], sys.argv[3]

NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>'''

root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="''' + NS_R + '''">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>'''

wb_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="drawings/drawing1.xml"/>
</Relationships>'''

# 故意把两个货号也放进 sharedStrings，且第二个带 NO. 前缀
shared_strings = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>JT666-5</t></si>
<si><t>NO.JT888-11Z-1</t></si>
<si><t>\u73a9\u5177\u540d\u79f0</t></si>
<si><t xml:space="preserve">JT999-13A </t></si>
</sst>'''

sheet = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols><col min="1" max="1" width="12.5" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/></cols>
<sheetData><row r="1" ht="95" customHeight="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>
<row r="2" ht="95" customHeight="1"><c r="A2" t="s"><v>1</v></c></row></sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>'''

sheet_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>'''

drawing = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="''' + NS_XDR + '''" xmlns:a="''' + NS_A + '''" xmlns:r="''' + NS_R + '''">
<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1" descr="JT666-5"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>
<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="JT888-11Z-1"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>'''

drawing_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.jpeg"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.jpeg"/>
</Relationships>'''

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', root_rels)
    z.writestr('xl/workbook.xml', workbook)
    z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
    z.writestr('xl/sharedStrings.xml', shared_strings)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
    z.writestr('xl/worksheets/_rels/sheet1.xml.rels', sheet_rels)
    z.writestr('xl/drawings/drawing1.xml', drawing)
    z.writestr('xl/drawings/_rels/drawing1.xml.rels', drawing_rels)
    z.write(jpg1, 'xl/media/image1.jpeg')
    z.write(jpg2, 'xl/media/image2.jpeg')
print(out)
`

const PY_INSPECT = `
import zipfile, sys, json
p = sys.argv[1]
res = {'bad': None, 'names': [], 'descr': [], 'strings': [], 'sizes': {}, 'error': None}
try:
    from PIL import Image
    import io
    with zipfile.ZipFile(p) as z:
        res['bad'] = z.testzip()
        res['names'] = z.namelist()
        d = z.read('xl/drawings/drawing1.xml').decode('utf-8')
        import re
        res['descr'] = re.findall(r'(?:descr|name)="([^"]*)"', d)
        s = z.read('xl/sharedStrings.xml').decode('utf-8')
        res['strings'] = re.findall(r'<t[^>]*>([^<]*)</t>', s)
        for n in z.namelist():
            if n.startswith('xl/media/'):
                im = Image.open(io.BytesIO(z.read(n)))
                res['sizes'][n] = list(im.size)
except Exception as e:
    res['error'] = repr(e)
print(json.dumps(res))
`

async function py(script: string, args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pyscript-'))
  const f = join(dir, 's.py')
  await writeFile(f, script, 'utf8')
  const { stdout } = await run('python', [f, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  return stdout.trim()
}

const OLD_PARTS = [
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/_rels/sheet1.xml.rels',
  'xl/drawings/_rels/drawing1.xml.rels'
]

describe('xlsxPatch（报价表换图改货号）', () => {
  it('xmlError 能识别良构与不良构', () => {
    expect(xmlError('<a><b/></a>')).toBeNull()
    expect(xmlError('<a><b></a>')).toMatch(/标签不匹配/)
    expect(xmlError('<a><b/>')).toMatch(/标签未闭合/)
    expect(xmlError('<!-- 没关')).toMatch(/注释未闭合/)
  })

  it('mappingCandidates 的回退顺序与 Python 版一致', () => {
    expect(mappingCandidates('JT666-5', 'JT', 'TJ')).toEqual(['TJ666-5', 'JT666-5'])
    // 与 Python 版一致：去掉 NO. 后只回退到「换了前缀的货号」，不会补回 NO.（NO. 在有图片名时也匹配不到文件）
    expect(mappingCandidates('NO.JT888-1', 'JT', 'TJ')).toEqual(['NO.JT888-1', 'TJ888-1'])
    expect(mappingCandidates('AB123', 'JT', 'TJ')).toEqual(['AB123'])
  })

  it('能识别非 xlsx（老式 .xls 改名成 .xlsx）', async () => {
    // 老式 .xls 内部也有一个小 zip，只改扩展名时包里没有工作表部件
    const dir = await mkdtemp(join(tmpdir(), 'notxlsx-'))
    const p = join(dir, 'old.xlsx')
    const { default: AdmZipLike } = { default: null as null }
    void AdmZipLike
    // 用 Python 造一个「有 zip 结构但没有工作表」的包
    await py(
      `import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('Theme/theme1.xml', '<theme/>')
z.writestr('[Content_Types].xml', '<Types/>')
z.close()`,
      [p]
    )
    const z = ZipArchive.open(await readFile(p))
    const r = looksLikeXlsx(z)
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/老式 \.xls/)
  })

  it('端到端：换图 + 改货号，未改动部件保持原始压缩字节', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlsx-test-'))
    const xlsx = join(dir, '报价表.xlsx')

    // 原表里嵌的图：960x720 与 800x600
    const jpg1 = join(dir, 'old1.jpg')
    const jpg2 = join(dir, 'old2.jpg')
    await writeFile(jpg1, await sharp({ create: { width: 960, height: 720, channels: 3, background: '#3366ff' } }).jpeg().toBuffer())
    await writeFile(jpg2, await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ff6633' } }).jpeg().toBuffer())
    await py(PY_FIXTURE, [xlsx, jpg1, jpg2])

    // 新图片文件夹：文件名 = 新货号，尺寸故意与老图不同（验证会被缩放到老图尺寸）
    const imgDir = join(dir, '新图')
    await mkdir(imgDir, { recursive: true })
    await writeFile(join(imgDir, 'TJ666-5.jpg'), await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#22cc55' } }).jpeg().toBuffer())
    await writeFile(join(imgDir, 'TJ888-11Z-1.jpg'), await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#cc22aa' } }).jpeg().toBuffer())

    const before = ZipArchive.open(await readFile(xlsx))
    expect(looksLikeXlsx(before).ok).toBe(true)

    const res = await patchXlsx({ xlsxPath: xlsx, imageDir: imgDir, oldPrefix: 'JT', newPrefix: 'TJ' })
    expect(res.buffer).toBeDefined()
    expect(res.plan.picturesPlanned).toBe(2)
    expect(res.plan.codesPlanned).toBe(3)

    const out = join(dir, 'out.xlsx')
    await writeFile(out, res.buffer!)

    // 1) 我们自己的校验必须全绿
    expect(verifyXlsxBuffer(res.buffer!, 'JT', 'TJ')).toEqual([])

    // 2) 没动过的部件：压缩流逐字节相同
    const after = ZipArchive.open(res.buffer!)
    for (const n of OLD_PARTS) {
      const a = before.entries.find((e) => e.name === n)!
      const b = after.entries.find((e) => e.name === n)!
      expect(b.localRaw.equals(a.localRaw)).toBe(true)
    }
    // 部件清单不能增删
    expect(after.names()).toEqual(before.names())

    // 3) Python 的 zipfile 与 PIL 做裁判
    const info = JSON.parse(await py(PY_INSPECT, [out])) as {
      bad: string | null
      descr: string[]
      strings: string[]
      sizes: Record<string, number[]>
      error: string | null
    }
    expect(info.error).toBeNull()
    expect(info.bad).toBeNull()
    expect(info.descr).toContain('TJ666-5')
    expect(info.descr).toContain('TJ888-11Z-1')
    expect(info.descr).not.toContain('JT666-5')
    expect(info.strings).toContain('TJ666-5')
    expect(info.strings).toContain('NO.TJ888-11Z-1')
    expect(info.strings).toContain('玩具名称')
    expect(info.strings.join('|')).not.toMatch(/(^|>|\|)JT\d/)
    // 嵌入图被缩放到原图尺寸：排版不变
    expect(info.sizes['xl/media/image1.jpeg']).toEqual([960, 720])
    expect(info.sizes['xl/media/image2.jpeg']).toEqual([800, 600])
  }, 300000)

  it('与 Python 原版 quote_tool 结果对比：改动的部件集合一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlsx-parity-'))
    const xlsx = join(dir, '报价表.xlsx')
    const jpg1 = join(dir, 'old1.jpg')
    const jpg2 = join(dir, 'old2.jpg')
    await writeFile(jpg1, await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3366ff' } }).jpeg().toBuffer())
    await writeFile(jpg2, await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ff6633' } }).jpeg().toBuffer())
    await py(PY_FIXTURE, [xlsx, jpg1, jpg2])
    const imgDir = join(dir, '新图')
    await mkdir(imgDir, { recursive: true })
    await writeFile(join(imgDir, 'TJ666-5.jpg'), await sharp({ create: { width: 1000, height: 750, channels: 3, background: '#22cc55' } }).jpeg().toBuffer())
    await writeFile(join(imgDir, 'TJ888-11Z-1.jpg'), await sharp({ create: { width: 1000, height: 750, channels: 3, background: '#cc22aa' } }).jpeg().toBuffer())

    // Python 原版
    const pyOut = join(dir, 'py.xlsx')
    await run('python', [
      join(PY_DIR, 'quote_tool.py'), '-q', xlsx, '-d', imgDir, '--old', 'JT', '--new', 'TJ', '-o', pyOut
    ], { cwd: PY_DIR, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })

    // TS 移植版
    const res = await patchXlsx({ xlsxPath: xlsx, imageDir: imgDir, oldPrefix: 'JT', newPrefix: 'TJ' })
    const tsOut = join(dir, 'ts.xlsx')
    await writeFile(tsOut, res.buffer!)

    const before = ZipArchive.open(await readFile(xlsx))
    const changed = (p: string): string[] => {
      const z = ZipArchive.open(require('node:fs').readFileSync(p))
      const set: string[] = []
      for (const e of z.entries) {
        const b = before.entries.find((x) => x.name === e.name)
        if (!b || !b.localRaw.equals(e.localRaw)) set.push(e.name)
      }
      return set.sort()
    }
    const pyChanged = changed(pyOut)
    const tsChanged = changed(tsOut)
    const pyText = JSON.parse(await py(PY_INSPECT, [pyOut])) as { descr: string[]; strings: string[] }
    const tsText = JSON.parse(await py(PY_INSPECT, [tsOut])) as { descr: string[]; strings: string[] }
    console.log('\nPython 改动部件:', pyChanged.join(', '))
    console.log('TS     改动部件:', tsChanged.join(', '))
    console.log('Python descr:', pyText.descr.filter((d) => !d.startsWith('Picture')).join(','), '| strings:', pyText.strings.join(','))
    console.log('TS     descr:', tsText.descr.filter((d) => !d.startsWith('Picture')).join(','), '| strings:', tsText.strings.join(','))
    expect(tsChanged).toEqual(pyChanged)
    expect(tsText.strings).toEqual(pyText.strings)
    expect(tsText.descr).toEqual(pyText.descr)
  }, 300000)
})

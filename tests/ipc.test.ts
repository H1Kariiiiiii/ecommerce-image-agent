import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type ProcessImageResponse } from '../src/shared/types'

const state = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  savePath: null as string | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      state.handlers.set(ch, fn)
    },
    on: (ch: string, fn: (...a: unknown[]) => unknown) => {
      state.handlers.set(`on:${ch}`, fn)
    }
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: state.savePath }))
  },
  BrowserWindow: { fromWebContents: () => undefined }
}))

type IpcModule = typeof import('../src/main/ipc')
let ipc: IpcModule

async function setup(): Promise<void> {
  vi.resetModules()
  state.handlers.clear()
  state.savePath = null
  state.userData = await mkdtemp(join(tmpdir(), 'ipc-test-'))
  ipc = await import('../src/main/ipc')
  ipc.registerIpcHandlers()
}

const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> => {
  const fn = state.handlers.get(ch)
  if (!fn) throw new Error(`no handler for ${ch}`)
  return fn({ sender: {} }, ...args) as Promise<T>
}

describe('路径授权模型（isAuthorizedInput / authorizePath）', () => {
  beforeEach(setup)

  it('未登记的任意路径默认拒绝', () => {
    expect(ipc.isAuthorizedInput('C:/evil/secret.png')).toBe(false)
  })

  it('authorizePath 登记后放行', () => {
    ipc.authorizePath('C:/in/toy.png')
    expect(ipc.isAuthorizedInput('C:/in/toy.png')).toBe(true)
  })

  it('反斜杠登记、正斜杠请求（asset:// 解码形式）也放行', () => {
    // 回归：asset:// 协议解码为 C:/... 而对话框/拖拽登记为 C:\...，必须归一化匹配
    ipc.authorizePath('C:\\Users\\me\\Pictures\\微信图片 2026.jpg')
    expect(ipc.isAuthorizedInput('C:/Users/me/Pictures/微信图片 2026.jpg')).toBe(true)
    expect(ipc.isAuthorizedInput('C:\\Users\\me\\Pictures\\微信图片 2026.jpg')).toBe(true)
    // 正斜杠登记、反斜杠请求同样放行
    ipc.authorizePath('D:/photos/toy.png')
    expect(ipc.isAuthorizedInput('D:\\photos\\toy.png')).toBe(true)
  })

  it('userData/processed 结果目录内路径放行（Windows 与 POSIX 分隔符）', () => {
    const out = join(state.userData, 'processed')
    expect(ipc.isAuthorizedInput(join(out, 'a_white.png'))).toBe(true)
    expect(ipc.isAuthorizedInput(join(out, 'a_white.png').replace(/\\/g, '/'))).toBe(true)
    // 仅前缀相同但不属于结果目录的路径拒绝
    expect(ipc.isAuthorizedInput(join(state.userData, 'processed_x', 'a.png'))).toBe(false)
  })

  it('authorizePath 忽略空值/非字符串', () => {
    ipc.authorizePath('')
    ipc.authorizePath('C:/a.png')
    expect(ipc.isAuthorizedInput('C:/a.png')).toBe(true)
  })

  it('authorizePath 支持数组批量登记（多文件拖拽）', () => {
    ipc.authorizePath(['C:/in/a.png', '', 'C:/in/b.png', 7 as unknown as string])
    expect(ipc.isAuthorizedInput('C:/in/a.png')).toBe(true)
    expect(ipc.isAuthorizedInput('C:/in/b.png')).toBe(true)
    expect(ipc.isAuthorizedInput('C:/in/c.png')).toBe(false)
  })

  it('Windows 下授权路径大小写不敏感（登记 C:/In/A.png 放行 c:/in/a.png）', () => {
    ipc.authorizePath('C:/In/A.png')
    if (process.platform === 'win32') {
      expect(ipc.isAuthorizedInput('c:/in/a.png')).toBe(true)
      expect(ipc.isAuthorizedInput('C:/IN/A.PNG')).toBe(true)
      expect(ipc.isAuthorizedInput('C:\\in\\a.png')).toBe(true)
    } else {
      // POSIX 保持大小写敏感
      expect(ipc.isAuthorizedInput('c:/in/a.png')).toBe(false)
    }
  })

  it('UNC 路径登记与 asset:// 解码形式互相匹配（UNC 403 修复）', () => {
    // 对话框/拖拽登记为 \\nas\share\img.png，asset:// 解码为 //nas/share/img.png
    ipc.authorizePath('\\\\nas\\share\\img.png')
    expect(ipc.isAuthorizedInput('//nas/share/img.png')).toBe(true)
    expect(ipc.isAuthorizedInput('\\\\nas\\share\\img.png')).toBe(true)
    if (process.platform === 'win32') {
      // 大小写混合的 UNC 同样放行
      expect(ipc.isAuthorizedInput('//NAS/Share/IMG.png')).toBe(true)
    }
    // 相似前缀不误放行
    expect(ipc.isAuthorizedInput('//nas/share2/img.png')).toBe(false)
    expect(ipc.isAuthorizedInput('/nas/share/img.png')).toBe(false)
  })
})

describe('processImage 授权校验', () => {
  beforeEach(setup)

  it('未授权路径直接拒绝，不调用 provider', async () => {
    const res = await invoke<ProcessImageResponse>(IPC.processImage, { inputPath: 'C:/evil/x.png' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未授权')
  })

  it('授权后的路径放行（错误不再是未授权，而是进入 provider 流程）', async () => {
    ipc.authorizePath('C:/in/toy.png')
    const res = await invoke<ProcessImageResponse>(IPC.processImage, { inputPath: 'C:/in/toy.png' })
    expect(res.ok).toBe(false)
    expect(res.error).not.toContain('未授权')
    // 已放行进入 provider 流程：默认 provider 未配置 model → 报「未配置 model」（而非未授权）
    expect(res.error).toContain('model')
  })

  it('method=local：无需 provider，纯算法直接出白底图', async () => {
    const { createRealPng } = await import('./helpers')
    const { access, mkdir, writeFile } = await import('node:fs/promises')
    const inDir = join(state.userData, 'processed')
    await mkdir(inDir, { recursive: true })
    const inputPath = join(inDir, 'toy-local.png')
    await writeFile(
      inputPath,
      await createRealPng({ width: 64, height: 48, background: { r: 210, g: 210, b: 210 } })
    )
    ipc.authorizePath(inputPath)
    const res = await invoke<ProcessImageResponse>(IPC.processImage, { inputPath, method: 'local' })
    expect(res.ok).toBe(true)
    expect(res.outputPath).toBeTruthy()
    await expect(access(res.outputPath!)).resolves.toBeUndefined()
  })

  it('paths:authorize 通道登记拖拽路径', async () => {
    const onAuth = state.handlers.get(`on:${IPC.pathsAuthorize}`)!
    onAuth({}, 'C:/drop/toy.png')
    expect(ipc.isAuthorizedInput('C:/drop/toy.png')).toBe(true)
  })
})

describe('exportImage 授权校验', () => {
  beforeEach(setup)

  it('未授权路径抛出错误', async () => {
    await expect(invoke(IPC.exportImage, 'C:/evil/secret.txt')).rejects.toThrow(/未授权的导出路径/)
  })

  it('授权路径（结果目录内）放行并返回保存路径', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const outDir = join(state.userData, 'processed')
    await mkdir(outDir, { recursive: true })
    const outFile = join(outDir, 'a_white.png')
    await writeFile(outFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
    state.savePath = join(state.userData, 'saved.png')
    const saved = await invoke<string | null>(IPC.exportImage, outFile)
    expect(saved).toBe(join(state.userData, 'saved.png'))
  })
})

describe('exportImagesToDir 同名文件唯一化', () => {
  beforeEach(setup)

  it('目标已存在同名文件时自动追加序号，不互相覆盖', async () => {
    const { mkdir, writeFile, readdir } = await import('node:fs/promises')
    const outDir = join(state.userData, 'processed')
    await mkdir(outDir, { recursive: true })
    const src1 = join(outDir, '1_white.png')
    const src2 = join(outDir, '2_white.png')
    await writeFile(src1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
    await writeFile(src2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]))
    // 两个源文件同名（不同目录），导出到同一目录
    const sub = join(state.userData, 'src-b')
    await mkdir(sub, { recursive: true })
    const src2b = join(sub, '1_white.png')
    await writeFile(src2b, Buffer.from([0x89, 0x50, 0x4e, 0x47, 3]))
    ipc.authorizePath([src1, src2b])

    const exportDir = join(state.userData, 'export')
    await mkdir(exportDir, { recursive: true })
    const openDialog = (await import('electron')).dialog.showOpenDialog as unknown as ReturnType<typeof vi.fn>
    openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [exportDir] })

    const dir = await invoke<string | null>(IPC.exportImagesToDir, [src1, src2b])
    expect(dir).toBe(exportDir)
    const files = await readdir(exportDir)
    expect(files).toContain('1_white.png')
    expect(files).toContain('1_white (1).png')
    expect(files).toHaveLength(2)
  })
})

describe('目录授权（批量货号 / 报价表用）', () => {
  beforeEach(setup)

  it('authorizeDir 后其下所有文件放行，相似前缀目录不放行', () => {
    ipc.authorizeDir('C:/shop/in')
    expect(ipc.isAuthorizedInput('C:/shop/in/a.jpg')).toBe(true)
    expect(ipc.isAuthorizedInput('C:/shop/in/sub/b.jpg')).toBe(true)
    expect(ipc.isAuthorizedInput('C:/shop/in')).toBe(true)
    // 仅前缀相同的兄弟目录必须拒绝（不能写成 startsWith(dir)）
    expect(ipc.isAuthorizedInput('C:/shop/in2/b.jpg')).toBe(false)
    expect(ipc.isAuthorizedInput('C:/shop/other/b.jpg')).toBe(false)
  })

  it('反斜杠选中的目录，正斜杠请求也放行', () => {
    ipc.authorizeDir('C:\\shop\\in')
    expect(ipc.isAuthorizedInput('C:/shop/in/a.jpg')).toBe(true)
  })
})

describe('批量改货号 IPC（label:preview / label:run / label:cancel）', () => {
  beforeEach(setup)

  async function makeJob(): Promise<{ inputDir: string; outDir: string }> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const sharp = (await import('sharp')).default
    const inputDir = join(state.userData, 'shop')
    await mkdir(inputDir, { recursive: true })
    const svg = '<svg width="900" height="800" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="900" height="800" fill="#f3f3f3"/><circle cx="450" cy="320" r="160" fill="#88bbff"/>' +
      '<text x="450" y="772" font-family="Arial" font-size="36" font-weight="bold" fill="#000" text-anchor="middle">NO.JT666-5</text></svg>'
    await writeFile(join(inputDir, 'JT666-5.jpg'), await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer())
    const outDir = join(state.userData, 'out')
    await mkdir(outDir, { recursive: true })
    return { inputDir, outDir }
  }

  it('未授权的输入文件夹直接拒绝', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(IPC.labelPreview, {
      inputDir: 'C:/evil/imgs',
      mode: 'replace',
      oldPrefix: 'JT',
      newPrefix: 'TJ'
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未授权')
  })

  it('未授权的输出文件夹也拒绝（防止写到任意位置）', async () => {
    const { inputDir } = await makeJob()
    ipc.authorizeDir(inputDir)
    const res = await invoke<{ ok: boolean; error?: string }>(IPC.labelPreview, {
      inputDir,
      outputDir: 'C:/evil/out',
      mode: 'replace',
      oldPrefix: 'JT',
      newPrefix: 'TJ'
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未授权的输出文件夹')
    // makeJob() 会先用 sharp 生成测试图，CI 冷启动时偶发超过 vitest 默认 5s
    // （2026-10-12 的 CI #3 就因 "Test timed out in 5000ms" 挂过）。断言本身是纯内存判断，
    // 给个大超时只是防止「环境慢」被误报成「逻辑错」。
  }, 120000)

  it('试跑：返回逐张检测结果，且不写任何文件', async () => {
    const { inputDir } = await makeJob()
    ipc.authorizeDir(inputDir)
    const res = await invoke<{ ok: boolean; dryRun: boolean; total: number; items: { status: string; text?: string }[] }>(
      IPC.labelPreview,
      { inputDir, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ' }
    )
    expect(res.ok).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.total).toBe(1)
    expect(res.items[0].status).toBe('dry')
    expect(res.items[0].text).toBe('NO.TJ666-5')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(inputDir, '_已处理'))).toBe(false)
  })

  it('正式处理：写出改名后的图与 CSV 报告，并推送进度', async () => {
    const { inputDir } = await makeJob()
    ipc.authorizeDir(inputDir)
    const progress: unknown[] = []
    const res = await invoke<{ ok: boolean; outputDir: string; renamedCount: number; reportPath?: string }>(
      IPC.labelRun,
      { inputDir, mode: 'replace', oldPrefix: 'JT', newPrefix: 'TJ', rename: true, compare: true },
      // 进度事件的接收方是 webContents.send
      progress
    )
    expect(res.ok).toBe(true)
    expect(res.renamedCount).toBe(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(res.outputDir, 'TJ666-5.jpg'))).toBe(true)
    expect(existsSync(join(res.outputDir, '_对比图', 'TJ666-5_对比.jpg'))).toBe(true)
    expect(res.reportPath && existsSync(res.reportPath)).toBe(true)
    expect(progress).toHaveLength(0) // 该 sender 没有 send 方法，主进程已 try/catch 兜住
  })

  it('label:cancel 可调用（无任务时是无害的 no-op）', async () => {
    await expect(invoke<Promise<boolean>>(IPC.labelCancel)).resolves.toBe(true)
  })
})

describe('报价表 IPC（quote:preview / quote:run）', () => {
  beforeEach(setup)

  async function makeQuoteJob(): Promise<{ xlsx: string; imgDir: string }> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const sharp = (await import('sharp')).default
    const { makeXlsxFixture } = await import('./helpers')
    const work = join(state.userData, 'quote')
    await mkdir(work, { recursive: true })
    const oldImg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3366ff' } }).jpeg().toBuffer()
    const xlsx = await makeXlsxFixture(work, { codes: ['JT666-5'], images: [oldImg] })
    const imgDir = join(work, 'new')
    await mkdir(imgDir, { recursive: true })
    await writeFile(
      join(imgDir, 'TJ666-5.jpg'),
      await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#22cc55' } }).jpeg().toBuffer()
    )
    return { xlsx, imgDir }
  }

  it('未授权的报价表路径拒绝', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(IPC.quotePreview, {
      xlsxPath: 'C:/evil/报价表.xlsx',
      imageDir: 'C:/evil/imgs'
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未授权')
  })

  it('试跑：返回逐条对应计划，不写文件', async () => {
    const { xlsx, imgDir } = await makeQuoteJob()
    // 等价于 dialogPickXlsx 的行为：授权文件本身 + 所在目录（默认输出就写在那里）
    ipc.authorizePath(xlsx)
    ipc.authorizeDir(join(xlsx, '..'))
    ipc.authorizeDir(imgDir)
    const res = await invoke<{ ok: boolean; dryRun: boolean; plan?: { pictures: { code: string; newCode: string; newFile?: string }[]; codesPlanned: number } }>(
      IPC.quotePreview,
      { xlsxPath: xlsx, imageDir: imgDir, oldPrefix: 'JT', newPrefix: 'TJ' }
    )
    expect(res.ok).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.plan?.pictures).toHaveLength(1)
    expect(res.plan?.pictures[0].code).toBe('JT666-5')
    expect(res.plan?.pictures[0].newCode).toBe('TJ666-5')
    expect(res.plan?.pictures[0].newFile).toContain('TJ666-5.jpg')
  })

  it('正式处理：另存新文件并通过写后校验', async () => {
    const { xlsx, imgDir } = await makeQuoteJob()
    ipc.authorizePath(xlsx)
    ipc.authorizeDir(join(xlsx, '..'))
    ipc.authorizeDir(imgDir)
    const res = await invoke<{ ok: boolean; outputPath?: string; bytes?: number; issues?: string[] }>(IPC.quoteRun, {
      xlsxPath: xlsx,
      imageDir: imgDir,
      oldPrefix: 'JT',
      newPrefix: 'TJ'
    })
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
    expect(res.outputPath).toBeTruthy()
    const { existsSync } = await import('node:fs')
    expect(existsSync(res.outputPath!)).toBe(true)
    // 原表不能被改动
    expect(res.outputPath).not.toBe(xlsx)
  })

  it('覆盖原表时自动生成 .bak 备份', async () => {
    const { xlsx, imgDir } = await makeQuoteJob()
    ipc.authorizePath(xlsx)
    ipc.authorizeDir(join(xlsx, '..'))
    ipc.authorizeDir(imgDir)
    const res = await invoke<{ ok: boolean; outputPath?: string }>(IPC.quoteRun, {
      xlsxPath: xlsx,
      imageDir: imgDir,
      oldPrefix: 'JT',
      newPrefix: 'TJ',
      inplace: true
    })
    expect(res.ok).toBe(true)
    expect(res.outputPath).toBe(xlsx)
    const { existsSync } = await import('node:fs')
    expect(existsSync(xlsx + '.bak')).toBe(true)
  })

  it('shell:openPath 只放行已授权路径', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(IPC.shellOpenPath, 'C:/evil/secret')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未授权')
  })
})

describe('「按映射表」模式（custom）载入流程', () => {
  beforeEach(setup)

  /** 造一个含三张图的目录，文件名覆盖「标准货号 / 带后缀 / 不含货号」三种情况 */
  async function makeShop(): Promise<string> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const sharp = (await import('sharp')).default
    const dir = join(state.userData, 'map-shop')
    await mkdir(dir, { recursive: true })
    const mk = async (name: string, text: string): Promise<void> => {
      const svg =
        '<svg width="900" height="800" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="900" height="800" fill="#f2f2f0"/><ellipse cx="450" cy="330" rx="240" ry="200" fill="#ffd166"/>' +
        '<text x="451" y="772" font-family="Arial" font-size="36" font-weight="bold" fill="#111" text-anchor="middle">' +
        text +
        '</text></svg>'
      await writeFile(join(dir, name), await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer())
    }
    await mk('JT666-5.jpg', 'NO.JT666-5')
    await mk('JT888-11Z-1.jpg', 'NO.JT888-11Z-1')
    await mk('other.jpg', 'NO.OLD999-1')
    return dir
  }

  /** 写一个映射表 JSON 并让对话框返回它（等价于用户点了「选择…」） */
  async function pickMappingFile(content: string): Promise<{ path: string; data?: Record<string, string>; error?: string } | null> {
    const { writeFile } = await import('node:fs/promises')
    const file = join(state.userData, 'mapping.json')
    await writeFile(file, content, 'utf8')
    const openDialog = (await import('electron')).dialog.showOpenDialog as unknown as ReturnType<typeof vi.fn>
    openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] })
    return invoke(IPC.dialogPickMapping)
  }

  it('解析 JSON 时忽略 _ 开头的说明键与空值', async () => {
    const res = await pickMappingFile(
      JSON.stringify({
        _说明: 'custom 模式映射表示例',
        'JT666-5': 'NO.PI666-5',
        'JT888-11Z-1': 'NO.PI888-11Z-1',
        '空值键': ''
      })
    )
    expect(res).not.toBeNull()
    expect(res!.error).toBeUndefined()
    expect(res!.data).toEqual({ 'JT666-5': 'NO.PI666-5', 'JT888-11Z-1': 'NO.PI888-11Z-1' })
  })

  it('映射表全是说明键时报错而不是静默通过', async () => {
    const res = await pickMappingFile(JSON.stringify({ _说明: '只有说明' }))
    expect(res!.error).toMatch(/没有可用的条目/)
    expect(res!.data).toBeUndefined()
  })

  it('非法 JSON 返回错误而不是抛异常', async () => {
    const res = await pickMappingFile('{ 这不是 json')
    expect(res!.error).toBeTruthy()
    expect(res!.data).toBeUndefined()
  })

  it('映射表按货号命中，未命中的条目用固定文字兜底', async () => {
    const dir = await makeShop()
    ipc.authorizeDir(dir)
    const picked = await pickMappingFile(
      JSON.stringify({ _说明: 'x', 'JT666-5': 'NO.PI666-5', 'JT888-11Z-1': 'NO.PI888-11Z-1' })
    )
    const res = await invoke<{ ok: boolean; total: number; items: { name: string; text?: string; status: string }[] }>(
      IPC.labelPreview,
      {
        inputDir: dir,
        mode: 'custom',
        oldPrefix: 'JT',
        newPrefix: 'PI',
        mapping: picked!.data,
        fixedText: 'NO.FALLBACK-1'
      }
    )
    expect(res.ok).toBe(true)
    expect(res.total).toBe(3)
    const byName = new Map(res.items.map((i) => [i.name, i]))
    // 命中的按映射表来
    expect(byName.get('JT666-5.jpg')!.text).toBe('NO.PI666-5')
    expect(byName.get('JT888-11Z-1.jpg')!.text).toBe('NO.PI888-11Z-1')
    // 没命中的回退到固定文字
    expect(byName.get('other.jpg')!.text).toBe('NO.FALLBACK-1')
  })

  it('文件名带中文后缀时，仍能按解析出的货号命中映射表', async () => {
    const dir = await makeShop()
    const { copyFile } = await import('node:fs/promises')
    await copyFile(join(dir, 'JT666-5.jpg'), join(dir, 'JT666-5 副本.jpg'))
    ipc.authorizeDir(dir)
    const res = await invoke<{ items: { name: string; text?: string }[] }>(IPC.labelPreview, {
      inputDir: dir,
      mode: 'custom',
      oldPrefix: 'JT',
      newPrefix: 'PI',
      mapping: { 'JT666-5': 'NO.PI666-5' }
    })
    const copy = res.items.find((i) => i.name === 'JT666-5 副本.jpg')!
    expect(copy.text).toBe('NO.PI666-5')
  })

  it('正式处理：映射表写进图片并产出报告', async () => {
    const dir = await makeShop()
    ipc.authorizeDir(dir)
    const res = await invoke<{ ok: boolean; outputDir: string; reportPath?: string; items: { name: string; text?: string }[] }>(
      IPC.labelRun,
      {
        inputDir: dir,
        mode: 'custom',
        oldPrefix: 'JT',
        newPrefix: 'PI',
        mapping: { 'JT666-5': 'NO.PI666-5' },
        fixedText: 'NO.FALLBACK-1'
      }
    )
    expect(res.ok).toBe(true)
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(join(res.outputDir, 'JT666-5.jpg'))).toBe(true)
    const csv = readFileSync(res.reportPath!, 'utf8')
    expect(csv).toContain('NO.PI666-5')
    expect(csv).toContain('NO.FALLBACK-1')
  })
})

describe('导出纯文本（dialog:exportText）', () => {
  beforeEach(setup)

  it('取消保存时返回 null，不写任何文件', async () => {
    // 默认 mock 就是取消
    await expect(invoke<string | null>(IPC.exportText, { defaultName: 'a.csv', content: 'x' })).resolves.toBeNull()
  })

  it('保存后落盘，内容与控制字符正确', async () => {
    const { readFile } = await import('node:fs/promises')
    const target = join(state.userData, '问题清单.csv')
    const saveDialog = (await import('electron')).dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>
    saveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    const content = '\ufeff源文件,状态\r\n"含,逗号.jpg",ok\r\n'
    const saved = await invoke<string | null>(IPC.exportText, { defaultName: '问题清单.csv', content })
    expect(saved).toBe(target)
    expect(await readFile(target, 'utf8')).toBe(content)
  })

  it('建议文件名里的路径分隔符会被剥掉（防止被引到别的目录）', async () => {
    const saveDialog = (await import('electron')).dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>
    saveDialog.mockResolvedValueOnce({ canceled: true })
    await invoke<string | null>(IPC.exportText, { defaultName: '..\\..\\evil.csv', content: 'x' })
    const opts = saveDialog.mock.calls[saveDialog.mock.calls.length - 1][1] as { defaultPath: string }
    expect(opts.defaultPath).not.toContain('\\')
    expect(opts.defaultPath).not.toContain('/')
    expect(opts.defaultPath).not.toContain('..')
  })

  it('内容类型不对时抛错', async () => {
    await expect(invoke(IPC.exportText, { defaultName: 'a.csv', content: 123 as unknown as string })).rejects.toThrow(/无效/)
  })
})

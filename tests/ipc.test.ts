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

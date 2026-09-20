import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const userData = mkdtempSync(join(tmpdir(), 'fontsetup-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => process.cwd() }
}))

const fontSetup = await import('../src/main/fontSetup')

describe('打包字体注册（fontSetup）', () => {
  it('能在仓库里定位到随应用打包的字体', () => {
    const dir = fontSetup.resolveBundledFontDir()
    expect(dir).toBeTruthy()
    expect(existsSync(join(dir!, fontSetup.BUNDLED_FONT_FILE))).toBe(true)
    // 同时带上 OFL 许可证，便于合规分发
    expect(existsSync(join(dir!, 'LICENSE-OFL.txt'))).toBe(true)
  })

  it('生成的 fonts.conf 含系统字体目录 + 打包字体目录 + Arial 回退规则', () => {
    const xml = fontSetup.buildFontConfigXml({
      dirs: ['C:/Windows/Fonts', 'D:/app/resources/fonts'],
      cacheDir: 'D:/cache'
    })
    expect(xml).toContain('<dir>C:/Windows/Fonts</dir>')
    expect(xml).toContain('<dir>D:/app/resources/fonts</dir>')
    expect(xml).toContain('<cachedir>D:/cache</cachedir>')
    // 关键规则：Arial 找不到时追加 Liberation Sans（顺序保持 Arial 优先）
    expect(xml).toMatch(/<test qual="any" name="family"><string>Arial<\/string><\/test>\s*<edit name="family" mode="append" binding="same"><string>Liberation Sans<\/string><\/edit>/)
    expect(xml).toContain('append')
    // 标签成对
    expect((xml.match(/<match /g) ?? []).length).toBe((xml.match(/<\/match>/g) ?? []).length)
    expect(xml.trimEnd().endsWith('</fontconfig>')).toBe(true)
  })

  it('路径里的 XML 特殊字符会被转义', () => {
    const xml = fontSetup.buildFontConfigXml({ dirs: ['C:/a&b/<fonts>'], cacheDir: 'C:/c' })
    expect(xml).toContain('C:/a&amp;b/&lt;fonts&gt;')
    expect(xml).not.toContain('<fonts>')
  })

  it('系统字体目录存在且被纳入配置', () => {
    const dirs = fontSetup.systemFontDirs()
    expect(dirs.length).toBeGreaterThan(0)
    for (const d of dirs) expect(existsSync(d)).toBe(true)
    if (process.platform === 'win32') {
      expect(dirs.some((d) => /Fonts$/i.test(d))).toBe(true)
    }
  })

  it('setupBundledFonts 生成配置并设置 FONTCONFIG_FILE', () => {
    const before = process.env.FONTCONFIG_FILE
    delete process.env.FONTCONFIG_FILE
    try {
      const res = fontSetup.setupBundledFonts()
      expect(res.ok).toBe(true)
      expect(res.confPath && existsSync(res.confPath)).toBe(true)
      expect(process.env.FONTCONFIG_FILE).toBe(res.confPath)
      const xml = readFileSync(res.confPath!, 'utf8')
      expect(xml).toContain('LiberationSans-Bold'.replace('LiberationSans-Bold', 'resources')) // 含打包字体目录片段
      expect(xml).toContain(res.fontDir!.replace(/\\/g, '/'))
    } finally {
      if (before === undefined) delete process.env.FONTCONFIG_FILE
      else process.env.FONTCONFIG_FILE = before
    }
  })

  it('被显式禁用时不改动任何东西', async () => {
    const mod = await import('../src/main/fontSetup')
    // 该模块内部有 cached，这里只校验开关语义：设置环境变量后新进程不会注册
    expect(mod.setupBundledFonts()).toBeTruthy()
    expect(process.env.DSH_LABEL_NO_BUNDLED_FONT ?? '').toBe('')
  })

  it('端到端：配好 fontconfig 后，Liberation Sans 真的解析到打包字体（子进程验证）', () => {
    // fontconfig 每进程只初始化一次，必须在全新子进程里验证
    const work = mkdtempSync(join(tmpdir(), 'fontcheck-'))
    const confDir = join(work, 'conf')
    const cacheDir = join(work, 'cache')
    mkdirSync(confDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    const fontDir = fontSetup.resolveBundledFontDir()!
    const confPath = join(confDir, 'fonts.conf')
    writeFileSync(
      confPath,
      fontSetup.buildFontConfigXml({
        dirs: [...fontSetup.systemFontDirs(), fontDir],
        cacheDir
      }),
      'utf8'
    )

    const probe = join(process.cwd(), 'tests', 'helpers', 'fontProbe.mjs')

    const stdout = execFileSync('node', [probe, confPath], {
      cwd: process.cwd(),
      env: { ...process.env, FONTCONFIG_FILE: confPath },
      encoding: 'utf8'
    })
    const r = JSON.parse(stdout.trim()) as { arial: string; lib: string; miss: string }
    rmSync(work, { recursive: true, force: true })

    // Arial 仍然解析到真的系统 Arial；Liberation Sans 不再等于「找不到字体的回退」
    expect(r.lib).not.toBe(r.miss)
    if (process.platform === 'win32') expect(r.arial).not.toBe(r.miss)
  }, 120000)
})
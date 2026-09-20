/**
 * 打包字体注册（fontconfig）
 * ========================
 * 为什么需要它：
 * 货号重绘依赖 Arial Bold（拿真实产品图做过灰度叠加比对，与原图字体 IoU 0.934）。
 * 但这张字体由系统 fontconfig 解析 —— 万一机器上没有 Arial，fontconfig 会静默回退到
 * DejaVu Sans（度量与 Arial 不同，字距会整体走样），而且**没有任何报错**。
 *
 * 实测结论（在本机验证过）：
 *   - librsvg **不支持** @font-face —— file:// 与 data:base64 两种写法都无效，
 *     渲染结果与「不存在的字体」完全相同。所以只能走 fontconfig；
 *   - 随应用打包 **Liberation Sans Bold**（SIL OFL 1.1，可再分发），
 *     实测与 Arial Bold **度量完全一致**（字号 100 时多种字符串宽度差 0.000px）；
 *   - 用一份自定义 fonts.conf 覆盖 FONTCONFIG_FILE：保留系统字体目录不动，
 *     追加打包字体目录，并给 Arial 加一条「找不到就退到 Liberation Sans」的规则。
 *
 * 安全性：自定义配置是系统目录的**超集**，实测 Arial / 微软雅黑 / SimHei / sans-serif
 * 的解析结果与默认配置完全一致，只有原来会退化成 DejaVu 的那条路径改成了打包字体。
 *
 * ⚠️ fontconfig 每个进程只初始化一次，必须在**任何一次文字渲染之前**调用。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const BUNDLED_FONT_FILE = 'LiberationSans-Bold.ttf'

export interface FontSetupResult {
  ok: boolean
  /** 生效的 fontconfig 配置文件路径 */
  confPath?: string
  /** 打包字体所在目录 */
  fontDir?: string
  message: string
}

let cached: FontSetupResult | null = null

/** 定位随应用打包的字体目录（开发态 / 打包后位置不同） */
export function resolveBundledFontDir(): string | null {
  const candidates: (string | null)[] = [
    process.env.DSH_LABEL_FONT_DIR ?? null,
    // electron-builder extraResources: resources/fonts -> <resources>/fonts
    process.resourcesPath ? join(process.resourcesPath, 'fonts') : null,
    // 开发态（electron-vite 的 __dirname 是 out/main）
    join(__dirname, '..', '..', 'resources', 'fonts'),
    join(app.getAppPath(), 'resources', 'fonts')
  ]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      if (existsSync(join(dir, BUNDLED_FONT_FILE))) return dir
    } catch {
      /* 忽略不可访问的候选目录 */
    }
  }
  return null
}

/** fontconfig 在 Windows 上对正斜杠更稳，统一转一下 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 系统字体目录（写进自定义配置，保证系统字体照常可用） */
export function systemFontDirs(): string[] {
  const out: string[] = []
  if (process.platform === 'win32') {
    out.push(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'))
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
  } else if (process.platform === 'darwin') {
    out.push('/System/Library/Fonts', '/Library/Fonts')
    try {
      out.push(join(app.getPath('home'), 'Library', 'Fonts'))
    } catch {
      /* ignore */
    }
  } else {
    out.push('/usr/share/fonts', '/usr/local/share/fonts')
    try {
      out.push(join(app.getPath('home'), '.fonts'), join(app.getPath('home'), '.local', 'share', 'fonts'))
    } catch {
      /* ignore */
    }
  }
  return out.filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}

/** 生成 fonts.conf 内容（导出以便单测直接校验） */
export function buildFontConfigXml(opts: { dirs: string[]; cacheDir: string }): string {
  const dirs = opts.dirs.map((d) => `  <dir>${escapeXml(toPosix(d))}</dir>`).join('\n')
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
${dirs}
  <cachedir>${escapeXml(toPosix(opts.cacheDir))}</cachedir>
  <!-- 有 Arial 就用 Arial；没有就把 Liberation Sans（度量完全一致）追加为候选 -->
  <match target="pattern">
    <test qual="any" name="family"><string>Arial</string></test>
    <edit name="family" mode="append" binding="same"><string>Liberation Sans</string></edit>
  </match>
  <match target="pattern">
    <test qual="any" name="family"><string>Arial Bold</string></test>
    <edit name="family" mode="append" binding="same"><string>Liberation Sans</string></edit>
  </match>
</fontconfig>
`
}

/**
 * 生成并生效自定义 fontconfig 配置。幂等；任何异常都不会影响应用启动
 * （失败时只是退回系统默认字体解析，与改动前行为一致）。
 */
export function setupBundledFonts(): FontSetupResult {
  if (cached) return cached

  if (process.env.DSH_LABEL_NO_BUNDLED_FONT === '1') {
    cached = { ok: false, message: '已通过 DSH_LABEL_NO_BUNDLED_FONT=1 禁用' }
    return cached
  }
  if (process.env.FONTCONFIG_FILE) {
    cached = { ok: false, message: 'FONTCONFIG_FILE 已被外部设置，不覆盖' }
    return cached
  }

  try {
    const fontDir = resolveBundledFontDir()
    if (!fontDir) {
      cached = { ok: false, message: '未找到随应用打包的字体目录，使用系统字体' }
      return cached
    }
    const base = join(app.getPath('userData'), 'fontconfig')
    const cacheDir = join(base, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const dirs = [...systemFontDirs(), fontDir]
    const confPath = join(base, 'fonts.conf')
    writeFileSync(confPath, buildFontConfigXml({ dirs, cacheDir }), 'utf8')
    process.env.FONTCONFIG_FILE = confPath
    cached = { ok: true, confPath, fontDir, message: `已注册打包字体：${fontDir}` }
    return cached
  } catch (err) {
    cached = { ok: false, message: '打包字体注册失败（不影响启动）：' + (err instanceof Error ? err.message : String(err)) }
    return cached
  }
}

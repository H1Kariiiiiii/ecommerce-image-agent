// ⚠️ 必须最先执行：fontconfig 每进程只初始化一次，要在任何文字渲染之前注册打包字体
import { setupBundledFonts } from './fontSetup'

const fontStatus = setupBundledFonts()
// 日志留在启动输出里，便于排查「重绘字体不对」类问题
console.log(`[字体] ${fontStatus.message}${fontStatus.ok ? `（配置：${fontStatus.confPath}）` : ''}`)

import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { cleanResultCache } from './cache'
import { isAuthorizedInput, registerIpcHandlers } from './ipc'

/** 自定义 asset:// 协议：仅允许预览已授权路径（文件对话框/拖拽登记）与处理结果目录内的图片 */
function registerAssetProtocol(): void {
  protocol.handle('asset', (request) => {
    try {
      const url = new URL(request.url)
      // 纵深防御：仅接受无 host 的绝对路径形式（asset:///C:/...），拒绝 host 与目录穿越
      if (url.host) {
        return new Response('forbidden host', { status: 403 })
      }
      let p = decodeURIComponent(url.pathname)
      // win32 下：本地路径 asset:///C:/... → C:/...（去掉单个前导斜杠）；
      // UNC 路径 asset://///server/share/... 的 pathname 以 // 开头，必须保留双斜杠
      // （砍掉一个会导致授权匹配失败返回 403，且 pathToFileURL 无法识别为 UNC）
      if (process.platform === 'win32' && p.startsWith('/') && !p.startsWith('//')) p = p.slice(1)
      const segments = p.split(/[\\/]/)
      if (segments.some((s) => s === '..')) {
        return new Response('forbidden path', { status: 403 })
      }
      if (!isAuthorizedInput(p)) {
        return new Response('forbidden: not authorized', { status: 403 })
      }
      return net.fetch(pathToFileURL(p).toString())
    } catch (err) {
      return new Response(String(err), { status: 400 })
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '玩具白底图 Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 防止外部链接在当前窗口内导航（会顶掉应用界面）；跨 origin 一律交给系统浏览器
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const current = win.webContents.getURL()
      if (current && new URL(url).origin === new URL(current).origin) return
    } catch {
      /* 解析失败视为外部链接 */
    }
    event.preventDefault()
    shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.ecommerce.image-agent')
  registerAssetProtocol()
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  registerIpcHandlers()
  createWindow()

  // 启动后异步清理 7 天前的旧结果图片，避免缓存无限累积（不阻塞启动）
  cleanResultCache(7 * 24 * 60 * 60 * 1000).catch(() => {})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * UI 截图工具（开发自测用，不参与打包）
 * =====================================
 * 用 Electron 加载**真实的构建产物** out/renderer/index.html，
 * 通过打桩的 window.api 提供假数据，逐个页签截图。
 *
 * 为什么需要它：之前两轮 UI 缺陷（样式块丢失、复选框被拉成大方框）
 * 都是「代码测过了但没人看界面」造成的。有了它就能在交付前自己看一眼。
 *
 * 用法：npm run ui:shot   （脚本会自己先 build）
 * 输出：.ui-shots/*.png + 每个场景的 DOM 状态（用来区分「DOM 对但图旧」这类问题）
 *
 * 注意：运行期间屏幕上会出现一个应用窗口（已设 focusable:false / skipTaskbar，
 * 不会抢焦点也不进任务栏），约十几秒后自动关闭 —— 这是必须的，隐藏或透明的
 * 窗口 Chromium 不出帧，capturePage 会拿到旧帧或空帧。
 */
const { app, BrowserWindow, protocol, net } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, '.ui-shots')
const INDEX = join(ROOT, 'out', 'renderer', 'index.html')
const PRELOAD = join(__dirname, 'ui-shot-preload.cjs')

/** 1x1 浅灰 PNG：asset:// 的占位图，避免截图里全是碎图标 */
const PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * 场景 = 一串**分步**操作。每步单独走一次 executeJavaScript 往返，
 * 让 React 有时间重渲染 —— 全部塞进一个 async IIFE 里时，
 * 后一步点击常常发生在按钮还是 disabled 的那一帧上（踩过）。
 */
const SCENES = [
  { name: '01-白底图', steps: [] },
  { name: '02-批量改货号-配置', steps: ['clickMode("🔢 批量改货号")'] },
  {
    name: '03-批量改货号-结果',
    steps: ['clickMode("🔢 批量改货号")', 'clickButton("选择…")', 'clickButton("① 先试跑")']
  },
  {
    name: '04-报价表',
    // 报价表要两样都选（表 + 新图目录），否则「先试跑」一直是禁用的
    steps: [
      'clickMode("📊 报价表")',
      'clickButton("选择…", 0)',
      'clickButton("选择…", 1)',
      'clickButton("① 先试跑")'
    ]
  }
]

// 注入到页面里的辅助函数（点击模式按钮 / 普通按钮 / 等一会儿）
const HELPERS = `
  window.wait = (ms) => new Promise((r) => setTimeout(r, ms))
  window.clickMode = (label) => {
    const btn = [...document.querySelectorAll('.mode-btn')].find((b) => b.textContent.includes(label))
    if (!btn) throw new Error('找不到模式按钮: ' + label)
    btn.click()
  }
  // index：同名按钮取第几个（例如「选择…」在不同区块里有好几个）
  window.clickButton = (text, index) => {
    const btns = [...document.querySelectorAll('button')].filter((b) => !b.disabled)
    const norm = (s) => s.replace(/\\s+/g, '')
    const matches = btns.filter((b) => norm(b.textContent).includes(norm(text)))
    const btn = matches[index || 0]
    if (!btn) {
      throw new Error('找不到按钮: ' + text + '[' + (index || 0) + '] 命中 ' + matches.length + ' 个 / 现有: ' +
        btns.map((b) => b.textContent.trim()).join(' | ').slice(0, 300))
    }
    btn.click()
  }
  // 结尾必须是可序列化的值：executeJavaScript 会把最后表达式的值回传，
  // 若停在函数赋值上 Electron 会报 "An object could not be cloned"
  void 0
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  // asset:// 一律返回占位图，让图片槽位有东西可显示
  protocol.handle('asset', () => new Response(PLACEHOLDER, { headers: { 'content-type': 'image/png' } }))

  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    // 平时隐藏；只在截图前短暂 showInactive() 一下 —— Chromium 只给「显示中」的窗口合成新帧，
    // 但加上 skipTaskbar/focusable:false 反而会拿到空帧，所以这里用最朴素的选项。
    show: false,
    backgroundColor: '#262624',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  })


  await win.loadFile(INDEX)
  await new Promise((r) => setTimeout(r, 800))
  await win.webContents.executeJavaScript(HELPERS)

  for (const scene of SCENES) {
    try {
      for (const step of scene.steps) {
        await win.webContents.executeJavaScript(`(async () => { ${step}; })()`)
        await new Promise((r) => setTimeout(r, 450))
      }
      await new Promise((r) => setTimeout(r, 400))
      const dom = await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.result-row').length,
          filterBar: !!document.querySelector('.filter-bar'),
          summary: document.querySelector('.summary') ? document.querySelector('.summary').textContent.slice(0, 40) : null,
          banner: !!document.querySelector('.mode-banner'),
          planRows: document.querySelectorAll('.result-list .result-row').length,
          placeholder: !!document.querySelector('.placeholder')
        })`
      )
      // 让窗口真正显示一下，Chromium 才会把最新 DOM 合成成帧
      win.showInactive()
      await new Promise((r) => setTimeout(r, 500))
      const img = await win.webContents.capturePage()
      win.hide()
      const png = img.toPNG()
      const file = join(OUT_DIR, scene.name + '.png')
      writeFileSync(file, png)
      const warn = png.length < 1000 ? '  ⚠ 截图疑似空白（' + png.length + ' B）' : ''
      console.log('  ✓ ' + scene.name + '.png  ' + Math.round(png.length / 1024) + 'KB   dom=' + dom + warn)
    } catch (err) {
      console.log('  ✗ ' + scene.name + ' 失败: ' + err.message)
    }
  }

  win.destroy()
  app.quit()
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})

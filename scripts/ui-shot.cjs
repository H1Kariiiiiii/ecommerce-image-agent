/**
 * UI 截图工具（开发自测用，不参与打包）
 * =====================================
 * 用 Electron 加载**真实的构建产物** out/renderer/index.html，
 * 通过打桩的 window.api 提供假数据，逐个场景截图。
 *
 * 为什么需要它：之前两轮 UI 缺陷（样式块丢失、复选框被拉成大方框）
 * 都是「代码测过了但没人看界面」造成的。有了它就能在交付前自己看一眼。
 * 现在它还有第二个用途：README 里的产品截图直接从 .ui-shots/ 挑选，
 * 保证文档里的界面**永远和实际构建产物一致**，不会出现「截图还是半年前的」。
 *
 * 用法：npm run ui:shot   （脚本会自己先 build）
 * 输出：.ui-shots/*.png
 *
 * 演示图：脚本会用 sharp 现场合成几张玩具产品图，写到系统临时目录
 * （不污染仓库），asset:// 协议把这些路径映射过去 —— 所以截图里
 * 显示的是**真实渲染出来的界面**，不是拼图。
 *
 * 注意：运行期间屏幕上会出现一个应用窗口（已设 focusable:false / skipTaskbar，
 * 不会抢焦点也不进任务栏），约十几秒后自动关闭 —— 这是必须的，隐藏或透明的
 * 窗口 Chromium 不出帧，capturePage 会拿到旧帧或空帧。
 */
const { app, BrowserWindow, protocol, net } = require('electron')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { join, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, '.ui-shots')
const INDEX = join(ROOT, 'out', 'renderer', 'index.html')
const PRELOAD = join(__dirname, 'ui-shot-preload.cjs')

/** 与 ui-shot-preload.cjs 里的 DEMO 常量保持一致 */
const DEMO_DIR = join(tmpdir(), 'eia-demo')
const DEMO_BASE = 'C:/eia-demo'

/**
 * 合成演示用产品图：浅灰渐变底 + 一个玩具轮廓 + 底部货号。
 * 刻意做成「非纯白底」，这样前后对比能一眼看出是抠了底的。
 */
async function makeProduct(sharp, name, opts) {
  const { w, h, code, body, font } = opts
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e9edf2"/><stop offset="100%" stop-color="#f7f9fb"/>
    </linearGradient>
    <radialGradient id="shade" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.18"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <ellipse cx="${w / 2}" cy="${h * 0.72}" rx="${w * 0.3}" ry="${h * 0.075}" fill="#0d1b2a" opacity="0.13"/>
  <g>
    <circle cx="${w / 2}" cy="${h * 0.36}" r="${Math.min(w, h) * 0.185}" fill="${body}"/>
    <circle cx="${w / 2 - Math.min(w, h) * 0.155}" cy="${h * 0.21}" r="${Math.min(w, h) * 0.075}" fill="${body}"/>
    <circle cx="${w / 2 + Math.min(w, h) * 0.155}" cy="${h * 0.21}" r="${Math.min(w, h) * 0.075}" fill="${body}"/>
    <circle cx="${w / 2}" cy="${h * 0.36}" r="${Math.min(w, h) * 0.185}" fill="url(#shade)"/>
    <ellipse cx="${w / 2}" cy="${h * 0.60}" rx="${Math.min(w, h) * 0.225}" ry="${Math.min(w, h) * 0.16}" fill="${body}"/>
    <ellipse cx="${w / 2 - Math.min(w, h) * 0.075}" cy="${h * 0.345}" rx="${Math.min(w, h) * 0.026}" ry="${Math.min(w, h) * 0.032}" fill="#20242b"/>
    <ellipse cx="${w / 2 + Math.min(w, h) * 0.075}" cy="${h * 0.345}" rx="${Math.min(w, h) * 0.026}" ry="${Math.min(w, h) * 0.032}" fill="#20242b"/>
    <path d="M ${w / 2 - Math.min(w, h) * 0.035} ${h * 0.41} q ${Math.min(w, h) * 0.035} ${Math.min(w, h) * 0.045} ${Math.min(w, h) * 0.07} 0"
          stroke="#20242b" stroke-width="${Math.max(2, Math.min(w, h) * 0.012)}" fill="none" stroke-linecap="round"/>
  </g>
  <text x="${w / 2}" y="${h * 0.965}" font-family="${font || 'Arial'}" font-size="${font ? Math.round(h * 0.052) : Math.round(h * 0.045)}"
        font-weight="bold" fill="#000000" text-anchor="middle">${code}</text>
</svg>`
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer()
  writeFileSync(join(DEMO_DIR, name), buf)
  return buf
}

/** 合成一张「已抠好白底」的结果图：纯白底 + 同样的玩具 */
async function makeWhiteResult(sharp) {
  const w = 1200
  const h = 1200
  const r = 190
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="#ffffff"/>
  <ellipse cx="${w / 2}" cy="${h * 0.74}" rx="${r * 1.25}" ry="${r * 0.24}" fill="#000000" opacity="0.07"/>
  <circle cx="${w / 2}" cy="${h * 0.40}" r="${r}" fill="#f2b705"/>
  <circle cx="${w / 2 - r * 0.82}" cy="${h * 0.24}" r="${r * 0.40}" fill="#f2b705"/>
  <circle cx="${w / 2 + r * 0.82}" cy="${h * 0.24}" r="${r * 0.40}" fill="#f2b705"/>
  <ellipse cx="${w / 2}" cy="${h * 0.40}" rx="${r * 0.30}" ry="${r * 0.22}" fill="#ffe08a" opacity="0.75"/>
  <circle cx="${w / 2 - r * 0.40}" cy="${h * 0.385}" r="${r * 0.14}" fill="#20242b"/>
  <circle cx="${w / 2 + r * 0.40}" cy="${h * 0.385}" r="${r * 0.14}" fill="#20242b"/>
  <path d="M ${w / 2 - r * 0.20} ${h * 0.455} q ${r * 0.20} ${r * 0.26} ${r * 0.40} 0"
        stroke="#20242b" stroke-width="${r * 0.075}" fill="none" stroke-linecap="round"/>
</svg>`
  writeFileSync(join(DEMO_DIR, 'out-toy.png'), await sharp(Buffer.from(svg)).png().toBuffer())
}

/**
 * 场景 = 一串**分步**操作。每步单独走一次 executeJavaScript 往返，
 * 让 React 有时间重渲染 —— 全部塞进一个 async IIFE 里时，
 * 后一步点击常常发生在按钮还是 disabled 的那一帧上（踩过）。
 * 每条场景可用 theme 指定主题：截图前切一次，用来出 README 的浅色 / 深色对照。
 */
const SCENES = [
  // 白底图：加 3 张、跑一遍，露出「处理结果 + 前后对比」的真实界面
  {
    name: '01-白底图-浅色',
    theme: 'light',
    steps: ['clickButton("+ 添加图片")', 'clickButton("批量生成")']
  },
  // 深色：沿用上一场景的状态，只切主题（同屏对照，README 里两张并排放）
  { name: '02-白底图-深色', theme: 'dark', steps: [] },
  { name: '03-批量改货号-配置', theme: 'light', steps: ['clickMode("🔢 批量改货号")'] },
  {
    name: '04-批量改货号-试跑',
    theme: 'light',
    steps: ['clickMode("🔢 批量改货号")', 'clickButton("选择…")', 'clickButton("① 先试跑")']
  },
  // 正式跑一遍：「处理后」那一列才会出现，能拍到真正的重绘结果
  {
    name: '05-批量改货号-结果',
    theme: 'light',
    steps: ['clickButton("② 开始处理")']
  },
  {
    name: '06-报价表',
    theme: 'light',
    // 报价表要两样都选（表 + 新图目录），否则「先试跑」一直是禁用的
    steps: [
      'clickMode("📊 报价表")',
      'clickButton("选择…", 0)',
      'clickButton("选择…", 1)',
      'clickButton("① 先试跑")'
    ]
  }
]

// 注入到页面里的辅助函数（点击模式按钮 / 普通按钮 / 切主题 / 等一会儿）
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
  // 直接改 <html data-theme>：主题最终就是落在这个属性上（theme 是受控 select，改起来更绕）
  window.setTheme = (t) => {
    document.documentElement.dataset.theme = t
    const sel = document.querySelector('.topbar-theme select')
    if (sel) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(sel, t)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
  // 结尾必须是可序列化的值：executeJavaScript 会把最后表达式的值回传，
  // 若停在函数赋值上 Electron 会报 "An object could not be cloned"
  void 0
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(DEMO_DIR, { recursive: true })

  // 演示图：仓库里不放二进制素材，需要时现合成（sharp 在 Electron 主进程里可用）
  const sharp = require('sharp')
  await Promise.all([
    makeProduct(sharp, 'JT666-5.jpg', { w: 1587, h: 1440, code: 'NO.JT666-5', body: '#f2b705' }),
    makeProduct(sharp, 'JT888-11Z-1.jpg', { w: 1587, h: 1440, code: 'NO.JT888-11Z-1', body: '#3aa0d8' }),
    makeProduct(sharp, 'JT999-13A.jpg', { w: 1400, h: 1400, code: 'NO.JT999-13A', body: '#7ac143' }),
    makeProduct(sharp, 'JT777-2.jpg', { w: 1500, h: 1500, code: 'NO.JT777-2', body: '#e2643f' }),
    makeProduct(sharp, '坏图.png', { w: 1200, h: 1200, code: 'NO.JT555-1', body: '#9b7ede' }),
    // 「处理后」的那几张：同一张图、只把货号换成新前缀，用来演示逐张前后对比。
    // ⚠ 这几张必须与 ui-shot-preload.cjs 里 LABEL_ITEMS 的 dst 一一对应，
    //   漏一张截图里就会出现碎图标（踩过一次，靠肉眼看图才发现）。
    makeProduct(sharp, 'PI666-5.jpg', { w: 1587, h: 1440, code: 'NO.PI666-5', body: '#f2b705' }),
    makeProduct(sharp, 'PI888-11Z-1.jpg', { w: 1587, h: 1440, code: 'NO.PI888-11Z-1', body: '#3aa0d8' }),
    makeProduct(sharp, 'PI999-13A.jpg', { w: 1400, h: 1400, code: 'NO.PI999-13A', body: '#7ac143' })
  ])
  await makeWhiteResult(sharp)

  // 自检：把预载脚本里所有 img('...') 引用的文件名抠出来，逐个确认磁盘上存在。
  // 少一张就会在界面里渲染成碎图标 —— 这类问题不会让脚本报错，只能靠断言拦住。
  //
  // 例外：状态为 not-found / error 的条目本来就没有「处理后」产物，
  // 界面也不会去渲染那一格，所以它们的 dst 允许不存在。凡是列进来的都要写清原因，
  // 免得以后有人图省事把真缺的图也塞进来。
  const EXPECTED_ABSENT = new Set([
    'PI777-2.jpg' // JT777-2 是 not-found（没检测到货号），本就没有输出图
  ])
  const preloadSrc = readFileSync(PRELOAD, 'utf8')
  const referenced = [...preloadSrc.matchAll(/img\('([^']+)'\)/g)].map((m) => m[1])
  const missing = [...new Set(referenced)].filter(
    (n) => !EXPECTED_ABSENT.has(n) && !existsSync(join(DEMO_DIR, n))
  )
  if (missing.length > 0) {
    throw new Error('预载脚本引用了未合成的演示图：' + missing.join('、'))
  }
  console.log(
    '  · 演示图已合成到 ' + DEMO_DIR + '（' + new Set(referenced).size + ' 张被引用，' +
      EXPECTED_ABSENT.size + ' 张按设计缺省，其余全部就位）'
  )

  // asset:// 只认**文件名**，到演示图目录里取 —— 演示图都是平铺的，
  // 这样既不用去解析 asset:///C:/... 这种伪路径，也天然挡住越权读取。
  protocol.handle('asset', (req) => {
    try {
      const name = basename(decodeURIComponent(new URL(req.url).pathname))
      const file = join(DEMO_DIR, name)
      if (!name || !existsSync(file)) return new Response('', { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('', { status: 404 })
    }
  })

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
      if (scene.theme) {
        await win.webContents.executeJavaScript(`window.setTheme(${JSON.stringify(scene.theme)})`)
        await new Promise((r) => setTimeout(r, 350))
      }
      await new Promise((r) => setTimeout(r, 400))
      const dom = await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.result-row').length,
          filterBar: !!document.querySelector('.filter-bar'),
          summary: document.querySelector('.summary') ? document.querySelector('.summary').textContent.slice(0, 40) : null,
          banner: !!document.querySelector('.mode-banner'),
          compare: document.querySelectorAll('.preview-pair img, .compare-side img').length,
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

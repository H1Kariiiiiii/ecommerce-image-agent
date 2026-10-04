// UI 截图专用的 window.api 打桩（仅开发自测，不参与打包）
// 目的：让真实构建产物能在没有主进程的情况下渲染出来，便于截图检查布局。
//
// 路径全部指向 demo 目录（见 ui-shot.cjs 里合成的那几张演示图），
// 这样 asset:// 请求能命中真实图片，截图里不会出现空白图框。
const DEMO = 'C:/eia-demo'

const PROVIDER = {
  id: 'p1',
  name: '火山方舟 · Seedream 5.0 Lite',
  type: 'openai-compatible',
  active: true,
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedream-5-0-260128'
}

const img = (n) => DEMO + '/' + n

const LABEL_ITEMS = [
  { src: img('JT666-5.jpg'), dst: img('PI666-5.jpg'), name: 'JT666-5.jpg', status: 'ok', text: 'NO.PI666-5', box: [552, 1340, 1034, 1406], renamed: true },
  { src: img('JT888-11Z-1.jpg'), dst: img('PI888-11Z-1.jpg'), name: 'JT888-11Z-1.jpg', status: 'ok', text: 'NO.PI888-11Z-1', box: [521, 1340, 1065, 1406], renamed: true },
  { src: img('JT999-13A.jpg'), dst: img('PI999-13A.jpg'), name: 'JT999-13A.jpg', status: 'warn', text: 'NO.PI999-13A', box: [594, 1052, 908, 1085], note: '位置偏差 dx=18.4 dy=3.1（已按检测框重绘）', renamed: true },
  // 没检测到货号：没有输出图，所以 PI777-2.jpg 本就不该存在（见 ui-shot.cjs 的 EXPECTED_ABSENT）
  { src: img('JT777-2.jpg'), dst: img('PI777-2.jpg'), name: 'JT777-2.jpg', status: 'not-found', renamed: true },
  { src: img('坏图.png'), dst: img('坏图.png'), name: '坏图.png', status: 'error', note: '无法读取图片尺寸' }
]

const LABEL_RESULT = {
  ok: true,
  outputDir: DEMO + '/_已处理',
  total: 5,
  okCount: 2,
  warnCount: 1,
  notFoundCount: 1,
  errorCount: 1,
  renamedCount: 4,
  dryRun: true,
  items: LABEL_ITEMS,
  reportPath: DEMO + '/_已处理/处理报告.csv'
}

const QUOTE_PLAN = {
  pictures: [
    { code: 'JT666-5', newCode: 'PI666-5', media: 'xl/media/image1.jpeg', newFile: img('PI666-5.jpg') },
    { code: 'JT888-11Z-1', newCode: 'PI888-11Z-1', media: 'xl/media/image2.jpeg', newFile: img('PI888-11Z-1.jpg') },
    { code: 'JT999-13A', newCode: 'PI999-13A', media: 'xl/media/image3.jpeg' }
  ],
  codeStrings: [
    { from: 'JT666-5', to: 'PI666-5' },
    { from: 'NO.JT888-11Z-1', to: 'NO.PI888-11Z-1' }
  ],
  warnings: ['找不到图片: 货号 "JT999-13A"（图片文件夹里没有对应文件）'],
  picturesPlanned: 2,
  codesPlanned: 2
}

// 白底图那一页：一条已完成（露出前后对比），一条待处理
const WHITE_BG_DONE = {
  ok: true,
  outputPath: img('out-toy.png'),
  sourceUrl: img('out-toy.png'),
  quota: { used: 12, limit: 200, yearMonth: '2026-09' }
}

let progressCb = null

window.api = {
  getPathForFile: () => '',
  getPathsForFiles: () => [],
  getProviders: async () => [PROVIDER],
  saveProvider: async (c) => [c],
  deleteProvider: async () => [],
  setActiveProvider: async () => [PROVIDER],
  testProvider: async () => ({ ok: true, message: '连接正常' }),
  queryBalance: async () => ({ ok: false, message: '该服务商不支持查询余额' }),
  processImage: async () => WHITE_BG_DONE,
  pickImage: async () => img('JT666-5.jpg'),
  // 让白底图那一页真的有图可处理：返回 3 张演示图
  pickImages: async () => [img('JT666-5.jpg'), img('JT888-11Z-1.jpg'), img('JT999-13A.jpg')],
  exportImage: async () => null,
  exportImagesToDir: async () => null,
  getSettings: async () => ({ theme: 'light' }),
  saveSettings: async (patch) => ({ theme: 'light', ...patch }),
  getQuota: async () => ({ used: 12, limit: 200, yearMonth: '2026-09' }),
  setQuotaLimit: async () => ({ used: 12, limit: 200, yearMonth: '2026-09' }),
  getCacheInfo: async () => ({ fileCount: 34, sizeBytes: 48 * 1024 * 1024 }),
  cleanCache: async () => ({ removedCount: 0, freedBytes: 0 }),
  clearCache: async () => ({ removedCount: 34, freedBytes: 48 * 1024 * 1024 }),
  pickFolder: async () => DEMO,
  pickXlsx: async () => DEMO + '/报价表.xlsx',
  pickMapping: async () => ({ path: DEMO + '/mapping.json', data: { 'JT666-5': 'NO.PI666-5' } }),
  labelPreview: async () => LABEL_RESULT,
  labelRun: async () => ({ ...LABEL_RESULT, dryRun: false }),
  labelCancel: async () => true,
  onLabelProgress: (cb) => {
    progressCb = cb
    return () => {
      progressCb = null
    }
  },
  quotePreview: async () => ({ ok: true, dryRun: true, plan: QUOTE_PLAN }),
  quoteRun: async () => ({ ok: true, dryRun: false, outputPath: DEMO + '/报价表_新.xlsx', bytes: 428000, plan: QUOTE_PLAN, issues: [] }),
  openPath: async () => ({ ok: true }),
  exportText: async () => DEMO + '/问题清单.csv'
}

// UI 截图专用的 window.api 打桩（仅开发自测，不参与打包）
// 目的：让真实构建产物能在没有主进程的情况下渲染出来，便于截图检查布局
const PROVIDER = {
  id: 'p1',
  name: '火山方舟 · Seedream 5.0 Lite',
  type: 'openai-compatible',
  active: true,
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedream-5-0-260128'
}

const LABEL_ITEMS = [
  { src: 'C:/shop/imgs/JT666-5.jpg', dst: 'C:/shop/imgs/_已处理/PI666-5.jpg', name: 'JT666-5.jpg', status: 'dry', text: 'NO.PI666-5', box: [552, 1340, 1034, 1406], renamed: true },
  { src: 'C:/shop/imgs/JT888-11Z-1.jpg', dst: 'C:/shop/imgs/_已处理/PI888-11Z-1.jpg', name: 'JT888-11Z-1.jpg', status: 'dry', text: 'NO.PI888-11Z-1', box: [577, 1350, 1003, 1392], renamed: true },
  { src: 'C:/shop/imgs/JT999-13A.jpg', dst: 'C:/shop/imgs/_已处理/PI999-13A.jpg', name: 'JT999-13A.jpg', status: 'warn', text: 'NO.PI999-13A', box: [594, 1052, 908, 1085], note: '位置偏差 dx=18.4 dy=3.1', renamed: true },
  { src: 'C:/shop/imgs/JT777-2.jpg', dst: 'C:/shop/imgs/_已处理/PI777-2.jpg', name: 'JT777-2.jpg', status: 'not-found', renamed: true },
  { src: 'C:/shop/imgs/坏图.jpg', dst: 'C:/shop/imgs/_已处理/坏图.jpg', name: '坏图.jpg', status: 'error', note: '无法读取图片尺寸' }
]

const LABEL_RESULT = {
  ok: true,
  outputDir: 'C:/shop/imgs/_已处理',
  total: 5,
  okCount: 2,
  warnCount: 1,
  notFoundCount: 1,
  errorCount: 1,
  renamedCount: 4,
  dryRun: true,
  items: LABEL_ITEMS,
  reportPath: 'C:/shop/imgs/_已处理/处理报告.csv'
}

const QUOTE_PLAN = {
  pictures: [
    { code: 'JT666-5', newCode: 'PI666-5', media: 'xl/media/image1.jpeg', newFile: 'C:/shop/imgs/_已处理/PI666-5.jpg' },
    { code: 'JT888-11Z-1', newCode: 'PI888-11Z-1', media: 'xl/media/image2.jpeg', newFile: 'C:/shop/imgs/_已处理/PI888-11Z-1.jpg' },
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
  processImage: async () => ({ ok: true, outputPath: 'C:/out/toy_white.png' }),
  ocrDetect: async () => ({ ok: true, text: 'NO.JT888-10', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }),
  ocrRecognize: async () => ({ ok: true, text: 'NO.JT888-10' }),
  eraseTextAI: async () => ({ ok: true, outputPath: 'C:/out/erased.png', detectedText: 'NO.JT888-10' }),
  eraseTextLocal: async () => ({ ok: true, outputPath: 'C:/out/erased.png', detectedText: 'NO.JT888-10' }),
  pickImage: async () => null,
  pickImages: async () => [],
  exportImage: async () => null,
  exportImagesToDir: async () => null,
  getSettings: async () => ({ theme: 'dark' }),
  saveSettings: async (patch) => ({ theme: 'dark', ...patch }),
  getQuota: async () => ({ used: 12, limit: 200, yearMonth: '2026-09' }),
  setQuotaLimit: async () => ({ used: 12, limit: 200, yearMonth: '2026-09' }),
  getCacheInfo: async () => ({ fileCount: 34, sizeBytes: 48 * 1024 * 1024 }),
  cleanCache: async () => ({ removedCount: 0, freedBytes: 0 }),
  clearCache: async () => ({ removedCount: 34, freedBytes: 48 * 1024 * 1024 }),
  pickFolder: async () => 'C:/shop/imgs',
  pickXlsx: async () => 'C:/shop/报价表.xlsx',
  pickMapping: async () => ({ path: 'C:/shop/mapping.json', data: { 'JT666-5': 'NO.PI666-5' } }),
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
  quoteRun: async () => ({ ok: true, dryRun: false, outputPath: 'C:/shop/报价表_新.xlsx', bytes: 428_000, plan: QUOTE_PLAN, issues: [] }),
  openPath: async () => ({ ok: true }),
  exportText: async () => 'C:/shop/问题清单.csv'
}

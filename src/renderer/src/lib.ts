/** 本地绝对路径 → asset:// 预览 URL（逐段编码，避免文件名含 # / % 时解析错误） */
export function assetUrl(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return 'asset:///' + norm.split('/').map(encodeURIComponent).join('/')
}

export type Theme = 'system' | 'light' | 'dark'

/** 当前是否应使用深色（跟随系统时按 prefers-color-scheme 判断） */
export function isDarkTheme(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 应用主题到 <html data-theme>（CSS 变量切换深/浅色） */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = isDarkTheme(theme) ? 'dark' : 'light'
}

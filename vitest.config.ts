import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 与 electron.vite.config.ts 保持一致：渲染层用到的 __APP_VERSION__ 在测试环境也要注入
const pkgVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion)
  },
  test: {
    // 开启全局注入 afterEach 等，@testing-library/react 才能自动 cleanup DOM
    globals: true
  }
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 开启全局注入 afterEach 等，@testing-library/react 才能自动 cleanup DOM
    globals: true
  }
})

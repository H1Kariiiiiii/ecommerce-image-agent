/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string
  export default content
}

/** 由 electron.vite.config.ts 在构建期注入（取自 package.json 的 version） */
declare const __APP_VERSION__: string

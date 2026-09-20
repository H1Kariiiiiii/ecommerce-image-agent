#!/usr/bin/env node
/**
 * 由 使用说明书.md 生成 src/renderer/src/help.ts（应用内「❓ 使用帮助」的内容）。
 *
 * 以前这一步是手工转义的，改一次说明书要手工同步一次，容易漏。
 * 现在固定成脚本：改完 使用说明书.md 执行 `npm run gen:help` 即可。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const SRC = join(repo, '使用说明书.md')
const OUT = join(repo, 'src', 'renderer', 'src', 'help.ts')

const rawMd = await readFile(SRC, 'utf8')

// 版本号从 package.json 注入，避免说明书里的版本号像以前那样漂成 0.3.6
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const md = rawMd.replaceAll('{{VERSION}}', pkg.version)
if (rawMd.includes('{{VERSION}}') && !pkg.version) {
  throw new Error('package.json 里没有 version 字段，无法注入 {{VERSION}}')
}

// 放进模板字符串里：反斜杠、反引号、${ 都要转义（顺序不能反）
const escaped = md
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const content =
  '// 由 使用说明书.md 生成（npm run gen:help），请勿直接修改本文件；改说明书写法后重新生成\n' +
  'export const HELP_MD: string = `' +
  escaped +
  '`\n'

await writeFile(OUT, content, 'utf8')
console.log(`已生成 ${OUT}（${md.length} 字符）`)

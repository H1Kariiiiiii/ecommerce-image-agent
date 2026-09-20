import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 样式表完整性守卫。
 *
 * 起因：我曾经用「读全文 → 在内存里追加 → 写回」的方式改 styles.css，
 * 而读取有 2000 行上限 —— 文件一旦超过 2000 行，读回来的就是截断版，
 * 写回时会把新增的样式块**静默删掉**（.mode-banner / .filter-bar 就这么丢过一次，
 * 还被打进了 0.9.0 的包里）。这个测试用来立刻发现这类丢失。
 */
const CSS_PATH = join(process.cwd(), 'src', 'renderer', 'src', 'styles.css')

describe('styles.css 完整性', () => {
  const css = readFileSync(CSS_PATH, 'utf8')

  it('本次新增的样式块都还在', () => {
    const required = [
      '.mode-banner',
      '.mode-banner-icon',
      '.mode-banner-text',
      '.link-btn',
      '.filter-bar',
      '.filter-chips',
      '.chip-count',
      '.app-version',
      '.main-batch',
      '.panel-body',
      '.panel-actions',
      '.row-input',
      '.adv-grid',
      '.summary',
      '.stat-chip',
      '.progress-track',
      '.result-split',
      '.result-list',
      '.result-row',
      '.result-icon',
      '.result-name',
      '.result-preview',
      '.preview-pair',
      '.preview-meta',
      '.warn-list',
      '.report-note'
    ]
    // 朴素的存在性检查：块被整段删掉时这里必然报出来
    const missing = required.filter((cls) => !css.includes(cls))
    expect(missing).toEqual([])
  })

  it('花括号成对（粗查截断 / 半截规则）', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(open).toBe(close)
    expect(open).toBeGreaterThan(100)
  })

  it('文件末尾不是旧的截断点', () => {
    // 截断发生时文件正好停在 .report-note 那个块，末尾没有后续新增的规则
    const tail = css.trimEnd().slice(-500)
    expect(tail).toContain('.chip-count')
  })
})

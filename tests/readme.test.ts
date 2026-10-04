import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * README 自洽性检查
 * =================
 * 起因：徽章上写着「323 个用例」，实际是 286 —— 仓库里最显眼的位置挂着一个
 * 顺手就能证伪的数字，而且是唯一一处「读者什么都不用做就能发现错了」的地方。
 *
 * 这里只钉住「能被外部验证的事实」，不做文案检查：
 *   - 三处用例数口径必须一致（互相印证，数值本身由人更新）
 *   - README 引用的每张本地图片必须真的存在
 *   - 引用的 npm script 必须真的在 package.json 里
 */

const ROOT = process.cwd()
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('README 与仓库实际状态一致', () => {
  it('三处用例数口径一致（徽章 / 技术栈 / 测试小节）', () => {
    const badge = readme.match(/badge\/tests-(\d+)%20passed/)
    const bullet = readme.match(/vitest 单元测试 (\d+) 个/)
    const section = readme.match(/npm test\s+# vitest run，(\d+) 个用例/)

    expect(badge, 'README 顶部应有 tests 徽章').toBeTruthy()
    expect(bullet, '「技术栈」应有单元测试条数').toBeTruthy()
    expect(section, '「测试」小节应有用例数').toBeTruthy()

    const counts = [badge![1], bullet![1], section![1]]
    expect(new Set(counts).size, '三处用例数不一致：' + counts.join(' / ')).toBe(1)
  })

  it('README 引用的本地图片都存在', () => {
    // 只查相对路径（跳过 http(s) 徽章）
    const refs = [...readme.matchAll(/!\[[^\]]*\]\((?!https?:)([^)]+)\)/g)].map((m) => m[1])
    expect(refs.length, 'README 应至少引用一张截图').toBeGreaterThan(0)
    for (const rel of refs) {
      expect(() => readFileSync(join(ROOT, rel)), 'README 引用了不存在的图片：' + rel).not.toThrow()
    }
  })

  it('README 里出现的 npm script 都真实存在', () => {
    const names = new Set(Object.keys(pkg.scripts))
    const used = [...readme.matchAll(/npm (?:run|test)\s+([a-z][\w:]*)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    for (const n of used) {
      expect(names.has(n), 'README 引用了不存在的 npm script：' + n).toBe(true)
    }
  })
})

// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HelpModal } from '../../src/renderer/src/components/HelpModal'
import { HELP_MD } from '../../src/renderer/src/help'

describe('HelpModal 使用帮助', () => {
  it('渲染说明书内容（标题、配置章节、常见问题）', () => {
    render(<HelpModal onClose={vi.fn()} />)
    expect(screen.getByText('📖 使用说明书')).toBeTruthy()
    // marked 渲染后的内容：主要章节标题（含序号，用正则匹配）
    expect(screen.getByRole('heading', { name: /安装应用/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /第一次使用：配置 API/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /常见问题排查/ })).toBeTruthy()
  })

  it('ESC 关闭', () => {
    const onClose = vi.fn()
    render(<HelpModal onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('关闭按钮关闭', () => {
    const onClose = vi.fn()
    render(<HelpModal onClose={onClose} />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalled()
  })

  it('HELP_MD 与使用说明书同源（含关键内容，无转义损坏）', () => {
    // 说明书中出现的关键片段都应存在
    expect(HELP_MD).toContain('安装应用')
    expect(HELP_MD).toContain('火山方舟')
    expect(HELP_MD).toContain('测试连接')
    expect(HELP_MD).toContain('images/generations')
    // 反引号转义正确（模板字符串未被提前终止）
    expect(HELP_MD.length).toBeGreaterThan(3000)
  })

  it('外部链接强制新窗口打开（target=_blank，不会顶掉应用界面）', () => {
    const { container } = render(<HelpModal onClose={vi.fn()} />)
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('.help-content a'))
    expect(links.length).toBeGreaterThan(0)
    // 外部链接（http/https）必须 target=_blank；目录锚点（#...）不受影响
    const external = links.filter((a) => /^https?:\/\//.test(a.getAttribute('href') ?? ''))
    expect(external.length).toBeGreaterThan(0)
    for (const a of external) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
    }
  })

  it('左侧目录渲染全部章节，点击目录项滚动到对应标题（滚动容器为 .help-content）', () => {
    const { container } = render(<HelpModal onClose={vi.fn()} />)
    const content = container.querySelector<HTMLElement>('.help-content')!
    // jsdom 无 scrollTo/布局：mock scrollTo 记录目标，mock getBoundingClientRect 模拟「目标标题在容器下方 388px」
    const scrollCalls: ScrollToOptions[] = []
    content.scrollTo = ((opts: ScrollToOptions) => {
      scrollCalls.push(opts)
    }) as typeof content.scrollTo
    const origRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this === content) return { top: 100, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      const target = Array.from(content.querySelectorAll('h1,h2,h3')).find((h) => h.id === '1-安装应用')
      if (this === target) return { top: 488, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    try {
      const items = Array.from(container.querySelectorAll<HTMLButtonElement>('.help-toc-item'))
      // 目录包含主要章节
      expect(items.length).toBeGreaterThanOrEqual(5)
      expect(items.some((b) => b.textContent?.includes('安装应用'))).toBe(true)
      expect(items.some((b) => b.textContent?.includes('配置 API'))).toBe(true)
      // 点击「安装应用」目录项 → .help-content 收到滚动调用，目标偏移 = 488 - 100 + 0 - 12 = 376
      fireEvent.click(items.find((b) => b.textContent?.includes('安装应用'))!)
      expect(scrollCalls.length).toBe(1)
      expect(scrollCalls[0]).toMatchObject({ top: 376, behavior: 'smooth' })
      // 点击其他目录项同样滚动
      fireEvent.click(items.find((b) => b.textContent?.includes('隐私说明'))!)
      expect(scrollCalls.length).toBe(2)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect
    }
  })

  it('章节标题带锚点 id，与目录 slug 一致', () => {
    const { container } = render(<HelpModal onClose={vi.fn()} />)
    const h2s = Array.from(container.querySelectorAll<HTMLHeadingElement>('.help-content h2'))
    const install = h2s.find((h) => h.textContent?.includes('安装应用'))
    expect(install?.id).toBe('1-安装应用')
  })
})

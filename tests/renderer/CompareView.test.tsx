// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CompareView } from '../../src/renderer/src/components/CompareView'

describe('CompareView', () => {
  it('默认并排模式：显示原图与白底图两张图', () => {
    render(<CompareView inputPath="C:/in/toy.png" outputPath="C:/out/toy_white.png" />)
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(2)
    expect(imgs[0].getAttribute('src')).toContain('toy.png')
    expect(imgs[1].getAttribute('src')).toContain('toy_white.png')
    expect(screen.getByText('原图')).toBeTruthy()
    expect(screen.getByText('白底图')).toBeTruthy()
  })

  it('切换到滑动模式：出现滑块，拖动改变分割位置', () => {
    render(<CompareView inputPath="C:/in/toy.png" outputPath="C:/out/toy_white.png" />)
    fireEvent.click(screen.getByText('滑动'))
    const slider = screen.getByRole('slider')
    expect(slider).toBeTruthy()

    fireEvent.change(slider, { target: { value: '70' } })
    const overlay = document.querySelector('.slider-overlay')
    expect(overlay?.getAttribute('style')).toContain('inset(0 30% 0 0)')

    fireEvent.change(slider, { target: { value: '0' } })
    const overlay2 = document.querySelector('.slider-overlay')
    expect(overlay2?.getAttribute('style')).toContain('inset(0 100% 0 0)')
  })

  it('拖动中间分隔线（◀▶ 手柄）也能改变分割位置', () => {
    render(<CompareView inputPath="C:/in/toy.png" outputPath="C:/out/toy_white.png" />)
    fireEvent.click(screen.getByText('滑动'))
    const wrap = document.querySelector('.slider-wrap') as HTMLDivElement
    const divider = document.querySelector('.slider-divider') as HTMLDivElement
    expect(divider).toBeTruthy()

    // jsdom 无真实布局：mock 容器边界
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 400, height: 300,
      right: 400, bottom: 300, x: 0, y: 0,
      toJSON: () => ({})
    } as DOMRect)

    // 按下手柄本身就要跳到点击位置（jsdom 无 setPointerCapture，此处曾抛异常
    // 导致「按下」这一步被跳过；这条断言专门钉住它）
    fireEvent.pointerDown(divider, { clientX: 40, pointerId: 1 })
    expect(document.querySelector('.slider-overlay')?.getAttribute('style')).toContain('inset(0 90% 0 0)')

    // 再按一次到 x=200（=50%），然后拖动到 x=280（=70%）
    fireEvent.pointerDown(divider, { clientX: 200, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 280, pointerId: 1 })
    const overlay = document.querySelector('.slider-overlay')
    expect(overlay?.getAttribute('style')).toContain('inset(0 30% 0 0)')

    // 拖到 x=40（=10%）
    fireEvent.pointerMove(divider, { clientX: 40, pointerId: 1 })
    const overlay2 = document.querySelector('.slider-overlay')
    expect(overlay2?.getAttribute('style')).toContain('inset(0 90% 0 0)')
  })

  it('可切回并排模式', () => {
    render(<CompareView inputPath="C:/in/toy.png" outputPath="C:/out/toy_white.png" />)
    fireEvent.click(screen.getByText('滑动'))
    fireEvent.click(screen.getByText('并排'))
    expect(document.querySelector('.compare-side')).toBeTruthy()
    expect(document.querySelector('.slider-wrap')).toBeNull()
  })
})

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TextRegion } from '../../../shared/types'
import { assetUrl } from '../lib'

interface Props {
  inputPath: string
  region: TextRegion | null
  onRegionChange: (region: TextRegion | null) => void
}

type DragMode = 'draw' | 'move' | 'resize-bl' | 'resize-br' | 'resize-tl' | 'resize-tr' | null

/** 图片上的矩形框选组件，支持拖拽绘制、移动、四角缩放 */
export function RegionSelector({ inputPath, region, onRegionChange }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [dragging, setDragging] = useState<DragMode>(null)
  const dragStart = useRef<{ x: number; y: number; region: TextRegion | null }>({ x: 0, y: 0, region: null })
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)

  // 图片加载后记录实际尺寸
  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  /** 鼠标位置 → 归一化坐标 (0~1) */
  const toNorm = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const el = imgRef.current
      if (!el) return { x: 0, y: 0 }
      const rect = el.getBoundingClientRect()
      return {
        x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      }
    },
    []
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const pos = toNorm(e.clientX, e.clientY)

      // 判断是否点击在已有选区的调整手柄上
      if (region) {
        const handleSize = 0.04
        const corners = [
          { key: 'resize-tl' as DragMode, x: region.x, y: region.y },
          { key: 'resize-tr' as DragMode, x: region.x + region.width, y: region.y },
          { key: 'resize-bl' as DragMode, x: region.x, y: region.y + region.height },
          { key: 'resize-br' as DragMode, x: region.x + region.width, y: region.y + region.height }
        ]
        for (const c of corners) {
          if (Math.abs(pos.x - c.x) < handleSize && Math.abs(pos.y - c.y) < handleSize) {
            dragStart.current = { x: pos.x, y: pos.y, region: { ...region } }
            setDragging(c.key)
            return
          }
        }
        // 点击在选区内部 → 移动
        if (
          pos.x >= region.x &&
          pos.x <= region.x + region.width &&
          pos.y >= region.y &&
          pos.y <= region.y + region.height
        ) {
          dragStart.current = { x: pos.x, y: pos.y, region: { ...region } }
          setDragging('move')
          return
        }
      }

      // 其他位置 → 新建选区
      dragStart.current = { x: pos.x, y: pos.y, region: null }
      setDragging('draw')
      onRegionChange({ x: pos.x, y: pos.y, width: 0, height: 0 })
    },
    [region, toNorm, onRegionChange]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const pos = toNorm(e.clientX, e.clientY)
      const start = dragStart.current

      if (dragging === 'draw') {
        const x = Math.min(start.x, pos.x)
        const y = Math.min(start.y, pos.y)
        const w = Math.abs(pos.x - start.x)
        const h = Math.abs(pos.y - start.y)
        onRegionChange({ x, y, width: w, height: h })
      } else if (dragging === 'move' && start.region) {
        const dx = pos.x - start.x
        const dy = pos.y - start.y
        const r = start.region
        onRegionChange({
          x: Math.max(0, Math.min(1 - r.width, r.x + dx)),
          y: Math.max(0, Math.min(1 - r.height, r.y + dy)),
          width: r.width,
          height: r.height
        })
      } else if (start.region) {
        // 四角缩放
        const r = { ...start.region }
        const br = { x: r.x + r.width, y: r.y + r.height }
        if (dragging === 'resize-tl') {
          r.x = Math.min(pos.x, br.x)
          r.y = Math.min(pos.y, br.y)
          r.width = br.x - r.x
          r.height = br.y - r.y
        } else if (dragging === 'resize-tr') {
          r.y = Math.min(pos.y, br.y)
          r.width = Math.max(0, pos.x - r.x)
          r.height = br.y - r.y
        } else if (dragging === 'resize-bl') {
          r.x = Math.min(pos.x, br.x)
          r.width = br.x - r.x
          r.height = Math.max(0, pos.y - r.y)
        } else if (dragging === 'resize-br') {
          r.width = Math.max(0, pos.x - r.x)
          r.height = Math.max(0, pos.y - r.y)
        }
        onRegionChange(r)
      }
    },
    [dragging, toNorm, onRegionChange]
  )

  const handleMouseUp = useCallback(() => {
    // 太小的选区视为无效，清除
    if (region && (region.width < 0.01 || region.height < 0.01)) {
      onRegionChange(null)
    }
    setDragging(null)
  }, [region, onRegionChange])

  // 键盘 Delete/Backspace 清除选区
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && region && !dragging) {
        onRegionChange(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [region, dragging, onRegionChange])

  return (
    <div
      ref={containerRef}
      className={`region-selector${dragging ? ' dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <img
        ref={imgRef}
        src={assetUrl(inputPath)}
        alt="原图"
        className="region-img"
        onLoad={handleImgLoad}
        draggable={false}
      />
      {region && imgSize && (
        <>
          {/* 半透明遮罩层：选区外变暗（上/下/左/右四条矩形条带，兼容性好） */}
          <div className="region-mask-outside" style={{ top: 0, left: 0, right: 0, height: `${region.y * 100}%` }} />
          <div className="region-mask-outside" style={{ top: `${(region.y + region.height) * 100}%`, left: 0, right: 0, bottom: 0 }} />
          <div className="region-mask-outside" style={{ top: `${region.y * 100}%`, left: 0, width: `${region.x * 100}%`, height: `${region.height * 100}%` }} />
          <div className="region-mask-outside" style={{ top: `${region.y * 100}%`, right: 0, width: `${(1 - region.x - region.width) * 100}%`, height: `${region.height * 100}%` }} />
          {/* 选区边框 */}
          <div
            className="region-rect"
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`
            }}
          >
            {/* 四角手柄 */}
            <span className="handle handle-tl" />
            <span className="handle handle-tr" />
            <span className="handle handle-bl" />
            <span className="handle handle-br" />
            {/* 选区尺寸提示 */}
            <span className="region-size-hint">
              {Math.round(region.width * imgSize.w)}×{Math.round(region.height * imgSize.h)}
            </span>
          </div>
        </>
      )}
      {!region && (
        <div className="region-hint">
          <span>🖱️</span>
          <p>拖拽框选货号文字区域</p>
        </div>
      )}
    </div>
  )
}

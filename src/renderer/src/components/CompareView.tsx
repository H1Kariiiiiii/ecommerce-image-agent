import { useRef, useState } from 'react'
import { assetUrl } from '../lib'

interface Props {
  inputPath: string
  outputPath: string
}

type Mode = 'side' | 'slider'

/** 对比分割位置（0~100） */
function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v))
}

export function CompareView({ inputPath, outputPath }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('side')
  const [pos, setPos] = useState(50)
  const wrapRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  /** 根据鼠标 clientX 换算分割位置百分比 */
  const updateFromClientX = (clientX: number): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    if (rect.width === 0) return
    setPos(clampPct(((clientX - rect.left) / rect.width) * 100))
  }

  /** 分隔线/手柄：按住即可拖动（pointer capture，拖动期间事件持续送达） */
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    updateFromClientX(e.clientX)
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (draggingRef.current) {
      updateFromClientX(e.clientX)
    }
  }
  const handlePointerUp = (): void => {
    draggingRef.current = false
  }

  return (
    <div className="compare">
      <div className="compare-toolbar">
        <span className="compare-tip">对比模式：</span>
        <button className={mode === 'side' ? 'chip active' : 'chip'} onClick={() => setMode('side')}>
          并排
        </button>
        <button className={mode === 'slider' ? 'chip active' : 'chip'} onClick={() => setMode('slider')}>
          滑动
        </button>
      </div>

      {mode === 'side' ? (
        <div className="compare-side">
          <figure>
            <img src={assetUrl(inputPath)} alt="原图" />
            <figcaption>原图</figcaption>
          </figure>
          <figure>
            <img src={assetUrl(outputPath)} alt="白底图" />
            <figcaption>白底图</figcaption>
          </figure>
        </div>
      ) : (
        <div className="compare-slider">
          <div className="slider-wrap" ref={wrapRef}>
            <img className="slider-base" src={assetUrl(outputPath)} alt="白底图" />
            <img
              className="slider-overlay"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
              src={assetUrl(inputPath)}
              alt="原图"
            />
            <div
              className="slider-divider"
              style={{ left: `${pos}%` }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <span className="slider-handle">◀▶</span>
            </div>
            <span className="slider-tag left">原图</span>
            <span className="slider-tag right">白底图</span>
          </div>
          <input
            className="slider-range"
            type="range"
            min={0}
            max={100}
            value={pos}
            onChange={(e) => setPos(Number(e.target.value))}
            aria-label="对比分割位置"
          />
        </div>
      )}
    </div>
  )
}

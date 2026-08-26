import { useCallback, useRef, useState } from 'react'

interface Props {
  inputPath: string | null
  onPick: () => void
  /** 拖入的图片绝对路径（可多张） */
  onFiles: (paths: string[]) => void
}

export function UploadZone({ inputPath, onPick, onFiles }: Props): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length > 0) {
        const paths = window.api.getPathsForFiles(files).filter(Boolean)
        if (paths.length > 0) onFiles(paths)
      }
    },
    [onFiles]
  )

  return (
    <div
      className={`upload-zone${dragging ? ' dragging' : ''}${inputPath ? ' has-image' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) setDragging(false)
      }}
      onDrop={handleDrop}
      onClick={onPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onPick()
      }}
    >
      {inputPath ? (
        <div className="upload-replace">
          <span>📷</span>
          <p>点击或拖入新图片替换</p>
          <p className="upload-file">{basenameOf(inputPath)}</p>
        </div>
      ) : (
        <div className="upload-hint">
          <span className="upload-icon">🖼️</span>
          <p>
            <strong>点击选择</strong> 或 <strong>拖拽</strong> 玩具产品图（可多选）
          </p>
          <p className="upload-sub">支持 PNG / JPG / WebP / BMP / GIF</p>
        </div>
      )}
    </div>
  )
}

function basenameOf(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p
}

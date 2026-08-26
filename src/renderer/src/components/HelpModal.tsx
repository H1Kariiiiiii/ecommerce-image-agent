import { useCallback, useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import { HELP_MD } from '../help'

interface Props {
  onClose: () => void
}

/** 章节标题 → 锚点 id（与 marked 渲染的 h2 id 保持一致） */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

interface TocItem {
  id: string
  title: string
}

/** 应用内「使用帮助」窗口：左侧目录 + 右侧说明书正文，目录点击滚动到对应章节 */
export function HelpModal({ onClose }: Props): JSX.Element {
  // 滚动容器是 .help-content（overflow-y: auto），不是 .help-body（仅 flex 布局）
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 去掉 markdown 自带的「目录」章节（改为左侧 React 目录导航）
  const bodyMd = useMemo(() => {
    return HELP_MD.replace(/##\s*目录[\s\S]*?(?=##\s)/, '')
  }, [])

  // 提取所有 ## 章节生成目录
  const toc = useMemo<TocItem[]>(() => {
    const items: TocItem[] = []
    const re = /^##\s+(.+)$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(bodyMd))) {
      const title = m[1].trim()
      if (!title || title === '目录') continue
      items.push({ id: slugify(title), title })
    }
    return items
  }, [bodyMd])

  const renderer = useMemo(() => {
    const r = new marked.Renderer()
    // 说明书中所有链接强制新窗口打开（target=_blank → 主进程 setWindowOpenHandler → 系统浏览器）
    const origLink = r.link.bind(r)
    r.link = (token) => {
      const html = origLink(token)
      return html.replace('<a href', '<a target="_blank" rel="noopener noreferrer" href')
    }
    // 标题生成与目录一致的锚点 id
    const origHeading = r.heading.bind(r)
    r.heading = (token) => {
      const id = slugify(token.text)
      return `<h${token.depth} id="${id}">${token.text}</h${token.depth}>`
    }
    return r
  }, [])

  const html = useMemo(() => marked.parse(bodyMd, { renderer }) as string, [bodyMd, renderer])

  const jumpTo = useCallback((id: string) => {
    const container = contentRef.current
    if (!container) return
    // 不用 querySelector('#中文id')：jsdom/nwsapi 不解析非 ASCII id，遍历标题元素按 id 匹配
    const el = Array.from(container.querySelectorAll('h1,h2,h3')).find((h) => h.id === id)
    if (!el) return
    const top =
      el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose]
  )

  return (
    <div className="modal-mask" onClick={handleBackdrop}>
      <div className="modal help" role="dialog" aria-label="使用帮助">
        <header className="modal-header">
          <h2>📖 使用说明书</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </header>
        <div className="help-body">
          <aside className="help-toc">
            <div className="help-toc-title">目录</div>
            {toc.map((t) => (
              <button key={t.id} className="help-toc-item" onClick={() => jumpTo(t.id)}>
                {t.title}
              </button>
            ))}
          </aside>
          <div
            className="help-content"
            ref={contentRef}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        <footer className="modal-footer">
          <span className="notice" />
          <button className="btn-primary" onClick={onClose}>
            开始使用
          </button>
        </footer>
      </div>
    </div>
  )
}

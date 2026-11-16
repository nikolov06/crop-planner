import { useEffect, useRef, useState } from 'react'

// Показване/скриване на колони с запомняне на избора (в браузъра на потребителя, до следваща промяна).
const KEY = (k: string) => `cp.cols.${k}`

export function useHiddenCols(screen: string) {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(KEY(screen))
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
    } catch { return new Set<string>() }
  })
  const save = (s: Set<string>) => { try { localStorage.setItem(KEY(screen), JSON.stringify(Array.from(s))) } catch { /* без запомняне */ } }
  const toggle = (k: string) => setHidden((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); save(n); return n })
  const showAll = () => { const n = new Set<string>(); save(n); setHidden(n) }
  return { hidden, vis: (k: string) => !hidden.has(k), toggle, showAll }
}

type Item = { key: string; label: string }

// Зъбчата в заглавието на таблицата; отваря списък с отметки за колоните.
export function ColumnPicker({ items, hidden, onToggle, onShowAll }: { items: Item[]; hidden: Set<string>; onToggle: (k: string) => void; onShowAll: () => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (pop.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)) })
    }
    setOpen(!open)
  }
  const hiddenCount = items.filter((i) => hidden.has(i.key)).length

  return (
    <>
      <button ref={btn} type="button" className="gear-btn" onClick={toggleOpen} aria-label="Колони: покажи или скрий" aria-expanded={open} title={hiddenCount ? `Скрити колони: ${hiddenCount}` : 'Колони'}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
        {hiddenCount > 0 && <span className="gear-badge">{hiddenCount}</span>}
      </button>
      {open && (
        <div ref={pop} className="col-pop" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Колони" onClick={(e) => e.stopPropagation()}>
          <div className="col-pop-head"><strong>Колони</strong><button type="button" className="col-pop-link" onClick={onShowAll} disabled={hiddenCount === 0}>Покажи всички</button></div>
          <div className="col-pop-list">
            {items.map((i) => (
              <label key={i.key}>
                <input type="checkbox" checked={!hidden.has(i.key)} onChange={() => onToggle(i.key)} /> {i.label}
              </label>
            ))}
          </div>
          <div className="col-pop-foot">Изборът се запомня в този браузър.</div>
        </div>
      )}
    </>
  )
}

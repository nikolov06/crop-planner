import { useEffect, useRef, useState } from 'react'

// Филтър с избор на няколко стойности (отметки). Стойността се пази като низ, за да пасва на
// досегашните състояния на филтрите: избраните токени са съединени със SEP; празният низ = „Всички“.
export const SEP = '\u001f'
export const splitMulti = (v: string | undefined | null): string[] => (v ? v.split(SEP).filter(Boolean) : [])
// ред минава, ако поне един от избраните токени е изпълнен
export const anyToken = (v: string | undefined | null, test: (token: string) => boolean): boolean => {
  const t = splitMulti(v)
  return t.length === 0 || t.some(test)
}

export type MOpt = { value: string; label: string }

export function MultiFilter({ value, onChange, options, specials = [], ariaLabel, wide }: {
  value: string; onChange: (v: string) => void; options: MOpt[]; specials?: MOpt[]; ariaLabel: string; wide?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const chosen = splitMulti(value)
  const all = [...specials, ...options]

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
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)) })
      setQ('')
    }
    setOpen(!open)
  }
  const flip = (v: string) => {
    const s = new Set(chosen)
    if (s.has(v)) s.delete(v); else s.add(v)
    onChange(all.map((o) => o.value).filter((x) => s.has(x)).join(SEP))
  }
  const text = chosen.length === 0 ? 'Всички' : chosen.length === 1 ? (all.find((o) => o.value === chosen[0])?.label ?? chosen[0]) : `${chosen.length} избрани`
  const ql = q.trim().toLowerCase()
  const shown = options.filter((o) => !ql || o.label.toLowerCase().includes(ql))

  return (
    <>
      <button ref={btn} type="button" className="input fi" aria-label={ariaLabel} aria-expanded={open} onClick={toggleOpen}
        style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', fontWeight: chosen.length ? 700 : 400, cursor: 'pointer' }}>
        {text} <span aria-hidden="true" style={{ float: 'right', opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div ref={pop} className="col-pop" style={{ top: pos.top, left: pos.left, minWidth: wide ? 300 : 240 }} role="dialog" aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
          <div className="col-pop-head">
            <strong>{chosen.length ? `Избрани: ${chosen.length}` : 'Всички'}</strong>
            <button type="button" className="col-pop-link" onClick={() => onChange('')} disabled={chosen.length === 0}>Изчисти</button>
          </div>
          {options.length > 8 && (
            <input className="input" style={{ margin: '0 10px 6px', width: 'calc(100% - 20px)' }} placeholder="Търси в списъка…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          )}
          <div className="col-pop-list">
            {specials.map((o) => (
              <label key={o.value}><input type="checkbox" checked={chosen.includes(o.value)} onChange={() => flip(o.value)} /> <em>{o.label}</em></label>
            ))}
            {shown.map((o) => (
              <label key={o.value}><input type="checkbox" checked={chosen.includes(o.value)} onChange={() => flip(o.value)} /> {o.label}</label>
            ))}
            {shown.length === 0 && <span className="muted" style={{ padding: '4px 10px' }}>Няма съвпадения.</span>}
          </div>
        </div>
      )}
    </>
  )
}

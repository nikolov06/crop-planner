import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, cropColor, cropLabel } from '../lib/format'
import { ColumnPicker, useHiddenCols } from '../lib/columns'

type Planting = {
  planting_id: string
  field_id: string
  field_name: string
  company_name: string | null
  farm_base_name: string | null
  crop_name: string
  planted_area_da: number | null
  potential_name: string | null
  tillage_id: number | null
  tillage_name: string | null
  tillage2_id: number | null
  tillage2_name: string | null
  prev_tillage: string | null
}
type Tillage = { tillage_id: number; name_bg: string }

const PAGE = 1000
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}
const chunks = <T,>(a: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n))
  return out
}

const EMPTY = '__empty'

export default function TillagePlanning() {
  const colPrefs = useHiddenCols('tillage')
  const vis = colPrefs.vis
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [types, setTypes] = useState<Tillage[]>([])
  const [seasonLabel, setSeasonLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [q, setQ] = useState('')
  const [fSel, setFSel] = useState<Record<string, string>>({})
  const [fArea, setFArea] = useState({ min: '', max: '' })
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'field_name', dir: 1 })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const lastIdx = useRef<number | null>(null)

  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string>('keep') // първа: 'keep' | 'clear' | tillage_id
  const [chosen2, setChosen2] = useState<string>('keep') // втора: 'keep' | 'clear' | tillage_id
  const [t2Ok, setT2Ok] = useState(true)

  async function load() {
    setLoading(true); setError(null)
    try {
      const { data: season, error: se } = await supabase.from('season').select('year_end,label').eq('is_current', true).limit(1)
      if (se) throw new Error(se.message)
      const ye = season?.[0]?.year_end as number | undefined
      setSeasonLabel((season?.[0]?.label as string | undefined) ?? '')
      type Ctx = Omit<Planting, 'prev_tillage' | 'tillage2_id' | 'tillage2_name'>
      const cur = await fetchAll<Ctx>((f, t) =>
        supabase.from('v_planting_context')
          .select('planting_id,field_id,field_name,company_name,farm_base_name,crop_name,planted_area_da,potential_name,tillage_id,tillage_name')
          .eq('season_year_end', ye).eq('role', 'main').order('field_name').order('planting_id').range(f, t))
      // последната известна почвообработка – от предходния сезон
      const prev = await fetchAll<{ field_id: string; tillage_name: string | null }>((f, t) =>
        supabase.from('v_planting_context').select('field_id,tillage_name')
          .eq('season_year_end', (ye ?? 0) - 1).eq('role', 'main').order('planting_id').range(f, t))
      const prevMap = new Map(prev.map((x) => [x.field_id, x.tillage_name]))
      const tt = await supabase.from('tillage_type').select('tillage_id,name_bg').eq('is_active', true).order('name_bg')
      if (tt.error) throw new Error(tt.error.message)
      const typeList = (tt.data ?? []) as Tillage[]
      // втора обработка (колона tillage2_id от миграция 20261116130000); ако още липсва, екранът работи само с първа
      const t2 = new Map<string, number>()
      try {
        const rows2 = await fetchAll<{ planting_id: string; tillage2_id: number }>((f, t) =>
          supabase.from('field_planting').select('planting_id,tillage2_id').not('tillage2_id', 'is', null).order('planting_id').range(f, t))
        for (const x of rows2) t2.set(x.planting_id, x.tillage2_id)
        setT2Ok(true)
      } catch { setT2Ok(false) }
      const nameOf = new Map(typeList.map((x) => [x.tillage_id, x.name_bg]))
      setPlantings(cur.map((p) => {
        const id2 = t2.get(p.planting_id) ?? null
        return { ...p, tillage2_id: id2, tillage2_name: id2 != null ? nameOf.get(id2) ?? null : null, prev_tillage: prevMap.get(p.field_id) ?? null }
      }))
      setTypes(typeList)
    } catch (e) { setError((e as Error).message) }
    setLoading(false)
  }
  useEffect(() => { void load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const opts = useMemo(() => {
    const u = (f: (p: Planting) => string | null) =>
      Array.from(new Set(plantings.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    return { company: u((p) => p.company_name), base: u((p) => p.farm_base_name), crop: u((p) => p.crop_name), potential: u((p) => p.potential_name), tillage: u((p) => p.tillage_name), tillage2: u((p) => p.tillage2_name), prev: u((p) => p.prev_tillage) }
  }, [plantings])

  const view = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = plantings.filter((p) => {
      if (n && !p.field_name.toLowerCase().includes(n)) return false
      const eq = (k: string, v: string | null) => { const f = fSel[k]; if (!f) return true; if (f === EMPTY) return !v; return v === f }
      if (!eq('company', p.company_name) || !eq('base', p.farm_base_name) || !eq('crop', p.crop_name) || !eq('potential', p.potential_name)
        || !eq('tillage', p.tillage_name) || !eq('tillage2', p.tillage2_name) || !eq('prev', p.prev_tillage)) return false
      const a = p.planted_area_da ?? 0
      if (fArea.min && a < Number(fArea.min.replace(',', '.'))) return false
      if (fArea.max && a > Number(fArea.max.replace(',', '.'))) return false
      return true
    })
    const { key, dir } = sort
    const val = (p: Planting): string | number => {
      switch (key) {
        case 'company': return p.company_name ?? ''
        case 'base': return p.farm_base_name ?? ''
        case 'crop': return p.crop_name
        case 'area': return p.planted_area_da ?? 0
        case 'potential': return p.potential_name ?? ''
        case 'tillage': return p.tillage_name ?? ''
        case 'tillage2': return p.tillage2_name ?? ''
        case 'prev': return p.prev_tillage ?? ''
        default: return p.field_name
      }
    }
    list.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'bg')) * dir
    })
    return list
  }, [plantings, q, fSel, fArea, sort])

  const activeFilters = (q ? 1 : 0) + Object.values(fSel).filter(Boolean).length + (fArea.min || fArea.max ? 1 : 0)
  const clearFilters = () => { setQ(''); setFSel({}); setFArea({ min: '', max: '' }) }
  const setF = (k: string, v: string) => setFSel((s) => ({ ...s, [k]: v }))
  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '')

  const selected = useMemo(() => plantings.filter((p) => sel.has(p.planting_id)), [plantings, sel])
  const selArea = selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0)
  const allShownSelected = view.length > 0 && view.every((p) => sel.has(p.planting_id))
  const pick = (idx: number, e: { shiftKey: boolean }) => {
    const id = view[idx].planting_id
    setSel((s) => {
      const n = new Set(s)
      if (e.shiftKey && lastIdx.current != null) {
        const [a, b] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)]
        const on = !s.has(id)
        for (let i = a; i <= b; i++) { if (on) n.add(view[i].planting_id); else n.delete(view[i].planting_id) }
      } else if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
    lastIdx.current = idx
  }
  const toggleAll = () => setSel((s) => {
    const n = new Set(s)
    if (allShownSelected) view.forEach((p) => n.delete(p.planting_id)); else view.forEach((p) => n.add(p.planting_id))
    return n
  })

  // ── назначаване ──
  const alreadySet = selected.filter((p) => p.tillage_name).length
  const nameOfType = (id: string) => types.find((t) => String(t.tillage_id) === id)?.name_bg ?? ''
  const nothingChosen = chosen === 'keep' && chosen2 === 'keep'

  // проверка преди запис: втората не може да е без първа и да съвпада с първата
  const problem = useMemo(() => {
    if (nothingChosen) return null
    const first = (p: Planting): number | null => (chosen === 'keep' ? p.tillage_id : chosen === 'clear' ? null : Number(chosen))
    const second = (p: Planting): number | null =>
      chosen === 'clear' ? null : chosen2 === 'keep' ? p.tillage2_id : chosen2 === 'clear' ? null : Number(chosen2)
    const noFirst = selected.filter((p) => second(p) != null && first(p) == null).length
    if (noFirst) return `За ${noFirst} БЗС няма първа обработка – задай първата, преди да добавиш втора.`
    const same = selected.filter((p) => second(p) != null && second(p) === first(p)).length
    if (same) return `За ${same} БЗС втората обработка съвпада с първата.`
    return null
  }, [selected, chosen, chosen2, nothingChosen])

  async function apply() {
    if (nothingChosen || problem) return
    setBusy(true); setError(null); setMsg(null)
    try {
      const patch: Record<string, number | null> = {}
      if (chosen === 'clear') { patch.tillage_id = null; patch.tillage2_id = null }
      else {
        if (chosen !== 'keep') patch.tillage_id = Number(chosen)
        if (chosen2 !== 'keep') patch.tillage2_id = chosen2 === 'clear' ? null : Number(chosen2)
      }
      const ids = selected.map((p) => p.planting_id)
      let done = 0
      for (const part of chunks(ids, 200)) {
        const { data, error: e } = await supabase.from('field_planting').update(patch).in('planting_id', part).select('planting_id')
        if (e) throw new Error(e.message)
        done += (data ?? []).length
      }
      if (done < ids.length) throw new Error(`Записани са само ${done} от ${ids.length} БЗС – за останалите нямате права или периодът е заключен.`)
      const what = chosen === 'clear' ? 'Почвообработката е изчистена'
        : [chosen !== 'keep' ? `първа: „${nameOfType(chosen)}“` : '', chosen2 === 'clear' ? 'втората е премахната' : chosen2 !== 'keep' ? `втора: „${nameOfType(chosen2)}“` : ''].filter(Boolean).join(', ')
      setMsg(`${what} · ${done} БЗС · ${fmtArea(selArea)} дка.`)
      setOpen(false); setChosen('keep'); setChosen2('keep')
      await load()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  const pickerItems = [
    { key: 'company', label: 'Фирма' }, { key: 'base', label: 'Стопанска база' }, { key: 'crop', label: 'Култура' },
    { key: 'area', label: 'Площ, дка' }, { key: 'potential', label: 'Потенциал' }, { key: 'tillage', label: 'Почвообработка' },
    ...(t2Ok ? [{ key: 'tillage2', label: 'Втора обработка' }] : []), { key: 'prev', label: 'Миналия сезон' },
  ]
  const COLS = 2 + pickerItems.filter((i) => vis(i.key)).length

  const totals = useMemo(() => ({ area: view.reduce((s, p) => s + (p.planted_area_da ?? 0), 0) }), [view])
  const withTillage = plantings.filter((p) => p.tillage_name).length

  // кратка статистика по вид (за показаните БЗС)
  const summary = useMemo(() => {
    const m = new Map<string, { n: number; area: number }>()
    for (const p of view) {
      const k = p.tillage_name ? p.tillage_name + (p.tillage2_name ? ' + ' + p.tillage2_name : '') : '— не е зададена —'
      const c = m.get(k) ?? { n: 0, area: 0 }
      c.n += 1; c.area += p.planted_area_da ?? 0
      m.set(k, c)
    }
    return Array.from(m.entries()).sort((a, b) => b[1].area - a[1].area)
  }, [view])

  return (
    <>
      <div className="page-head">
        <h1>Почвообработка{seasonLabel ? ` · ${seasonLabel}` : ''}</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${view.length} от ${plantings.length} БЗС · ${fmtArea(totals.area)} дка · с почвообработка: ${withTillage}`}</span>
      </div>

      {error && <div className="banner err" role="alert">Грешка: {error}</div>}
      {msg && <div className="banner" role="status" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-strong-bg)', color: 'var(--ok-ink)' }}>{msg}</div>}

      <div className="filters">
        <label className="field grow">Търсене (име на БЗС)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn outline" onClick={clearFilters} disabled={activeFilters === 0}>Изчисти филтрите{activeFilters ? ` (${activeFilters})` : ''}</button>
      </div>

      {sel.size > 0 && (
        <div className="card pad seed-toolbar">
          <strong>Избрани: {selected.length} БЗС · {fmtArea(selArea)} дка</strong>
          <div className="filters">
            <button className="btn" onClick={() => { setChosen('keep'); setChosen2('keep'); setOpen(true) }}>Назначи почвообработка…</button>
            <button className="btn outline" onClick={() => setSel(new Set())}>Откажи избора</button>
          </div>
          <span className="muted">Съвет: Shift + клик избира диапазон. Филтрирай по култура и база, после „избери всички показани“ от отметката в заглавието.</span>
        </div>
      )}

      <div className="card">
        <table className="grid" style={{ minWidth: 1400 }}>
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Избери всички показани" checked={allShownSelected} onChange={toggleAll} /></th>
              <th><button onClick={() => toggleSort('field_name')}>Наименование {arrow('field_name')}</button><ColumnPicker items={pickerItems} hidden={colPrefs.hidden} onToggle={colPrefs.toggle} onShowAll={colPrefs.showAll} /></th>
              {vis('company') && (<th><button onClick={() => toggleSort('company')}>Фирма {arrow('company')}</button></th>)}
              {vis('base') && (<th><button onClick={() => toggleSort('base')}>Стопанска база {arrow('base')}</button></th>)}
              {vis('crop') && (<th><button onClick={() => toggleSort('crop')}>Култура {arrow('crop')}</button></th>)}
              {vis('area') && (<th className="num"><button onClick={() => toggleSort('area')}>Площ, дка {arrow('area')}</button></th>)}
              {vis('potential') && (<th><button onClick={() => toggleSort('potential')}>Потенциал {arrow('potential')}</button></th>)}
              {vis('tillage') && (<th><button onClick={() => toggleSort('tillage')}>Почвообработка {arrow('tillage')}</button></th>)}
              {t2Ok && vis('tillage2') && <th><button onClick={() => toggleSort('tillage2')}>Втора обработка {arrow('tillage2')}</button></th>}
              {vis('prev') && (<th><button onClick={() => toggleSort('prev')}>Миналия сезон {arrow('prev')}</button></th>)}
            </tr>
            <tr className="filter-row">
              <th />
              <th><input className="input fi" placeholder="Филтър" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Филтър Наименование" /></th>
              {(['company', 'base', 'crop'] as const).filter((k) => vis(k)).map((k) => (
                <th key={k}>
                  <select className="input fi" value={fSel[k] ?? ''} onChange={(e) => setF(k, e.target.value)} aria-label={`Филтър ${k}`}>
                    <option value="">Всички</option><option value={EMPTY}>— празно —</option>
                    {opts[k].map((v) => <option key={v} value={v}>{k === 'crop' ? cropLabel(v) : v}</option>)}
                  </select>
                </th>
              ))}
              {vis('area') && <th className="num">
                <span className="range">
                  <input className="input fi" inputMode="decimal" placeholder="от" value={fArea.min} onChange={(e) => setFArea({ ...fArea, min: e.target.value })} aria-label="Площ от" />
                  <input className="input fi" inputMode="decimal" placeholder="до" value={fArea.max} onChange={(e) => setFArea({ ...fArea, max: e.target.value })} aria-label="Площ до" />
                </span>
              </th>}
              {(t2Ok ? ['potential', 'tillage', 'tillage2', 'prev'] as const : ['potential', 'tillage', 'prev'] as const).filter((k) => vis(k)).map((k) => (
                <th key={k}>
                  <select className="input fi" value={fSel[k] ?? ''} onChange={(e) => setF(k, e.target.value)} aria-label={`Филтър ${k}`}>
                    <option value="">Всички</option><option value={EMPTY}>— няма —</option>
                    {opts[k].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((p, idx) => {
              const on = sel.has(p.planting_id)
              return (
                <tr key={p.planting_id} className={`row ${on ? 'open' : ''}`} onClick={(e) => pick(idx, e)}>
                  <td><input type="checkbox" checked={on} onChange={() => undefined} aria-label={`Избери ${p.field_name}`} /></td>
                  <td><span className="name">{p.field_name}</span></td>
                  {vis('company') && <td>{p.company_name ?? <span className="empty">—</span>}</td>}
                  {vis('base') && <td>{p.farm_base_name ?? <span className="empty">—</span>}</td>}
                  {vis('crop') && <td><span className="crop crop-main"><span className="dot" style={{ background: cropColor(p.crop_name) }} />{cropLabel(p.crop_name)}</span></td>}
                  {vis('area') && <td className="num">{fmtArea(p.planted_area_da)}</td>}
                  {vis('potential') && <td>{p.potential_name ?? <span className="empty">—</span>}</td>}
                  {vis('tillage') && <td>{p.tillage_name ? <span className="chip ok">{p.tillage_name}</span> : <span className="empty">—</span>}</td>}
                  {t2Ok && vis('tillage2') && <td>{p.tillage2_name ? <span className="chip ok">{p.tillage2_name}</span> : <span className="empty">—</span>}</td>}
                  {vis('prev') && <td>{p.prev_tillage ? <span className="chip">{p.prev_tillage}</span> : <span className="empty">—</span>}</td>}
                </tr>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={COLS} className="empty">Няма БЗС по тези филтри.</td></tr>}
          </tbody>
        </table>
      </div>

      <details className="card pad">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Обобщение за показаните БЗС ({summary.length} реда)</summary>
        <table className="grid narrow" style={{ marginTop: 12 }}>
          <thead><tr><th>Почвообработка</th><th className="num">БЗС</th><th className="num">Площ, дка</th></tr></thead>
          <tbody>
            {summary.map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{v.n}</td><td className="num">{fmtArea(v.area)}</td></tr>)}
          </tbody>
        </table>
      </details>

      {open && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Назначи почвообработка" onClick={() => !busy && setOpen(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h2 style={{ flex: 1 }}>Назначи почвообработка на {selected.length} БЗС · {fmtArea(selArea)} дка</h2>
              <button className="btn outline" onClick={() => setOpen(false)} disabled={busy}>Затвори</button>
            </div>
            <div className="filters">
              <label className="field" style={{ flex: '1 1 240px' }}>Първа обработка
                <select className="input" value={chosen} onChange={(e) => setChosen(e.target.value)}>
                  <option value="keep">— не променяй —</option>
                  {types.map((t) => <option key={t.tillage_id} value={String(t.tillage_id)}>{t.name_bg}</option>)}
                  <option value="clear">— изчисти всичко —</option>
                </select>
              </label>
              {t2Ok && (
                <label className="field" style={{ flex: '1 1 240px' }}>Втора обработка (по избор)
                  <select className="input" value={chosen === 'clear' ? 'clear' : chosen2} disabled={chosen === 'clear'} onChange={(e) => setChosen2(e.target.value)}>
                    <option value="keep">— не променяй —</option>
                    {types.map((t) => <option key={t.tillage_id} value={String(t.tillage_id)}>{t.name_bg}</option>)}
                    <option value="clear">— без втора обработка —</option>
                  </select>
                </label>
              )}
            </div>
            {!nothingChosen && (
              <div>
                {chosen === 'clear'
                  ? <>Ще се изчисти почвообработката на <strong>{selected.length}</strong> БЗС.</>
                  : <>Ще се зададе на <strong>{selected.length}</strong> БЗС · {fmtArea(selArea)} дка:
                    {chosen !== 'keep' && <> първа „<strong>{nameOfType(chosen)}</strong>“</>}
                    {chosen2 !== 'keep' && <>{chosen !== 'keep' ? ',' : ''} {chosen2 === 'clear' ? 'без втора обработка' : <>втора „<strong>{nameOfType(chosen2)}</strong>“</>}</>}.</>}
                {chosen !== 'keep' && alreadySet > 0 && <div className="muted" style={{ marginTop: 6 }}>За {alreadySet} БЗС вече има почвообработка и първата ще се презапише.</div>}
              </div>
            )}
            {problem && <div className="banner err" role="alert">{problem}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={apply} disabled={nothingChosen || !!problem || busy}>{busy ? 'Записване…' : 'Назначи'}</button>
              <button className="btn outline" onClick={() => setOpen(false)} disabled={busy}>Отказ</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

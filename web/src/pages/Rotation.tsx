import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtRate, cropColor, cropLabel } from '../lib/format'

type SeedRow = { variety: string | null; reproduction: string | null; area_da: number | null; rate: number | null; rate_basis: string | null; origin: string | null }
type AliasRow = { name: string; isak_number: string | null; area_da: number | null }
type Row = {
  field_id: string
  code: string | null
  field_name: string
  isak_number: string | null
  company_name: string | null
  farm_base_name: string | null
  settlement_name: string | null
  work_field_name: string | null
  season_label: string | null
  area_da: number | null
  crop: string | null
  crop_prev1: string | null
  crop_prev2: string | null
  crop_prev3: string | null
  crop_prev4: string | null
  season_prev1: string | null
  season_prev2: string | null
  season_prev3: string | null
  season_prev4: string | null
  n_second_crops: number | null
  potential?: string | null
  tillage?: string | null
  seeds: SeedRow[] | null
  aliases: AliasRow[] | null
}

type ColKey = 'field_name' | 'company' | 'base' | 'area' | 'crop' | 'p1' | 'p2' | 'p3' | 'p4' | 'potential' | 'tillage' | 'variety' | 'repro' | 'rate'
type Kind = 'text' | 'select' | 'num'
type Col = { key: ColKey; kind: Kind; num?: boolean }

const PAGE = 1000
const EMPTY = '__empty'
const POT_RANK: Record<string, number> = { 'лоша': 1, 'средна': 2, 'добра': 3, 'много добра': 4 }

const COLS: Col[] = [
  { key: 'field_name', kind: 'text' }, { key: 'company', kind: 'select' }, { key: 'base', kind: 'select' },
  { key: 'area', kind: 'num', num: true }, { key: 'crop', kind: 'select' },
  { key: 'p1', kind: 'select' }, { key: 'p2', kind: 'select' }, { key: 'p3', kind: 'select' }, { key: 'p4', kind: 'select' },
  { key: 'potential', kind: 'select' }, { key: 'tillage', kind: 'select' },
  { key: 'variety', kind: 'select' }, { key: 'repro', kind: 'select' }, { key: 'rate', kind: 'num', num: true },
]

// значение на колона за един ред (за филтри и сортиране)
function textVal(r: Row, k: ColKey): string {
  switch (k) {
    case 'field_name': return r.field_name ?? ''
    case 'company': return r.company_name ?? ''
    case 'base': return r.farm_base_name ?? ''
    case 'crop': return r.crop ?? ''
    case 'p1': return r.crop_prev1 ?? ''
    case 'p2': return r.crop_prev2 ?? ''
    case 'p3': return r.crop_prev3 ?? ''
    case 'p4': return r.crop_prev4 ?? ''
    case 'potential': return r.potential ?? ''
    case 'tillage': return r.tillage ?? ''
    default: return ''
  }
}
const seedVals = (r: Row, k: 'variety' | 'repro') =>
  (r.seeds ?? []).map((s) => (k === 'variety' ? s.variety : s.reproduction)).filter((x): x is string => !!x)
const numVal = (r: Row, k: 'area' | 'rate'): number | null =>
  k === 'area' ? r.area_da : ((r.seeds ?? []).find((s) => s.rate != null)?.rate ?? null)

function CropCell({ crop, main }: { crop: string | null; main?: boolean }) {
  if (!crop) return <span className="empty">—</span>
  return (
    <span className={`crop ${main ? 'crop-main' : 'crop-prev'}`}>
      <span className="dot" style={{ background: cropColor(crop) }} />
      {cropLabel(crop)}
    </span>
  )
}

export default function Rotation() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Record<string, string>>({})          // текст/избор по колона
  const [rng, setRng] = useState<Record<string, { min: string; max: string }>>({})  // площ, норма
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 }>({ key: 'field_name', dir: 1 })
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const all: Row[] = []
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase.from('v_rotation_list').select('*').order('field_name').order('field_id').range(from, from + PAGE - 1)
          if (error) throw new Error(error.message)
          all.push(...((data ?? []) as Row[]))
          if (!data || data.length < PAGE) break
        }
        // потенциал и почвообработка за текущия сезон (основен период)
        const { data: season } = await supabase.from('season').select('year_end').eq('is_current', true).limit(1)
        const ye = season?.[0]?.year_end
        const extra = new Map<string, { potential: string | null; tillage: string | null }>()
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase.from('v_planting_context')
            .select('field_id,potential_name,tillage_name')
            .eq('season_year_end', ye).eq('role', 'main').order('planting_id').range(from, from + PAGE - 1)
          if (error) throw new Error(error.message)
          for (const x of (data ?? []) as { field_id: string; potential_name: string | null; tillage_name: string | null }[])
            extra.set(x.field_id, { potential: x.potential_name, tillage: x.tillage_name })
          if (!data || data.length < PAGE) break
        }
        for (const r of all) { const e = extra.get(r.field_id); r.potential = e?.potential ?? null; r.tillage = e?.tillage ?? null }
        if (!cancelled) setRows(all)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  const options = useMemo(() => {
    const o: Partial<Record<ColKey, string[]>> = {}
    for (const c of COLS) {
      if (c.kind !== 'select') continue
      const set = new Set<string>()
      for (const r of rows) {
        if (c.key === 'variety' || c.key === 'repro') seedVals(r, c.key).forEach((v) => set.add(v))
        else { const v = textVal(r, c.key); if (v) set.add(v) }
      }
      const arr = Array.from(set)
      arr.sort((a, b) => c.key === 'potential' ? (POT_RANK[a] ?? 9) - (POT_RANK[b] ?? 9) : a.localeCompare(b, 'bg'))
      o[c.key] = arr
    }
    return o
  }, [rows])

  const activeCount = Object.values(sel).filter(Boolean).length + Object.values(rng).filter((x) => x.min || x.max).length + (q ? 1 : 0)
  const clearAll = () => { setQ(''); setSel({}); setRng({}) }

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = rows.filter((r) => {
      if (needle) {
        const hay = [r.field_name, r.code, r.isak_number, r.work_field_name, ...(r.aliases ?? []).map((a) => a.name)].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      for (const c of COLS) {
        if (c.kind === 'num') {
          const f = rng[c.key]; if (!f || (!f.min && !f.max)) continue
          const v = numVal(r, c.key as 'area' | 'rate')
          if (v == null) return false
          if (f.min && v < Number(f.min.replace(',', '.'))) return false
          if (f.max && v > Number(f.max.replace(',', '.'))) return false
          continue
        }
        const f = sel[c.key]; if (!f) continue
        if (c.kind === 'text') { if (!textVal(r, c.key).toLowerCase().includes(f.toLowerCase())) return false; continue }
        if (c.key === 'variety' || c.key === 'repro') {
          const vs = seedVals(r, c.key)
          if (f === EMPTY ? vs.length > 0 : !vs.includes(f)) return false
          continue
        }
        const v = textVal(r, c.key)
        if (f === EMPTY ? v !== '' : v !== f) return false
      }
      return true
    })
    const { key, dir } = sort
    const col = COLS.find((c) => c.key === key)!
    list.sort((a, b) => {
      if (col.kind === 'num') return ((numVal(a, key as 'area' | 'rate') ?? -1) - (numVal(b, key as 'area' | 'rate') ?? -1)) * dir
      const f = (r: Row) => key === 'variety' || key === 'repro' ? (seedVals(r, key)[0] ?? '') : textVal(r, key)
      if (key === 'potential') return ((POT_RANK[f(a)] ?? 0) - (POT_RANK[f(b)] ?? 0)) * dir
      return f(a).localeCompare(f(b), 'bg') * dir
    })
    return list
  }, [rows, q, sel, rng, sort])

  const total = useMemo(() => view.reduce((s, r) => s + (r.area_da ?? 0), 0), [view])
  const toggleSort = (key: ColKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: ColKey) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '')

  const seasonLabel = rows[0]?.season_label
  const prevLabels = [1, 2, 3, 4].map((i) => rows.find((r) => r[`season_prev${i}` as keyof Row])?.[`season_prev${i}` as keyof Row] as string | undefined)
  const label: Record<ColKey, string> = {
    field_name: 'Наименование', company: 'Фирма', base: 'Стопанска база', area: 'Площ, дка', crop: `Култура ${seasonLabel ?? ''}`,
    p1: prevLabels[0] ?? '−1', p2: prevLabels[1] ?? '−2', p3: prevLabels[2] ?? '−3', p4: prevLabels[3] ?? '−4',
    potential: 'Потенциал', tillage: 'Почвообработка', variety: 'Сорт / хибрид', repro: 'Размножение', rate: 'Сеитбена норма',
  }
  const cropKeys: ColKey[] = ['crop', 'p1', 'p2', 'p3', 'p4']

  return (
    <>
      <div className="page-head">
        <h1>Сеитбооборот</h1>
        <span className="muted">{loading ? 'Зареждане…' : `Показани ${view.length} от ${rows.length} полета · ${fmtArea(total)} дка`}</span>
      </div>

      {error && <div className="banner err" role="alert">Грешка при зареждане: {error}</div>}

      <div className="filters">
        <label className="field grow">
          Търсене (име, БЗС, разширено име)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn outline" onClick={clearAll} disabled={activeCount === 0}>Изчисти филтрите{activeCount ? ` (${activeCount})` : ''}</button>
      </div>

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''}><button onClick={() => toggleSort(c.key)}>{label[c.key]} {arrow(c.key)}</button></th>
              ))}
            </tr>
            <tr className="filter-row">
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''}>
                  {c.kind === 'text' && (
                    <input className="input fi" placeholder="Филтър" value={sel[c.key] ?? ''} onChange={(e) => setSel({ ...sel, [c.key]: e.target.value })} aria-label={`Филтър ${label[c.key]}`} />
                  )}
                  {c.kind === 'select' && (
                    <select className="input fi" value={sel[c.key] ?? ''} onChange={(e) => setSel({ ...sel, [c.key]: e.target.value })} aria-label={`Филтър ${label[c.key]}`}>
                      <option value="">Всички</option>
                      <option value={EMPTY}>— празно —</option>
                      {(options[c.key] ?? []).map((v) => <option key={v} value={v}>{cropKeys.includes(c.key) ? cropLabel(v) : v}</option>)}
                    </select>
                  )}
                  {c.kind === 'num' && (
                    <span className="range">
                      <input className="input fi" inputMode="decimal" placeholder="от" value={rng[c.key]?.min ?? ''} onChange={(e) => setRng({ ...rng, [c.key]: { min: e.target.value, max: rng[c.key]?.max ?? '' } })} aria-label={`${label[c.key]} от`} />
                      <input className="input fi" inputMode="decimal" placeholder="до" value={rng[c.key]?.max ?? ''} onChange={(e) => setRng({ ...rng, [c.key]: { min: rng[c.key]?.min ?? '', max: e.target.value } })} aria-label={`${label[c.key]} до`} />
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
              const open = openId === r.field_id
              const seeds = r.seeds ?? []
              const s0 = seeds[0]
              return (
                <Fragment key={r.field_id}>
                  <tr className={`row ${open ? 'open' : ''}`} onClick={() => setOpenId(open ? null : r.field_id)}>
                    <td>
                      <span className="name">
                        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {r.field_name}
                      </span>
                    </td>
                    <td>{r.company_name ?? <span className="empty">—</span>}</td>
                    <td>{r.farm_base_name ?? <span className="empty">—</span>}</td>
                    <td className="num">{fmtArea(r.area_da)}</td>
                    <td><CropCell crop={r.crop} main />{(r.n_second_crops ?? 0) > 0 && <> <span className="chip">+{r.n_second_crops}</span></>}</td>
                    <td><CropCell crop={r.crop_prev1} /></td>
                    <td><CropCell crop={r.crop_prev2} /></td>
                    <td><CropCell crop={r.crop_prev3} /></td>
                    <td><CropCell crop={r.crop_prev4} /></td>
                    <td>{r.potential ?? <span className="empty">—</span>}</td>
                    <td>{r.tillage ?? <span className="empty">—</span>}</td>
                    <td>{s0?.variety ? <>{s0.variety}{seeds.length > 1 && <> <span className="chip">+{seeds.length - 1}</span></>}</> : <span className="empty">—</span>}</td>
                    <td>{s0?.reproduction ?? <span className="empty">—</span>}</td>
                    <td className="num">{s0?.rate != null ? fmtRate(s0.rate, s0.rate_basis) : <span className="empty">—</span>}</td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={COLS.length}>
                        <div className="detail-grid detail">
                          <div>
                            <h3>Данни за БЗС</h3>
                            <table className="mini"><tbody>
                              <tr><th>Код</th><td>{r.code ?? '—'}</td></tr>
                              <tr><th>ИСАК №</th><td>{r.isak_number ?? '—'}</td></tr>
                              <tr><th>Землище</th><td>{r.settlement_name ?? '—'}</td></tr>
                              <tr><th>Обработваемо поле</th><td>{r.work_field_name ?? '—'}</td></tr>
                            </tbody></table>
                          </div>
                          <div>
                            <h3>Разширени имена</h3>
                            {(r.aliases ?? []).length === 0 ? <span className="empty">Няма</span> : (
                              <table className="mini"><thead><tr><th>Име</th><th>ИСАК №</th><th className="num">Площ</th></tr></thead><tbody>
                                {(r.aliases ?? []).map((a, i) => (
                                  <tr key={i}><td>{a.name}</td><td>{a.isak_number ?? '—'}</td><td className="num">{fmtArea(a.area_da)}</td></tr>
                                ))}
                              </tbody></table>
                            )}
                          </div>
                          <div>
                            <h3>Сортове / хибриди</h3>
                            {seeds.length === 0 ? <span className="empty">Още няма въведени</span> : (
                              <table className="mini"><thead><tr><th>Сорт</th><th>Размн.</th><th className="num">Площ</th><th className="num">Норма</th><th>Произход</th></tr></thead><tbody>
                                {seeds.map((s, i) => (
                                  <tr key={i}><td>{s.variety ?? '—'}</td><td>{s.reproduction ?? '—'}</td><td className="num">{fmtArea(s.area_da)}</td><td className="num">{s.rate != null ? fmtRate(s.rate, s.rate_basis) : '—'}</td><td>{s.origin ?? '—'}</td></tr>
                                ))}
                              </tbody></table>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {!loading && view.length === 0 && (
              <tr><td colSpan={COLS.length} className="empty">Няма полета по тези филтри.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

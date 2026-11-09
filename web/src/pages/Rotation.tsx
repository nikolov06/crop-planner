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
  seeds: SeedRow[] | null
  aliases: AliasRow[] | null
}

type SortKey = 'field_name' | 'area_da' | 'crop'

const PAGE = 1000

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
  const [base, setBase] = useState('')
  const [crop, setCrop] = useState('')
  const [company, setCompany] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'field_name', dir: 1 })
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const all: Row[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('v_rotation_list')
          .select('*')
          .order('field_name')
          .order('field_id')
          .range(from, from + PAGE - 1)
        if (error) {
          if (!cancelled) setError(error.message)
          break
        }
        all.push(...((data ?? []) as Row[]))
        if (!data || data.length < PAGE) break
      }
      if (!cancelled) {
        setRows(all)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const opts = useMemo(() => {
    const uniq = (f: (r: Row) => string | null) =>
      Array.from(new Set(rows.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    return { bases: uniq((r) => r.farm_base_name), crops: uniq((r) => r.crop), companies: uniq((r) => r.company_name) }
  }, [rows])

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = rows.filter((r) => {
      if (base && r.farm_base_name !== base) return false
      if (crop && r.crop !== crop) return false
      if (company && r.company_name !== company) return false
      if (needle) {
        const hay = [r.field_name, r.code, r.isak_number, r.work_field_name, ...(r.aliases ?? []).map((a) => a.name)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    const { key, dir } = sort
    list.sort((a, b) => {
      if (key === 'area_da') return ((a.area_da ?? 0) - (b.area_da ?? 0)) * dir
      const av = (key === 'crop' ? a.crop : a.field_name) ?? ''
      const bv = (key === 'crop' ? b.crop : b.field_name) ?? ''
      return av.localeCompare(bv, 'bg') * dir
    })
    return list
  }, [rows, q, base, crop, company, sort])

  const total = useMemo(() => view.reduce((s, r) => s + (r.area_da ?? 0), 0), [view])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '')

  const seasonLabel = rows[0]?.season_label
  const prevLabels = [1, 2, 3, 4].map((i) => rows.find((r) => r[`season_prev${i}` as keyof Row])?.[`season_prev${i}` as keyof Row] as string | undefined)

  return (
    <>
      <div className="page-head">
        <h1>Сеитбооборот</h1>
        <span className="muted">
          {loading ? 'Зареждане…' : `Показани ${view.length} от ${rows.length} полета · ${fmtArea(total)} дка`}
        </span>
      </div>

      {error && <div className="banner err" role="alert">Грешка при зареждане: {error}</div>}

      <div className="filters">
        <label className="field grow">
          Търсене (име, БЗС, разширено име)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          Стопанска база
          <select className="input" value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">Всички</option>
            {opts.bases.map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
        <label className="field">
          Култура
          <select className="input" value={crop} onChange={(e) => setCrop(e.target.value)}>
            <option value="">Всички</option>
            {opts.crops.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}
          </select>
        </label>
        <label className="field">
          Фирма
          <select className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">Всички</option>
            {opts.companies.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th><button onClick={() => toggleSort('field_name')}>Наименование {arrow('field_name')}</button></th>
              <th>Фирма</th>
              <th>Стопанска база</th>
              <th className="num"><button onClick={() => toggleSort('area_da')}>Площ, дка {arrow('area_da')}</button></th>
              <th><button onClick={() => toggleSort('crop')}>Култура {seasonLabel ?? ''} {arrow('crop')}</button></th>
              {prevLabels.map((l, i) => <th key={i}>{l ?? `−${i + 1}`}</th>)}
              <th>Сорт / хибрид</th>
              <th>Размножение</th>
              <th className="num">Сеитбена норма</th>
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
                    <td>{s0?.variety ? <>{s0.variety}{seeds.length > 1 && <> <span className="chip">+{seeds.length - 1}</span></>}</> : <span className="empty">—</span>}</td>
                    <td>{s0?.reproduction ?? <span className="empty">—</span>}</td>
                    <td className="num">{s0?.rate != null ? fmtRate(s0.rate, s0.rate_basis) : <span className="empty">—</span>}</td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={12}>
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
              <tr><td colSpan={12} className="empty">Няма полета по тези филтри.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

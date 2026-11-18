import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { cropColor, fmtDka } from '../lib/format'
import { MultiFilter, splitMulti } from '../lib/multifilter'
import { downloadXlsxBook, type Cell, type Sheet } from '../lib/xlsx'
import { ENP_GROUP, computeCompany, fmtPct, placeLabel, statusText, type CompanyRecap, type EcoRule, type GroupArea, type SchemeResult } from '../lib/recap'

// Сеитбооборот → Рекапитулация: площи по фирма и култура (правно основание), ДЗЕС / ЕКОРОК, ЕНП, стопански бази.

type Season = { season_id: number; label: string; is_current: boolean }
type VRow = {
  company_id: string | null; company_name: string | null; in_holding: boolean
  role: 'main' | 'second'; crop_name: string; recap_group: string | null; in_total: boolean; ranks: boolean
  area_dka: number; n_bzs: number; has_fallback: boolean; fallback_bzs: string[]
}
type BRow = { farm_base_name: string | null; crop_name: string; planted_area_dka: number }

// Колони на таблицата с площи (култури от номенклатурата → колона)
type AreaCol = { key: string; label: string; crops?: string[]; enp?: boolean; title?: string }
const AREA_COLS: AreaCol[] = [
  { key: 'ech', label: 'Ечемик', crops: ['ЕЧЕМИК'] },
  { key: 'psh', label: 'Пшеница', crops: ['ПШЕНИЦА'] },
  { key: 'rap', label: 'Рапица', crops: ['РАПИЦА'] },
  { key: 'sl', label: 'Слънчоглед', crops: ['СЛЪНЧОГЛЕД'] },
  { key: 'car', label: 'Царевица', crops: ['ЦАРЕВИЦА', 'ПОЛИВНА ЦАРЕВИЦА'], title: 'Царевица и поливна царевица' },
  { key: 'sor', label: 'Сорго', crops: ['СОРГО'] },
  { key: 'npp', label: 'НПП', crops: ['НПП'] },
  { key: 'lu', label: 'Люцерна', crops: ['ЛЮЦЕРНА'] },
  { key: 'gr', label: 'Грах', crops: ['ГРАХ'] },
  { key: 'enp', label: 'ЕНП реално', enp: true, title: 'Изчислява се: НПП + люцерна + грах (група „ЕНП РЕАЛНО“)' },
  { key: 'lo', label: 'Лозя', crops: ['ЛОЗЯ'] },
]
const BASE_COLS = [
  { label: 'Ечемик', crop: 'ЕЧЕМИК', autumn: true }, { label: 'Пшеница', crop: 'ПШЕНИЦА', autumn: true }, { label: 'Рапица', crop: 'РАПИЦА', autumn: true },
  { label: 'Сорго', crop: 'СОРГО' }, { label: 'Царевица', crop: 'ЦАРЕВИЦА' }, { label: 'Поливна царевица', crop: 'ПОЛИВНА ЦАРЕВИЦА' }, { label: 'Слънчоглед', crop: 'СЛЪНЧОГЛЕД' },
]
const GROUP_COLOR: Record<string, string> = { [ENP_GROUP]: 'var(--crop-alfalfa)' }
const groupLabel = (g: string) => (g === ENP_GROUP ? 'ЕНП реално' : g.charAt(0) + g.slice(1).toLowerCase())
const NO_FIRM = 'Без фирма'
const PAGE = 1000

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

// ───────── етикети ok / warn / info с икона ─────────
function Icon({ tone }: { tone: 'ok' | 'warn' | 'info' }) {
  if (tone === 'ok') return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (tone === 'warn') return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5l4.8 8.7H1.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M6 5v2.4M6 8.8v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6 5.3v3M6 3.6v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
}
function Tag({ tone, children, title }: { tone: 'ok' | 'warn' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`chip tag ${tone === 'info' ? 'info' : tone}`} title={title}><Icon tone={tone} />{children}</span>
}
function Status({ r }: { r: SchemeResult }) {
  return r.ok ? <Tag tone="ok">Покрива</Tag> : <Tag tone="warn" title={r.fails.map((f) => f.text).join('\n')}>{statusText(r)}</Tag>
}
function Bar({ share, color }: { share: number; color: string }) {
  return (
    <div className="bar" aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(100, share * 100))}%`, background: color }} /></div>
  )
}

type Firm = { key: string; name: string; inHolding: boolean; main: VRow[]; second: VRow[]; recap: CompanyRecap }
const itemsOf = (rows: VRow[]): GroupArea[] => rows.filter((r) => r.recap_group).map((r) => ({ group: r.recap_group!, area: Number(r.area_dka), inTotal: r.in_total, ranks: r.ranks }))
const colArea = (rows: VRow[], c: AreaCol) => rows.reduce((a, r) => a + ((c.enp ? r.recap_group === ENP_GROUP : c.crops!.includes(r.crop_name)) ? Number(r.area_dka) : 0), 0)
const totalArea = (rows: VRow[]) => rows.reduce((a, r) => a + (r.recap_group && r.in_total ? Number(r.area_dka) : 0), 0)

export default function RotationRecap() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [sid, setSid] = useState<number | null>(null)
  const [rows, setRows] = useState<VRow[]>([])
  const [bases, setBases] = useState<BRow[]>([])
  const [rule, setRule] = useState<EcoRule | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fCrop, setFCrop] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [fbOpen, setFbOpen] = useState(false)

  useEffect(() => {
    supabase.from('season').select('season_id,label,is_current').order('year_end').then(({ data, error }) => {
      if (error) { setError(error.message); setLoading(false); return }
      const s = (data ?? []) as Season[]
      setSeasons(s)
      setSid((s.find((x) => x.is_current) ?? s[s.length - 1])?.season_id ?? null)
    })
  }, [])

  useEffect(() => {
    if (sid == null) return
    let off = false
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const [r, b, ru] = await Promise.all([
          fetchAll<VRow>((a, z) => supabase.from('v_recap_company_crop').select('company_id,company_name,in_holding,role,crop_name,recap_group,in_total,ranks,area_dka,n_bzs,has_fallback,fallback_bzs').eq('season_id', sid).order('company_name').order('crop_name').order('role').range(a, z)),
          fetchAll<BRow>((a, z) => supabase.from('v_recap_base_crop').select('farm_base_name,crop_name,planted_area_dka').eq('season_id', sid).order('farm_base_name').order('crop_name').range(a, z)),
          supabase.from('eco_scheme_rule').select('*').eq('season_id', sid).maybeSingle(),
        ])
        if (ru.error) throw new Error(ru.error.message)
        if (off) return
        setRows(r); setBases(b)
        setRule(ru.data ? Object.fromEntries(Object.entries(ru.data).map(([k, v]) => [k, typeof v === 'string' && /^[\d.]+$/.test(v) ? Number(v) : v])) as unknown as EcoRule : null)
      } catch (e) { if (!off) setError((e as Error).message) }
      if (!off) setLoading(false)
    })()
    return () => { off = true }
  }, [sid])

  const seasonLabel = seasons.find((s) => s.season_id === sid)?.label ?? ''
  const effRule: EcoRule = rule ?? { dzes_first_max: 0.75, dzes_first_two_max: 0.95, dzes_third_min: 0.05, ekorok_first_max: 0.75, ekorok_first_three_max: 0.95, ekorok_fourth_min: 0.05, enp_min: 0.04, dzes_min_crops: 3, ekorok_min_crops: 4, min_crops_from_dka: 300 }

  const firms = useMemo<Firm[]>(() => {
    const m = new Map<string, Omit<Firm, 'recap'>>()
    for (const r of rows) {
      const key = r.company_id ?? '—'
      const f = m.get(key) ?? { key, name: r.company_name ?? NO_FIRM, inHolding: r.in_holding, main: [], second: [] }
      ;(r.role === 'main' ? f.main : f.second).push(r)
      m.set(key, f)
    }
    return Array.from(m.values())
      .map((f) => ({ ...f, recap: computeCompany(itemsOf(f.main), effRule) }))
      .sort((a, b) => Number(b.inHolding) - Number(a.inHolding) || a.name.localeCompare(b.name, 'bg'))
  }, [rows, rule]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (firms.length && !firms.some((f) => f.key === picked)) setPicked(firms[0].key) }, [firms, picked])
  const groupsH = [{ label: 'В холдинга', firms: firms.filter((f) => f.inHolding) }, { label: 'Извън холдинга', firms: firms.filter((f) => !f.inHolding) }].filter((g) => g.firms.length)
  const mainAll = useMemo(() => rows.filter((r) => r.role === 'main'), [rows])
  const secondAll = useMemo(() => rows.filter((r) => r.role === 'second'), [rows])
  const scored = firms.filter((f) => f.recap.total > 0)
  const grand = totalArea(mainAll)
  const enpAll = mainAll.reduce((a, r) => a + (r.recap_group === ENP_GROUP ? Number(r.area_dka) : 0), 0)
  const noGroup = useMemo(() => {
    const m = new Map<string, { area: number; n: number }>()
    for (const r of mainAll) if (!r.recap_group) { const x = m.get(r.crop_name) ?? { area: 0, n: 0 }; x.area += Number(r.area_dka); x.n += r.n_bzs; m.set(r.crop_name, x) }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], 'bg'))
  }, [mainAll])
  const fallback = useMemo(() => {
    const list: { firm: string; crop: string; bzs: string }[] = []
    for (const r of mainAll) for (const b of r.fallback_bzs ?? []) list.push({ firm: r.company_name ?? NO_FIRM, crop: r.crop_name, bzs: b })
    return list.sort((a, b) => a.bzs.localeCompare(b.bzs, 'bg'))
  }, [mainAll])

  // филтър по култура – само за таблицата с площи
  const chosen = splitMulti(fCrop)
  const cols = chosen.length ? AREA_COLS.filter((c) => chosen.includes(c.key) || (c.enp && ['npp', 'lu', 'gr'].some((k) => chosen.includes(k)))) : AREA_COLS
  const rowTotal = (rs: VRow[]) => (chosen.length ? cols.filter((c) => !c.enp).reduce((a, c) => a + colArea(rs.filter((r) => r.in_total && r.recap_group), c), 0) : totalArea(rs))

  // стопански бази (засята площ)
  const baseNames = Array.from(new Set(bases.map((b) => b.farm_base_name ?? 'Без база'))).sort((a, b) => a.localeCompare(b, 'bg'))
  const baseArea = (base: string | null, crop: string) => bases.reduce((a, b) => a + ((base == null || (b.farm_base_name ?? 'Без база') === base) && b.crop_name === crop ? Number(b.planted_area_dka) : 0), 0)
  const baseTotal = (base: string | null) => BASE_COLS.reduce((a, c) => a + baseArea(base, c.crop), 0)
  const autumn = BASE_COLS.filter((c) => c.autumn).reduce((a, c) => a + baseArea(null, c.crop), 0)
  const spring = BASE_COLS.filter((c) => !c.autumn).reduce((a, c) => a + baseArea(null, c.crop), 0)
  const bAll = autumn + spring

  const sel = firms.find((f) => f.key === picked) ?? null
  const failCell = (r: CompanyRecap, scheme: 'dzes' | 'ekorok', key: string) => r[scheme].fails.some((f) => f.key === key) ? 'cell-warn' : undefined

  function exportXlsx() {
    const n = (v: number) => Math.round(v * 1000) / 1000
    const p = (v: number) => Math.round(v * 10000) / 10000
    const areaRows: Cell[][] = []
    for (const g of groupsH) {
      areaRows.push([g.label])
      for (const f of g.firms) areaRows.push([f.name, ...AREA_COLS.map((c) => n(colArea(f.main, c))), n(totalArea(f.main))])
      const all = g.firms.flatMap((f) => f.main)
      areaRows.push(['Общо за групата', ...AREA_COLS.map((c) => n(colArea(all, c))), n(totalArea(all))])
    }
    areaRows.push(['Общо за деклариране в ИСАК', ...AREA_COLS.map((c) => n(colArea(mainAll, c))), n(totalArea(mainAll))])
    areaRows.push(['Втора култура', ...AREA_COLS.map((c) => n(colArea(secondAll, c))), n(totalArea(secondAll))])
    areaRows.push(['Общо за планиране и изпълнение', ...AREA_COLS.map((c) => n(colArea(mainAll, c) + colArea(secondAll, c))), n(totalArea(mainAll) + totalArea(secondAll))])
    const ecoRows: Cell[][] = firms.map((f) => [f.name, f.inHolding ? 'Да' : 'Не', n(f.recap.total), f.recap.nCrops, p(f.recap.I), p(f.recap.I_II), p(f.recap.III), f.recap.dzes.ok ? 'Покрива' : f.recap.dzes.fails.map((x) => x.text).join('; '),
      p(f.recap.I), p(f.recap.I_II_III), p(f.recap.IV), f.recap.ekorok.ok ? 'Покрива' : f.recap.ekorok.fails.map((x) => x.text).join('; ')])
    const rankRows: Cell[][] = firms.flatMap((f) => f.recap.ranked.map((x) => [f.name, x.place, groupLabel(x.group), n(x.area), p(x.share), placeLabel(x.place)] as Cell[]))
    const enpRows: Cell[][] = firms.map((f) => [f.name, n(f.recap.total), n(colArea(f.main, AREA_COLS[6])), n(colArea(f.main, AREA_COLS[7])), null, n(f.recap.enpArea), p(f.recap.enpShare), n(f.recap.enpNeeded), n(f.recap.enpDiff)])
    const baseRows: Cell[][] = [...baseNames.map((b) => [b, ...BASE_COLS.map((c) => n(baseArea(b, c.crop))), n(baseTotal(b))]), ['Общо', ...BASE_COLS.map((c) => n(baseArea(null, c.crop))), n(baseTotal(null))],
      [], ['Есенници (ечемик, пшеница, рапица)', n(autumn), bAll ? p(autumn / bAll) : null], ['Пролетници', n(spring), bAll ? p(spring / bAll) : null]]
    const r = effRule
    const sheets: Sheet[] = [
      { name: 'Площи', headers: ['Фирма', ...AREA_COLS.map((c) => c.label), 'Общо'], rows: areaRows },
      { name: 'Екосхеми', headers: ['Фирма', 'В холдинга', 'Обща площ, дка', 'Брой култури', 'ДЗЕС I', 'ДЗЕС I+II', 'ДЗЕС III', 'ДЗЕС статус', 'ЕКОРОК I', 'ЕКОРОК I+II+III', 'ЕКОРОК IV', 'ЕКОРОК статус'], rows: ecoRows },
      { name: 'Класиране', headers: ['Фирма', 'Място', 'Група', 'Площ, дка', 'Дял', 'Място в проверката'], rows: rankRows },
      { name: 'ЕНП', headers: ['Фирма', 'Обща площ', 'НПП', 'Люцерна', 'Междинни', 'Общо ЕНП', 'Дял ЕНП', `Необходимо (${fmtPct(r.enp_min)})`, 'Разлика'], rows: enpRows },
      { name: 'Стопански бази', headers: ['База', ...BASE_COLS.map((c) => c.label), 'Общо'], rows: baseRows },
      { name: 'Правила', headers: ['Правило', 'Стойност'], rows: [
        ['ДЗЕС: I култура – не покрива при ≥', r.dzes_first_max], ['ДЗЕС: I+II – не покрива при ≥', r.dzes_first_two_max], ['ДЗЕС: III култура – не покрива при <', r.dzes_third_min],
        ['ЕКОРОК: I култура – не покрива при ≥', r.ekorok_first_max], ['ЕКОРОК: I+II+III – не покрива при ≥', r.ekorok_first_three_max], ['ЕКОРОК: IV култура – не покрива при <', r.ekorok_fourth_min],
        ['ДЗЕС: минимален брой култури', r.dzes_min_crops], ['ЕКОРОК: минимален брой култури', r.ekorok_min_crops], ['Броят се проверява при обща площ над, дка', r.min_crops_from_dka], ['ЕНП: минимален дял', r.enp_min]] },
    ]
    if (fallback.length) sheets.push({ name: 'Без правно основание', headers: ['БЗС', 'Фирма', 'Култура'], rows: fallback.map((x) => [x.bzs, x.firm, x.crop]) })
    downloadXlsxBook(`Рекапитулация_сеитбооборот_${seasonLabel.replace('/', '-')}.xlsx`, sheets)
  }

  const head = (label: string, extra?: ReactNode) => <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}><h2>{label}</h2>{extra}</div>
  const firmBtn = (f: Firm) => (
    <button className={`link-btn${picked === f.key ? ' on' : ''}`} onClick={() => setPicked(f.key)} aria-pressed={picked === f.key}>{f.name}</button>
  )

  return (
    <>
      <div className="page-head">
        <h1>Рекапитулация · сеитбооборот</h1>
        <span className="muted">{loading ? 'Зареждане…' : `сезон ${seasonLabel} · ${firms.length} фирми`}</span>
      </div>
      {error && <div className="banner err" role="alert">Грешка при зареждане: {error}</div>}

      <div className="filters">
        <label className="field">Стопанска година
          <select className="input" value={sid ?? ''} onChange={(e) => setSid(Number(e.target.value))}>
            {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текуща)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Култура (таблица с площи)
          <MultiFilter value={fCrop} onChange={setFCrop} ariaLabel="Култура" options={AREA_COLS.filter((c) => !c.enp).map((c) => ({ value: c.key, label: c.label }))} />
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={exportXlsx} disabled={loading || firms.length === 0}>Експорт в Excel</button>
      </div>

      {!loading && !rule && <div className="banner" role="status"><Icon tone="warn" /> Няма правила за ДЗЕС/ЕКОРОК за {seasonLabel} – използват се праговете по подразбиране. Добави ги в Номенклатури → „Правила за екосхеми“.</div>}
      {noGroup.length > 0 && (
        <div className="banner" role="status">
          <Icon tone="warn" /> Култури без група в рекапитулацията – не участват в площите и проверките: {noGroup.map(([c, x]) => `${c} (${fmtDka(x.area)} дка, ${x.n} БЗС)`).join(', ')}. Задай група в Номенклатури → „Групи за рекапитулация“.
        </div>
      )}
      {fallback.length > 0 && (
        <div className="banner" role="status" style={{ display: 'grid', gap: 8 }}>
          <span><Icon tone="warn" /> {fallback.length} БЗС {fallback.length === 1 ? 'е' : 'са'} без площ по правно основание и {fallback.length === 1 ? 'е сметнато' : 'са сметнати'} със засятата площ.{' '}
            <button className="link-btn" onClick={() => setFbOpen((o) => !o)} aria-expanded={fbOpen}>{fbOpen ? 'Скрий списъка' : 'Покажи списъка'}</button></span>
          {fbOpen && <ul style={{ margin: 0, paddingLeft: 18 }}>{fallback.map((x, i) => <li key={i}>{x.bzs} · {x.firm} · {x.crop.toLowerCase()}</li>)}</ul>}
        </div>
      )}

      <div className="tiles">
        <div className="card pad tile"><div className="muted">Площ по правно основание</div><div className="tile-n">{fmtDka(grand)} дка</div>{fallback.length > 0 && <div className="muted">вкл. {fallback.length} БЗС със засятата площ</div>}</div>
        <div className="card pad tile"><div className="muted">Покриват ДЗЕС</div><div className="tile-n">{scored.filter((f) => f.recap.dzes.ok).length} от {scored.length}</div><div className="muted">фирми</div></div>
        <div className="card pad tile"><div className="muted">Покриват ЕКОРОК</div><div className="tile-n">{scored.filter((f) => f.recap.ekorok.ok).length} от {scored.length}</div><div className="muted">фирми</div></div>
        <div className="card pad tile"><div className="muted">ЕНП реално от площта</div><div className="tile-n">{grand > 0 ? fmtPct(enpAll / grand) : '—'}</div><div className="muted">{fmtDka(enpAll)} дка · нужно {fmtPct(effRule.enp_min)}</div></div>
        <div className="card pad tile"><div className="muted">Есенници / пролетници</div><div className="tile-n">{bAll > 0 ? `${fmtPct(autumn / bAll)} / ${fmtPct(spring / bAll)}` : '—'}</div><div className="muted">по засятата площ</div></div>
      </div>

      {/* ───────── Площи ───────── */}
      <div className="card">
        {head('Площи по фирма и култура, дка', <span className="muted">основна култура: площ по правно основание{chosen.length ? ' · „Общо“ е за избраните култури' : ''}</span>)}
        <table className="grid" style={{ minWidth: 980 }}>
          <thead><tr><th>Фирма</th>{cols.map((c) => <th key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`} title={c.title}>{c.label}</th>)}<th className="num">Общо</th></tr></thead>
          <tbody>
            {groupsH.map((g) => {
              const all = g.firms.flatMap((f) => f.main)
              return (
                <Fragment key={g.label}>
                  <tr className="grp-row"><td colSpan={cols.length + 2}>{g.label}</td></tr>
                  {g.firms.map((f) => (
                    <tr key={f.key}><td>{f.name}</td>{cols.map((c) => { const v = colArea(f.main, c); return <td key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`}>{v ? fmtDka(v) : <span className="empty">0</span>}</td> })}<td className="num"><strong>{fmtDka(rowTotal(f.main))}</strong></td></tr>
                  ))}
                  <tr className="sum-row"><td>Общо за групата</td>{cols.map((c) => <td key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`}>{fmtDka(colArea(all, c))}</td>)}<td className="num">{fmtDka(rowTotal(all))}</td></tr>
                </Fragment>
              )
            })}
            <tr className="sum-row strong"><td>Общо за деклариране в ИСАК</td>{cols.map((c) => <td key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`}>{fmtDka(colArea(mainAll, c))}</td>)}<td className="num">{fmtDka(rowTotal(mainAll))}</td></tr>
            <tr><td>Втора култура</td>{cols.map((c) => { const v = colArea(secondAll, c); return <td key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`}>{v ? fmtDka(v) : <span className="empty">0</span>}</td> })}<td className="num">{fmtDka(rowTotal(secondAll))}</td></tr>
            <tr className="sum-row strong"><td>Общо за планиране и изпълнение</td>{cols.map((c) => <td key={c.key} className={`num${c.enp ? ' cell-calc' : ''}`}>{fmtDka(colArea(mainAll, c) + colArea(secondAll, c))}</td>)}<td className="num">{fmtDka(rowTotal(mainAll) + rowTotal(secondAll))}</td></tr>
          </tbody>
        </table>
      </div>

      {/* ───────── Екосхеми ───────── */}
      <div className="recap-two">
        <div className="card">
          {head('Екосхеми по фирма', <span className="muted">дял от общата площ; клетка в жълто = неспазен праг</span>)}
          <table className="grid" style={{ minWidth: 760 }}>
            <thead>
              <tr><th rowSpan={2}>Фирма</th><th colSpan={4} className="th-group">ДЗЕС</th><th colSpan={4} className="th-group">ЕКОРОК</th></tr>
              <tr><th className="num">I</th><th className="num">I+II</th><th className="num">III</th><th>Статус</th><th className="num">I</th><th className="num">I+II+III</th><th className="num">IV</th><th>Статус</th></tr>
            </thead>
            <tbody>
              {groupsH.map((g) => {
                const agg = computeCompany(itemsOf(g.firms.flatMap((f) => f.main)), effRule)
                return (
                  <Fragment key={g.label}>
                    <tr className="grp-row"><td colSpan={9}>{g.label}</td></tr>
                    {g.firms.map((f) => {
                      const r = f.recap
                      if (r.total <= 0) return <tr key={f.key}><td>{firmBtn(f)}</td><td colSpan={8} className="empty">няма площ</td></tr>
                      return (
                        <tr key={f.key} className={picked === f.key ? 'picked' : undefined}>
                          <td>{firmBtn(f)}</td>
                          <td className={`num ${failCell(r, 'dzes', 'I') ?? ''}`}>{fmtPct(r.I)}</td>
                          <td className={`num ${failCell(r, 'dzes', 'I+II') ?? ''}`}>{fmtPct(r.I_II)}</td>
                          <td className={`num ${failCell(r, 'dzes', 'III') ?? ''}`}>{fmtPct(r.III)}</td>
                          <td><Status r={r.dzes} /></td>
                          <td className={`num ${failCell(r, 'ekorok', 'I') ?? ''}`}>{fmtPct(r.I)}</td>
                          <td className={`num ${failCell(r, 'ekorok', 'I+II+III') ?? ''}`}>{fmtPct(r.I_II_III)}</td>
                          <td className={`num ${failCell(r, 'ekorok', 'IV') ?? ''}`}>{fmtPct(r.IV)}</td>
                          <td><Status r={r.ekorok} /></td>
                        </tr>
                      )
                    })}
                    <tr className="sum-row" title="Само информативно – екосхемите се проверяват по фирма">
                      <td>Общо за групата</td><td className="num">{fmtPct(agg.I)}</td><td className="num">{fmtPct(agg.I_II)}</td><td className="num">{fmtPct(agg.III)}</td><td><Tag tone="info">информативно</Tag></td>
                      <td className="num">{fmtPct(agg.I)}</td><td className="num">{fmtPct(agg.I_II_III)}</td><td className="num">{fmtPct(agg.IV)}</td><td />
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="card pad" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h2>Правила на проверката</h2>
          <span className="muted">{seasonLabel}{rule ? '' : ' · по подразбиране'}</span>
          <table className="mini"><tbody>
            <tr><th colSpan={2}>ДЗЕС</th></tr>
            <tr><td>I култура</td><td className="num">&lt; {fmtPct(effRule.dzes_first_max)}</td></tr>
            <tr><td>I+II култура</td><td className="num">&lt; {fmtPct(effRule.dzes_first_two_max)}</td></tr>
            <tr><td>III култура</td><td className="num">≥ {fmtPct(effRule.dzes_third_min)}</td></tr>
            <tr><td>Брой култури</td><td className="num">≥ {effRule.dzes_min_crops}</td></tr>
            <tr><th colSpan={2}>ЕКОРОК</th></tr>
            <tr><td>I култура</td><td className="num">&lt; {fmtPct(effRule.ekorok_first_max)}</td></tr>
            <tr><td>I+II+III култура</td><td className="num">&lt; {fmtPct(effRule.ekorok_first_three_max)}</td></tr>
            <tr><td>IV култура</td><td className="num">≥ {fmtPct(effRule.ekorok_fourth_min)}</td></tr>
            <tr><td>Брой култури</td><td className="num">≥ {effRule.ekorok_min_crops}</td></tr>
            <tr><th colSpan={2}>Общи</th></tr>
            <tr><td>Броят култури се проверява</td><td className="num">при площ &gt; {fmtDka(effRule.min_crops_from_dka)} дка</td></tr>
            <tr><td>ЕНП (справочно)</td><td className="num">≥ {fmtPct(effRule.enp_min)}</td></tr>
          </tbody></table>
          <span className="muted" style={{ fontSize: 12 }}>НПП, люцерна и грах се класират като една култура („ЕНП реално“). Лозята не влизат в общата площ. Промяна: Номенклатури → „Правила за екосхеми“.</span>
        </div>
      </div>

      {/* ───────── Детайл за фирмата ───────── */}
      {sel && (
        <div className="card pad" style={{ display: 'grid', gap: 12 }}>
          {head(sel.name, <span className="muted">{sel.inHolding ? 'в холдинга' : 'извън холдинга'} · обща площ {fmtDka(sel.recap.total)} дка · брой култури {sel.recap.nCrops}{sel.recap.total > effRule.min_crops_from_dka ? ` (нужни ДЗЕС ≥ ${effRule.dzes_min_crops}, ЕКОРОК ≥ ${effRule.ekorok_min_crops})` : ''}</span>)}
          {sel.recap.total > 0 && (sel.recap.dzes.ok && sel.recap.ekorok.ok
            ? <div className="banner ok"><Icon tone="ok" /> Покрива ДЗЕС и ЕКОРОК.</div>
            : (
              <div className="banner" role="status">
                <strong><Icon tone="warn" /> Неспазени условия</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {[...sel.recap.dzes.fails, ...sel.recap.ekorok.fails].map((f, i) => <li key={i}><strong>{f.scheme}:</strong> {f.text}</li>)}
                </ul>
                {sel.recap.dzes.ok && <div style={{ marginTop: 6 }}>ДЗЕС покрива.</div>}
                {sel.recap.ekorok.ok && <div style={{ marginTop: 6 }}>ЕКОРОК покрива.</div>}
              </div>
            ))}
          <table className="grid" style={{ minWidth: 640 }}>
            <thead><tr><th className="num" style={{ width: 40 }}>№</th><th>Група</th><th className="num">Площ, дка</th><th className="num">Дял</th><th style={{ width: '32%' }} /><th>Място</th></tr></thead>
            <tbody>
              {sel.recap.ranked.map((x) => (
                <tr key={x.group}>
                  <td className="num">{x.place}</td>
                  <td><span className="crop"><span className="dot" style={{ background: GROUP_COLOR[x.group] ?? cropColor(x.group) }} />{groupLabel(x.group)}</span></td>
                  <td className="num">{fmtDka(x.area)}</td><td className="num">{fmtPct(x.share)}</td>
                  <td><Bar share={x.share} color={GROUP_COLOR[x.group] ?? cropColor(x.group)} /></td>
                  <td>{x.place <= 4 ? <Tag tone="info">{placeLabel(x.place)}</Tag> : <span className="empty">—</span>}</td>
                </tr>
              ))}
              {sel.recap.ranked.length === 0 && <tr><td colSpan={6} className="empty">Няма класирани култури.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ───────── ЕНП ───────── */}
      <div className="card">
        {head('ЕНП по фирма', <span className="muted">справочно · необходимо {fmtPct(effRule.enp_min)} от общата площ</span>)}
        <table className="grid" style={{ minWidth: 820 }}>
          <thead><tr><th>Фирма</th><th className="num">Обща площ</th><th className="num">НПП</th><th className="num">Люцерна</th><th className="num">Междинни</th><th className="num">Общо ЕНП</th><th className="num">Дял</th><th className="num">Необходимо</th><th className="num">Разлика</th></tr></thead>
          <tbody>
            {groupsH.map((g) => (
              <Fragment key={g.label}>
                <tr className="grp-row"><td colSpan={9}>{g.label}</td></tr>
                {g.firms.map((f) => { const r = f.recap; return (
                  <tr key={f.key}><td>{f.name}</td><td className="num">{fmtDka(r.total)}</td><td className="num">{fmtDka(colArea(f.main, AREA_COLS[6]))}</td><td className="num">{fmtDka(colArea(f.main, AREA_COLS[7]))}</td>
                    <td className="num"><span className="empty">—</span></td><td className="num">{fmtDka(r.enpArea)}</td>
                    <td className={`num ${r.total > 0 && r.enpBelow ? 'cell-warn' : ''}`}>{r.total > 0 ? fmtPct(r.enpShare) : '—'}</td>
                    <td className="num">{fmtDka(Math.round(r.enpNeeded * 100) / 100)}</td><td className={`num ${r.enpDiff < 0 ? 'cell-warn' : ''}`}>{fmtDka(Math.round(r.enpDiff * 100) / 100)}</td></tr>
                ) })}
              </Fragment>
            ))}
            {(() => { const r = computeCompany(itemsOf(mainAll), effRule); return (
              <tr className="sum-row strong"><td>Общо</td><td className="num">{fmtDka(r.total)}</td><td className="num">{fmtDka(colArea(mainAll, AREA_COLS[6]))}</td><td className="num">{fmtDka(colArea(mainAll, AREA_COLS[7]))}</td><td className="num">—</td>
                <td className="num">{fmtDka(r.enpArea)}</td><td className="num">{r.total > 0 ? fmtPct(r.enpShare) : '—'}</td><td className="num">{fmtDka(Math.round(r.enpNeeded * 100) / 100)}</td><td className="num">{fmtDka(Math.round(r.enpDiff * 100) / 100)}</td></tr>
            ) })()}
          </tbody>
        </table>
      </div>

      {/* ───────── Стопански бази ───────── */}
      <div className="card">
        {head('По стопански бази', <span className="muted">засята площ на основната култура, дка</span>)}
        <table className="grid" style={{ minWidth: 820 }}>
          <thead><tr><th>Стопанска база</th>{BASE_COLS.map((c) => <th key={c.crop} className="num">{c.label}</th>)}<th className="num">Общо</th></tr></thead>
          <tbody>
            {baseNames.map((b) => <tr key={b}><td>{b}</td>{BASE_COLS.map((c) => <td key={c.crop} className="num">{fmtDka(baseArea(b, c.crop))}</td>)}<td className="num"><strong>{fmtDka(baseTotal(b))}</strong></td></tr>)}
            <tr className="sum-row strong"><td>Общо</td>{BASE_COLS.map((c) => <td key={c.crop} className="num">{fmtDka(baseArea(null, c.crop))}</td>)}<td className="num">{fmtDka(baseTotal(null))}</td></tr>
          </tbody>
        </table>
        <table className="grid" style={{ minWidth: 0, marginTop: 12 }}>
          <tbody>
            {[{ l: 'Есенници (ечемик, пшеница, рапица)', v: autumn, c: 'var(--crop-wheat)' }, { l: 'Пролетници (сорго, царевица, поливна царевица, слънчоглед)', v: spring, c: 'var(--crop-sunflower)' }].map((x) => (
              <tr key={x.l}><td>{x.l}</td><td className="num">{fmtDka(x.v)} дка</td><td className="num" style={{ width: 90 }}>{bAll ? fmtPct(x.v / bAll) : '—'}</td><td style={{ width: '40%' }}><Bar share={bAll ? x.v / bAll : 0} color={x.c} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

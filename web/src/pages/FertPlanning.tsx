import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, cropColor, cropLabel } from '../lib/format'

// ───────────────────────── типове ─────────────────────────
type Planting = {
  planting_id: string
  organization_id: string
  field_name: string
  company_name: string | null
  farm_base_name: string | null
  crop_id: string
  crop_name: string
  planted_area_da: number | null
  potential_name: string | null
  tillage_name: string | null
}
type Stage = { stage_id: number; name_bg: string; method: string; sort_order: number }
type Product = {
  product_id: string
  code: string
  name: string
  category: string
  form: 'solid' | 'liquid'
  density_kg_l: number | null
  n_pct: number | null
  p2o5_pct: number | null
  k2o_pct: number | null
  s_pct: number | null
  s_basis: string | null
  manufacturer: string | null
  data_status: string | null
}
type Line = {
  line_id: string
  planting_id: string
  stage_id: number
  product_id: string
  rate_per_da: number
  unit: 'kg_da' | 'l_da'
  treated_area_da: number | null
  source: string
}
type Allowed = { organization_id: string; stage_id: number; product_id: string; farm_base_id: string | null; is_active: boolean }

const CATEGORY_LABEL: Record<string, string> = {
  mineral: 'Минерален', organic: 'Органичен', foliar: 'Листен', specialty: 'Специален', biostimulant: 'Биостимулатор',
}
const STATUS_LABEL: Record<string, string> = { verified: 'потвърден', needs_check: 'за проверка', generic: 'типов' }
const UNIT_LABEL = { kg_da: 'кг/дка', l_da: 'л/дка' } as const

// ───────────────────────── помощни ─────────────────────────
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
const LAT = 'ABCEHKMOPTXYabcehkmoptxy'
const CYR = 'АВСЕНКМОРТХУавсенкмортху'
const norm = (s: string | null | undefined) =>
  (s ?? '').replace(/[A-Za-z]/g, (ch) => { const i = LAT.indexOf(ch); return i >= 0 ? CYR[i] : ch }).toUpperCase().replace(/\s+/g, ' ').trim()
const num2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString('bg-BG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const fmtRateNum = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString('bg-BG', { maximumFractionDigits: 3 })

// плътност: твърди = 1; течни = density_kg_l (може да липсва за „за проверка“ продукти)
const rhoOf = (p: Product): number | null => (p.form === 'solid' ? 1 : p.density_kg_l)
type Av = { n: number; p: number; k: number; s: number }
// активни вещества, kg на дка (P и K като оксиди; S според s_basis: SO3 → ×0,4005)
function avPerDa(p: Product, rate: number): Av | null {
  const rho = rhoOf(p)
  if (rho == null) return null
  const f = (pct: number | null, mult = 1) => (rate * rho * (pct ?? 0) * mult) / 100
  return { n: f(p.n_pct), p: f(p.p2o5_pct), k: f(p.k2o_pct), s: f(p.s_pct, p.s_basis === 'oxide' ? 0.4005 : 1) }
}

// ───────────────────────── компонент ─────────────────────────
export default function FertPlanning() {
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [allowed, setAllowed] = useState<Allowed[]>([])
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

  const [assignOpen, setAssignOpen] = useState(false)
  const [stageId, setStageId] = useState<number>(0)
  const [catF, setCatF] = useState('')
  const [pq, setPq] = useState('')
  const [limit, setLimit] = useState(40)
  const [chosen, setChosen] = useState('')
  const [rate, setRate] = useState('')

  const [rmOpen, setRmOpen] = useState(false)
  const [rmStage, setRmStage] = useState('all')
  const [rmProduct, setRmProduct] = useState('all')

  async function load() {
    setLoading(true); setError(null)
    try {
      const { data: season, error: se } = await supabase.from('season').select('year_end').eq('is_current', true).limit(1)
      if (se) throw new Error(se.message)
      const ye = season?.[0]?.year_end
      const pl = await fetchAll<Planting>((f, t) =>
        supabase.from('v_planting_context')
          .select('planting_id,organization_id,field_name,company_name,farm_base_name,crop_id,crop_name,planted_area_da,potential_name,tillage_name')
          .eq('season_year_end', ye).eq('role', 'main').order('field_name').order('planting_id').range(f, t))
      const st = await supabase.from('fertilization_stage').select('stage_id,name_bg,method,sort_order').eq('is_active', true).order('sort_order')
      if (st.error) throw new Error(st.error.message)
      const [pr, ln, al] = await Promise.all([
        fetchAll<Product>((f, t) => supabase.from('fertilizer_product')
          .select('product_id,code,name,category,form,density_kg_l,n_pct,p2o5_pct,k2o_pct,s_pct,s_basis,manufacturer,data_status')
          .eq('is_active', true).order('name').order('product_id').range(f, t)),
        fetchAll<Line>((f, t) => supabase.from('fert_plan_line')
          .select('line_id,planting_id,stage_id,product_id,rate_per_da,unit,treated_area_da,source').order('line_id').range(f, t)),
        fetchAll<Allowed>((f, t) => supabase.from('stage_product')
          .select('organization_id,stage_id,product_id,farm_base_id,is_active').order('stage_product_id').range(f, t)),
      ])
      setPlantings(pl); setStages((st.data ?? []) as Stage[]); setProducts(pr); setLines(ln); setAllowed(al)
      if (!stageId && st.data && st.data.length) setStageId((st.data as Stage[])[0].stage_id)
    } catch (e) { setError((e as Error).message) }
    setLoading(false)
  }
  useEffect(() => { void load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const prodById = useMemo(() => new Map(products.map((p) => [p.product_id, p])), [products])
  const plantingById = useMemo(() => new Map(plantings.map((p) => [p.planting_id, p])), [plantings])
  const linesByPlanting = useMemo(() => {
    const m = new Map<string, Line[]>()
    for (const l of lines) m.set(l.planting_id, [...(m.get(l.planting_id) ?? []), l])
    return m
  }, [lines])

  // активни вещества на период (сума по всички етапи), kg/дка
  const avByPlanting = useMemo(() => {
    const m = new Map<string, { av: Av; missing: boolean }>()
    for (const [pid, ls] of linesByPlanting) {
      const sum: Av = { n: 0, p: 0, k: 0, s: 0 }
      let missing = false
      for (const l of ls) {
        const p = prodById.get(l.product_id); if (!p) continue
        const a = avPerDa(p, l.rate_per_da)
        if (!a) { missing = true; continue }
        sum.n += a.n; sum.p += a.p; sum.k += a.k; sum.s += a.s
      }
      m.set(pid, { av: sum, missing })
    }
    return m
  }, [linesByPlanting, prodById])

  // ── филтри ──
  const EMPTY = '__empty', ANY = '__any'
  const opts = useMemo(() => {
    const u = (f: (p: Planting) => string | null) =>
      Array.from(new Set(plantings.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    const byStage: Record<number, { id: string; name: string }[]> = {}
    for (const s of stages) {
      byStage[s.stage_id] = Array.from(new Set(lines.filter((l) => l.stage_id === s.stage_id).map((l) => l.product_id)))
        .map((id) => ({ id, name: prodById.get(id)?.name ?? '' })).sort((a, b) => a.name.localeCompare(b.name, 'bg'))
    }
    return { company: u((p) => p.company_name), base: u((p) => p.farm_base_name), crop: u((p) => p.crop_name), potential: u((p) => p.potential_name), byStage }
  }, [plantings, stages, lines, prodById])

  const view = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = plantings.filter((p) => {
      if (n && !p.field_name.toLowerCase().includes(n)) return false
      const eq = (k: string, v: string | null) => { const f = fSel[k]; if (!f) return true; if (f === EMPTY) return !v; return v === f }
      if (!eq('company', p.company_name) || !eq('base', p.farm_base_name) || !eq('crop', p.crop_name) || !eq('potential', p.potential_name)) return false
      const a = p.planted_area_da ?? 0
      if (fArea.min && a < Number(fArea.min.replace(',', '.'))) return false
      if (fArea.max && a > Number(fArea.max.replace(',', '.'))) return false
      for (const s of stages) {
        const f = fSel['s' + s.stage_id]; if (!f) continue
        const items = (linesByPlanting.get(p.planting_id) ?? []).filter((x) => x.stage_id === s.stage_id)
        if (f === EMPTY) { if (items.length > 0) return false }
        else if (f === ANY) { if (items.length === 0) return false }
        else if (!items.some((x) => x.product_id === f)) return false
      }
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
        case 'n': return avByPlanting.get(p.planting_id)?.av.n ?? 0
        case 'p': return avByPlanting.get(p.planting_id)?.av.p ?? 0
        case 'k': return avByPlanting.get(p.planting_id)?.av.k ?? 0
        default: return p.field_name
      }
    }
    list.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'bg')) * dir
    })
    return list
  }, [plantings, q, fSel, fArea, sort, stages, linesByPlanting, avByPlanting])

  const activeFilters = (q ? 1 : 0) + Object.values(fSel).filter(Boolean).length + (fArea.min || fArea.max ? 1 : 0)
  const clearFilters = () => { setQ(''); setFSel({}); setFArea({ min: '', max: '' }) }
  const setF = (k: string, v: string) => setFSel((s) => ({ ...s, [k]: v }))
  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '')

  // ── избор ──
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

  // ── продукти ──
  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))).sort(), [products])
  const hay = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of products) m.set(p.product_id, norm([p.name, p.code, p.manufacturer].join(' | ')))
    return m
  }, [products])
  const results = useMemo(() => {
    const tokens = norm(pq).split(' ').filter(Boolean)
    return products.filter((p) => {
      if (catF && p.category !== catF) return false
      if (tokens.length && !tokens.every((t) => (hay.get(p.product_id) ?? '').includes(t))) return false
      return true
    })
  }, [products, catF, pq, hay])
  const chosenProduct = chosen ? prodById.get(chosen) : undefined

  const preview = useMemo(() => {
    const r = Number(rate.replace(',', '.'))
    if (!chosenProduct || !(r > 0)) return null
    const targets = selected.filter((p) => (p.planted_area_da ?? 0) > 0)
    const area = targets.reduce((s, p) => s + (p.planted_area_da ?? 0), 0)
    const qty = r * area                                    // кг или л
    const rho = rhoOf(chosenProduct)
    const av = avPerDa(chosenProduct, r)
    const overwrite = targets.filter((p) => (linesByPlanting.get(p.planting_id) ?? []).some((l) => l.stage_id === stageId && l.product_id === chosenProduct.product_id)).length
    return {
      r, count: targets.length, skipped: selected.length - targets.length, area, qty,
      unit: chosenProduct.form === 'solid' ? 'kg_da' as const : 'l_da' as const,
      tons: rho != null ? (qty * rho) / 1000 : null, av, overwrite,
    }
  }, [chosenProduct, rate, selected, linesByPlanting, stageId])

  function openAssign() {
    setMsg(null); setError(null)
    setChosen(''); setRate(''); setPq(''); setCatF(''); setLimit(40)
    setAssignOpen(true)
  }

  async function doAssign() {
    if (!chosenProduct || !preview) return
    setBusy(true); setMsg(null); setError(null)
    const targets = selected.filter((p) => (p.planted_area_da ?? 0) > 0)
    // допустим продукт за етапа: ако за организацията няма запис, добавяме го (изисква права на администратор)
    const orgs = Array.from(new Set(targets.map((p) => p.organization_id)))
    const missing = orgs.filter((o) => !allowed.some((a) => a.organization_id === o && a.stage_id === stageId && a.product_id === chosenProduct.product_id && a.is_active && a.farm_base_id == null))
    if (missing.length > 0) {
      const ins = await supabase.from('stage_product').insert(missing.map((o) => ({
        organization_id: o, stage_id: stageId, product_id: chosenProduct.product_id, unit: preview.unit, is_active: true,
      })))
      if (ins.error && !/duplicate|unique/i.test(ins.error.message)) {
        setError(`Продуктът не е допустим за този етап и не може да бъде добавен автоматично: ${ins.error.message}`)
        setBusy(false); return
      }
    }
    const rows = targets.map((p) => ({
      organization_id: p.organization_id,
      planting_id: p.planting_id,
      stage_id: stageId,
      product_id: chosenProduct.product_id,
      rate_per_da: preview.r,
      unit: preview.unit,
      treated_area_da: p.planted_area_da,
      source: 'manual',
    }))
    for (const part of chunks(rows, 200)) {
      const r = await supabase.from('fert_plan_line').upsert(part, { onConflict: 'planting_id,stage_id,product_id' })
      if (r.error) { setError(r.error.message); setBusy(false); return }
    }
    setMsg(`„${chosenProduct.name}“ е назначен в етап „${stages.find((s) => s.stage_id === stageId)?.name_bg}“ за ${rows.length} БЗС.`)
    setAssignOpen(false); setSel(new Set())
    await load(); setBusy(false)
  }

  // ── премахване ──
  const rmCandidates = useMemo(() => {
    const ids = new Set(selected.map((p) => p.planting_id))
    const set = new Set<string>()
    for (const l of lines) if (ids.has(l.planting_id) && (rmStage === 'all' || String(l.stage_id) === rmStage)) set.add(l.product_id)
    return Array.from(set).map((id) => ({ id, name: prodById.get(id)?.name ?? id })).sort((a, b) => a.name.localeCompare(b.name, 'bg'))
  }, [selected, lines, rmStage, prodById])
  const rmCount = useMemo(() => {
    const ids = new Set(selected.map((p) => p.planting_id))
    return lines.filter((l) => ids.has(l.planting_id) && (rmStage === 'all' || String(l.stage_id) === rmStage) && (rmProduct === 'all' || l.product_id === rmProduct)).length
  }, [selected, lines, rmStage, rmProduct])
  async function doRemove() {
    setBusy(true); setMsg(null); setError(null)
    for (const part of chunks(selected.map((p) => p.planting_id), 100)) {
      let qd = supabase.from('fert_plan_line').delete().in('planting_id', part)
      if (rmStage !== 'all') qd = qd.eq('stage_id', Number(rmStage))
      if (rmProduct !== 'all') qd = qd.eq('product_id', rmProduct)
      const r = await qd
      if (r.error) { setError(r.error.message); setBusy(false); return }
    }
    setMsg(`Премахнати редове: ${rmCount}.`)
    setRmOpen(false); setSel(new Set())
    await load(); setBusy(false)
  }

  // ── суми за показаните БЗС ──
  const totals = useMemo(() => {
    let area = 0, n = 0, p = 0, k = 0, s = 0
    for (const pl of view) {
      const a = pl.planted_area_da ?? 0
      area += a
      const v = avByPlanting.get(pl.planting_id)
      if (v) { n += v.av.n * a; p += v.av.p * a; k += v.av.k * a; s += v.av.s * a }
    }
    return { area, n, p, k, s }
  }, [view, avByPlanting])

  const summary = useMemo(() => {
    const ids = new Set(view.map((p) => p.planting_id))
    const m = new Map<string, { stage_id: number; product_id: string; area: number; qty: number; n: number }>()
    for (const l of lines) {
      if (!ids.has(l.planting_id)) continue
      const k = `${l.stage_id}|${l.product_id}`
      const cur = m.get(k) ?? { stage_id: l.stage_id, product_id: l.product_id, area: 0, qty: 0, n: 0 }
      const a = l.treated_area_da ?? plantingById.get(l.planting_id)?.planted_area_da ?? 0
      cur.area += a; cur.qty += l.rate_per_da * a; cur.n += 1
      m.set(k, cur)
    }
    const order = new Map(stages.map((s, i) => [s.stage_id, i]))
    return Array.from(m.values()).sort((a, b) => (order.get(a.stage_id) ?? 0) - (order.get(b.stage_id) ?? 0) ||
      (prodById.get(a.product_id)?.name ?? '').localeCompare(prodById.get(b.product_id)?.name ?? '', 'bg'))
  }, [view, lines, stages, prodById, plantingById])

  const COLS = 9 + stages.length

  return (
    <>
      <div className="page-head">
        <h1>Планиране на торове</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${view.length} от ${plantings.length} БЗС · ${fmtArea(totals.area)} дка · N ${fmtInt(totals.n / 1000)} т · P₂O₅ ${fmtInt(totals.p / 1000)} т · K₂O ${fmtInt(totals.k / 1000)} т`}</span>
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
            <button className="btn" onClick={openAssign}>Назначи тор…</button>
            <button className="btn outline" onClick={() => { setRmStage('all'); setRmProduct('all'); setRmOpen(true) }}>Премахни назначения…</button>
            <button className="btn outline" onClick={() => setSel(new Set())}>Откажи избора</button>
          </div>
          <span className="muted">Съвет: Shift + клик избира диапазон. Филтрирай по култура и база, после „избери всички показани“ от отметката в заглавието.</span>
        </div>
      )}

      <div className="card">
        <table className="grid" style={{ minWidth: 1500 + stages.length * 190 }}>
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Избери всички показани" checked={allShownSelected} onChange={toggleAll} /></th>
              <th><button onClick={() => toggleSort('field_name')}>Наименование {arrow('field_name')}</button></th>
              <th><button onClick={() => toggleSort('company')}>Фирма {arrow('company')}</button></th>
              <th><button onClick={() => toggleSort('base')}>Стопанска база {arrow('base')}</button></th>
              <th><button onClick={() => toggleSort('crop')}>Култура {arrow('crop')}</button></th>
              <th className="num"><button onClick={() => toggleSort('area')}>Площ, дка {arrow('area')}</button></th>
              <th><button onClick={() => toggleSort('potential')}>Потенциал {arrow('potential')}</button></th>
              {stages.map((s) => <th key={s.stage_id}>{s.name_bg}</th>)}
              <th className="num"><button onClick={() => toggleSort('n')}>N, кг/дка {arrow('n')}</button></th>
              <th className="num"><button onClick={() => toggleSort('p')}>P₂O₅, кг/дка {arrow('p')}</button></th>
              <th className="num"><button onClick={() => toggleSort('k')}>K₂O, кг/дка {arrow('k')}</button></th>
            </tr>
            <tr className="filter-row">
              <th />
              <th><input className="input fi" placeholder="Филтър" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Филтър Наименование" /></th>
              {(['company', 'base', 'crop'] as const).map((k) => (
                <th key={k}>
                  <select className="input fi" value={fSel[k] ?? ''} onChange={(e) => setF(k, e.target.value)} aria-label={`Филтър ${k}`}>
                    <option value="">Всички</option><option value={EMPTY}>— празно —</option>
                    {opts[k].map((v) => <option key={v} value={v}>{k === 'crop' ? cropLabel(v) : v}</option>)}
                  </select>
                </th>
              ))}
              <th className="num">
                <span className="range">
                  <input className="input fi" inputMode="decimal" placeholder="от" value={fArea.min} onChange={(e) => setFArea({ ...fArea, min: e.target.value })} aria-label="Площ от" />
                  <input className="input fi" inputMode="decimal" placeholder="до" value={fArea.max} onChange={(e) => setFArea({ ...fArea, max: e.target.value })} aria-label="Площ до" />
                </span>
              </th>
              <th>
                <select className="input fi" value={fSel.potential ?? ''} onChange={(e) => setF('potential', e.target.value)} aria-label="Филтър потенциал">
                  <option value="">Всички</option><option value={EMPTY}>— празно —</option>
                  {opts.potential.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </th>
              {stages.map((s) => (
                <th key={s.stage_id}>
                  <select className="input fi" value={fSel['s' + s.stage_id] ?? ''} onChange={(e) => setF('s' + s.stage_id, e.target.value)} aria-label={`Филтър ${s.name_bg}`}>
                    <option value="">Всички</option><option value={EMPTY}>— няма —</option><option value={ANY}>— има —</option>
                    {(opts.byStage[s.stage_id] ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </th>
              ))}
              <th /><th /><th />
            </tr>
          </thead>
          <tbody>
            {view.map((p, idx) => {
              const items = linesByPlanting.get(p.planting_id) ?? []
              const on = sel.has(p.planting_id)
              const v = avByPlanting.get(p.planting_id)
              return (
                <tr key={p.planting_id} className={`row ${on ? 'open' : ''}`} onClick={(e) => pick(idx, e)}>
                  <td><input type="checkbox" checked={on} onChange={() => undefined} aria-label={`Избери ${p.field_name}`} /></td>
                  <td><span className="name">{p.field_name}</span></td>
                  <td>{p.company_name ?? <span className="empty">—</span>}</td>
                  <td>{p.farm_base_name ?? <span className="empty">—</span>}</td>
                  <td><span className="crop crop-main"><span className="dot" style={{ background: cropColor(p.crop_name) }} />{cropLabel(p.crop_name)}</span></td>
                  <td className="num">{fmtArea(p.planted_area_da)}</td>
                  <td>{p.potential_name ?? <span className="empty">—</span>}</td>
                  {stages.map((s) => {
                    const cell = items.filter((l) => l.stage_id === s.stage_id)
                    return (
                      <td key={s.stage_id} style={{ whiteSpace: 'normal', minWidth: 160 }}>
                        {cell.length === 0 ? <span className="empty">—</span> : cell.map((l) => {
                          const pr = prodById.get(l.product_id)
                          const noRho = pr ? rhoOf(pr) == null : false
                          return (
                            <div key={l.line_id} style={{ marginBottom: 2 }}>
                              <span className={`chip ${noRho ? 'warn' : ''}`} title={noRho ? 'Липсва плътност: активните вещества не се изчисляват' : undefined}>
                                {pr?.name ?? '?'} · {fmtRateNum(l.rate_per_da)} {UNIT_LABEL[l.unit]}{noRho ? ' ⚠' : ''}
                              </span>
                            </div>
                          )
                        })}
                      </td>
                    )
                  })}
                  <td className="num">{v ? num2(v.av.n) : <span className="empty">—</span>}{v?.missing ? ' ⚠' : ''}</td>
                  <td className="num">{v ? num2(v.av.p) : <span className="empty">—</span>}</td>
                  <td className="num">{v ? num2(v.av.k) : <span className="empty">—</span>}</td>
                </tr>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={COLS} className="empty">Няма БЗС по тези филтри.</td></tr>}
          </tbody>
        </table>
      </div>

      <details className="card pad">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Потребност за показаните БЗС ({summary.length} реда)</summary>
        {summary.length === 0 ? <p className="muted">Още няма назначени торове за показаните БЗС.</p> : (
          <table className="grid narrow" style={{ marginTop: 12 }}>
            <thead><tr><th>Етап</th><th>Продукт</th><th className="num">БЗС</th><th className="num">Площ, дка</th><th className="num">Количество</th><th className="num">Тонове</th></tr></thead>
            <tbody>
              {summary.map((s, i) => {
                const pr = prodById.get(s.product_id)
                const rho = pr ? rhoOf(pr) : null
                return (
                  <tr key={i}>
                    <td>{stages.find((x) => x.stage_id === s.stage_id)?.name_bg}</td>
                    <td>{pr?.name ?? '?'}</td>
                    <td className="num">{s.n}</td>
                    <td className="num">{fmtArea(s.area)}</td>
                    <td className="num">{fmtInt(s.qty)} {pr?.form === 'liquid' ? 'л' : 'кг'}</td>
                    <td className="num">{rho != null ? num2((s.qty * rho) / 1000) : <span className="empty">—</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </details>

      {/* ───── Назначи тор ───── */}
      {assignOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Назначи тор" onClick={() => !busy && setAssignOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <h2>Назначи тор на {selected.length} БЗС · {fmtArea(selArea)} дка</h2>
              <button className="btn outline" onClick={() => setAssignOpen(false)} disabled={busy}>Затвори</button>
            </div>
            <div className="filters">
              <label className="field">Етап
                <select className="input" value={stageId} onChange={(e) => setStageId(Number(e.target.value))}>
                  {stages.map((s) => <option key={s.stage_id} value={s.stage_id}>{s.name_bg}</option>)}
                </select>
              </label>
              <label className="field">Вид
                <select className="input" value={catF} onChange={(e) => { setCatF(e.target.value); setLimit(40) }}>
                  <option value="">Всички</option>
                  {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
                </select>
              </label>
              <label className="field grow">Търсене (име, код, производител)
                <input className="input" type="search" autoFocus value={pq} onChange={(e) => { setPq(e.target.value); setLimit(40) }} />
              </label>
            </div>

            <div className="modal-list">
              <table className="grid narrow">
                <thead><tr><th style={{ width: 28 }} /><th>Продукт</th><th>Вид</th><th>Форма</th><th className="num">N %</th><th className="num">P₂O₅ %</th><th className="num">K₂O %</th><th className="num">S %</th><th>Данни</th></tr></thead>
                <tbody>
                  {results.slice(0, limit).map((p) => (
                    <tr key={p.product_id} className={`row ${chosen === p.product_id ? 'open' : ''}`} onClick={() => { setChosen(p.product_id); setRate('') }}>
                      <td><input type="radio" name="fert-product" checked={chosen === p.product_id} onChange={() => { setChosen(p.product_id); setRate('') }} aria-label={p.name} /></td>
                      <td><span className="name">{p.name}</span></td>
                      <td>{CATEGORY_LABEL[p.category] ?? p.category}</td>
                      <td>{p.form === 'solid' ? 'твърд' : 'течен'}</td>
                      <td className="num">{p.n_pct ?? '—'}</td><td className="num">{p.p2o5_pct ?? '—'}</td><td className="num">{p.k2o_pct ?? '—'}</td><td className="num">{p.s_pct ?? '—'}</td>
                      <td><span className={`chip ${p.data_status === 'verified' ? 'ok' : 'warn'}`}>{STATUS_LABEL[p.data_status ?? ''] ?? '—'}</span></td>
                    </tr>
                  ))}
                  {results.length === 0 && <tr><td colSpan={9} className="empty">Няма продукти по това търсене.</td></tr>}
                </tbody>
              </table>
              {results.length > limit && <button className="btn outline" onClick={() => setLimit(limit + 60)}>Покажи още ({results.length - limit})</button>}
            </div>

            {chosenProduct && (
              <div className="card pad" style={{ borderColor: 'var(--accent)' }}>
                <strong>{chosenProduct.name}</strong>
                <span className="muted"> · {stages.find((s) => s.stage_id === stageId)?.name_bg}</span>
                <div className="filters" style={{ marginTop: 8 }}>
                  <label className="field">Норма на декар ({chosenProduct.form === 'solid' ? 'кг/дка' : 'л/дка'})
                    <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(',', '.'))} />
                  </label>
                </div>
                {rhoOf(chosenProduct) == null && (
                  <div className="chip warn" style={{ marginBottom: 8 }}>Липсва плътност за този течен продукт: количествата в л се изчисляват, но активните вещества и тоновете – не. Попълни плътността в Номенклатури.</div>
                )}
                {preview ? (
                  <div>
                    <div>Общо за {preview.count} БЗС: <strong>{fmtInt(preview.qty)} {preview.unit === 'kg_da' ? 'кг' : 'л'}</strong>
                      {preview.tons != null ? ` (${num2(preview.tons)} т)` : ''} на {fmtArea(preview.area)} дка
                      {preview.skipped > 0 ? ` · ${preview.skipped} без засета площ ще се пропуснат` : ''}</div>
                    {preview.av && (
                      <div className="muted" style={{ marginTop: 4 }}>
                        Активни вещества на дка: N {num2(preview.av.n)} · P₂O₅ {num2(preview.av.p)} · K₂O {num2(preview.av.k)} · S {num2(preview.av.s)} кг.
                        Общо: N {fmtInt(preview.av.n * preview.area)} · P₂O₅ {fmtInt(preview.av.p * preview.area)} · K₂O {fmtInt(preview.av.k * preview.area)} · S {fmtInt(preview.av.s * preview.area)} кг.
                      </div>
                    )}
                    {preview.overwrite > 0 && <div className="muted" style={{ marginTop: 6 }}>За {preview.overwrite} БЗС този продукт вече е в етапа и нормата ще се презапише.</div>}
                  </div>
                ) : <div className="muted">Въведи норма, за да видиш количествата и активните вещества.</div>}
                <div className="filters" style={{ marginTop: 12 }}>
                  <button className="btn" disabled={busy || !preview || preview.count === 0} onClick={doAssign}>Назначи</button>
                  <button className="btn outline" disabled={busy} onClick={() => setAssignOpen(false)}>Отказ</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ───── Премахни ───── */}
      {rmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Премахни назначения" onClick={() => !busy && setRmOpen(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <h2>Премахни назначения от {selected.length} БЗС</h2>
              <button className="btn outline" onClick={() => setRmOpen(false)} disabled={busy}>Затвори</button>
            </div>
            <div className="filters">
              <label className="field">Етап
                <select className="input" value={rmStage} onChange={(e) => { setRmStage(e.target.value); setRmProduct('all') }}>
                  <option value="all">Всички етапи</option>
                  {stages.map((s) => <option key={s.stage_id} value={String(s.stage_id)}>{s.name_bg}</option>)}
                </select>
              </label>
              <label className="field grow">Продукт
                <select className="input" value={rmProduct} onChange={(e) => setRmProduct(e.target.value)}>
                  <option value="all">Всички продукти</option>
                  {rmCandidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            <div className="muted">Ще се премахнат {fmtInt(rmCount)} реда. Действието не може да се върне.</div>
            <div className="filters">
              <button className="btn" disabled={busy || rmCount === 0} onClick={doRemove}>Премахни</button>
              <button className="btn outline" disabled={busy} onClick={() => setRmOpen(false)}>Отказ</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

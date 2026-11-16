import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, cropColor, cropLabel } from '../lib/format'
import { ColumnPicker, useHiddenCols } from '../lib/columns'
import { MultiFilter, anyToken } from '../lib/multifilter'

type Planting = {
  planting_id: string
  organization_id: string
  field_name: string
  company_name: string | null
  farm_base_name: string | null
  crop_id: string
  crop_name: string
  planted_area_da: number | null
}
type Crop = {
  crop_id: string
  name_bg: string
  seeding_method: 'solid' | 'row' | null
  rate_basis: string | null
  order_unit: string | null
  default_seeds_per_pack: number | null
  seed_overage_pct: number | null
  rate_rounding_step: number | null
}
type Variety = { variety_id: string; crop_id: string; name: string; seeds_per_pack: number | null }
type Batch = {
  batch_id: string
  variety_id: string
  reproduction_id: number | null
  tkw_g: number | null
  germination_pct: number | null
  seeds_per_pack: number | null
}
type Repro = { reproduction_id: number; name: string }
type PSeed = {
  planting_seed_id: string
  planting_id: string
  variety_id: string
  batch_id: string | null
  area_da: number
  target_rate: number
  overage_pct: number | null
  seed_origin: string | null
}

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

type Calc = { totalSeedsM2: number | null; kgDa: number | null; kg: number | null; t: number | null; packs: number | null; missing: boolean }

function calcRow(crop: Crop, ps: { area_da: number; target_rate: number; overage_pct: number | null }, b: Batch | undefined, v?: Variety): Calc {
  const ov = ps.overage_pct ?? crop.seed_overage_pct ?? 0
  const spp = b?.seeds_per_pack ?? v?.seeds_per_pack ?? crop.default_seeds_per_pack
  if (crop.seeding_method === 'solid') {
    if (!b || !b.germination_pct) return { totalSeedsM2: null, kgDa: null, kg: null, t: null, packs: null, missing: true }
    const total = Math.ceil(ps.target_rate / (b.germination_pct / 100))
    if (crop.order_unit === 'packs') {   // слети, но се поръчват на торби (рапица)
      if (!spp) return { totalSeedsM2: total, kgDa: null, kg: null, t: null, packs: null, missing: true }
      return { totalSeedsM2: total, kgDa: null, kg: null, t: null, packs: (total * 1000 * ps.area_da * (1 + ov / 100)) / spp, missing: false }
    }
    if (!b.tkw_g) return { totalSeedsM2: total, kgDa: null, kg: null, t: null, packs: null, missing: true }
    const step = crop.rate_rounding_step ?? 1
    const kgDa = Math.round((total * b.tkw_g) / 1000 / step) * step
    const kg = kgDa * ps.area_da * (1 + ov / 100)
    return { totalSeedsM2: total, kgDa, kg, t: kg / 1000, packs: null, missing: false }
  }
  if (!spp) return { totalSeedsM2: null, kgDa: null, kg: null, t: null, packs: null, missing: true }
  return { totalSeedsM2: null, kgDa: null, kg: null, t: null, packs: (ps.target_rate * ps.area_da * (1 + ov / 100)) / spp, missing: false }
}

export default function SeedPlanning() {
  const colPrefs = useHiddenCols('seeds')
  const vis = colPrefs.vis
  const pickerItems = [
    { key: 'company', label: 'Фирма' }, { key: 'crop', label: 'Култура' }, { key: 'area', label: 'Площ, дка' },
    { key: 'variety', label: 'Сорт / хибрид' }, { key: 'repro', label: 'Размножение' }, { key: 'origin', label: 'Произход' }, { key: 'rate', label: 'Норма' },
    { key: 'total', label: 'Общи сем./м²' }, { key: 'kgda', label: 'кг/дка' }, { key: 'kg', label: 'кг общо' }, { key: 't', label: 'Тона' }, { key: 'packs', label: 'Торби' },
  ]
  const shownCols = pickerItems.filter((i) => vis(i.key)).length + 2
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [varieties, setVarieties] = useState<Variety[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [repros, setRepros] = useState<Repro[]>([])
  const [pseeds, setPseeds] = useState<PSeed[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [q, setQ] = useState('')
  const [cropF, setCropF] = useState('')
  const [companyF, setCompanyF] = useState('')
  const [baseF, setBaseF] = useState('')
  const [onlyEmpty, setOnlyEmpty] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const [varietyId, setVarietyId] = useState('')
  const [batchId, setBatchId] = useState('')
  const [reproF, setReproF] = useState('') // Размножение (отделно от партидата)
  const [rate, setRate] = useState('')
  const [packInput, setPackInput] = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data: season, error: se } = await supabase.from('season').select('year_end').eq('is_current', true).limit(1)
      if (se) throw new Error(se.message)
      const ye = season?.[0]?.year_end
      const [cr, va, ba, re] = await Promise.all([
        fetchAll<Crop>((f, t) => supabase.from('crop').select('*').not('seeding_method', 'is', null).range(f, t)),
        fetchAll<Variety>((f, t) => supabase.from('variety').select('variety_id,crop_id,name,seeds_per_pack').order('name').range(f, t)),
        fetchAll<Batch>((f, t) => supabase.from('seed_batch').select('batch_id,variety_id,reproduction_id,tkw_g,germination_pct,seeds_per_pack').range(f, t)),
        fetchAll<Repro>((f, t) => supabase.from('reproduction').select('reproduction_id,name').range(f, t)),
      ])
      const pl = await fetchAll<Planting>((f, t) =>
        supabase.from('v_planting_context')
          .select('planting_id,organization_id,field_name,company_name,farm_base_name,crop_id,crop_name,planted_area_da')
          .eq('season_year_end', ye).eq('role', 'main').order('field_name').order('planting_id').range(f, t))
      const ps = await fetchAll<PSeed>((f, t) =>
        supabase.from('planting_seed').select('planting_seed_id,planting_id,variety_id,batch_id,area_da,target_rate,overage_pct,seed_origin')
          .order('planting_seed_id').range(f, t))
      const withSeeding = new Set(cr.map((c) => c.crop_id))
      setCrops(cr); setVarieties(va); setBatches(ba); setRepros(re); setPseeds(ps)
      setPlantings(pl.filter((p) => withSeeding.has(p.crop_id)))
    } catch (e) {
      setError((e as Error).message)
    }
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.crop_id, c])), [crops])
  const varById = useMemo(() => new Map(varieties.map((v) => [v.variety_id, v])), [varieties])
  const batchById = useMemo(() => new Map(batches.map((b) => [b.batch_id, b])), [batches])
  const reproById = useMemo(() => new Map(repros.map((r) => [r.reproduction_id, r.name])), [repros])
  const seedsByPlanting = useMemo(() => {
    const m = new Map<string, PSeed[]>()
    for (const s of pseeds) m.set(s.planting_id, [...(m.get(s.planting_id) ?? []), s])
    return m
  }, [pseeds])
  const originByBatch = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of pseeds) if (s.batch_id && s.seed_origin && !m.has(s.batch_id)) m.set(s.batch_id, s.seed_origin)
    return m
  }, [pseeds])

  // партида = произход · МХЗ · кълняемост (размножението е отделно поле; показва се в етикета само когато не е избрано)
  const batchLabel = (b: Batch, withRepro = false) =>
    [withRepro && b.reproduction_id != null ? reproById.get(b.reproduction_id) : null, originByBatch.get(b.batch_id),
      b.tkw_g ? `МХЗ ${b.tkw_g} г` : null, b.germination_pct ? `кълняемост ${b.germination_pct}%` : null].filter(Boolean).join(' · ') || 'без данни'

  const opts = useMemo(() => {
    const u = (f: (p: Planting) => string | null) =>
      Array.from(new Set(plantings.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    return { crops: u((p) => p.crop_name), companies: u((p) => p.company_name), bases: u((p) => p.farm_base_name) }
  }, [plantings])

  const view = useMemo(() => {
    const n = q.trim().toLowerCase()
    return plantings.filter((p) => {
      if (!anyToken(cropF, (t) => p.crop_name === t)) return false
      if (!anyToken(companyF, (t) => p.company_name === t)) return false
      if (!anyToken(baseF, (t) => p.farm_base_name === t)) return false
      if (onlyEmpty && (seedsByPlanting.get(p.planting_id)?.length ?? 0) > 0) return false
      if (n && !p.field_name.toLowerCase().includes(n)) return false
      return true
    })
  }, [plantings, q, cropF, companyF, baseF, onlyEmpty, seedsByPlanting])

  const calcFor = (p: Planting) => {
    const crop = cropById.get(p.crop_id)
    const rows = seedsByPlanting.get(p.planting_id) ?? []
    if (!crop || rows.length === 0) return null
    const sum: Calc = { totalSeedsM2: null, kgDa: null, kg: 0, t: 0, packs: 0, missing: false }
    for (const r of rows) {
      const c = calcRow(crop, r, r.batch_id ? batchById.get(r.batch_id) : undefined, varById.get(r.variety_id))
      if (c.missing) sum.missing = true
      sum.kg = (sum.kg ?? 0) + (c.kg ?? 0)
      sum.t = (sum.t ?? 0) + (c.t ?? 0)
      sum.packs = (sum.packs ?? 0) + (c.packs ?? 0)
      if (rows.length === 1) { sum.totalSeedsM2 = c.totalSeedsM2; sum.kgDa = c.kgDa }
    }
    return sum
  }

  // ---- избор ----
  const selected = plantings.filter((p) => sel.has(p.planting_id))
  const selCrops = Array.from(new Set(selected.map((p) => p.crop_id)))
  const selCrop = selCrops.length === 1 ? cropById.get(selCrops[0]) : undefined
  const allShownSelected = view.length > 0 && view.every((p) => sel.has(p.planting_id))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = () => setSel((s) => {
    const n = new Set(s)
    if (allShownSelected) view.forEach((p) => n.delete(p.planting_id)); else view.forEach((p) => n.add(p.planting_id))
    return n
  })

  const isPacks = selCrop?.order_unit === 'packs'
  const effectivePack = (varietyId ? varById.get(varietyId)?.seeds_per_pack : null) ?? selCrop?.default_seeds_per_pack ?? 0
  const packSize = packInput !== '' ? Number(packInput) : effectivePack
  const cropVarieties = selCrop ? varieties.filter((v) => v.crop_id === selCrop.crop_id) : []
  const varBatches = batches.filter((b) => b.variety_id === varietyId)
  const reproOptions = Array.from(new Set(varBatches.map((b) => b.reproduction_id).filter((x): x is number => x != null)))
    .map((id) => ({ id: String(id), name: reproById.get(id) ?? String(id) })).sort((a, b) => a.name.localeCompare(b.name, 'bg'))
  const shownBatches = reproF ? varBatches.filter((b) => String(b.reproduction_id) === reproF) : varBatches

  async function apply() {
    if (!selCrop || !varietyId || !(Number(rate) > 0)) return
    setBusy(true); setMsg(null); setError(null)
    const ids = selected.map((p) => p.planting_id)
    const origin = batchId ? originByBatch.get(batchId) ?? null : null
    const del = await supabase.from('planting_seed').delete().in('planting_id', ids)
    if (del.error) { setError(del.error.message); setBusy(false); return }
    const rows = selected.filter((p) => (p.planted_area_da ?? 0) > 0).map((p) => ({
      organization_id: p.organization_id,
      planting_id: p.planting_id,
      variety_id: varietyId,
      batch_id: batchId || null,
      area_da: p.planted_area_da,
      target_rate: Number(rate),
      seed_origin: origin,
    }))
    const ins = await supabase.from('planting_seed').insert(rows)
    if (ins.error) { setError(ins.error.message); setBusy(false); return }
    setMsg(`Записано за ${rows.length} БЗС.`)
    setSel(new Set()); setRate(''); setBatchId(''); setReproF('')
    await load()
    setBusy(false)
  }

  async function savePack() {
    if (!varietyId || !(packSize > 0)) return
    setBusy(true); setMsg(null); setError(null)
    const up = await supabase.from('variety').update({ seeds_per_pack: packSize }).eq('variety_id', varietyId)
    if (up.error) setError(up.error.message)
    else { setMsg(`Запазени ${fmtInt(packSize)} семена в торба за „${varById.get(varietyId)?.name}“.`); setPackInput(''); await load() }
    setBusy(false)
  }

  async function clearSeeds() {
    if (selected.length === 0) return
    setBusy(true); setMsg(null); setError(null)
    const del = await supabase.from('planting_seed').delete().in('planting_id', selected.map((p) => p.planting_id))
    if (del.error) setError(del.error.message)
    else { setMsg(`Изчистени семена за ${selected.length} БЗС.`); setSel(new Set()); await load() }
    setBusy(false)
  }

  // ---- суми ----
  const totals = useMemo(() => {
    let area = 0, t = 0, packs = 0
    for (const p of view) {
      area += p.planted_area_da ?? 0
      const c = calcFor(p)
      if (c) { t += c.t ?? 0; packs += c.packs ?? 0 }
    }
    return { area, t, packs }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, seedsByPlanting, batchById, cropById])

  const isSolid = selCrop?.seeding_method === 'solid'
  const rateLabel = selCrop ? (isSolid ? 'Норма, кълняеми семена/м²' : 'Норма, семена/дка') : 'Норма'
  const preview = useMemo(() => {
    if (!selCrop || !(Number(rate) > 0)) return null
    const b = batchId ? batchById.get(batchId) : undefined
    const area = selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0)
    const c = calcRow(selCrop, { area_da: area, target_rate: Number(rate), overage_pct: null }, b, varietyId ? { ...(varById.get(varietyId) as Variety), seeds_per_pack: packSize > 0 ? packSize : (varById.get(varietyId)?.seeds_per_pack ?? null) } : undefined)
    return { area, c }
  }, [selCrop, rate, batchId, selected, batchById, varietyId, packSize, varById])

  return (
    <>
      <div className="page-head">
        <h1>Планиране семена</h1>
        <span className="muted">
          {loading ? 'Зареждане…' : `${view.length} от ${plantings.length} БЗС · ${fmtArea(totals.area)} дка · ${fmtArea(totals.t)} т · ${fmtInt(totals.packs)} торби`}
        </span>
      </div>

      {error && <div className="banner err" role="alert">Грешка: {error}</div>}
      {msg && <div className="banner" role="status" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-strong-bg)', color: 'var(--ok-ink)' }}>{msg}</div>}

      <div className="filters">
        <label className="field grow">Търсене (име на БЗС)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">Култура
          <MultiFilter value={cropF} onChange={setCropF} ariaLabel="Култура" options={opts.crops.map((c) => ({ value: c, label: cropLabel(c) }))} />
        </label>
        <label className="field">Фирма
          <MultiFilter value={companyF} onChange={setCompanyF} ariaLabel="Фирма" options={opts.companies.map((c) => ({ value: c, label: c }))} />
        </label>
        <label className="field">Стопанска база
          <MultiFilter value={baseF} onChange={setBaseF} ariaLabel="Стопанска база" options={opts.bases.map((c) => ({ value: c, label: c }))} />
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> Само без сорт
        </label>
      </div>

      {sel.size > 0 && (
        <div className="card pad seed-toolbar">
          <strong>Избрани: {selected.length} БЗС · {fmtArea(selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0))} дка</strong>
          {selCrops.length > 1 ? (
            <div className="banner">Избрани са различни култури. Избери БЗС само от една култура, за да им назначиш сорт.</div>
          ) : (
            <div className="filters">
              <label className="field">Сорт / хибрид
                <select className="input" value={varietyId} onChange={(e) => { setVarietyId(e.target.value); setBatchId(''); setReproF(''); setPackInput('') }}>
                  <option value="">— избери —</option>
                  {cropVarieties.map((v) => <option key={v.variety_id} value={v.variety_id}>{v.name}</option>)}
                </select>
              </label>
              <label className="field">Размножение
                <select className="input" value={reproF} onChange={(e) => { setReproF(e.target.value); setBatchId('') }} disabled={!varietyId}>
                  <option value="">— всички —</option>
                  {reproOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label className="field grow">Партида (произход · МХЗ · кълняемост)
                <select className="input" value={batchId} onChange={(e) => setBatchId(e.target.value)} disabled={!varietyId}>
                  <option value="">Без партида</option>
                  {shownBatches.map((b) => <option key={b.batch_id} value={b.batch_id}>{batchLabel(b, !reproF)}</option>)}
                </select>
              </label>
              <label className="field">{rateLabel}
                <input className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(',', '.'))} />
              </label>
              {isPacks && (
                <label className="field">Семена в торба
                  <input className="input num" inputMode="numeric" value={packInput !== '' ? packInput : String(effectivePack || '')}
                    onChange={(e) => setPackInput(e.target.value.replace(/\D/g, ''))} />
                </label>
              )}
              {isPacks && varietyId && (
                <button className="btn outline" disabled={busy || !(packSize > 0)} onClick={savePack}>Запази за хибрида</button>
              )}
              <button className="btn" disabled={busy || !varietyId || !(Number(rate) > 0)} onClick={apply}>Приложи</button>
              <button className="btn outline" disabled={busy} onClick={clearSeeds}>Изчисти семената</button>
              <button className="btn outline" onClick={() => setSel(new Set())}>Откажи избора</button>
            </div>
          )}
          {preview && !preview.c.missing && (
            <div className="muted">
              Преглед за избраните: {isSolid && preview.c.totalSeedsM2 != null ? `${fmtInt(preview.c.totalSeedsM2)} общи семена/м²` : ''}
              {preview.c.kgDa != null ? ` · ${fmtInt(preview.c.kgDa)} кг/дка · ${fmtArea(preview.c.t)} т` : ''}
              {preview.c.packs != null ? `${isSolid ? ' · ' : ''}${fmtInt(Math.ceil(preview.c.packs))} торби` : ''}
            </div>
          )}
          {preview?.c.missing && <div className="muted">За тази партида няма нужните данни (кълняемост, МХЗ или семена в торба), затова количествата не се смятат.</div>}
        </div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Избери всички показани" checked={allShownSelected} onChange={toggleAll} /></th>
              <th>Наименование<ColumnPicker items={pickerItems} hidden={colPrefs.hidden} onToggle={colPrefs.toggle} onShowAll={colPrefs.showAll} /></th>
              {vis('company') && <th>Фирма</th>}{vis('crop') && <th>Култура</th>}{vis('area') && <th className="num">Площ, дка</th>}
              {vis('variety') && <th>Сорт / хибрид</th>}{vis('repro') && <th>Размножение</th>}{vis('origin') && <th>Произход</th>}
              {vis('rate') && <th className="num">Норма</th>}{vis('total') && <th className="num">Общи сем./м²</th>}{vis('kgda') && <th className="num">кг/дка</th>}
              {vis('kg') && <th className="num">кг общо</th>}{vis('t') && <th className="num">Тона</th>}{vis('packs') && <th className="num">Торби</th>}
            </tr>
          </thead>
          <tbody>
            {view.map((p) => {
              const rows = seedsByPlanting.get(p.planting_id) ?? []
              const r0 = rows[0]
              const crop = cropById.get(p.crop_id)
              const b0 = r0?.batch_id ? batchById.get(r0.batch_id) : undefined
              const c = calcFor(p)
              return (
                <tr key={p.planting_id} className={`row ${sel.has(p.planting_id) ? 'open' : ''}`} onClick={() => toggle(p.planting_id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(p.planting_id)} onChange={() => toggle(p.planting_id)} aria-label={`Избери ${p.field_name}`} /></td>
                  <td><span className="name">{p.field_name}</span></td>
                  {vis('company') && (<td>{p.company_name ?? <span className="empty">—</span>}</td>)}
                  {vis('crop') && (<td><span className="crop crop-main"><span className="dot" style={{ background: cropColor(p.crop_name) }} />{cropLabel(p.crop_name)}</span></td>)}
                  {vis('area') && (<td className="num">{fmtArea(p.planted_area_da)}</td>)}
                  {vis('variety') && (<td>{r0 ? <>{varById.get(r0.variety_id)?.name ?? '—'}{rows.length > 1 && <> <span className="chip">+{rows.length - 1}</span></>}</> : <span className="empty">—</span>}</td>)}
                  {vis('repro') && (<td>{r0 && b0?.reproduction_id != null && reproById.get(b0.reproduction_id) ? reproById.get(b0.reproduction_id) : <span className="empty">—</span>}</td>)}
                  {vis('origin') && (<td>{r0?.seed_origin ?? <span className="empty">—</span>}</td>)}
                  {vis('rate') && (<td className="num">{r0 ? fmtInt(r0.target_rate) : ''}{r0 && crop ? <span className="muted"> {crop.seeding_method === 'solid' ? 'к.с./м²' : 'сем./дка'}</span> : ''}</td>)}
                  {vis('total') && (<td className="num">{c?.totalSeedsM2 != null ? fmtInt(c.totalSeedsM2) : ''}</td>)}
                  {vis('kgda') && (<td className="num">{c?.kgDa != null ? fmtInt(c.kgDa) : ''}</td>)}
                  {vis('kg') && (<td className="num">{c?.kg != null && c.kg > 0 && !c.missing ? fmtInt(c.kg) : ''}</td>)}
                  {vis('t') && (<td className="num">{c?.kg != null && c.kg > 0 && !c.missing ? fmtArea(c.t) : (c?.missing ? <span className="chip warn">липсват данни</span> : '')}</td>)}
                  {vis('packs') && (<td className="num">{c && (c.packs ?? 0) > 0 && !c.missing ? fmtInt(Math.ceil(c.packs ?? 0)) : ''}</td>)}
                </tr>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={shownCols} className="empty">Няма БЗС по тези филтри.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

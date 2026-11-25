import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, cropColor, cropLabel } from '../lib/format'
import { ColumnPicker, useHiddenCols } from '../lib/columns'
import { MultiFilter, anyToken, splitMulti } from '../lib/multifilter'
import { calcRow, round1, type Crop, type Variety, type Batch, type SeedPrice, type Source } from '../lib/seedcalc'
import { loadSeedData, loadSeasons, seedLine, type Planting, type PSeed, type Repro, type SeedLine } from '../lib/seeddata'
import { downloadXlsx, red, type Cell } from '../lib/xlsx'
import { useConfirm } from '../lib/confirm'
import SeedImport from './SeedImport'

type LastImport = { import_id: string; created_at: string; rows_applied: number; file_name: string | null }

// единствената избрана стойност на мултифилтъра (за обхвата на импорта)
const one = (v: string) => { const t = splitMulti(v); return t.length === 1 ? t[0] : undefined }

// bg-BG: запетая за десетични, интервал за хиляди
const nf = (d: number) => new Intl.NumberFormat('bg-BG', { minimumFractionDigits: d, maximumFractionDigits: d })
const NF = [nf(0), nf(1), nf(2)]
const fmtN = (v: number | null | undefined, d: 0 | 1 | 2) => (v == null ? '' : NF[d].format(v))
const fmtQ = (v: number | null | undefined, packs: boolean) => fmtN(v, packs ? 1 : 2)
const fmtMaybe = (v: number | null | undefined) => (v == null ? '' : new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 2 }).format(v))
const UNIT_TEXT: Record<SeedPrice['unit'], string> = { pack: 'торба', t: 'т', kg: 'кг' }
const SRC_TEXT: Record<Exclude<Source, null>, string> = { bzs: 'за това БЗС', batch: 'от партидата', variety: 'от сорта' }
const parseNum = (s: string) => { const t = s.replace(/\s/g, '').replace(',', '.'); return t === '' ? null : Number(t) }

// клетка, която се редактира с клик: Enter/излизане записва, Esc отказва; празно = връща стойността по подразбиране
function EditCell({ value, display, onSave, disabled, title, label }: {
  value: number | null; display: ReactNode; onSave: (v: number | null) => Promise<void>; disabled?: boolean; title?: string; label: string
}) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState('')
  if (disabled) return <span title={title}>{display}</span>
  const start = () => { setText(value == null ? '' : String(value).replace('.', ',')); setEdit(true) }
  if (!edit) {
    return (
      <span role="button" tabIndex={0} title={title ? `${title} · клик за промяна` : 'Клик за промяна'} style={{ cursor: 'text', display: 'inline-block', minWidth: 28 }}
        onClick={(e) => { e.stopPropagation(); start() }}
        onKeyDown={(e) => { if (e.key === 'Enter') start() }}>
        {display === '' || display == null ? <span className="empty">·</span> : display}
      </span>
    )
  }
  const commit = async () => {
    setEdit(false)
    const v = parseNum(text)
    if (v != null && !(v > 0)) return
    if (v === value) return
    await onSave(v)
  }
  return (
    <input className="input cell-in" autoFocus inputMode="decimal" aria-label={label} value={text}
      onClick={(e) => e.stopPropagation()} onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()} onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEdit(false) }} />
  )
}

export default function SeedPlanning() {
  const colPrefs = useHiddenCols('seeds')
  const vis = colPrefs.vis
  const pickerItems = [
    { key: 'company', label: 'Фирма' }, { key: 'base', label: 'Стопанска база' }, { key: 'crop', label: 'Култура' }, { key: 'area', label: 'Площ, дка' },
    { key: 'variety', label: 'Сорт / хибрид' }, { key: 'repro', label: 'Размножение' }, { key: 'origin', label: 'Произход' },
    { key: 'tkw', label: 'МХЗ, г' }, { key: 'germ', label: 'Кълняемост, %' }, { key: 'gsm', label: 'Кълняеми/м²' }, { key: 'seeds', label: 'Семена/м²' },
    { key: 'rate', label: 'Норма' }, { key: 'need', label: 'Нужда' }, { key: 'withov', label: 'С преразход' },
    { key: 'price', label: 'Цена' }, { key: 'value', label: 'Стойност EUR' }, { key: 'eurda', label: 'EUR/дка' },
  ]
  const shownCols = pickerItems.filter((i) => vis(i.key)).length + 2
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [varieties, setVarieties] = useState<Variety[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [repros, setRepros] = useState<Repro[]>([])
  const [pseeds, setPseeds] = useState<PSeed[]>([])
  const [prices, setPrices] = useState<Map<string, SeedPrice>>(new Map())
  const [pricesOk, setPricesOk] = useState(true)
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
  const [qTkw, setQTkw] = useState('')
  const [qGerm, setQGerm] = useState('')
  const [qRate, setQRate] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [lastImport, setLastImport] = useState<LastImport | null>(null)
  const [confirm, confirmNode] = useConfirm()

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const seasons = await loadSeasons()
      const sid = seasons.find((s) => s.is_current)?.season_id ?? seasons[0]?.season_id
      if (sid == null) throw new Error('Няма текущ сезон.')
      const d = await loadSeedData(sid)
      const li = await supabase.from('seed_import').select('import_id,created_at,rows_applied,file_name')
        .eq('season_id', sid).is('undone_at', null).order('created_at', { ascending: false }).limit(1)
      setLastImport(!li.error ? ((li.data ?? [])[0] as LastImport | undefined) ?? null : null)
      setCrops(d.crops); setVarieties(d.varieties); setBatches(d.batches); setRepros(d.repros); setPseeds(d.pseeds)
      setPlantings(d.plantings); setPrices(d.prices); setPricesOk(d.pricesOk)
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

  // сметките за всяко БЗС (един или няколко реда семена)
  const linesByPlanting = useMemo(() => {
    const m = new Map<string, SeedLine[]>()
    for (const p of plantings) {
      const crop = cropById.get(p.crop_id)
      const rows = seedsByPlanting.get(p.planting_id) ?? []
      if (!crop || rows.length === 0) continue
      m.set(p.planting_id, rows.map((r) => seedLine(crop, r, r.batch_id ? batchById.get(r.batch_id) : undefined, varById.get(r.variety_id), prices.get(r.variety_id))))
    }
    return m
  }, [plantings, cropById, seedsByPlanting, batchById, varById, prices])

  type Sum = { need: number | null; withOverage: number | null; value: number | null; noPrice: boolean; mismatch: boolean; missing: boolean }
  const sumFor = (ls: SeedLine[] | undefined): Sum | null => {
    if (!ls || ls.length === 0) return null
    const packs = ls[0].unit === 'packs'
    const r = (x: number) => (packs ? round1(x) : Math.round(x * 100) / 100)
    let need = 0, ov = 0, value = 0, any = false, missing = false, noPrice = false, mismatch = false
    for (const l of ls) {
      if (l.need == null || l.withOverage == null) { missing = true; continue }
      need += l.need; ov += l.withOverage; any = true
      if (l.value == null) noPrice = true; else value += l.value
      if (l.mismatch) mismatch = true
    }
    return { need: any ? r(need) : null, withOverage: any ? r(ov) : null, value: any && !noPrice ? Math.round(value * 100) / 100 : null, noPrice, mismatch, missing }
  }

  // партида = произход · МХЗ · кълняемост (размножението е отделно поле; показва се в етикета само когато не е избрано)
  const batchLabel = (b: Batch, withRepro = false) =>
    [withRepro && b.reproduction_id != null ? reproById.get(b.reproduction_id) : null, originByBatch.get(b.batch_id),
      b.tkw_g ? `МХЗ ${fmtMaybe(b.tkw_g)} г` : null, b.germination_pct ? `кълняемост ${fmtMaybe(b.germination_pct)}%` : null].filter(Boolean).join(' · ') || 'без данни'

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

  // масово: МХЗ, кълняемост, кълняеми/м² (норма) за избраните БЗС с назначен сорт; празно поле = без промяна
  const selSeedIds = selected.flatMap((p) => (seedsByPlanting.get(p.planting_id) ?? []).map((s) => s.planting_seed_id))
  async function applyQuality() {
    const patch: Record<string, number> = {}
    const t = parseNum(qTkw), g = parseNum(qGerm), r = parseNum(qRate)
    if (t != null) { if (!(t > 0)) return setError('МХЗ трябва да е число над 0.'); patch.tkw_g = t }
    if (g != null) { if (!(g > 0 && g <= 100)) return setError('Кълняемостта трябва да е между 0 и 100 %.'); patch.germination_pct = g }
    if (r != null) { if (!(r > 0)) return setError('Нормата трябва да е число над 0.'); patch.target_rate = r }
    if (Object.keys(patch).length === 0 || selSeedIds.length === 0) return
    setBusy(true); setMsg(null); setError(null)
    const u = await supabase.from('planting_seed').update(patch).in('planting_seed_id', selSeedIds).select('planting_seed_id')
    if (u.error) setError(u.error.message)
    else { setMsg(`Качеството е зададено за ${u.data?.length ?? 0} реда семена.`); setQTkw(''); setQGerm(''); setQRate(''); await load() }
    setBusy(false)
  }
  async function resetSelected(what: 'quality' | 'manual') {
    if (selSeedIds.length === 0) return
    setBusy(true); setMsg(null); setError(null)
    const patch = what === 'quality' ? { tkw_g: null, germination_pct: null } : { rate_kg_da_manual: null }
    const u = await supabase.from('planting_seed').update(patch).in('planting_seed_id', selSeedIds).select('planting_seed_id')
    if (u.error) setError(u.error.message)
    else { setMsg(what === 'quality' ? `МХЗ и кълняемостта се взимат от партидата/сорта за ${u.data?.length ?? 0} реда.` : `Върнати изчислените норми за ${u.data?.length ?? 0} реда.`); await load() }
    setBusy(false)
  }

  // редакция в клетка (само за БЗС с един ред семена)
  async function patchSeed(ps: PSeed, patch: Partial<PSeed>) {
    setError(null)
    const u = await supabase.from('planting_seed').update(patch).eq('planting_seed_id', ps.planting_seed_id).select('*')
    if (u.error) { setError(u.error.message); return }
    if (!u.data?.length) { setError('Не е записано – вероятно нямаш права за това БЗС.'); return }
    const row = u.data[0] as PSeed
    setPseeds((all) => all.map((s) => (s.planting_seed_id === row.planting_seed_id ? row : s)))
  }

  async function undoImport() {
    if (!lastImport) return
    const when = new Date(lastImport.created_at).toLocaleString('bg-BG')
    const ok = await confirm(`Да отменя ли импорта от ${when} (${lastImport.file_name ?? 'таблица'}, ${lastImport.rows_applied} БЗС)?\nСортовете и нормите на тези БЗС ще се върнат както бяха преди импорта.`, { ok: 'Отмени импорта', danger: true })
    if (!ok) return
    setBusy(true); setMsg(null); setError(null)
    const res = await supabase.rpc('undo_seed_import', { p_import_id: lastImport.import_id })
    if (res.error) setError(res.error.message)
    else { setMsg(`Импортът е отменен: върнати ${res.data} БЗС.`); await load() }
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

  // ---- суми за показаните ----
  const totals = useMemo(() => {
    let area = 0, t = 0, packs = 0, value = 0, noPrice = 0, missing = 0
    for (const p of view) {
      area += p.planted_area_da ?? 0
      const ls = linesByPlanting.get(p.planting_id)
      const s = sumFor(ls)
      if (s?.missing) missing++
      if (!s || s.withOverage == null) continue
      if (ls?.[0]?.unit === 'packs') packs += s.withOverage; else t += s.withOverage
      if (s.value != null) value += s.value; else noPrice++
    }
    return { area, t, packs, value, noPrice, missing }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, linesByPlanting])

  const isSolid = selCrop?.seeding_method === 'solid'
  const rateLabel = selCrop ? (isSolid ? 'Норма, кълняеми семена/м²' : 'Норма, семена/дка') : 'Норма'
  const preview = useMemo(() => {
    if (!selCrop || !(Number(rate) > 0)) return null
    const b = batchId ? batchById.get(batchId) : undefined
    const area = selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0)
    const v = varietyId ? varById.get(varietyId) : undefined
    const c = calcRow(selCrop, { area_da: area, target_rate: Number(rate), overage_pct: null }, b, v ? { ...v, seeds_per_pack: packSize > 0 ? packSize : v.seeds_per_pack } : undefined)
    return { area, c }
  }, [selCrop, rate, batchId, selected, batchById, varietyId, packSize, varById])

  // ---- клетки ----
  const priceText = (p: SeedPrice) => `${fmtN(p.price, 2)} /${UNIT_TEXT[p.unit]}`
  const priceTitle = (p: SeedPrice) => `${p.supplier ?? ''}${p.own ? ' · вътрешна цена' : ''}${p.offers && p.offers > 1 ? ` · ${p.offers} оферти` : ''}`
  const qtyUnit = (packs: boolean) => <span className="muted"> {packs ? 'торби' : 'т'}</span>

  function exportXlsx() {
    const headers = ['БЗС', 'Фирма', 'Стопанска база', 'Култура', 'Площ, дка', 'Сорт / хибрид', 'Добавка', 'Размножение', 'Произход',
      'МХЗ, г', 'Кълняемост, %', 'Кълняеми/м²', 'Семена/м²', 'Норма', 'Ед. норма', 'Ръчна норма', 'Преразход, %', 'Нужда', 'С преразход', 'Ед. количество',
      'Доставчик', 'Цена EUR без ДДС', 'Ед. цена', 'Стойност EUR', 'EUR/дка', 'Забележка']
    const rows: Cell[][] = []
    for (const p of view) {
      const crop = cropById.get(p.crop_id)
      const ls = linesByPlanting.get(p.planting_id) ?? []
      const head: Cell[] = [p.field_name, p.company_name, p.farm_base_name, p.crop_name]
      if (ls.length === 0 || !crop) { rows.push([...head, p.planted_area_da, ...Array(headers.length - 5).fill(null)]); continue }
      for (const l of ls) {
        const b = l.ps.batch_id ? batchById.get(l.ps.batch_id) : undefined
        const kg = crop.order_unit === 'kg'
        const solid = crop.seeding_method === 'solid'
        const area = ls.length > 1 ? Number(l.ps.area_da) : p.planted_area_da
        rows.push([...head, area,
          varById.get(l.ps.variety_id)?.name ?? '', l.ps.addon ?? null, b?.reproduction_id != null ? reproById.get(b.reproduction_id) ?? null : null, l.ps.seed_origin,
          l.calc.tkw, l.calc.germ, solid ? Number(l.ps.target_rate) : null, l.calc.totalSeedsM2 == null ? null : round1(l.calc.totalSeedsM2),
          kg ? l.calc.kgDa : solid ? l.calc.kgDaInfo : Number(l.ps.target_rate), kg ? 'кг/дка' : solid ? 'кг/дка (инф.)' : 'сем./дка',
          l.calc.manual, l.calc.overagePct, l.need ?? (l.calc.missing ? red('липсват данни') : null), l.withOverage ?? (l.calc.missing ? red('липсват данни') : null), l.unit === 'packs' ? 'торби' : 'т',
          l.price?.supplier ?? null, l.price?.price ?? null, l.price ? UNIT_TEXT[l.price.unit] : null, l.value,
          l.value != null && area ? Math.round((l.value / Number(area)) * 100) / 100 : null,
          l.calc.missing ? red(`липсват данни${l.calc.missingWhat.length ? `: ${l.calc.missingWhat.join(', ')}` : ''}`) : null])
      }
    }
    downloadXlsx(`планиране_семена_${new Date().toISOString().slice(0, 10)}.xlsx`, 'Планиране семена', headers, rows)
  }

  return (
    <>
      <div className="page-head">
        <h1>Планиране семена</h1>
        <span className="muted">
          {loading ? 'Зареждане…' : `${view.length} от ${plantings.length} БЗС · ${fmtArea(totals.area)} дка · с преразход ${fmtN(totals.t, 2)} т и ${fmtN(totals.packs, 1)} торби · ${fmtN(totals.value, 2)} EUR${totals.noPrice ? ` (+ ${totals.noPrice} БЗС без цена)` : ''}`}
          {!loading && totals.missing > 0 && <span className="chip err" style={{ marginLeft: 8 }} title="Тези БЗС нямат кълняемост, МХЗ или семена в торба и не влизат в сумите">{totals.missing} БЗС: липсват данни</span>}
        </span>
      </div>

      {error && <div className="banner err" role="alert">Грешка: {error}</div>}
      {msg && <div className="banner" role="status" style={{ background: 'var(--ok-bg)', borderColor: 'var(--ok-strong-bg)', color: 'var(--ok-ink)' }}>{msg}</div>}
      {!pricesOk && <div className="banner">Цените на семената не се заредиха – колоните с цени са празни.</div>}

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
        <button className="btn outline" onClick={() => setImportOpen(true)}>Импорт от таблица</button>
        {lastImport && (
          <button className="btn outline" disabled={busy} onClick={() => void undoImport()}
            title={`Последен импорт: ${new Date(lastImport.created_at).toLocaleString('bg-BG')} · ${lastImport.rows_applied} БЗС`}>Отмени последния импорт</button>
        )}
        <button className="btn outline" onClick={exportXlsx} disabled={loading || view.length === 0}>Експорт в Excel</button>
      </div>
      {importOpen && (
        <SeedImport
          defaults={{ crop: one(cropF), company: one(companyF), base: one(baseF) }}
          onClose={() => setImportOpen(false)}
          onDone={(m) => { setImportOpen(false); setMsg(m); void load() }}
        />
      )}
      {confirmNode}

      {sel.size > 0 && (
        <div className="card pad seed-toolbar">
          <strong>Избрани: {selected.length} БЗС · {fmtArea(selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0))} дка</strong>
          {selCrops.length > 1 ? (
            <div className="banner">Избрани са различни култури. Избери БЗС само от една култура, за да им назначиш сорт или качество.</div>
          ) : (
            <>
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
                <button className="btn" disabled={busy || !varietyId || !(Number(rate) > 0)} onClick={apply}>Приложи сорта</button>
                <button className="btn outline" disabled={busy} onClick={clearSeeds}>Изчисти семената</button>
                <button className="btn outline" onClick={() => setSel(new Set())}>Откажи избора</button>
              </div>
              {preview && !preview.c.missing && (
                <div className="muted">
                  Преглед за избраните: {isSolid && preview.c.totalSeedsM2 != null ? `${fmtInt(preview.c.totalSeedsM2)} семена/м²` : ''}
                  {preview.c.kgDa != null ? ` · ${fmtN(preview.c.kgDa, 0)} кг/дка · нужда ${fmtN(preview.c.needT, 2)} т, с преразход ${fmtN(preview.c.t, 2)} т` : ''}
                  {preview.c.packs != null ? `${isSolid ? ' · ' : ''}нужда ${fmtN(preview.c.needPacks, 1)} торби, с преразход ${fmtN(preview.c.packs, 1)}` : ''}
                </div>
              )}
              {preview?.c.missing && <div className="muted">Липсва: {preview.c.missingWhat.join(', ') || 'кълняемост, МХЗ или семена в торба'} – въведи ги по-долу или в сорта/партидата.</div>}

              <div className="filters" style={{ borderTop: '1px solid var(--border, #e3e3e3)', paddingTop: 10 }}>
                <span className="muted" style={{ alignSelf: 'center' }}>Качество за избраните ({selSeedIds.length} реда със сорт); празно = без промяна:</span>
                <label className="field">МХЗ, г<input className="input num" inputMode="decimal" value={qTkw} onChange={(e) => setQTkw(e.target.value)} /></label>
                <label className="field">Кълняемост, %<input className="input num" inputMode="decimal" value={qGerm} onChange={(e) => setQGerm(e.target.value)} /></label>
                <label className="field">{isSolid ? 'Кълняеми/м²' : 'Норма, сем./дка'}<input className="input num" inputMode="decimal" value={qRate} onChange={(e) => setQRate(e.target.value)} /></label>
                <button className="btn" disabled={busy || selSeedIds.length === 0 || (!qTkw.trim() && !qGerm.trim() && !qRate.trim())} onClick={() => void applyQuality()}>Задай качеството</button>
                <button className="btn outline" disabled={busy || selSeedIds.length === 0} onClick={() => void resetSelected('quality')} title="МХЗ и кълняемост отново от партидата, иначе от сорта">МХЗ/кълняемост по подразбиране</button>
                {selCrop?.order_unit === 'kg' && <button className="btn outline" disabled={busy || selSeedIds.length === 0} onClick={() => void resetSelected('manual')}>Върни изчислените норми</button>}
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Избери всички показани" checked={allShownSelected} onChange={toggleAll} /></th>
              <th>Наименование<ColumnPicker items={pickerItems} hidden={colPrefs.hidden} onToggle={colPrefs.toggle} onShowAll={colPrefs.showAll} /></th>
              {vis('company') && <th>Фирма</th>}{vis('base') && <th>База</th>}{vis('crop') && <th>Култура</th>}{vis('area') && <th className="num">Площ, дка</th>}
              {vis('variety') && <th>Сорт / хибрид</th>}{vis('repro') && <th>Размножение</th>}{vis('origin') && <th>Произход</th>}
              {vis('tkw') && <th className="num" title="Маса на 1000 семена">МХЗ, г</th>}{vis('germ') && <th className="num">Кълн., %</th>}
              {vis('gsm') && <th className="num" title="Кълняеми семена/м² (норма за житни и рапица)">Кълн./м²</th>}{vis('seeds') && <th className="num" title="Брой семена/м² = CEILING(кълняеми ÷ кълняемост)">Сем./м²</th>}
              {vis('rate') && <th className="num">Норма</th>}
              {vis('need') && <th className="num" title="Без преразход">Нужда</th>}{vis('withov') && <th className="num" title="Нужда × (1 + преразход %) – от нея е заявката">С преразход</th>}
              {vis('price') && <th className="num" title="Избраната оферта за сорта и сезона">Цена</th>}{vis('value') && <th className="num" title="С преразход × цена">Стойност EUR</th>}{vis('eurda') && <th className="num">EUR/дка</th>}
            </tr>
          </thead>
          <tbody>
            {view.map((p) => {
              const rows = seedsByPlanting.get(p.planting_id) ?? []
              const r0 = rows[0]
              const crop = cropById.get(p.crop_id)
              const b0 = r0?.batch_id ? batchById.get(r0.batch_id) : undefined
              const ls = linesByPlanting.get(p.planting_id)
              const l0 = ls?.[0]
              const c = l0?.calc
              const s = sumFor(ls)
              const single = rows.length === 1
              const solid = crop?.seeding_method === 'solid'
              const kg = crop?.order_unit === 'kg'
              const packs = l0?.unit === 'packs'
              const v0 = r0 ? varById.get(r0.variety_id) : undefined
              const dflt = (field: 'tkw_g' | 'germination_pct') => {
                const bv = b0?.[field]; const vv = v0?.[field]
                return bv != null ? `партида: ${fmtMaybe(bv)}` : vv != null ? `сорт: ${fmtMaybe(vv)}` : 'няма стойност по подразбиране'
              }
              const qualityCell = (field: 'tkw_g' | 'germination_pct', val: number | null | undefined, src: Source) => (
                <EditCell value={r0?.[field] ?? null} label={field === 'tkw_g' ? 'МХЗ' : 'Кълняемост'} disabled={!single}
                  title={src ? `${SRC_TEXT[src]}${src === 'bzs' ? ` (по подразбиране – ${dflt(field)}); празно връща подразбиращата се` : ''}` : dflt(field)}
                  display={val == null ? '' : <span className={src === 'bzs' ? 'own-val' : undefined}>{fmtMaybe(val)}</span>}
                  onSave={(v) => patchSeed(r0, { [field]: v } as Partial<PSeed>)} />
              )
              const price = l0?.price
              const sameVariety = !!ls && ls.every((l) => l.ps.variety_id === l0?.ps.variety_id)
              return (
                <tr key={p.planting_id} className={`row ${sel.has(p.planting_id) ? 'open' : ''}`} onClick={() => toggle(p.planting_id)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(p.planting_id)} onChange={() => toggle(p.planting_id)} aria-label={`Избери ${p.field_name}`} /></td>
                  <td><span className="name">{p.field_name}</span></td>
                  {vis('company') && (<td>{p.company_name ?? <span className="empty">—</span>}</td>)}
                  {vis('base') && (<td>{p.farm_base_name ?? <span className="empty">—</span>}</td>)}
                  {vis('crop') && (<td><span className="crop crop-main"><span className="dot" style={{ background: cropColor(p.crop_name) }} />{cropLabel(p.crop_name)}</span></td>)}
                  {vis('area') && (<td className="num">{fmtArea(p.planted_area_da)}</td>)}
                  {vis('variety') && (<td>{r0 ? <>{v0?.name ?? '—'}{r0.addon ? <span className="muted"> + {r0.addon}</span> : null}{rows.length > 1 && <> <span className="chip" title="Няколко сорта на това БЗС – редакцията в клетка е само за БЗС с един сорт">+{rows.length - 1}</span></>}</> : <span className="empty">—</span>}</td>)}
                  {vis('repro') && (<td>{r0 && b0?.reproduction_id != null && reproById.get(b0.reproduction_id) ? reproById.get(b0.reproduction_id) : <span className="empty">—</span>}</td>)}
                  {vis('origin') && (<td>{r0?.seed_origin ?? <span className="empty">—</span>}</td>)}
                  {vis('tkw') && (<td className="num" onClick={(e) => e.stopPropagation()}>{r0 ? qualityCell('tkw_g', c?.tkw, c?.tkwSource ?? null) : ''}</td>)}
                  {vis('germ') && (<td className="num" onClick={(e) => e.stopPropagation()}>{r0 ? qualityCell('germination_pct', c?.germ, c?.germSource ?? null) : ''}</td>)}
                  {vis('gsm') && (<td className="num" onClick={(e) => e.stopPropagation()}>{r0 && solid
                    ? <EditCell value={Number(r0.target_rate)} label="Кълняеми семена/м²" disabled={!single} display={fmtN(Number(r0.target_rate), 0)} onSave={async (v) => { if (v != null) await patchSeed(r0, { target_rate: v }) }} />
                    : ''}</td>)}
                  {vis('seeds') && (<td className="num">{single && c?.totalSeedsM2 != null ? fmtN(c.totalSeedsM2, 0) : ''}</td>)}
                  {vis('rate') && (<td className="num" onClick={(e) => e.stopPropagation()}>{!r0 || !crop ? '' : !single ? <span className="muted">няколко</span>
                    : kg ? (
                      c?.kgDa == null ? <span className="chip err" title={`Липсва: ${c?.missingWhat.join(', ') || 'МХЗ, кълняемост'} – въведи ги (или ръчна норма)`}>липсват данни</span> : (
                        <>
                          <EditCell value={c.manual ? c.kgDa : null} label="Ръчна норма кг/дка"
                            title={c.manual ? `Ръчна норма; изчислената е ${fmtMaybe(c.kgDaCalc)} кг/дка` : 'Изчислена; въведи стойност за ръчна норма (1 знак)'}
                            display={<span className={c.manual ? 'manual manual-bg' : undefined}>{c.manual ? fmtN(c.kgDa, 1) : fmtN(c.kgDa, 0)}</span>}
                            onSave={(v) => patchSeed(r0, { rate_kg_da_manual: v == null ? null : round1(v) })} />
                          <span className="muted"> кг/дка</span>
                          {c.manual && <button className="reset-btn" title={`Върни изчислената (${c.kgDaCalc == null ? 'няма данни' : fmtMaybe(c.kgDaCalc)})`} aria-label="Върни изчислената норма" onClick={() => void patchSeed(r0, { rate_kg_da_manual: null })}>↺</button>}
                        </>
                      ))
                    : solid ? (c?.kgDaInfo != null ? <span title="Само за информация – количеството се смята в торби през семената">{fmtN(c.kgDaInfo, 2)}<span className="muted"> кг/дка (инф.)</span></span> : (c?.missing ? <span className="chip err" title={`Липсва: ${c.missingWhat.join(', ')} – за торбите е нужна кълняемостта`}>липсват данни</span> : <span className="muted" title="кг/дка е само информативен – иска МХЗ">—</span>))
                    : <><EditCell value={Number(r0.target_rate)} label="Норма семена/дка" display={fmtN(Number(r0.target_rate), 0)} onSave={async (v) => { if (v != null) await patchSeed(r0, { target_rate: v }) }} /><span className="muted"> сем./дка</span></>}
                  </td>)}
                  {vis('need') && (<td className="num">{s?.need != null ? <>{fmtQ(s.need, packs)}{qtyUnit(packs)}</> : (s?.missing ? <span className="chip err" title={c?.missingWhat.length ? `Липсва: ${c.missingWhat.join(', ')}` : undefined}>липсват данни</span> : '')}</td>)}
                  {vis('withov') && (<td className="num" title={c ? `Преразход ${fmtMaybe(c.overagePct)} %` : undefined}>{s?.withOverage != null ? <>{fmtQ(s.withOverage, packs)}{qtyUnit(packs)}</> : (s?.missing ? <span className="chip err" title={c?.missingWhat.length ? `Липсва: ${c.missingWhat.join(', ')}` : undefined}>липсват данни</span> : '')}</td>)}
                  {vis('price') && (<td className="num">{!l0 ? '' : price && sameVariety ? <span title={priceTitle(price)}>{priceText(price)}</span> : <span className="chip warn" title="Няма избрана оферта за сорта и сезона (Планиране семена → Оферти)">—</span>}</td>)}
                  {vis('value') && (<td className="num">{!l0 ? '' : s?.mismatch ? <span className="chip warn" title="Цената е за торба, а количеството е в т (или обратно) – не се превръща">мерна единица</span> : s?.value != null ? fmtN(s.value, 2) : s?.noPrice ? '—' : ''}</td>)}
                  {vis('eurda') && (<td className="num">{s?.value != null && (p.planted_area_da ?? 0) > 0 ? fmtN(s.value / (p.planted_area_da as number), 2) : ''}</td>)}
                </tr>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={shownCols} className="empty">Няма БЗС по тези филтри.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        МХЗ, кълняемост и нормата се променят с клик в клетката. <span className="own-val">Синьо с пунктир</span> = въведено за това БЗС (празно връща стойността от партидата/сорта).
        {' '}<span className="manual manual-bg">Синя норма</span> = ръчна; ↺ връща изчислената. Торби с 1 знак, тонове с 2 знака; заявката е от „С преразход“.
      </div>
    </>
  )
}

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, cropColor, cropLabel } from '../lib/format'
import { ColumnPicker, useHiddenCols } from '../lib/columns'

// ───────────────────────── типове ─────────────────────────
type Stage = 't1' | 't2' | 'corrective' | 'total_herbicide_pre'
type DoseUnit = 'ml_da' | 'g_da' | 'l_da' | 'kg_da'

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
type Product = {
  prz_product_id: string
  trade_name: string
  function_groups: string[] | null
  active_substances: string | null
  holder: string | null
  source: string
  is_active: boolean
}
type PName = { prz_product_id: string; name_norm: string }
type Use = {
  prz_product_id: string
  crop_id: string
  dose_min: number | null
  dose_max: number | null
  dose_unit: string | null
  phi_days: number | null
  max_applications: number | null
}
type Assign = {
  planting_prz_id: string
  planting_id: string
  prz_product_id: string
  stage: Stage
  dose_per_da: number
  dose_unit: DoseUnit
  area_da: number
}

const STAGES: { key: Stage; label: string; short: string }[] = [
  { key: 't1', label: 'Т1', short: 'Т1' },
  { key: 't2', label: 'Т2', short: 'Т2' },
  { key: 'corrective', label: 'Коригиращо', short: 'Коригиращо' },
  { key: 'total_herbicide_pre', label: 'Тотален хербицид преди поникване', short: 'Тотален хербицид' },
]
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label])) as Record<Stage, string>

const FUNC_LABEL: Record<string, string> = {
  fungicide: 'Фунгицид', herbicide: 'Хербицид', insecticide: 'Инсектицид', acaricide: 'Акарицид',
  growth_regulator: 'Растежен регулатор', desiccant: 'Десикант', molluscicide: 'Молюскоцид', rodenticide: 'Родентицид',
  nematicide: 'Нематоцид', bactericide: 'Бактерицид', repellent: 'Репелент', fumigant: 'Фумигант',
  adjuvant: 'Прилепител / добавка', other: 'Друго',
}
const UNIT_LABEL: Record<DoseUnit, string> = { ml_da: 'мл/дка', g_da: 'г/дка', l_da: 'л/дка', kg_da: 'кг/дка' }
const UNITS: DoseUnit[] = ['ml_da', 'g_da', 'l_da', 'kg_da']

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

const toNorm = (d: number, u: DoseUnit | string) => d * (u === 'l_da' || u === 'kg_da' ? 1000 : 1)   // мл или г на дка
const familyOf = (u: DoseUnit | string): 'vol' | 'mass' => (u === 'ml_da' || u === 'l_da' ? 'vol' : 'mass')
const isDoseUnit = (u: string | null): u is DoseUnit => u === 'ml_da' || u === 'g_da' || u === 'l_da' || u === 'kg_da'
const fmtDose = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString('bg-BG', { maximumFractionDigits: 3 })
const qtyOf = (a: { dose_per_da: number; dose_unit: DoseUnit; area_da: number }) => (toNorm(a.dose_per_da, a.dose_unit) * a.area_da) / 1000   // л или кг

type Reg = { minN: number | null; maxN: number | null; phi: number | null; apps: number | null; unit: DoseUnit | null }

// ───────────────────────── компонент ─────────────────────────
export default function PrzPlanning() {
  const colPrefs = useHiddenCols('prz')
  const vis = colPrefs.vis
  const [plantings, setPlantings] = useState<Planting[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [pnames, setPnames] = useState<PName[]>([])
  const [uses, setUses] = useState<Use[]>([])
  const [assigns, setAssigns] = useState<Assign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // филтри по колони
  const [q, setQ] = useState('')
  const [fSel, setFSel] = useState<Record<string, string>>({})
  const [fArea, setFArea] = useState<{ min: string; max: string }>({ min: '', max: '' })
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'field_name', dir: 1 })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const lastIdx = useRef<number | null>(null)

  // прозорец „Назначи ПРЗ“
  const [assignOpen, setAssignOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('t1')
  const [typeF, setTypeF] = useState('')
  const [pq, setPq] = useState('')
  const [onlyReg, setOnlyReg] = useState(true)
  const [limit, setLimit] = useState(40)
  const [chosen, setChosen] = useState<string>('')
  const [dose, setDose] = useState('')
  const [unit, setUnit] = useState<DoseUnit>('ml_da')

  // прозорец „Премахни“
  const [rmOpen, setRmOpen] = useState(false)
  const [rmStage, setRmStage] = useState<string>('all')
  const [rmProduct, setRmProduct] = useState<string>('all')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { data: season, error: se } = await supabase.from('season').select('year_end').eq('is_current', true).limit(1)
      if (se) throw new Error(se.message)
      const ye = season?.[0]?.year_end
      const pl = await fetchAll<Planting>((f, t) =>
        supabase.from('v_planting_context')
          .select('planting_id,organization_id,field_name,company_name,farm_base_name,crop_id,crop_name,planted_area_da,potential_name,tillage_name')
          .eq('season_year_end', ye).eq('role', 'main').order('field_name').order('planting_id').range(f, t))
      const [pr, nm, us, as] = await Promise.all([
        fetchAll<Product>((f, t) => supabase.from('prz_product').select('prz_product_id,trade_name,function_groups,active_substances,holder,source,is_active').eq('is_active', true).order('trade_name').order('prz_product_id').range(f, t)),
        fetchAll<PName>((f, t) => supabase.from('prz_product_name').select('prz_product_id,name_norm').order('name_id').range(f, t)),
        fetchAll<Use>((f, t) => supabase.from('prz_use').select('prz_product_id,crop_id,dose_min,dose_max,dose_unit,phi_days,max_applications').not('crop_id', 'is', null).order('prz_use_id').range(f, t)),
        fetchAll<Assign>((f, t) => supabase.from('planting_prz').select('planting_prz_id,planting_id,prz_product_id,stage,dose_per_da,dose_unit,area_da').order('planting_prz_id').range(f, t)),
      ])
      setPlantings(pl); setProducts(pr); setPnames(nm); setUses(us); setAssigns(as)
    } catch (e) {
      setError((e as Error).message)
    }
    setLoading(false)
  }
  useEffect(() => { void load() }, [])

  // ── справочници ──
  const prodById = useMemo(() => new Map(products.map((p) => [p.prz_product_id, p])), [products])
  const plantingById = useMemo(() => new Map(plantings.map((p) => [p.planting_id, p])), [plantings])
  const usesMap = useMemo(() => {
    const m = new Map<string, Use[]>()
    for (const u of uses) { const k = `${u.prz_product_id}|${u.crop_id}`; m.set(k, [...(m.get(k) ?? []), u]) }
    return m
  }, [uses])
  const hay = useMemo(() => {
    const names = new Map<string, string[]>()
    for (const n of pnames) names.set(n.prz_product_id, [...(names.get(n.prz_product_id) ?? []), n.name_norm])
    const m = new Map<string, string>()
    for (const p of products) m.set(p.prz_product_id, norm([p.trade_name, ...(names.get(p.prz_product_id) ?? []), p.active_substances, p.holder].join(' | ')))
    return m
  }, [products, pnames])

  const isRegistered = (productId: string, cropId: string) => usesMap.has(`${productId}|${cropId}`)
  function regFor(productId: string, cropId: string, fam: 'vol' | 'mass'): Reg {
    const list = (usesMap.get(`${productId}|${cropId}`) ?? []).filter((u) => isDoseUnit(u.dose_unit) && u.dose_max != null)
    const same = list.filter((u) => familyOf(u.dose_unit as DoseUnit) === fam)
    const all = usesMap.get(`${productId}|${cropId}`) ?? []
    const phi = all.reduce<number | null>((a, u) => (u.phi_days != null && (a == null || u.phi_days > a) ? u.phi_days : a), null)
    const apps = all.reduce<number | null>((a, u) => (u.max_applications != null && (a == null || u.max_applications > a) ? u.max_applications : a), null)
    if (same.length === 0) return { minN: null, maxN: null, phi, apps, unit: null }
    const minN = Math.min(...same.map((u) => toNorm(u.dose_min ?? (u.dose_max as number), u.dose_unit as DoseUnit)))
    const maxN = Math.max(...same.map((u) => toNorm(u.dose_max as number, u.dose_unit as DoseUnit)))
    return { minN, maxN, phi, apps, unit: same[0].dose_unit as DoseUnit }
  }

  const assignsByPlanting = useMemo(() => {
    const m = new Map<string, Assign[]>()
    for (const a of assigns) m.set(a.planting_id, [...(m.get(a.planting_id) ?? []), a])
    return m
  }, [assigns])

  // проблем в назначение: не е разрешен за културата / над макс. доза / над макс. брой третирания
  function issueOf(a: Assign): string | null {
    const p = plantingById.get(a.planting_id)
    if (!p) return null
    if (prodById.get(a.prz_product_id)?.source === 'own') return null
    if (!isRegistered(a.prz_product_id, p.crop_id)) return 'Не е разрешен за тази култура по регистъра на БАБХ'
    const r = regFor(a.prz_product_id, p.crop_id, familyOf(a.dose_unit))
    if (r.maxN != null && toNorm(a.dose_per_da, a.dose_unit) > r.maxN + 0.0001) return 'Дозата е над разрешената по регистъра'
    const same = (assignsByPlanting.get(a.planting_id) ?? []).filter((x) => x.prz_product_id === a.prz_product_id).length
    if (r.apps != null && same > r.apps) return `Над разрешения брой третирания (${r.apps})`
    return null
  }

  // ── филтри и подредба ──
  const opts = useMemo(() => {
    const u = (f: (p: Planting) => string | null) =>
      Array.from(new Set(plantings.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    const stageProducts = (s: Stage) =>
      Array.from(new Set(assigns.filter((a) => a.stage === s).map((a) => a.prz_product_id)))
        .map((id) => ({ id, name: prodById.get(id)?.trade_name ?? '' })).sort((a, b) => a.name.localeCompare(b.name, 'bg'))
    return {
      company: u((p) => p.company_name), base: u((p) => p.farm_base_name), crop: u((p) => p.crop_name),
      potential: u((p) => p.potential_name), tillage: u((p) => p.tillage_name),
      t1: stageProducts('t1'), t2: stageProducts('t2'), corrective: stageProducts('corrective'), total_herbicide_pre: stageProducts('total_herbicide_pre'),
    }
  }, [plantings, assigns, prodById])

  const EMPTY = '__empty', ANY = '__any'
  const view = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = plantings.filter((p) => {
      if (n && !p.field_name.toLowerCase().includes(n)) return false
      const eq = (k: string, v: string | null) => { const f = fSel[k]; if (!f) return true; if (f === EMPTY) return !v; return v === f }
      if (!eq('company', p.company_name) || !eq('base', p.farm_base_name) || !eq('crop', p.crop_name) || !eq('potential', p.potential_name) || !eq('tillage', p.tillage_name)) return false
      const a = p.planted_area_da ?? 0
      if (fArea.min && a < Number(fArea.min.replace(',', '.'))) return false
      if (fArea.max && a > Number(fArea.max.replace(',', '.'))) return false
      for (const s of STAGES) {
        const f = fSel[s.key]; if (!f) continue
        const items = (assignsByPlanting.get(p.planting_id) ?? []).filter((x) => x.stage === s.key)
        if (f === EMPTY) { if (items.length > 0) return false }
        else if (f === ANY) { if (items.length === 0) return false }
        else if (!items.some((x) => x.prz_product_id === f)) return false
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
        case 'tillage': return p.tillage_name ?? ''
        default: return p.field_name
      }
    }
    list.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'bg')) * dir
    })
    return list
  }, [plantings, q, fSel, fArea, sort, assignsByPlanting])

  const activeFilters = (q ? 1 : 0) + Object.values(fSel).filter(Boolean).length + (fArea.min || fArea.max ? 1 : 0)
  const clearFilters = () => { setQ(''); setFSel({}); setFArea({ min: '', max: '' }) }
  const setF = (k: string, v: string) => setFSel((s) => ({ ...s, [k]: v }))
  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: string) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '')

  // ── избор (отметки, цял списък, диапазон със Shift) ──
  const selected = useMemo(() => plantings.filter((p) => sel.has(p.planting_id)), [plantings, sel])
  const selArea = selected.reduce((s, p) => s + (p.planted_area_da ?? 0), 0)
  const selCropIds = useMemo(() => Array.from(new Set(selected.map((p) => p.crop_id))), [selected])
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

  // ── търсене на продукт ──
  const typeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const p of products) for (const g of p.function_groups ?? []) set.add(g)
    return Array.from(set).sort((a, b) => (FUNC_LABEL[a] ?? a).localeCompare(FUNC_LABEL[b] ?? b, 'bg'))
  }, [products])

  const results = useMemo(() => {
    const tokens = norm(pq).split(' ').filter(Boolean)
    const cover = (p: Product) => selCropIds.filter((c) => isRegistered(p.prz_product_id, c)).length
    const list = products.filter((p) => {
      if (typeF && !(p.function_groups ?? []).includes(typeF)) return false
      if (tokens.length && !tokens.every((t) => (hay.get(p.prz_product_id) ?? '').includes(t))) return false
      if (onlyReg && selCropIds.length > 0 && p.source !== 'own' && cover(p) === 0) return false
      return true
    })
    list.sort((a, b) => cover(b) - cover(a) || a.trade_name.localeCompare(b.trade_name, 'bg'))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, typeF, pq, onlyReg, selCropIds, hay, usesMap])

  const chosenProduct = chosen ? prodById.get(chosen) : undefined

  function chooseProduct(p: Product) {
    setChosen(p.prz_product_id)
    // единица и доза по подразбиране от регистъра за първата избрана култура, която има данни
    for (const c of selCropIds) {
      const list = (usesMap.get(`${p.prz_product_id}|${c}`) ?? []).filter((u) => isDoseUnit(u.dose_unit) && u.dose_max != null)
      if (list.length > 0) {
        const u = list[0].dose_unit as DoseUnit
        setUnit(u)
        const lo = Math.min(...list.filter((x) => x.dose_unit === u).map((x) => x.dose_min ?? (x.dose_max as number)))
        const hi = Math.max(...list.filter((x) => x.dose_unit === u).map((x) => x.dose_max as number))
        setDose(lo === hi ? String(lo) : '')
        return
      }
    }
    setDose('')
  }

  // подсказка за дозата по култура
  const regHints = useMemo(() => {
    if (!chosenProduct) return []
    return selCropIds.map((c) => {
      const cropName = plantings.find((p) => p.crop_id === c)?.crop_name ?? ''
      const list = (usesMap.get(`${chosenProduct.prz_product_id}|${c}`) ?? []).filter((u) => isDoseUnit(u.dose_unit) && u.dose_max != null)
      const parts = Array.from(new Set(list.map((u) => {
        const lo = u.dose_min ?? (u.dose_max as number)
        return `${lo === u.dose_max ? fmtDose(lo) : `${fmtDose(lo)}–${fmtDose(u.dose_max as number)}`} ${UNIT_LABEL[u.dose_unit as DoseUnit]}`
      })))
      const r = regFor(chosenProduct.prz_product_id, c, familyOf(unit))
      return { cropName, registered: isRegistered(chosenProduct.prz_product_id, c), parts, phi: r.phi, apps: r.apps }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenProduct, selCropIds, plantings, usesMap, unit])

  // преглед на назначението
  const preview = useMemo(() => {
    const d = Number(dose.replace(',', '.'))
    if (!chosenProduct || !(d > 0)) return null
    let area = 0, over = 0, unreg = 0, overwrite = 0
    const targets = selected.filter((p) => (p.planted_area_da ?? 0) > 0)
    for (const p of targets) {
      area += p.planted_area_da ?? 0
      const reg = chosenProduct.source === 'own' ? true : isRegistered(chosenProduct.prz_product_id, p.crop_id)
      if (!reg) unreg++
      else if (chosenProduct.source !== 'own') {
        const r = regFor(chosenProduct.prz_product_id, p.crop_id, familyOf(unit))
        if (r.maxN != null && toNorm(d, unit) > r.maxN + 0.0001) over++
      }
      if ((assignsByPlanting.get(p.planting_id) ?? []).some((x) => x.stage === stage && x.prz_product_id === chosenProduct.prz_product_id)) overwrite++
    }
    const qty = (toNorm(d, unit) * area) / 1000
    return { d, count: targets.length, skipped: selected.length - targets.length, area, qty, qtyUnit: familyOf(unit) === 'vol' ? 'л' : 'кг', over, unreg, overwrite }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenProduct, dose, unit, stage, selected, assignsByPlanting, usesMap])

  function openAssign() {
    setMsg(null); setError(null)
    setChosen(''); setDose(''); setPq(''); setTypeF(''); setLimit(40)
    setAssignOpen(true)
  }

  async function doAssign() {
    if (!chosenProduct || !preview) return
    setBusy(true); setMsg(null); setError(null)
    const rows = selected.filter((p) => (p.planted_area_da ?? 0) > 0).map((p) => ({
      organization_id: p.organization_id,
      planting_id: p.planting_id,
      prz_product_id: chosenProduct.prz_product_id,
      stage,
      dose_per_da: preview.d,
      dose_unit: unit,
      area_da: p.planted_area_da,
    }))
    for (const part of chunks(rows, 200)) {
      const r = await supabase.from('planting_prz').upsert(part, { onConflict: 'planting_id,stage,prz_product_id' })
      if (r.error) { setError(r.error.message); setBusy(false); return }
    }
    setMsg(`„${chosenProduct.trade_name}“ е назначен в етап „${STAGE_LABEL[stage]}“ за ${rows.length} БЗС.`)
    setAssignOpen(false)
    setSel(new Set())
    await load()
    setBusy(false)
  }

  // ── премахване ──
  const rmCandidates = useMemo(() => {
    const ids = new Set(selected.map((p) => p.planting_id))
    const set = new Set<string>()
    for (const a of assigns) if (ids.has(a.planting_id) && (rmStage === 'all' || a.stage === rmStage)) set.add(a.prz_product_id)
    return Array.from(set).map((id) => ({ id, name: prodById.get(id)?.trade_name ?? id })).sort((a, b) => a.name.localeCompare(b.name, 'bg'))
  }, [selected, assigns, rmStage, prodById])
  const rmCount = useMemo(() => {
    const ids = new Set(selected.map((p) => p.planting_id))
    return assigns.filter((a) => ids.has(a.planting_id) && (rmStage === 'all' || a.stage === rmStage) && (rmProduct === 'all' || a.prz_product_id === rmProduct)).length
  }, [selected, assigns, rmStage, rmProduct])

  async function doRemove() {
    setBusy(true); setMsg(null); setError(null)
    for (const part of chunks(selected.map((p) => p.planting_id), 100)) {
      let qd = supabase.from('planting_prz').delete().in('planting_id', part)
      if (rmStage !== 'all') qd = qd.eq('stage', rmStage)
      if (rmProduct !== 'all') qd = qd.eq('prz_product_id', rmProduct)
      const r = await qd
      if (r.error) { setError(r.error.message); setBusy(false); return }
    }
    setMsg(`Премахнати назначения: ${rmCount}.`)
    setRmOpen(false); setSel(new Set())
    await load()
    setBusy(false)
  }

  // ── суми за показаните БЗС ──
  const totals = useMemo(() => {
    let area = 0
    for (const p of view) area += p.planted_area_da ?? 0
    return { area }
  }, [view])

  const summary = useMemo(() => {
    const ids = new Set(view.map((p) => p.planting_id))
    const m = new Map<string, { stage: Stage; id: string; area: number; qty: number; fam: 'vol' | 'mass'; n: number }>()
    for (const a of assigns) {
      if (!ids.has(a.planting_id)) continue
      const fam = familyOf(a.dose_unit)
      const k = `${a.stage}|${a.prz_product_id}|${fam}`
      const cur = m.get(k) ?? { stage: a.stage, id: a.prz_product_id, area: 0, qty: 0, fam, n: 0 }
      cur.area += a.area_da; cur.qty += qtyOf(a); cur.n += 1
      m.set(k, cur)
    }
    const order = new Map(STAGES.map((s, i) => [s.key, i]))
    return Array.from(m.values()).sort((a, b) => (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0) ||
      (prodById.get(a.id)?.trade_name ?? '').localeCompare(prodById.get(b.id)?.trade_name ?? '', 'bg'))
  }, [view, assigns, prodById])

  const pickerItems = [...[
    { key: 'company', label: 'Фирма' },
    { key: 'base', label: 'Стопанска база' },
    { key: 'crop', label: 'Култура' },
    { key: 'area', label: 'Площ, дка' },
    { key: 'potential', label: 'Потенциал' },
    { key: 'tillage', label: 'Почвообработка' }
  ], ...STAGES.map((s) => ({ key: s.key, label: s.short }))]
  const COLS = 2 + pickerItems.filter((i) => vis(i.key)).length

  // ───────────────────────── изглед ─────────────────────────
  return (
    <>
      <div className="page-head">
        <h1>Планиране на ПРЗ</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${view.length} от ${plantings.length} БЗС · ${fmtArea(totals.area)} дка`}</span>
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
          <strong>Избрани: {selected.length} БЗС · {fmtArea(selArea)} дка{selCropIds.length > 1 ? ` · ${selCropIds.length} култури` : ''}</strong>
          <div className="filters">
            <button className="btn" onClick={openAssign}>Назначи ПРЗ…</button>
            <button className="btn outline" onClick={() => { setRmStage('all'); setRmProduct('all'); setRmOpen(true) }}>Премахни назначения…</button>
            <button className="btn outline" onClick={() => setSel(new Set())}>Откажи избора</button>
          </div>
          <span className="muted">Съвет: Shift + клик избира диапазон. Филтрирай по култура и база, после „избери всички показани“ от отметката в заглавието.</span>
        </div>
      )}

      <div className="card">
        <table className="grid" style={{ minWidth: 1700 }}>
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
              {STAGES.filter((s) => vis(s.key)).map((s) => <th key={s.key}>{s.short}</th>)}
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
              {(['potential', 'tillage'] as const).filter((k) => vis(k)).map((k) => (
                <th key={k}>
                  <select className="input fi" value={fSel[k] ?? ''} onChange={(e) => setF(k, e.target.value)} aria-label={`Филтър ${k}`}>
                    <option value="">Всички</option><option value={EMPTY}>— празно —</option>
                    {opts[k].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </th>
              ))}
              {STAGES.filter((s) => vis(s.key)).map((s) => (
                <th key={s.key}>
                  <select className="input fi" value={fSel[s.key] ?? ''} onChange={(e) => setF(s.key, e.target.value)} aria-label={`Филтър ${s.short}`}>
                    <option value="">Всички</option><option value={EMPTY}>— няма —</option><option value={ANY}>— има —</option>
                    {opts[s.key].map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((p, idx) => {
              const items = assignsByPlanting.get(p.planting_id) ?? []
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
                  {vis('tillage') && <td>{p.tillage_name ?? <span className="empty">—</span>}</td>}
                  {STAGES.filter((s) => vis(s.key)).map((s) => {
                    const cell = items.filter((a) => a.stage === s.key)
                    return (
                      <td key={s.key} style={{ whiteSpace: 'normal', minWidth: 170 }}>
                        {cell.length === 0 ? <span className="empty">—</span> : cell.map((a) => {
                          const issue = issueOf(a)
                          return (
                            <div key={a.planting_prz_id} style={{ marginBottom: 2 }}>
                              <span className={`chip ${issue ? 'warn' : ''}`} title={issue ?? undefined}>
                                {prodById.get(a.prz_product_id)?.trade_name ?? '?'} · {fmtDose(a.dose_per_da)} {UNIT_LABEL[a.dose_unit]}{issue ? ' ⚠' : ''}
                              </span>
                            </div>
                          )
                        })}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={COLS} className="empty">Няма БЗС по тези филтри.</td></tr>}
          </tbody>
        </table>
      </div>

      <details className="card pad">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Потребност за показаните БЗС ({summary.length} реда)</summary>
        {summary.length === 0 ? <p className="muted">Още няма назначени продукти за показаните БЗС.</p> : (
          <table className="grid narrow" style={{ marginTop: 12 }}>
            <thead><tr><th>Етап</th><th>Продукт</th><th className="num">БЗС</th><th className="num">Площ, дка</th><th className="num">Количество</th></tr></thead>
            <tbody>
              {summary.map((s, i) => (
                <Fragment key={i}>
                  <tr>
                    <td>{STAGE_LABEL[s.stage]}</td>
                    <td>{prodById.get(s.id)?.trade_name ?? '?'}</td>
                    <td className="num">{s.n}</td>
                    <td className="num">{fmtArea(s.area)}</td>
                    <td className="num">{fmtArea(s.qty)} {s.fam === 'vol' ? 'л' : 'кг'}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </details>

      {/* ───── Назначи ПРЗ ───── */}
      {assignOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Назначи ПРЗ" onClick={() => !busy && setAssignOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="page-head">
              <h2>Назначи ПРЗ на {selected.length} БЗС · {fmtArea(selArea)} дка</h2>
              <button className="btn outline" onClick={() => setAssignOpen(false)} disabled={busy}>Затвори</button>
            </div>

            <div className="filters">
              <label className="field">Етап
                <select className="input" value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
                  {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
              <label className="field">Тип продукт
                <select className="input" value={typeF} onChange={(e) => { setTypeF(e.target.value); setLimit(40) }}>
                  <option value="">Всички</option>
                  {typeOptions.map((t) => <option key={t} value={t}>{FUNC_LABEL[t] ?? t}</option>)}
                </select>
              </label>
              <label className="field grow">Търсене (име, активно вещество, притежател)
                <input className="input" type="search" autoFocus value={pq} onChange={(e) => { setPq(e.target.value); setLimit(40) }} />
              </label>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
                <input type="checkbox" checked={onlyReg} onChange={(e) => setOnlyReg(e.target.checked)} /> Само разрешени за избраните култури
              </label>
            </div>

            <div className="modal-list">
              <table className="grid narrow">
                <thead><tr><th style={{ width: 28 }} /><th>Продукт</th><th>Тип</th><th>Активно вещество</th><th>За избраните култури</th></tr></thead>
                <tbody>
                  {results.slice(0, limit).map((p) => {
                    const cov = selCropIds.filter((c) => isRegistered(p.prz_product_id, c)).length
                    const own = p.source === 'own'
                    return (
                      <tr key={p.prz_product_id} className={`row ${chosen === p.prz_product_id ? 'open' : ''}`} onClick={() => chooseProduct(p)}>
                        <td><input type="radio" name="prz-product" checked={chosen === p.prz_product_id} onChange={() => chooseProduct(p)} aria-label={p.trade_name} /></td>
                        <td><span className="name">{p.trade_name}</span></td>
                        <td>{(p.function_groups ?? []).map((g) => FUNC_LABEL[g] ?? g).join(', ')}</td>
                        <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{p.active_substances ?? <span className="empty">—</span>}</td>
                        <td>{own ? <span className="chip">собствен</span> : <span className={`chip ${cov === selCropIds.length ? 'ok' : cov === 0 ? 'warn' : ''}`}>{cov}/{selCropIds.length} култури</span>}</td>
                      </tr>
                    )
                  })}
                  {results.length === 0 && <tr><td colSpan={5} className="empty">Няма продукти по това търсене{onlyReg ? ' (опитай без „Само разрешени“)' : ''}.</td></tr>}
                </tbody>
              </table>
              {results.length > limit && <button className="btn outline" onClick={() => setLimit(limit + 60)}>Покажи още ({results.length - limit})</button>}
            </div>

            {chosenProduct && (
              <div className="card pad" style={{ borderColor: 'var(--accent)' }}>
                <strong>{chosenProduct.trade_name}</strong>
                <span className="muted"> · {STAGE_LABEL[stage]}</span>
                <div className="filters" style={{ marginTop: 8 }}>
                  <label className="field">Доза на декар
                    <input className="input num" inputMode="decimal" value={dose} onChange={(e) => setDose(e.target.value.replace(',', '.'))} />
                  </label>
                  <label className="field">Единица
                    <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as DoseUnit)}>
                      {UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
                    </select>
                  </label>
                </div>
                {regHints.length > 0 && (
                  <div className="muted" style={{ marginBottom: 8 }}>
                    {chosenProduct.source === 'own' ? 'Собствен продукт (не е от регистъра на БАБХ).' : regHints.map((h) => (
                      <div key={h.cropName}>
                        {cropLabel(h.cropName)}: {h.registered ? <>по регистър {h.parts.length ? h.parts.join('; ') : 'без разчетена доза'}{h.phi != null ? ` · карантина ${h.phi} дни` : ''}{h.apps != null ? ` · до ${h.apps} третирания` : ''}</> : <strong style={{ color: 'var(--warn-ink)' }}>не е разрешен за тази култура</strong>}
                      </div>
                    ))}
                  </div>
                )}
                {preview ? (
                  <div>
                    <div>Общо за {preview.count} БЗС: <strong>{fmtArea(preview.qty)} {preview.qtyUnit}</strong> на {fmtArea(preview.area)} дка
                      {preview.skipped > 0 ? ` · ${preview.skipped} без засета площ ще се пропуснат` : ''}</div>
                    {preview.unreg > 0 && <div className="chip warn" style={{ marginTop: 6 }}>Не е разрешен за {preview.unreg} от избраните БЗС (култура извън регистъра)</div>}
                    {preview.over > 0 && <div className="chip warn" style={{ marginTop: 6 }}>Дозата е над разрешената за {preview.over} БЗС</div>}
                    {preview.overwrite > 0 && <div className="muted" style={{ marginTop: 6 }}>За {preview.overwrite} БЗС този продукт вече е в етапа и дозата ще се презапише.</div>}
                  </div>
                ) : <div className="muted">Въведи доза, за да видиш количествата.</div>}
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
                  {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
              <label className="field grow">Продукт
                <select className="input" value={rmProduct} onChange={(e) => setRmProduct(e.target.value)}>
                  <option value="all">Всички продукти</option>
                  {rmCandidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            <div className="muted">Ще се премахнат {fmtInt(rmCount)} назначения. Действието не може да се върне.</div>
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

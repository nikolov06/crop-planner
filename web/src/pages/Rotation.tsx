import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, fmtRate, cropColor, cropLabel } from '../lib/format'
import { ColumnPicker, useHiddenCols } from '../lib/columns'
import { MultiFilter, anyToken } from '../lib/multifilter'
import { BulkModal, FieldAddModal, FieldDeleteModal, FieldEditModal } from './RotationEdit'
import { INLINE_COLS, InlineArea, InlineCrop, InlineName, InlineTillage, useInlineEdit, type InlineKey, type RowPatch } from './RotationInline'

type SeedRow = { variety: string | null; reproduction: string | null; area_da: number | null; rate: number | null; rate_basis: string | null; origin: string | null; kg_da?: number | null }
type AliasRow = { name: string; isak_number: string | null; area_da: number | null }
type Row = {
  field_id: string
  planting_id?: string | null
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

type ColKey = 'field_name' | 'company' | 'base' | 'area' | 'crop' | 'p1' | 'p2' | 'p3' | 'p4' | 'potential' | 'tillage' | 'variety' | 'repro' | 'rate' | 'rate2'
type Kind = 'text' | 'select' | 'num' | 'none'
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
  { key: 'rate2', kind: 'none', num: true },
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
// втора норма: кг/дка (слети култури, по партида) или семена на хектар (редови култури: семена/дка × 10)
function seedRate2(s: SeedRow | undefined): { v: number; text: string } | null {
  if (!s || s.rate == null) return null
  if (s.rate_basis === 'seeds_da') return { v: s.rate * 10, text: `${fmtInt(s.rate * 10)} сем./ха` }
  if (s.kg_da != null) return { v: s.kg_da, text: `${fmtArea(s.kg_da)} кг/дка` }
  return null
}
const numVal = (r: Row, k: 'area' | 'rate' | 'rate2'): number | null =>
  k === 'area' ? r.area_da : k === 'rate' ? ((r.seeds ?? []).find((s) => s.rate != null)?.rate ?? null) : (seedRate2((r.seeds ?? [])[0])?.v ?? null)

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
  // търсене от адреса (#/rotation?q=…), напр. от „Отвори в Сеитбооборот“ в картата
  const [q, setQ] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q') ?? '')
  const [sel, setSel] = useState<Record<string, string>>({})          // текст/избор по колона
  const [rng, setRng] = useState<Record<string, { min: string; max: string }>>({})  // площ, норма
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 }>({ key: 'field_name', dir: 1 })
  const [openId, setOpenId] = useState<string | null>(null)
  const colPrefs = useHiddenCols('rotation')
  const [reloadKey, setReloadKey] = useState(0)
  const [modal, setModal] = useState<null | { kind: 'add' } | { kind: 'edit' | 'del'; id: string; name: string }>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [flashErr, setFlashErr] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [unlocked, setUnlocked] = useState<Set<InlineKey>>(new Set())
  const [lockOpen, setLockOpen] = useState(false)
  const patchRow = (id: string, p: RowPatch) => setRows((rs) => rs.map((x) => (x.field_id === id ? { ...x, ...p } as Row : x)))
  const ie = useInlineEdit(unlocked.size > 0, patchRow, (m, isErr) => { setFlash(m); setFlashErr(isErr) })
  const unl = (k: InlineKey) => unlocked.has(k) && ie.ready
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const done = (m: string) => { setModal(null); setBulkOpen(false); setPicked(new Set()); setFlashErr(false); setFlash(m); setLoading(true); setReloadKey((k) => k + 1) }

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
        const { data: season } = await supabase.from('season').select('year_end,season_id').eq('is_current', true).limit(1)
        const ye = season?.[0]?.year_end
        const extra = new Map<string, { potential: string | null; tillage: string | null }>()
        const pl2field = new Map<string, string>()
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase.from('v_planting_context')
            .select('planting_id,field_id,potential_name,tillage_name')
            .eq('season_year_end', ye).eq('role', 'main').order('planting_id').range(from, from + PAGE - 1)
          if (error) throw new Error(error.message)
          for (const x of (data ?? []) as { planting_id: string; field_id: string; potential_name: string | null; tillage_name: string | null }[]) {
            extra.set(x.field_id, { potential: x.potential_name, tillage: x.tillage_name })
            pl2field.set(x.planting_id, x.field_id)
          }
          if (!data || data.length < PAGE) break
        }
        // втора почвообработка (ако миграцията е приложена; иначе се пропуска)
        try {
          const t2 = await supabase.from('field_planting').select('planting_id,tillage2_id').not('tillage2_id', 'is', null).limit(5000)
          const tn = await supabase.from('tillage_type').select('tillage_id,name_bg')
          if (!t2.error && !tn.error) {
            const nm = new Map((tn.data ?? []).map((x: { tillage_id: number; name_bg: string }) => [x.tillage_id, x.name_bg]))
            for (const x of (t2.data ?? []) as { planting_id: string; tillage2_id: number }[]) {
              const fid = pl2field.get(x.planting_id); const e = fid ? extra.get(fid) : undefined
              if (e && e.tillage && nm.get(x.tillage2_id)) e.tillage = `${e.tillage} + ${nm.get(x.tillage2_id)}`
            }
          }
        } catch { /* колоната още не съществува */ }
        // кг/дка за слетите култури – от изчислението на семената (по партида); ако липсва, колоната остава празна
        try {
          const sid = season?.[0]?.season_id
          const [calc, vars] = await Promise.all([
            supabase.from('v_seed_calc').select('planting_id,variety_id,rate_kg_da').eq('season_id', sid).not('rate_kg_da', 'is', null).limit(20000),
            supabase.from('variety').select('variety_id,name').limit(5000),
          ])
          if (!calc.error && !vars.error) {
            const vn = new Map((vars.data ?? []).map((v: { variety_id: string; name: string }) => [v.variety_id, v.name]))
            const kg = new Map<string, number>()
            for (const c of (calc.data ?? []) as { planting_id: string; variety_id: string; rate_kg_da: number }[]) kg.set(`${c.planting_id}|${vn.get(c.variety_id)}`, c.rate_kg_da)
            for (const r of all) for (const sd of r.seeds ?? []) sd.kg_da = kg.get(`${r.planting_id}|${sd.variety}`) ?? null
          }
        } catch { /* без кг/дка */ }
        for (const r of all) { const e = extra.get(r.field_id); r.potential = e?.potential ?? null; r.tillage = e?.tillage ?? null }
        if (!cancelled) setRows(all)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [reloadKey])

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
          const v = numVal(r, c.key as 'area' | 'rate' | 'rate2')
          if (v == null) return false
          if (f.min && v < Number(f.min.replace(',', '.'))) return false
          if (f.max && v > Number(f.max.replace(',', '.'))) return false
          continue
        }
        const f = sel[c.key]; if (!f) continue
        if (c.kind === 'text') { if (!textVal(r, c.key).toLowerCase().includes(f.toLowerCase())) return false; continue }
        if (c.key === 'variety' || c.key === 'repro') {
          const vs = seedVals(r, c.key)
          if (!anyToken(f, (t) => (t === EMPTY ? vs.length === 0 : vs.includes(t)))) return false
          continue
        }
        const v = textVal(r, c.key)
        if (!anyToken(f, (t) => (t === EMPTY ? v === '' : v === t))) return false
      }
      return true
    })
    const { key, dir } = sort
    const col = COLS.find((c) => c.key === key)!
    list.sort((a, b) => {
      if (col.kind === 'num' || col.kind === 'none') return ((numVal(a, key as 'area' | 'rate' | 'rate2') ?? -1) - (numVal(b, key as 'area' | 'rate' | 'rate2') ?? -1)) * dir
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
    potential: 'Потенциал', tillage: 'Почвообработка', variety: 'Сорт / хибрид', repro: 'Размножение', rate: 'Сеитбена норма', rate2: 'кг/дка · сем./ха',
  }
  const cropKeys: ColKey[] = ['crop', 'p1', 'p2', 'p3', 'p4']
  const shownCols = COLS.filter((c) => c.key === 'field_name' || colPrefs.vis(c.key))
  const vis = (k: ColKey) => colPrefs.vis(k)

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
        <span style={{ position: 'relative' }}>
          <button className={unlocked.size ? 'btn' : 'btn outline'} onClick={() => setLockOpen((o) => !o)} aria-expanded={lockOpen}>{unlocked.size ? `🔓 Редакция в таблицата (${unlocked.size})` : '🔒 Редакция в таблицата'}</button>
          {lockOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setLockOpen(false)} />
              <div className="card" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 41, padding: 12, minWidth: 260, display: 'grid', gap: 6 }} role="dialog" aria-label="Отключване на колони за редакция">
                <strong>Отключи колони за редакция</strong>
                {INLINE_COLS.map((c) => (
                  <label key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={unlocked.has(c.key)} onChange={() => setUnlocked((u) => { const n = new Set(u); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n })} /> {c.label}
                  </label>
                ))}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn outline" onClick={() => setUnlocked(new Set(INLINE_COLS.map((c) => c.key)))}>Всички</button>
                  <button className="btn outline" onClick={() => setUnlocked(new Set())} disabled={!unlocked.size}>Заключи всички</button>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>Промените се записват веднага, клетка по клетка. Смяна на култура изтрива сортовете за сезона (с потвърждение).</span>
              </div>
            </>
          )}
        </span>
        <button className="btn" onClick={() => setModal({ kind: 'add' })}>+ Ново БЗС</button>
      </div>
      {unlocked.size > 0 && !ie.ready && !ie.loadErr && <div className="banner">Зареждане на данните за редакция…</div>}
      {ie.loadErr && <div className="banner err" role="alert">Редакцията не е достъпна: {ie.loadErr}</div>}
      {flash && <div className={flashErr ? 'banner err' : 'banner'} role={flashErr ? 'alert' : 'status'} onClick={() => setFlash(null)}>{flash}</div>}
      {picked.size > 0 && (
        <div className="banner" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>Избрани: {picked.size} БЗС · {fmtArea(rows.filter((x) => picked.has(x.field_id)).reduce((a, x) => a + (x.area_da ?? 0), 0))} дка</strong>
          <button className="btn" onClick={() => setBulkOpen(true)}>Промени култура / почвообработка…</button>
          <button className="btn outline" onClick={() => setPicked(new Set())}>Изчисти избора</button>
        </div>
      )}
      {bulkOpen && <BulkModal fieldIds={Array.from(picked)} onClose={() => setBulkOpen(false)} onDone={done} />}
      {modal?.kind === 'add' && <FieldAddModal onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'edit' && <FieldEditModal fieldId={modal.id} fieldName={modal.name} onClose={() => setModal(null)} onDone={done} onDelete={() => setModal({ kind: 'del', id: modal.id, name: modal.name })} />}
      {modal?.kind === 'del' && <FieldDeleteModal fieldId={modal.id} fieldName={modal.name} onClose={() => setModal(null)} onDone={done} />}

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 34 }}><input type="checkbox" aria-label="Избери всички показани" checked={view.length > 0 && view.every((x) => picked.has(x.field_id))}
                onChange={() => setPicked((p) => { const n = new Set(p); if (view.length > 0 && view.every((x) => n.has(x.field_id))) view.forEach((x) => n.delete(x.field_id)); else view.forEach((x) => n.add(x.field_id)); return n })} /></th>
              {shownCols.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''}>
                  <button onClick={() => toggleSort(c.key)}>{label[c.key]} {arrow(c.key)}</button>
                  {c.key === 'field_name' && (
                    <ColumnPicker items={COLS.filter((x) => x.key !== 'field_name').map((x) => ({ key: x.key, label: label[x.key] }))}
                      hidden={colPrefs.hidden} onToggle={colPrefs.toggle} onShowAll={colPrefs.showAll} />
                  )}
                </th>
              ))}
              <th aria-label="Действия" style={{ width: 44 }} />
            </tr>
            <tr className="filter-row">
              <th />
              {shownCols.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''}>
                  {c.kind === 'text' && (
                    <input className="input fi" placeholder="Филтър" value={sel[c.key] ?? ''} onChange={(e) => setSel({ ...sel, [c.key]: e.target.value })} aria-label={`Филтър ${label[c.key]}`} />
                  )}
                  {c.kind === 'select' && (
                    <MultiFilter value={sel[c.key] ?? ''} onChange={(v) => setSel({ ...sel, [c.key]: v })} ariaLabel={`Филтър ${label[c.key]}`}
                      specials={[{ value: EMPTY, label: '— празно —' }]}
                      options={(options[c.key] ?? []).map((v) => ({ value: v, label: cropKeys.includes(c.key) ? cropLabel(v) : v }))} />
                  )}
                  {c.kind === 'num' && (
                    <span className="range">
                      <input className="input fi" inputMode="decimal" placeholder="от" value={rng[c.key]?.min ?? ''} onChange={(e) => setRng({ ...rng, [c.key]: { min: e.target.value, max: rng[c.key]?.max ?? '' } })} aria-label={`${label[c.key]} от`} />
                      <input className="input fi" inputMode="decimal" placeholder="до" value={rng[c.key]?.max ?? ''} onChange={(e) => setRng({ ...rng, [c.key]: { min: rng[c.key]?.min ?? '', max: e.target.value } })} aria-label={`${label[c.key]} до`} />
                    </span>
                  )}
                </th>
              ))}
              <th />
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
                    <td onClick={stop}><input type="checkbox" aria-label={`Избери ${r.field_name}`} checked={picked.has(r.field_id)}
                      onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.field_id)) n.delete(r.field_id); else n.add(r.field_id); return n })} /></td>
                    <td>
                      <span className="name">
                        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        {unl('field_name') ? <span onClick={stop}><InlineName ie={ie} r={r} /></span> : r.field_name}
                      </span>
                    </td>
                    {vis('company') && (<td>{r.company_name ?? <span className="empty">—</span>}</td>)}
                    {vis('base') && (<td>{r.farm_base_name ?? <span className="empty">—</span>}</td>)}
                    {vis('area') && (<td className="num" onClick={unl('area') ? stop : undefined}>{unl('area') ? <InlineArea ie={ie} r={r} /> : fmtArea(r.area_da)}</td>)}
                    {vis('crop') && (<td onClick={unl('crop') ? stop : undefined}>{unl('crop') ? <InlineCrop ie={ie} r={r} off={0} /> : <><CropCell crop={r.crop} main />{(r.n_second_crops ?? 0) > 0 && <> <span className="chip">+{r.n_second_crops}</span></>}</>}</td>)}
                    {vis('p1') && (<td><CropCell crop={r.crop_prev1} /></td>)}
                    {vis('p2') && (<td><CropCell crop={r.crop_prev2} /></td>)}
                    {vis('p3') && (<td><CropCell crop={r.crop_prev3} /></td>)}
                    {vis('p4') && (<td><CropCell crop={r.crop_prev4} /></td>)}
                    {vis('potential') && (<td>{r.potential ?? <span className="empty">—</span>}</td>)}
                    {vis('tillage') && (<td onClick={unl('tillage') ? stop : undefined}>{unl('tillage') ? <InlineTillage ie={ie} r={r} /> : (r.tillage ?? <span className="empty">—</span>)}</td>)}
                    {vis('variety') && (<td>{s0?.variety ? <>{s0.variety}{seeds.length > 1 && <> <span className="chip">+{seeds.length - 1}</span></>}</> : <span className="empty">—</span>}</td>)}
                    {vis('repro') && (<td>{s0?.reproduction ?? <span className="empty">—</span>}</td>)}
                    {vis('rate') && (<td className="num">{s0?.rate != null ? fmtRate(s0.rate, s0.rate_basis) : <span className="empty">—</span>}</td>)}
                    {vis('rate2') && (<td className="num" title={s0 && s0.rate_basis !== 'seeds_da' && s0.kg_da == null ? 'Няма партида с мин. данни (МХЗ и кълняемост)' : undefined}>{seedRate2(s0)?.text ?? <span className="empty">—</span>}</td>)}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={stop}>
                      <button className="btn outline" style={{ minHeight: 28, padding: '0 7px' }} title="Редакция" aria-label={`Редакция ${r.field_name}`} onClick={() => setModal({ kind: 'edit', id: r.field_id, name: r.field_name })}>✎</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="detail">
                      <td colSpan={shownCols.length + 2}>
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
                              <table className="mini"><thead><tr><th>Сорт</th><th>Размн.</th><th className="num">Площ</th><th className="num">Норма</th><th className="num">кг/дка · сем./ха</th><th>Произход</th></tr></thead><tbody>
                                {seeds.map((s, i) => (
                                  <tr key={i}><td>{s.variety ?? '—'}</td><td>{s.reproduction ?? '—'}</td><td className="num">{fmtArea(s.area_da)}</td><td className="num">{s.rate != null ? fmtRate(s.rate, s.rate_basis) : '—'}</td><td className="num">{seedRate2(s)?.text ?? '—'}</td><td>{s.origin ?? '—'}</td></tr>
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
              <tr><td colSpan={shownCols.length + 2} className="empty">Няма полета по тези филтри.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

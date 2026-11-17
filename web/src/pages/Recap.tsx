import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, cropLabel } from '../lib/format'
import { downloadXlsx } from '../lib/xlsx'
import { MultiFilter, anyToken } from '../lib/multifilter'
import { fmtEuro, priceText, unitLabel, type Unit } from '../lib/prices'

// Рекапитулация на количества и стойност за ПРЗ или торове по сезон: по продукт, култура, стопанска база и етап.
export type Module = 'prz' | 'fert'
type Season = { season_id: number; label: string; is_current: boolean }
type Row = {
  planting_id: string; crop: string; base: string; stage: string; productId: string; product: string
  area: number; qty: number; qtyUnit: string; tons: number | null
  supplier: string | null; price: number | null; priceUnit: Unit | null; cost: number | null
}
type Group = 'product' | 'crop' | 'base' | 'stage'
const GROUPS: { key: Group; label: string }[] = [
  { key: 'product', label: 'По продукт' }, { key: 'crop', label: 'По култура' }, { key: 'base', label: 'По стопанска база' }, { key: 'stage', label: 'По етап' },
]
const PRZ_STAGE: Record<string, string> = { t1: 'Т1', t2: 'Т2', corrective: 'Коригиращо', total_herbicide_pre: 'Тотален хербицид преди поникване' }
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
const n2 = (v: number) => v.toLocaleString('bg-BG', { maximumFractionDigits: 2 })

export default function Recap({ module }: { module: Module }) {
  const isPrz = module === 'prz'
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonId, setSeasonId] = useState<number | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [group, setGroup] = useState<Group>('product')
  const [fBase, setFBase] = useState('')
  const [fCrop, setFCrop] = useState('')

  useEffect(() => {
    let off = false
    supabase.from('season').select('season_id,label,is_current').order('year_end', { ascending: false }).then((r: { data: Season[] | null; error: { message: string } | null }) => {
      if (off) return
      if (r.error) return setError(r.error.message)
      const list = r.data ?? []
      setSeasons(list); setSeasonId((c) => c ?? list.find((x) => x.is_current)?.season_id ?? list[0]?.season_id ?? null)
    })
    return () => { off = true }
  }, [])

  useEffect(() => {
    if (seasonId == null) return
    let off = false
    setLoading(true)
    ;(async () => {
      try {
        let out: Row[]
        if (isPrz) {
          const d = await fetchAll<Record<string, unknown>>((f, t) => supabase.from('v_prz_cost')
            .select('planting_prz_id,planting_id,crop_name,farm_base_name,stage,prz_product_id,trade_name,area_da,qty_total,qty_unit,supplier_name,price,price_unit,cost_eur,price_unit_mismatch')
            .eq('season_id', seasonId).order('planting_prz_id').range(f, t))
          out = d.map((x) => ({
            planting_id: String(x.planting_id), crop: String(x.crop_name ?? ''), base: String(x.farm_base_name ?? '—'), stage: PRZ_STAGE[String(x.stage)] ?? String(x.stage),
            productId: String(x.prz_product_id), product: String(x.trade_name ?? '?'), area: Number(x.area_da), qty: Number(x.qty_total), qtyUnit: x.qty_unit === 'kg' ? 'кг' : 'л', tons: null,
            supplier: (x.supplier_name as string) ?? null, price: x.price == null ? null : Number(x.price), priceUnit: (x.price_unit as Unit) ?? null, cost: x.cost_eur == null ? null : Number(x.cost_eur),
          }))
        } else {
          const st = await supabase.from('fertilization_stage').select('stage_id,name_bg')
          const stn = new Map<number, string>(((st.data ?? []) as { stage_id: number; name_bg: string }[]).map((s) => [s.stage_id, s.name_bg] as [number, string]))
          const d = await fetchAll<Record<string, unknown>>((f, t) => supabase.from('v_fert_cost')
            .select('line_id,planting_id,crop_name,farm_base_name,stage_id,product_id,product_name,form,treated_area_da,quantity_native,quantity_t,supplier_name,price,price_unit,cost_eur')
            .eq('season_id', seasonId).order('line_id').range(f, t))
          out = d.map((x) => ({
            planting_id: String(x.planting_id), crop: String(x.crop_name ?? ''), base: String(x.farm_base_name ?? '—'), stage: stn.get(Number(x.stage_id)) ?? String(x.stage_id),
            productId: String(x.product_id), product: String(x.product_name ?? '?'), area: Number(x.treated_area_da ?? 0), qty: Number(x.quantity_native), qtyUnit: x.form === 'liquid' ? 'л' : 'кг',
            tons: x.quantity_t == null ? null : Number(x.quantity_t),
            supplier: (x.supplier_name as string) ?? null, price: x.price == null ? null : Number(x.price), priceUnit: (x.price_unit as Unit) ?? null, cost: x.cost_eur == null ? null : Number(x.cost_eur),
          }))
        }
        if (!off) { setRows(out); setError(null) }
      } catch (e) {
        if (!off) setError(/v_prz_cost|v_fert_cost|does not exist|relation/i.test((e as Error).message)
          ? 'Разходите още не са налични: миграцията за оферти не е приложена в базата.' : (e as Error).message)
      }
      if (!off) setLoading(false)
    })()
    return () => { off = true }
  }, [seasonId, isPrz])

  const bases = useMemo(() => Array.from(new Set(rows.map((r) => r.base))).sort((a, b) => a.localeCompare(b, 'bg')), [rows])
  const crops = useMemo(() => Array.from(new Set(rows.map((r) => r.crop))).sort((a, b) => a.localeCompare(b, 'bg')), [rows])
  const view = useMemo(() => rows.filter((r) => anyToken(fBase, (t) => r.base === t) && anyToken(fCrop, (t) => r.crop === t)), [rows, fBase, fCrop])

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; plantings: Set<string>; area: number; qty: Map<string, number>; tons: number; hasTons: boolean; cost: number; missing: number; stages: Set<string>; price: string; supplier: string }>()
    for (const r of view) {
      const label = group === 'product' ? r.product : group === 'crop' ? r.crop : group === 'base' ? r.base : r.stage
      const g = m.get(label) ?? { label, plantings: new Set(), area: 0, qty: new Map(), tons: 0, hasTons: false, cost: 0, missing: 0, stages: new Set(), price: '', supplier: '' }
      g.plantings.add(r.planting_id); g.area += r.area
      g.qty.set(r.qtyUnit, (g.qty.get(r.qtyUnit) ?? 0) + r.qty)
      if (r.tons != null) { g.tons += r.tons; g.hasTons = true }
      if (r.cost == null) g.missing += 1; else g.cost += r.cost
      g.stages.add(r.stage)
      if (group === 'product' && r.price != null && r.priceUnit) { g.price = priceText({ price: r.price, unit: r.priceUnit, supplier: r.supplier, offers: 1 }); g.supplier = r.supplier ?? '' }
      m.set(label, g)
    }
    return Array.from(m.values()).sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label, 'bg'))
  }, [view, group])

  const total = useMemo(() => {
    let cost = 0, area = 0, missing = 0
    const best = new Map<string, number>()
    const prodsAll = new Set<string>(), prodsPriced = new Set<string>()
    for (const r of view) {
      if (r.cost == null) missing += 1; else cost += r.cost
      best.set(r.planting_id, Math.max(best.get(r.planting_id) ?? 0, r.area))
      prodsAll.add(r.productId); if (r.price != null) prodsPriced.add(r.productId)
    }
    for (const v of best.values()) area += v
    return { cost, area, missing, prodsAll: prodsAll.size, prodsPriced: prodsPriced.size }
  }, [view])
  const maxCost = groups.reduce((a, g) => Math.max(a, g.cost), 0)
  const seasonLabel = seasons.find((s) => s.season_id === seasonId)?.label ?? ''
  const qtyText = (g: { qty: Map<string, number> }) => Array.from(g.qty.entries()).map(([u, v]) => `${n2(v)} ${u}`).join(' + ')

  function exportXlsx() {
    const head = [GROUPS.find((g) => g.key === group)?.label.replace('По ', '') ?? '', 'БЗС', 'Третирана площ, дка', 'Количество', ...(isPrz ? [] : ['Тонове']), 'Стойност, евро', 'Редове без цена']
    const out = groups.map((g) => [g.label, g.plantings.size, Math.round(g.area * 100) / 100, qtyText(g), ...(isPrz ? [] : [g.hasTons ? Math.round(g.tons * 100) / 100 : null]), Math.round(g.cost * 100) / 100, g.missing])
    out.push(['Общо', null, null, '', ...(isPrz ? [] : [null]), Math.round(total.cost * 100) / 100, total.missing])
    downloadXlsx(`Рекапитулация_${isPrz ? 'ПРЗ' : 'торове'}_${seasonLabel.replace('/', '-')}.xlsx`, 'Рекапитулация', head, out)
  }

  return (
    <>
      <div className="page-head">
        <h1>Рекапитулация · {isPrz ? 'ПРЗ' : 'торове'}</h1>
        <span className="muted">{loading ? 'Зареждане…' : `сезон ${seasonLabel} · ${view.length} реда`}</span>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}

      <div className="filters">
        <label className="field">Сезон
          <select className="input" value={seasonId ?? ''} onChange={(e) => setSeasonId(Number(e.target.value))}>
            {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текущ)' : ''}</option>)}
          </select>
        </label>
        <div className="field">Групиране
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {GROUPS.map((g) => <button key={g.key} className={group === g.key ? 'btn' : 'btn outline'} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>{g.label}</button>)}
          </div>
        </div>
        <label className="field">Култура
          <MultiFilter value={fCrop} onChange={setFCrop} ariaLabel="Култура" options={crops.map((c) => ({ value: c, label: cropLabel(c) }))} />
        </label>
        <label className="field">Стопанска база
          <MultiFilter value={fBase} onChange={setFBase} ariaLabel="Стопанска база" options={bases.map((b) => ({ value: b, label: b }))} />
        </label>
        <button className="btn outline" onClick={exportXlsx} disabled={groups.length === 0}>Експорт в Excel</button>
      </div>

      <div className="filters" style={{ alignItems: 'stretch' }}>
        <div className="card pad" style={{ flex: 1 }}><div className="muted">Обща стойност</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtEuro(total.cost)} евро</div>{total.missing > 0 && <div className="muted">без {total.missing} реда без цена</div>}</div>
        <div className="card pad" style={{ flex: 1 }}><div className="muted">Третирана площ</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtArea(total.area)} дка</div></div>
        <div className="card pad" style={{ flex: 1 }}><div className="muted">Средно на дка</div><div style={{ fontSize: 24, fontWeight: 700 }}>{total.area > 0 ? fmtEuro(total.cost / total.area) : '—'} евро</div></div>
        <div className="card pad" style={{ flex: 1 }}><div className="muted">Покритие с цени</div><div style={{ fontSize: 24, fontWeight: 700 }}>{total.prodsPriced} от {total.prodsAll} продукта</div>{total.prodsPriced < total.prodsAll && <div className="muted">добави оферти за останалите</div>}</div>
      </div>

      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>{GROUPS.find((g) => g.key === group)?.label.replace('По ', '').replace(/^./, (c) => c.toUpperCase())}</th>
              {group === 'product' && <th>Етап</th>}
              <th className="num">БЗС</th><th className="num">Третирана площ, дка</th><th className="num">Количество</th>
              {!isPrz && group === 'product' && <th className="num">Тонове</th>}
              {group === 'product' && <th>Доставчик · цена</th>}
              <th className="num">Стойност, евро</th><th style={{ width: 160 }}>Дял</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.label}>
                <td>{group === 'crop' ? cropLabel(g.label) : g.label}</td>
                {group === 'product' && <td>{Array.from(g.stages).join(', ')}</td>}
                <td className="num">{g.plantings.size}</td>
                <td className="num">{fmtArea(g.area)}</td>
                <td className="num">{group === 'product' || g.qty.size === 1 ? qtyText(g) : <span className="muted">различни мерни единици</span>}</td>
                {!isPrz && group === 'product' && <td className="num">{g.hasTons ? n2(g.tons) : <span className="empty">—</span>}</td>}
                {group === 'product' && <td>{g.price ? <>{g.price}{g.supplier && <span className="muted"> · {g.supplier}</span>}</> : <span className="chip warn">няма оферта</span>}</td>}
                <td className="num">{g.cost > 0 || g.missing === 0 ? fmtEuro(g.cost) : '—'}{g.missing > 0 && g.cost > 0 && <> <span className="chip warn" title={`${g.missing} реда без цена`}>непълна</span></>}</td>
                <td><div style={{ height: 10, background: 'var(--line, #eceee9)', borderRadius: 99, overflow: 'hidden', minWidth: 100 }}><div style={{ height: '100%', width: `${maxCost > 0 ? Math.max(2, Math.round((g.cost / maxCost) * 100)) : 0}%`, background: 'var(--accent, #2f5d48)' }} /></div></td>
              </tr>
            ))}
            {!loading && groups.length === 0 && <tr><td colSpan={9} className="empty">Още няма назначени {isPrz ? 'ПРЗ' : 'торове'} за този сезон.</td></tr>}
            {groups.length > 0 && (
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={group === 'product' ? 2 : 1}>Общо</td><td className="num" />
                <td className="num" /><td /> {!isPrz && group === 'product' && <td />}{group === 'product' && <td />}
                <td className="num">{fmtEuro(total.cost)}</td><td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">Цената е основната от офертите за сезона (иначе от приета оферта, иначе най-ниската). Мерните единици на цената се съпоставят с количеството: {isPrz ? 'л или кг' : `${unitLabel('t')}, ${unitLabel('kg')} или ${unitLabel('l')}`}.</p>
    </>
  )
}

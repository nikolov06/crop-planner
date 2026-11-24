// Рекапитулация / заявка за семена: База → Култура → Сорт.
// Фирмата е само филтър: заявката се закръгля за База × Сорт, независимо на коя фирма са БЗС-тата.
// Закръгляне (по заданието):
//   - на ниво БЗС: торби с 1 знак, тонове с 2 знака (както се виждат в Планиране);
//   - Сорт × База: торбите се сумират и закръглят НАГОРЕ до цяла торба („за заявка“),
//     тоновете се сумират с 2 знака без закръгляне нагоре;
//   - по-горните нива сумират закръглените количества (не се закръгля отново);
//   - стойността се смята от количеството „за заявка“.
import { round1, round2, seedCost, type QtyUnit, type SeedPrice } from './seedcalc.ts'

export type RecapInput = {
  /** само за филтъра; не влияе на закръглянето */
  company: string
  base: string
  crop: string
  varietyId: string
  variety: string
  unit: QtyUnit
  area: number
  /** норма за претеглената средна (сем./дка или кг/дка); null = не участва */
  rate: number | null
  rateUnit: string
  /** количество на БЗС без и с преразход (сурово – закръгля се тук) */
  need: number | null
  withOverage: number | null
}
export type Qty = { packs: number; t: number }
export type RecapNode = {
  level: 'base' | 'crop' | 'variety' | 'total'
  key: string
  label: string
  n: number
  area: number
  /** претеглена по площ норма (само на ниво култура и сорт) */
  avgRate: number | null
  rateUnit: string | null
  need: Qty
  withOverage: Qty
  order: Qty
  /** само на ниво сорт */
  unit?: QtyUnit
  price?: SeedPrice
  value: number | null
  /** има ред без цена или с несъвместима мерна единица */
  priceMissing: boolean
  unitMismatch: boolean
  missingQty: number
  children: RecapNode[]
}

const zero = (): Qty => ({ packs: 0, t: 0 })
const add = (a: Qty, b: Qty): Qty => ({ packs: round1(a.packs + b.packs), t: round2(a.t + b.t) })
const perUnit = (u: QtyUnit, v: number): Qty => (u === 'packs' ? { packs: v, t: 0 } : { packs: 0, t: v })
/** количеството на БЗС, както се вижда в Планиране */
export const shown = (u: QtyUnit, v: number | null) => (v == null ? null : u === 'packs' ? round1(v) : round2(v))
/** за заявка от сумата за Сорт × База */
export const orderQty = (u: QtyUnit, sum: number) => (u === 'packs' ? Math.ceil(round1(sum)) : round2(sum))

function leaf(rows: RecapInput[], price: SeedPrice | undefined): RecapNode {
  const r0 = rows[0]
  const u = r0.unit
  let need = 0, ov = 0, area = 0, wSum = 0, wArea = 0, missingQty = 0
  for (const r of rows) {
    area += r.area
    const n = shown(u, r.need), w = shown(u, r.withOverage)
    if (n == null || w == null) { missingQty++; continue }
    need += n; ov += w
    if (r.rate != null) { wSum += r.rate * r.area; wArea += r.area }
  }
  const ord = orderQty(u, ov)
  const cost = seedCost(ord, u, price)
  return {
    level: 'variety', key: r0.varietyId, label: r0.variety, n: rows.length, area,
    avgRate: wArea > 0 ? wSum / wArea : null, rateUnit: r0.rateUnit,
    need: perUnit(u, u === 'packs' ? round1(need) : round2(need)),
    withOverage: perUnit(u, u === 'packs' ? round1(ov) : round2(ov)),
    order: perUnit(u, ord), unit: u, price,
    value: cost.value == null ? null : round2(cost.value),
    priceMissing: !price || cost.value == null, unitMismatch: cost.mismatch, missingQty, children: [],
  }
}

function sumNodes(level: RecapNode['level'], key: string, label: string, kids: RecapNode[]): RecapNode {
  const node: RecapNode = {
    level, key, label, n: 0, area: 0, avgRate: null, rateUnit: null,
    need: zero(), withOverage: zero(), order: zero(), value: null, priceMissing: false, unitMismatch: false, missingQty: 0, children: kids,
  }
  let value = 0, anyValue = false, wSum = 0, wArea = 0
  const units = new Set<string>()
  for (const c of kids) {
    node.n += c.n; node.area += c.area
    node.need = add(node.need, c.need); node.withOverage = add(node.withOverage, c.withOverage); node.order = add(node.order, c.order)
    if (c.value != null) { value += c.value; anyValue = true }
    node.priceMissing ||= c.priceMissing; node.unitMismatch ||= c.unitMismatch; node.missingQty += c.missingQty
    if (c.avgRate != null && c.rateUnit) { wSum += c.avgRate * c.area; wArea += c.area; units.add(c.rateUnit) }
  }
  node.value = anyValue ? round2(value) : null
  // средна норма има смисъл само в една мерна единица (в рамките на култура)
  if (level === 'crop' && units.size === 1 && wArea > 0) { node.avgRate = wSum / wArea; node.rateUnit = [...units][0] }
  return node
}

const byLabel = (a: RecapNode, b: RecapNode) => a.label.localeCompare(b.label, 'bg')

/** prices: по variety_id (избраната оферта) */
export function buildSeedRecap(rows: RecapInput[], prices: Map<string, SeedPrice>): RecapNode {
  const group = <T,>(xs: T[], f: (x: T) => string) => {
    const m = new Map<string, T[]>()
    for (const x of xs) { const k = f(x); m.set(k, [...(m.get(k) ?? []), x]) }
    return m
  }
  const bases: RecapNode[] = []
  for (const [ba, baRows] of group(rows, (r) => r.base)) {
    const crops: RecapNode[] = []
    for (const [cr, crRows] of group(baRows, (r) => r.crop)) {
      const vars = [...group(crRows, (r) => r.varietyId).values()].map((vr) => leaf(vr, prices.get(vr[0].varietyId))).sort(byLabel)
      crops.push(sumNodes('crop', `${ba}|${cr}`, cr, vars))
    }
    bases.push(sumNodes('base', ba, ba, crops.sort(byLabel)))
  }
  return sumNodes('total', 'total', 'ОБЩО', bases.sort(byLabel))
}

/** Плосък лист „Заявка“: един ред за База × Сорт – същите числа като в дървото. */
export type OrderLine = { base: string; crop: string; variety: string; unit: QtyUnit; bzs: number; area: number; need: number; withOverage: number; order: number; supplier: string | null; price: SeedPrice | undefined; value: number | null; mismatch: boolean }
export function orderLines(tree: RecapNode): OrderLine[] {
  const out: OrderLine[] = []
  for (const ba of tree.children) for (const cr of ba.children) for (const v of cr.children) {
    const u = v.unit ?? 'packs'
    const q = (x: Qty) => (u === 'packs' ? x.packs : x.t)
    out.push({ base: ba.label, crop: cr.label, variety: v.label, unit: u, bzs: v.n, area: v.area, need: q(v.need), withOverage: q(v.withOverage), order: q(v.order),
      supplier: v.price?.supplier ?? null, price: v.price, value: v.value, mismatch: v.unitMismatch })
  }
  return out.sort((a, b) => a.base.localeCompare(b.base, 'bg') || (a.supplier ?? '').localeCompare(b.supplier ?? '', 'bg') || a.variety.localeCompare(b.variety, 'bg'))
}

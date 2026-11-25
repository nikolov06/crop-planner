// Изчисляване на количеството семена за ред от planting_seed.
// Ползва се от „Планиране семена“, импорта на сортове и рекапитулацията – логиката е една
// и съвпада с изгледа v_seed_calc.
//
// Слети култури (житни, рапица):
//   Брой семена/м² = CEILING(кълняеми семена/м² ÷ (кълняемост/100))
//   Норма кг/дка   = ROUND(брой × МХЗ ÷ 1000) (по стъпката на културата) или ръчната (1 знак)
//   Нужда т        = норма × площ ÷ 1000;  С преразход = нужда × (1 + преразход %)
// Рапица (слята, поръчва се в торби): сем./дка = кълняеми/м² ÷ кълняемост × 1000 (без закръгляне нагоре);
//   торби = сем./дка × дка ÷ семена в торба. Нужна е само кълняемостта; МХЗ – само за кг/дка (2 знака, информативно).
// Редови (слънчоглед, царевица, сорго): торби = сем./дка × площ ÷ семена в торба (× преразход).
// МХЗ и кълняемост: БЗС → партида → сорт.

export type Crop = {
  crop_id: string
  name_bg: string
  seeding_method: 'solid' | 'row' | null
  rate_basis: string | null
  order_unit: string | null
  default_seeds_per_pack: number | null
  seed_overage_pct: number | null
  rate_rounding_step: number | null
}
export type Variety = {
  variety_id: string; crop_id: string; name: string; seeds_per_pack: number | null; default_rate?: number | null
  tkw_g?: number | null; germination_pct?: number | null
}
export type Batch = {
  batch_id: string
  variety_id: string
  reproduction_id: number | null
  tkw_g: number | null
  germination_pct: number | null
  seeds_per_pack: number | null
}
/** Ред от planting_seed (само полетата за сметката). */
export type SeedInput = {
  area_da: number
  target_rate: number
  overage_pct: number | null
  tkw_g?: number | null
  germination_pct?: number | null
  rate_kg_da_manual?: number | null
}
export type Source = 'bzs' | 'batch' | 'variety' | null
export type Calc = {
  /** Брой семена/м² (слети) */
  totalSeedsM2: number | null
  /** Норма кг/дка, която се ползва (ръчната или изчислената); само при поръчка в кг/т */
  kgDa: number | null
  /** Изчислена норма кг/дка (без ръчната) */
  kgDaCalc: number | null
  /** Нормата е въведена ръчно */
  manual: boolean
  /** Рапица: кг/дка с 2 знака, само за информация */
  kgDaInfo: number | null
  /** С преразход (за заявката) */
  kg: number | null
  t: number | null
  packs: number | null
  /** Без преразход */
  needT: number | null
  needPacks: number | null
  overagePct: number
  tkw: number | null
  germ: number | null
  tkwSource: Source
  germSource: Source
  missing: boolean
  /** какво липсва за количеството (празно, ако нищо) */
  missingWhat: string[]
}

// защита от 526,0000000001 → 527 и 22,4999999 → 22 при плаваща запетая
const clean = (x: number) => Number(x.toFixed(9))
export const round1 = (x: number) => Math.round(clean(x) * 10) / 10
export const round2 = (x: number) => Math.round(clean(x) * 100) / 100

/** Брой семена/м² = CEILING(кълняеми ÷ (кълняемост/100)) */
export const totalSeeds = (germSeedsM2: number, germPct: number) => Math.ceil(clean((germSeedsM2 * 100) / germPct))
/** Норма кг/дка = ROUND(брой × МХЗ ÷ 1000) по стъпка (по подразбиране 1) */
export const kgPerDa = (seedsM2: number, tkw: number, step = 1) =>
  Number((Math.round(clean((seedsM2 * tkw) / 1000 / step)) * step).toFixed(6))

export function calcRow(crop: Crop, ps: SeedInput, b: Batch | undefined, v?: Variety): Calc {
  const ov = Number(ps.overage_pct ?? crop.seed_overage_pct ?? 0)
  const k = 1 + ov / 100
  const spp = b?.seeds_per_pack ?? v?.seeds_per_pack ?? crop.default_seeds_per_pack
  const pick = (own: number | null | undefined, bv: number | null | undefined, vv: number | null | undefined): [number | null, Source] =>
    own != null ? [Number(own), 'bzs'] : bv != null ? [Number(bv), 'batch'] : vv != null ? [Number(vv), 'variety'] : [null, null]
  const [tkw, tkwSource] = pick(ps.tkw_g, b?.tkw_g, v?.tkw_g)
  const [germ, germSource] = pick(ps.germination_pct, b?.germination_pct, v?.germination_pct)
  const out: Calc = {
    totalSeedsM2: null, kgDa: null, kgDaCalc: null, manual: false, kgDaInfo: null,
    kg: null, t: null, packs: null, needT: null, needPacks: null,
    overagePct: ov, tkw, germ, tkwSource, germSource, missing: false, missingWhat: [],
  }
  const miss = (...what: (string | false)[]) => { out.missing = true; out.missingWhat = what.filter((w): w is string => !!w); return out }
  const area = Number(ps.area_da)
  const rate = Number(ps.target_rate)

  if (crop.seeding_method === 'solid') {
    if (crop.order_unit === 'packs') {   // рапица: МХЗ не е нужна за торбите
      const seedsM2 = germ ? clean((rate * 100) / germ) : null
      out.totalSeedsM2 = seedsM2
      if (seedsM2 != null && tkw) out.kgDaInfo = round2((seedsM2 * tkw) / 1000)
      if (seedsM2 == null || !spp) return miss(!germ && 'кълняемост', !spp && 'семена в торба')
      out.needPacks = (seedsM2 * 1000 * area) / spp
      out.packs = out.needPacks * k
      return out
    }
    if (germ) out.totalSeedsM2 = totalSeeds(rate, germ)
    if (out.totalSeedsM2 != null && tkw) out.kgDaCalc = kgPerDa(out.totalSeedsM2, tkw, Number(crop.rate_rounding_step ?? 1))
    const manual = ps.rate_kg_da_manual != null ? Number(ps.rate_kg_da_manual) : null
    out.manual = manual != null
    out.kgDa = manual ?? out.kgDaCalc
    if (out.kgDa == null) return miss(!tkw && 'МХЗ', !germ && 'кълняемост')
    out.needT = (out.kgDa * area) / 1000
    out.t = out.needT * k
    out.kg = out.t * 1000
    return out
  }
  if (!spp) return miss('семена в торба')
  out.needPacks = (rate * area) / spp
  out.packs = out.needPacks * k
  return out
}

// ---------- Цени ----------
export type PriceUnit = 'pack' | 't' | 'kg'
export type SeedPrice = { price: number; unit: PriceUnit; supplier: string | null; own?: boolean; offers?: number }
export type QtyUnit = 'packs' | 't'

/** Стойност EUR за количество; кг ↔ т се превръща, торба ↔ маса – не (mismatch). */
export function seedCost(qty: number | null, qtyUnit: QtyUnit, p: SeedPrice | undefined): { value: number | null; mismatch: boolean } {
  if (!p || qty == null) return { value: null, mismatch: false }
  if (qtyUnit === 'packs') return p.unit === 'pack' ? { value: qty * p.price, mismatch: false } : { value: null, mismatch: true }
  if (p.unit === 't') return { value: qty * p.price, mismatch: false }
  if (p.unit === 'kg') return { value: qty * 1000 * p.price, mismatch: false }
  return { value: null, mismatch: true }
}

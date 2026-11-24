// Изчисляване на количеството семена (общи семена/м², кг/дка, кг, т, торби) за ред от planting_seed.
// Ползва се от „Планиране семена“ и от импорта на сортове – логиката е една.

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
export type Variety = { variety_id: string; crop_id: string; name: string; seeds_per_pack: number | null; default_rate?: number | null }
export type Batch = {
  batch_id: string
  variety_id: string
  reproduction_id: number | null
  tkw_g: number | null
  germination_pct: number | null
  seeds_per_pack: number | null
}
export type Calc = { totalSeedsM2: number | null; kgDa: number | null; kg: number | null; t: number | null; packs: number | null; missing: boolean }

export function calcRow(crop: Crop, ps: { area_da: number; target_rate: number; overage_pct: number | null }, b: Batch | undefined, v?: Variety): Calc {
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


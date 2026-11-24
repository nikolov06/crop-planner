// Данни за „Планиране семена“ и рекапитулацията: БЗС, семена, култури, сортове, партиди и избраните оферти.
import { supabase } from './supabase'
import { calcRow, round1, round2, seedCost, type Batch, type Calc, type Crop, type QtyUnit, type SeedPrice, type Variety } from './seedcalc'

export type Planting = {
  planting_id: string
  organization_id: string
  field_name: string
  company_name: string | null
  farm_base_name: string | null
  crop_id: string
  crop_name: string
  planted_area_da: number | null
}
export type PSeed = {
  planting_seed_id: string
  planting_id: string
  variety_id: string
  batch_id: string | null
  area_da: number
  target_rate: number
  overage_pct: number | null
  seed_origin: string | null
  addon?: string | null
  tkw_g?: number | null
  germination_pct?: number | null
  rate_kg_da_manual?: number | null
}
export type Repro = { reproduction_id: number; name: string }
export type Season = { season_id: number; label: string; is_current: boolean; year_end: number }

const PAGE = 1000
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
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

export async function loadSeasons(): Promise<Season[]> {
  const r = await supabase.from('season').select('season_id,label,is_current,year_end').order('year_end', { ascending: false })
  if (r.error) throw new Error(r.error.message)
  return (r.data ?? []) as Season[]
}

export async function loadSeedData(seasonId: number) {
  const [crops, varieties, batches, repros] = await Promise.all([
    fetchAll<Crop>((f, t) => supabase.from('crop').select('*').not('seeding_method', 'is', null).range(f, t)),
    fetchAll<Variety>((f, t) => supabase.from('variety').select('variety_id,crop_id,name,seeds_per_pack,default_rate,tkw_g,germination_pct').order('name').order('variety_id').range(f, t)),
    fetchAll<Batch>((f, t) => supabase.from('seed_batch').select('batch_id,variety_id,reproduction_id,tkw_g,germination_pct,seeds_per_pack').order('batch_id').range(f, t)),
    fetchAll<Repro>((f, t) => supabase.from('reproduction').select('reproduction_id,name').range(f, t)),
  ])
  const withSeeding = new Set(crops.map((c) => c.crop_id))
  const plantings = (await fetchAll<Planting>((f, t) =>
    supabase.from('v_planting_context')
      .select('planting_id,organization_id,field_name,company_name,farm_base_name,crop_id,crop_name,planted_area_da')
      .eq('season_id', seasonId).eq('role', 'main').order('field_name').order('planting_id').range(f, t)))
    .filter((p) => withSeeding.has(p.crop_id))
  const ids = new Set(plantings.map((p) => p.planting_id))
  const pseeds = (await fetchAll<PSeed>((f, t) => supabase.from('planting_seed').select('*').order('planting_seed_id').range(f, t)))
    .filter((s) => ids.has(s.planting_id))
  const prices = await loadSeedPrices(seasonId)
  return { crops, varieties, batches, repros, plantings, pseeds, ...prices }
}

/** Избраните оферти за семена (v_seed_price_selected) по сорт. */
export async function loadSeedPrices(seasonId: number): Promise<{ prices: Map<string, SeedPrice>; pricesOk: boolean }> {
  const prices = new Map<string, SeedPrice>()
  const r = await supabase.from('v_seed_price_selected').select('variety_id,price,price_unit,supplier_name,is_own_production,n_offers,offer_date,valid_until').eq('season_id', seasonId)
  if (r.error) return { prices, pricesOk: false }
  for (const x of (r.data ?? []) as { variety_id: string; price: number; price_unit: SeedPrice['unit']; supplier_name: string; is_own_production: boolean; n_offers: number }[]) {
    prices.set(x.variety_id, { price: Number(x.price), unit: x.price_unit, supplier: x.supplier_name, own: x.is_own_production, offers: Number(x.n_offers) })
  }
  return { prices, pricesOk: true }
}

/** Сметка за един ред от planting_seed + закръглените количества, както се виждат (торби 1 знак, т 2 знака). */
export type SeedLine = {
  ps: PSeed
  calc: Calc
  unit: QtyUnit
  need: number | null
  withOverage: number | null
  price?: SeedPrice
  value: number | null
  mismatch: boolean
}
export function seedLine(crop: Crop, ps: PSeed, b: Batch | undefined, v: Variety | undefined, price: SeedPrice | undefined): SeedLine {
  const calc = calcRow(crop, ps, b, v)
  const unit: QtyUnit = crop.order_unit === 'packs' ? 'packs' : 't'
  const r = unit === 'packs' ? round1 : round2
  const need = unit === 'packs' ? calc.needPacks : calc.needT
  const ov = unit === 'packs' ? calc.packs : calc.t
  const withOverage = ov == null ? null : r(ov)
  const cost = seedCost(withOverage, unit, price)
  return { ps, calc, unit, need: need == null ? null : r(need), withOverage, price, value: cost.value == null ? null : round2(cost.value), mismatch: cost.mismatch }
}

export const rateUnitOf = (crop: Crop) => (crop.order_unit === 'kg' ? 'кг/дка' : crop.seeding_method === 'solid' ? 'к.с./м²' : 'сем./дка')
/** нормата за средната в рекапитулацията: кг/дка за житни, кълняеми/м² за рапица, сем./дка за редовите */
export const rateForAvg = (crop: Crop, l: SeedLine) => (crop.order_unit === 'kg' ? l.calc.kgDa : Number(l.ps.target_rate))

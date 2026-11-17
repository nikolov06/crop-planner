import { supabase } from './supabase'

// Ефективни цени по продукт и сезон (изглед v_product_price_effective: основна → приета → най-ниска).
export type Unit = 'l' | 'kg' | 't'
export type Price = { price: number; unit: Unit; supplier: string | null; offers: number }
export type Kind = 'prz' | 'fert'

const PAGE = 1000
// ok = false, ако изгледът още го няма (миграцията не е приложена) – екраните тогава скриват стойностите
export async function loadPrices(seasonId: number | null | undefined, kind: Kind): Promise<{ map: Map<string, Price>; ok: boolean }> {
  const map = new Map<string, Price>()
  if (seasonId == null) return { map, ok: false }
  const col = kind === 'prz' ? 'prz_product_id' : 'fertilizer_product_id'
  try {
    for (let from = 0; ; from += PAGE) {
      const r = await supabase.from('v_product_price_effective').select(`${col},price,price_unit,supplier_name,n_offers`)
        .eq('season_id', seasonId).not(col, 'is', null).order('offer_line_id').range(from, from + PAGE - 1)
      if (r.error) return { map: new Map(), ok: false }
      for (const x of (r.data ?? []) as Record<string, unknown>[]) {
        map.set(String(x[col]), { price: Number(x.price), unit: x.price_unit as Unit, supplier: (x.supplier_name as string) ?? null, offers: Number(x.n_offers) })
      }
      if (!r.data || r.data.length < PAGE) break
    }
    return { map, ok: true }
  } catch { return { map: new Map(), ok: false } }
}

export const fmtEuro = (n: number) => n.toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const unitLabel = (u: Unit) => (u === 't' ? 'т' : u === 'kg' ? 'кг' : 'л')
export const priceText = (p: Price) => `${p.price.toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} евро/${unitLabel(p.unit)}`

// ПРЗ: количеството е в л или кг; цената трябва да е в същата единица
export function costPrz(qty: number, qtyUnit: 'l' | 'kg', p?: Price): number | null {
  if (!p || p.unit !== qtyUnit) return null
  return qty * p.price
}
// торове: количество в кг, т и „родна“ единица (л за течните)
export function costFert(q: { kg: number; t: number; native: number; liquid: boolean }, p?: Price): number | null {
  if (!p) return null
  if (p.unit === 't') return q.t * p.price
  if (p.unit === 'kg') return q.kg * p.price
  return q.liquid ? q.native * p.price : null
}

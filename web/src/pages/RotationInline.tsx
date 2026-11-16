import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// Редакция по колони директно в таблицата „Сеитбооборот“ (след отключване на колоната).
// Данните за редакцията се зареждат при първото отключване; записът е по клетка, веднага.

export type InlineKey = 'field_name' | 'area' | 'crop' | 'p1' | 'p2' | 'p3' | 'p4' | 'tillage'
export const INLINE_COLS: { key: InlineKey; label: string }[] = [
  { key: 'field_name', label: 'Наименование' }, { key: 'area', label: 'Площ' }, { key: 'crop', label: 'Култура (текущ сезон)' },
  { key: 'p1', label: 'Култура −1 година' }, { key: 'p2', label: 'Култура −2 години' }, { key: 'p3', label: 'Култура −3 години' },
  { key: 'p4', label: 'Култура −4 години' }, { key: 'tillage', label: 'Почвообработка (1 и 2)' },
]

export type RowLike = {
  field_id: string; field_name: string; area_da: number | null; crop: string | null
  crop_prev1: string | null; crop_prev2: string | null; crop_prev3: string | null; crop_prev4: string | null
  tillage?: string | null; seeds: unknown[] | null
}
export type RowPatch = Partial<Pick<RowLike, 'field_name' | 'area_da' | 'crop' | 'crop_prev1' | 'crop_prev2' | 'crop_prev3' | 'crop_prev4' | 'tillage' | 'seeds'>>

type P = { planting_id: string; crop_id: string; t1: number | null; t2: number | null }
type Opt = { id: string; label: string }
const PAGE = 1000
const prevKey = (k: number) => (['crop', 'crop_prev1', 'crop_prev2', 'crop_prev3', 'crop_prev4'] as const)[k]

export function useInlineEdit(enabled: boolean, patch: (fieldId: string, p: RowPatch) => void, report: (m: string | null, isErr: boolean) => void) {
  const [ready, setReady] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [crops, setCrops] = useState<Opt[]>([])
  const [tills, setTills] = useState<Opt[]>([])
  const [t2Ok, setT2Ok] = useState(false)
  const data = useRef<{ ye: number; byField: Map<string, Record<number, P>>; fcy: Map<string, string> }>({ ye: 0, byField: new Map(), fcy: new Map() })
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    ;(async () => {
      try {
        const s = await supabase.from('season').select('season_id,year_end').eq('is_current', true).limit(1)
        if (s.error) throw new Error(s.error.message)
        const sid = s.data?.[0]?.season_id; const ye = s.data?.[0]?.year_end as number
        if (sid == null) throw new Error('Няма текущ сезон.')
        const [c, t] = await Promise.all([
          supabase.from('crop').select('crop_id,name_bg').eq('is_active', true).order('name_bg'),
          supabase.from('tillage_type').select('tillage_id,name_bg').eq('is_active', true).order('name_bg'),
        ])
        if (c.error) throw new Error(c.error.message)
        if (t.error) throw new Error(t.error.message)
        const byField = new Map<string, Record<number, P>>()
        const byPl = new Map<string, P>()
        for (let from = 0; ; from += PAGE) {
          const r = await supabase.from('v_planting_context').select('planting_id,field_id,season_year_end,crop_id,tillage_id')
            .eq('role', 'main').gte('season_year_end', ye - 4).lte('season_year_end', ye).order('planting_id').range(from, from + PAGE - 1)
          if (r.error) throw new Error(r.error.message)
          for (const x of (r.data ?? []) as { planting_id: string; field_id: string; season_year_end: number; crop_id: string; tillage_id: number | null }[]) {
            const p: P = { planting_id: x.planting_id, crop_id: x.crop_id, t1: x.tillage_id, t2: null }
            const rec = byField.get(x.field_id) ?? {}; rec[x.season_year_end] = p; byField.set(x.field_id, rec); byPl.set(x.planting_id, p)
          }
          if (!r.data || r.data.length < PAGE) break
        }
        let t2ok = false
        const t2 = await supabase.from('field_planting').select('planting_id,tillage2_id').not('tillage2_id', 'is', null).limit(20000)
        if (!t2.error) {
          t2ok = true
          for (const x of (t2.data ?? []) as { planting_id: string; tillage2_id: number }[]) { const p = byPl.get(x.planting_id); if (p) p.t2 = x.tillage2_id }
        } else {
          const probe = await supabase.from('field_planting').select('tillage2_id').limit(1)
          t2ok = !probe.error
        }
        const fcy = new Map<string, string>()
        for (let from = 0; ; from += PAGE) {
          const r = await supabase.from('field_crop_year').select('fcy_id,field_id').eq('season_id', sid).order('fcy_id').range(from, from + PAGE - 1)
          if (r.error) throw new Error(r.error.message)
          for (const x of (r.data ?? []) as { fcy_id: string; field_id: string }[]) fcy.set(x.field_id, x.fcy_id)
          if (!r.data || r.data.length < PAGE) break
        }
        data.current = { ye, byField, fcy }
        setCrops((c.data ?? []).map((x: { crop_id: string; name_bg: string }) => ({ id: x.crop_id, label: x.name_bg })))
        setTills((t.data ?? []).map((x: { tillage_id: number; name_bg: string }) => ({ id: String(x.tillage_id), label: x.name_bg })))
        setT2Ok(t2ok)
        setReady(true)
      } catch (e) { setLoadErr((e as Error).message); started.current = false }
    })()
  }, [enabled])

  const tillName = useCallback((id: number | null) => tills.find((x) => x.id === String(id))?.label ?? null, [tills])
  const plOf = (fieldId: string, off: number): P | undefined => data.current.byField.get(fieldId)?.[data.current.ye - off]

  async function setName(r: RowLike, v: string) {
    const name = v.trim()
    if (!name) return report('Наименованието не може да е празно.', true)
    if (name === r.field_name) return
    const fcy = data.current.fcy.get(r.field_id)
    if (!fcy) return report('Полето няма регистрация за текущия сезон – наименованието не може да се промени оттук.', true)
    const x = await supabase.from('field_crop_year').update({ field_name: name }).eq('fcy_id', fcy).select('fcy_id')
    if (x.error) return report(x.error.message, true)
    if (!x.data?.length) return report('Не е записано – вероятно нямате права или периодът е заключен.', true)
    patch(r.field_id, { field_name: name }); report(null, false)
  }
  async function setArea(r: RowLike, v: string) {
    const n = Number(v.replace(',', '.'))
    if (!(n > 0) || !Number.isFinite(n)) return report('Площта трябва да е число над 0.', true)
    const a = Math.round(n * 100) / 100
    if (a === r.area_da) return
    const p = plOf(r.field_id, 0)
    if (!p) return report('Няма основна култура за текущия сезон – площта не може да се промени.', true)
    const x = await supabase.from('field_planting').update({ planted_area_da: a }).eq('planting_id', p.planting_id).select('planting_id')
    if (x.error) return report(x.error.message, true)
    if (!x.data?.length) return report('Не е записано – вероятно нямате права или периодът е заключен.', true)
    patch(r.field_id, { area_da: a }); report(null, false)
  }
  async function setCrop(r: RowLike, off: number, cropId: string) {
    const p = plOf(r.field_id, off)
    if (!p) return report('Няма запис за този сезон – културата не може да се добави оттук (използвай ✎ или „+ Ново БЗС“ за текущия сезон).', true)
    if (!cropId || cropId === p.crop_id) return
    const cnt = await supabase.from('planting_seed').select('planting_id', { count: 'exact', head: true }).eq('planting_id', p.planting_id)
    const n = cnt.count ?? 0
    if (n > 0) {
      if (!window.confirm(`Смяната на културата изтрива ${n} ред(а) със сортове за този сезон на „${r.field_name}“. Продължаваш ли?`)) return
      const d = await supabase.from('planting_seed').delete().eq('planting_id', p.planting_id)
      if (d.error) return report(d.error.message, true)
    }
    const x = await supabase.from('field_planting').update({ crop_id: cropId }).eq('planting_id', p.planting_id).select('planting_id')
    if (x.error) return report(x.error.message, true)
    if (!x.data?.length) return report('Не е записано – вероятно нямате права или периодът е заключен.', true)
    p.crop_id = cropId
    const name = crops.find((c) => c.id === cropId)?.label ?? null
    patch(r.field_id, { [prevKey(off)]: name, ...(off === 0 && n > 0 ? { seeds: [] } : {}) } as RowPatch); report(null, false)
  }
  async function setTillage(r: RowLike, which: 1 | 2, v: string) {
    const p = plOf(r.field_id, 0)
    if (!p) return report('Няма основна култура за текущия сезон – почвообработката не може да се промени.', true)
    let t1 = p.t1; let t2 = p.t2
    if (which === 1) { t1 = v ? Number(v) : null; if (!t1) t2 = null } else t2 = v ? Number(v) : null
    if (t2 != null && t1 == null) return report('Втората обработка изисква първа.', true)
    if (t2 != null && t1 === t2) return report('Втората обработка не може да съвпада с първата.', true)
    const upd: Record<string, unknown> = { tillage_id: t1 }
    if (t2Ok) upd.tillage2_id = t2
    const x = await supabase.from('field_planting').update(upd).eq('planting_id', p.planting_id).select('planting_id')
    if (x.error) return report(x.error.message, true)
    if (!x.data?.length) return report('Не е записано – вероятно нямате права или периодът е заключен.', true)
    p.t1 = t1; p.t2 = t2
    patch(r.field_id, { tillage: [tillName(t1), tillName(t2)].filter(Boolean).join(' + ') || null }); report(null, false)
  }

  return {
    ready, loadErr, crops, tills, t2Ok, plOf, setName, setArea, setCrop, setTillage,
  }
}
export type InlineApi = ReturnType<typeof useInlineEdit>

// ───────── клетки ─────────
function Field({ value, num, onCommit, label }: { value: string; num?: boolean; onCommit: (v: string) => void; label: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input className="input fi" style={{ minWidth: num ? 70 : 140, textAlign: num ? 'right' : undefined }} aria-label={label} inputMode={num ? 'decimal' : undefined} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== value) onCommit(v) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur() } }} />
  )
}
function Pick({ value, opts, onChange, label, disabled, empty = '—' }: { value: string; opts: Opt[]; onChange: (v: string) => void; label: string; disabled?: boolean; empty?: string }) {
  return (
    <select className="input fi" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}

export function InlineName({ ie, r }: { ie: InlineApi; r: RowLike }) {
  return <Field value={r.field_name} label={`Наименование ${r.field_name}`} onCommit={(v) => ie.setName(r, v)} />
}
export function InlineArea({ ie, r }: { ie: InlineApi; r: RowLike }) {
  return <Field value={r.area_da != null ? String(r.area_da) : ''} num label={`Площ ${r.field_name}`} onCommit={(v) => ie.setArea(r, v)} />
}
export function InlineCrop({ ie, r, off }: { ie: InlineApi; r: RowLike; off: 0 | 1 | 2 | 3 | 4 }) {
  const p = ie.plOf(r.field_id, off)
  if (!p) return <span className="empty" title="Няма запис за този сезон">—</span>
  return <Pick value={p.crop_id} opts={ie.crops} label={`Култура ${r.field_name}`} onChange={(v) => ie.setCrop(r, off, v)} />
}
export function InlineTillage({ ie, r }: { ie: InlineApi; r: RowLike }) {
  const p = ie.plOf(r.field_id, 0)
  if (!p) return <span className="empty">—</span>
  return (
    <span style={{ display: 'grid', gap: 4 }}>
      <Pick value={p.t1 != null ? String(p.t1) : ''} opts={ie.tills} label={`Почвообработка ${r.field_name}`} onChange={(v) => ie.setTillage(r, 1, v)} />
      {ie.t2Ok && <Pick value={p.t2 != null ? String(p.t2) : ''} opts={ie.tills} label={`Втора обработка ${r.field_name}`} disabled={p.t1 == null} empty="+ втора…" onChange={(v) => ie.setTillage(r, 2, v)} />}
    </span>
  )
}

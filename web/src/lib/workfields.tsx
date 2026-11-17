import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'

// Обработваеми полета (work_field) и техните БЗС (field): зареждане, преместване на БЗС, избор на поле.
// „Празно“ обработваемо поле = без нито едно БЗС (field) във всички сезони.

export type Bzs = { field_id: string; organization_id: string; work_field_id: string | null; field_name: string | null; isak_number: string | null; company_name: string | null }
export type WFStat = {
  work_field_id: string; organization_id: string; name: string; name_bg: string | null; jd_field_id: string | null
  hasGeom: boolean; nBzs: number; companies: string[]
}

const PAGE = 1000
async function paged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
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
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

export async function loadWorkFields(): Promise<{ wfs: WFStat[]; bzs: Bzs[] }> {
  const [w, g, f, r] = await Promise.all([
    paged<{ work_field_id: string; organization_id: string; name: string; name_bg: string | null; jd_field_id: string | null }>((a, b) =>
      supabase.from('work_field').select('work_field_id,organization_id,name,name_bg,jd_field_id').order('name').order('work_field_id').range(a, b)),
    paged<{ work_field_id: string }>((a, b) => supabase.from('v_work_field_geojson').select('work_field_id').order('work_field_id').range(a, b)).catch(() => [] as { work_field_id: string }[]),
    paged<{ field_id: string; organization_id: string; work_field_id: string | null }>((a, b) =>
      supabase.from('field').select('field_id,organization_id,work_field_id').order('field_id').range(a, b)),
    paged<{ field_id: string; field_name: string | null; isak_number: string | null; company_name: string | null }>((a, b) =>
      supabase.from('v_rotation_list').select('field_id,field_name,isak_number,company_name').order('field_id').range(a, b)),
  ])
  const info = new Map(r.map((x) => [x.field_id, x]))
  const bzs: Bzs[] = f.map((x) => ({ ...x, field_name: info.get(x.field_id)?.field_name ?? null, isak_number: info.get(x.field_id)?.isak_number ?? null, company_name: info.get(x.field_id)?.company_name ?? null }))
  const geo = new Set(g.map((x) => x.work_field_id))
  const per = new Map<string, Bzs[]>()
  for (const b of bzs) if (b.work_field_id) per.set(b.work_field_id, [...(per.get(b.work_field_id) ?? []), b])
  const wfs = w.map((x) => {
    const list = per.get(x.work_field_id) ?? []
    return { ...x, hasGeom: geo.has(x.work_field_id), nBzs: list.length, companies: Array.from(new Set(list.map((b) => b.company_name).filter(Boolean) as string[])).sort() }
  })
  return { wfs, bzs }
}

// Премества БЗС към обработваемо поле. Връща предишните стойности (за връщане при грешка).
export async function moveBzs(fieldIds: string[], target: string): Promise<Map<string, string | null>> {
  const prev = new Map<string, string | null>()
  for (const c of chunk(fieldIds, 100)) {
    const r = await supabase.from('field').select('field_id,work_field_id').in('field_id', c)
    if (r.error) throw new Error(r.error.message)
    for (const x of (r.data ?? []) as { field_id: string; work_field_id: string | null }[]) prev.set(x.field_id, x.work_field_id)
  }
  let done = 0
  try {
    for (const c of chunk(fieldIds, 100)) {
      const r = await supabase.from('field').update({ work_field_id: target }).in('field_id', c).select('field_id')
      if (r.error) throw new Error(r.error.message)
      done += r.data?.length ?? 0
    }
    if (done < fieldIds.length) throw new Error(`Преместени са само ${done} от ${fieldIds.length} БЗС – вероятно нямаш права за част от тях.`)
  } catch (e) {
    await revertMove(prev).catch(() => undefined)
    throw e
  }
  return prev
}

// Връща БЗС към предишните им обработваеми полета.
export async function revertMove(prev: Map<string, string | null>): Promise<void> {
  const by = new Map<string, string[]>()
  for (const [fid, wf] of prev) { const k = wf ?? ''; by.set(k, [...(by.get(k) ?? []), fid]) }
  for (const [wf, ids] of by) {
    for (const c of chunk(ids, 100)) {
      const r = await supabase.from('field').update({ work_field_id: wf || null }).in('field_id', c)
      if (r.error) throw new Error(r.error.message)
    }
  }
}

// Кои от дадените обработваеми полета са останали без БЗС (проверка в базата).
export async function emptyOf(wfIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(wfIds.filter(Boolean)))
  if (!ids.length) return []
  const used = new Set<string>()
  for (const c of chunk(ids, 100)) {
    const r = await supabase.from('field').select('work_field_id').in('work_field_id', c)
    if (r.error) throw new Error(r.error.message)
    for (const x of (r.data ?? []) as { work_field_id: string }[]) used.add(x.work_field_id)
  }
  return ids.filter((i) => !used.has(i))
}

export async function countBzs(wfId: string): Promise<number> {
  const r = await supabase.from('field').select('field_id', { count: 'exact', head: true }).eq('work_field_id', wfId)
  if (r.error) throw new Error(r.error.message)
  return r.count ?? 0
}

export const permMsg = (m: string) =>
  /permission denied|42501|row-level security|violates row-level/i.test(m) ? `Нямаш права за тази промяна. (${m})` : m

export function useWorkFields() {
  const [data, setData] = useState<{ wfs: WFStat[]; bzs: Bzs[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    loadWorkFields().then((r) => { if (!off) setData(r) }).catch((e) => { if (!off) setErr((e as Error).message) })
    return () => { off = true }
  }, [])
  return { wfs: data?.wfs ?? null, bzs: data?.bzs ?? null, err }
}

// Поле за избор на обработваемо поле: търсене по име, брой БЗС и дали има граница.
export function WorkFieldPicker({ wfs, value, onChange, label = 'Обработваемо поле', placeholder = 'Търси по име…', exclude }: {
  wfs: WFStat[]; value: string | null; onChange: (id: string | null) => void; label?: string; placeholder?: string; exclude?: string | null
}) {
  const cur = value ? wfs.find((w) => w.work_field_id === value) ?? null : null
  const [q, setQ] = useState(cur?.name ?? '')
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLLabelElement>(null)
  // при избор (или късно зареждане) показваме името; при писане изборът се чисти, но текстът остава
  useEffect(() => { if (cur) setQ(cur.name) }, [cur?.work_field_id, cur?.name])
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const hits = useMemo(() => {
    const n = q.trim().toLowerCase()
    return wfs.filter((w) => w.work_field_id !== exclude && (!n || w.name.toLowerCase().includes(n) || (w.name_bg ?? '').toLowerCase().includes(n))).slice(0, 12)
  }, [wfs, q, exclude])
  return (
    <label className="field" ref={wrap} style={{ position: 'relative', minWidth: 260 }}>{label}
      <input className="input" type="search" value={q} placeholder={placeholder} aria-expanded={open}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); if (value) onChange(null) }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }} />
      {open && hits.length > 0 && (
        <div className="col-pop" style={{ position: 'absolute', top: '100%', left: 0, right: 0, width: 'auto' }}>
          <div className="col-pop-list">
            {hits.map((w) => (
              <button key={w.work_field_id} type="button" className="wf-hit" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(w.work_field_id); setQ(w.name); setOpen(false) }}>
                <span>{w.name}</span>
                <span className="muted">{w.nBzs} БЗС · {w.hasGeom ? 'с граница' : 'без граница'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </label>
  )
}

// Бележка, ако в избраното обработваемо поле има БЗС от друга фирма (само информативно).
export function otherCompanies(target: WFStat | null, companies: (string | null)[]): string[] {
  if (!target) return []
  const mine = new Set(companies.filter(Boolean) as string[])
  return target.companies.filter((c) => !mine.has(c))
}

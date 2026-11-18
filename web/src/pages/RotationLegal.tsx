import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDka, parseDka } from '../lib/format'
import { normName, normSeason } from '../lib/bzsname'
import { readTableFile } from '../lib/tableread'

// Площ по правно основание и буферна ивица на ниво БЗС (field_crop_year) – редакция, групово задаване, импорт.

export type LegalRow = {
  field_id: string
  field_name: string
  company_name: string | null
  fcy_id?: string | null
  legal_area_dka?: number | null
  buffer_strip_dka?: number | null
  area_wo_buffer_dka?: number | null
}
export type LegalPatch = Pick<LegalRow, 'legal_area_dka' | 'buffer_strip_dka' | 'area_wo_buffer_dka'>
type Which = 'legal' | 'buffer'

const BUF_GT = 'Буферната ивица е по-голяма от площта по правно основание – не е записано.'
const round3 = (n: number) => Math.round(n * 1000) / 1000
const same = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && round3(a) === round3(b))

// ───────── редакция в реда ─────────
export function useLegalEdit(patch: (fieldId: string, p: LegalPatch) => void) {
  const [errs, setErrs] = useState<Record<string, { which: Which; msg: string }>>({})
  const setErr = (id: string, e: { which: Which; msg: string } | null) =>
    setErrs((x) => { const n = { ...x }; if (e) n[id] = e; else delete n[id]; return n })

  async function save(r: LegalRow, which: Which, text: string) {
    if (!r.fcy_id) return setErr(r.field_id, { which, msg: 'БЗС няма регистрация за текущия сезон.' })
    const v = parseDka(text)
    if (v != null && (Number.isNaN(v) || v < 0)) return setErr(r.field_id, { which, msg: 'Въведи число ≥ 0 (или остави празно).' })
    const legal = which === 'legal' ? v : (r.legal_area_dka ?? null)
    const buffer = which === 'buffer' ? (v ?? 0) : (r.buffer_strip_dka ?? 0)
    if (legal != null && buffer > legal) return setErr(r.field_id, { which, msg: BUF_GT })
    if (same(legal, r.legal_area_dka) && same(buffer, r.buffer_strip_dka ?? 0)) return setErr(r.field_id, null)
    const x = await supabase.from('field_crop_year').update({ legal_area_dka: legal, buffer_strip_dka: buffer })
      .eq('fcy_id', r.fcy_id).select('legal_area_dka,buffer_strip_dka,area_wo_buffer_dka')
    if (x.error) return setErr(r.field_id, { which, msg: x.error.message })
    if (!x.data?.length) return setErr(r.field_id, { which, msg: 'Не е записано – вероятно нямате права за това БЗС.' })
    setErr(r.field_id, null)
    patch(r.field_id, x.data[0] as LegalPatch)
  }
  return { errs, save }
}
export type LegalEdit = ReturnType<typeof useLegalEdit>

export function LegalInput({ le, r, which }: { le: LegalEdit; r: LegalRow; which: Which }) {
  const cur = which === 'legal' ? r.legal_area_dka : r.buffer_strip_dka
  const value = cur == null ? '' : String(cur).replace('.', ',')
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const err = le.errs[r.field_id]
  const mine = err && err.which === which
  if (!r.fcy_id) return <span className="empty" title="Няма регистрация за текущия сезон">—</span>
  return (
    <span style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
      <input className="input fi" style={{ minWidth: 80, textAlign: 'right', ...(mine ? { borderColor: '#c0392b' } : {}) }} inputMode="decimal"
        aria-label={`${which === 'legal' ? 'Площ правно основание' : 'Буферна ивица'} ${r.field_name}`} aria-invalid={mine || undefined}
        placeholder={which === 'legal' ? 'празно' : '0'} value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v !== value || mine) le.save(r, which, v) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); (e.target as HTMLInputElement).blur() } }} />
      {mine && <span role="alert" style={{ color: '#7a1f12', fontSize: 12, lineHeight: '16px', whiteSpace: 'normal', maxWidth: 220, textAlign: 'right' }}>{err.msg}</span>}
    </span>
  )
}

export function WoBufferCell({ r }: { r: LegalRow }) {
  return (
    <span title="Изчислява се: правно основание − буферна ивица" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', width: '100%' }}>
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ color: 'var(--ink-muted)', flex: 'none' }}>
        <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="currentColor" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      {r.area_wo_buffer_dka != null ? fmtDka(r.area_wo_buffer_dka) : <span className="empty">—</span>}
    </span>
  )
}
export const WOBUF_CELL_STYLE = { background: 'var(--surface-chip)' } as const

// ───────── запис (импорт и групово) – една транзакция в базата ─────────
type SetRow = { fcy_id: string; legal: number | null; buffer: number }
async function saveAll(rows: SetRow[]): Promise<number> {
  const { data, error } = await supabase.rpc('set_bzs_legal_areas', { p_rows: rows })
  if (error) throw new Error(error.message)
  return data as number
}

// ───────── групово задаване ─────────
export function LegalBulkModal({ rows, onClose, onDone }: { rows: LegalRow[]; onClose: () => void; onDone: (m: string) => void }) {
  const [useL, setUseL] = useState(false)
  const [useB, setUseB] = useState(false)
  const [l, setL] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lv = parseDka(l), bv = parseDka(b)
  const inputErr = (useL && lv != null && (Number.isNaN(lv) || lv < 0)) || (useB && bv != null && (Number.isNaN(bv) || bv < 0))
  const ok = rows.filter((r) => r.fcy_id)
  const plan = ok.map((r) => ({
    r, legal: useL ? lv : (r.legal_area_dka ?? null), buffer: useB ? (bv ?? 0) : (r.buffer_strip_dka ?? 0),
  }))
  const bad = plan.filter((p) => p.legal != null && p.buffer > p.legal)
  const changes = plan.filter((p) => !same(p.legal, p.r.legal_area_dka) || !same(p.buffer, p.r.buffer_strip_dka ?? 0))

  async function apply() {
    setBusy(true); setError(null)
    try {
      const n = await saveAll(changes.map((p) => ({ fcy_id: p.r.fcy_id!, legal: p.legal, buffer: p.buffer })))
      onDone(`Записани площи за ${n} БЗС.`)
    } catch (e) { setError(`Нищо не е записано: ${(e as Error).message}`); setBusy(false) }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Групово задаване на площи">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Площи за {rows.length} БЗС</h2>
          <button className="btn outline" onClick={onClose} disabled={busy}>Затвори</button>
        </div>
        {error && <div className="banner err" role="alert">{error}</div>}
        <span className="muted">Отбележи коя стойност да се зададе. Празно поле: площта по правно основание става празна (NULL), буферната ивица – 0. Неотбелязаните не се пипат.</span>
        <div className="filters" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            <span><input type="checkbox" checked={useL} onChange={(e) => setUseL(e.target.checked)} /> Площ правно осн., дка</span>
            <input className="input" inputMode="decimal" value={l} disabled={!useL} onChange={(e) => setL(e.target.value)} style={{ textAlign: 'right' }} />
          </label>
          <label className="field">
            <span><input type="checkbox" checked={useB} onChange={(e) => setUseB(e.target.checked)} /> Буферна ивица, дка</span>
            <input className="input" inputMode="decimal" value={b} disabled={!useB} onChange={(e) => setB(e.target.value)} style={{ textAlign: 'right' }} />
          </label>
        </div>
        {inputErr && <div className="banner err" role="alert">Стойностите трябва да са числа ≥ 0.</div>}
        {rows.length > ok.length && <div className="banner">{rows.length - ok.length} от избраните нямат регистрация за текущия сезон и ще бъдат пропуснати.</div>}
        {!inputErr && bad.length > 0 && (
          <div className="banner err" role="alert">
            При {bad.length} БЗС буферната ивица би била по-голяма от площта по правно основание – нищо няма да се запише:{' '}
            {bad.slice(0, 12).map((p) => `${p.r.field_name} (${fmtDka(p.buffer)} > ${fmtDka(p.legal)})`).join(', ')}{bad.length > 12 ? ` и още ${bad.length - 12}` : ''}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={apply} disabled={busy || inputErr || bad.length > 0 || (!useL && !useB) || changes.length === 0}>
            {busy ? 'Записване…' : `Запиши за ${changes.length} БЗС`}
          </button>
          <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
        </div>
      </div>
    </div>
  )
}

// ───────── импорт от файл ─────────
type FileRow = { line: number; bzs: string; season: string; firm: string; legal: number | null; buffer: number; err?: string }
type Fcy = { fcy_id: string; field_id: string; field_name: string; season_id: number; season: string; company: string | null; legal: number | null; buffer: number }
type Match = { fcy: Fcy; rows: FileRow[]; viaAlias: boolean; legal: number | null; buffer: number; err?: string }
type Preview = {
  fileRows: FileRow[]
  matches: Match[]
  unmatched: FileRow[]
  missing: Fcy[]
  changed: Match[]
  firmDiff: { row: FileRow; fcy: Fcy }[]
  errors: string[]
  seasons: string[]
  sumFile: { legal: number; buffer: number }
  sumAfter: { legal: number; buffer: number; wo: number }
}

const REQ = ['bzs_name', 'season', 'legal_area_dka'] as const
const PAGE = 1000
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function buildPreview(file: File): Promise<Preview> {
  const table = await readTableFile(file)
  if (table.length < 2) throw new Error('Файлът е празен.')
  const head = table[0].map((h) => h.replace(/^﻿/, '').trim().toLowerCase())
  const miss = REQ.filter((k) => !head.includes(k))
  if (miss.length) throw new Error(`Липсват колони: ${miss.join(', ')}. Очакват се: bzs_name, season, firm, region, land, legal_area_dka, buffer_strip_dka, area_wo_buffer_dka.`)
  const col = (r: string[], k: string) => { const i = head.indexOf(k); return i < 0 ? '' : (r[i] ?? '').trim() }

  const fileRows: FileRow[] = []
  for (let i = 1; i < table.length; i++) {
    const r = table[i]
    const bzs = col(r, 'bzs_name')
    if (!bzs) continue
    const legal = parseDka(col(r, 'legal_area_dka'))
    const b0 = parseDka(col(r, 'buffer_strip_dka'))
    const fr: FileRow = { line: i + 1, bzs, season: normSeason(col(r, 'season')), firm: col(r, 'firm'), legal, buffer: b0 ?? 0 }
    if (legal != null && (Number.isNaN(legal) || legal < 0)) fr.err = 'площта по правно основание не е число ≥ 0'
    else if (b0 != null && (Number.isNaN(b0) || b0 < 0)) fr.err = 'буферната ивица не е число ≥ 0'
    else if (legal != null && fr.buffer > legal) fr.err = 'буферната ивица е по-голяма от площта по правно основание'
    else if (!fr.season) fr.err = 'липсва сезон'
    fileRows.push(fr)
  }
  if (!fileRows.length) throw new Error('Във файла няма редове с bzs_name.')

  const seasonsDb = await supabase.from('season').select('season_id,label')
  if (seasonsDb.error) throw new Error(seasonsDb.error.message)
  const seasonId = new Map((seasonsDb.data ?? []).map((s: { season_id: number; label: string }) => [normSeason(s.label), s.season_id]))
  const errors: string[] = []
  const seasons = Array.from(new Set(fileRows.map((r) => r.season).filter(Boolean)))
  for (const s of seasons) if (!seasonId.has(s)) errors.push(`Непознат сезон „${s}“ – няма такава стопанска година в базата.`)
  const sids = seasons.map((s) => seasonId.get(s)).filter((x): x is number => x != null)

  type FcyDb = { fcy_id: string; field_id: string; field_name: string | null; season_id: number; legal_area_dka: number | null; buffer_strip_dka: number | null; company: { name: string } | null }
  const fcyRows = sids.length ? await fetchAll<FcyDb>((a, b) => supabase.from('field_crop_year')
    .select('fcy_id,field_id,field_name,season_id,legal_area_dka,buffer_strip_dka,company:company_id(name)').in('season_id', sids).order('fcy_id').range(a, b)) : []
  const aliases = await fetchAll<{ field_id: string; alias_name: string }>((a, b) => supabase.from('field_alias').select('field_id,alias_name').order('alias_id').range(a, b))
  const sLabel = new Map(Array.from(seasonId.entries()).map(([l, id]) => [id, l]))
  const fcys: Fcy[] = fcyRows.map((x) => ({
    fcy_id: x.fcy_id, field_id: x.field_id, field_name: x.field_name ?? '', season_id: x.season_id, season: sLabel.get(x.season_id) ?? '',
    company: x.company?.name ?? null, legal: x.legal_area_dka, buffer: x.buffer_strip_dka ?? 0,
  }))
  // индекси по сезон: име → БЗС; разширено име → БЗС
  const byName = new Map<string, Fcy[]>()
  const byField = new Map<string, Fcy>()
  for (const f of fcys) {
    const k = `${f.season}|${normName(f.field_name)}`
    byName.set(k, [...(byName.get(k) ?? []), f])
    byField.set(`${f.season}|${f.field_id}`, f)
  }
  const aliasOf = new Map<string, string[]>()
  for (const a of aliases) { const k = normName(a.alias_name); aliasOf.set(k, [...(aliasOf.get(k) ?? []), a.field_id]) }

  const groups = new Map<string, Match>()
  const unmatched: FileRow[] = []
  for (const r of fileRows) {
    if (r.err) { errors.push(`Ред ${r.line} („${r.bzs}“): ${r.err}.`); continue }
    if (!seasonId.has(r.season)) continue
    const n = normName(r.bzs)
    let hit: Fcy | undefined
    let viaAlias = false
    const direct = byName.get(`${r.season}|${n}`) ?? []
    if (direct.length > 1) { errors.push(`Ред ${r.line}: „${r.bzs}“ отговаря на ${direct.length} БЗС в базата за ${r.season} – не може да се определи кое.`); continue }
    if (direct.length === 1) hit = direct[0]
    else {
      const cand = Array.from(new Set((aliasOf.get(n) ?? []).map((fid) => byField.get(`${r.season}|${fid}`)).filter((x): x is Fcy => !!x)))
      if (cand.length > 1) { errors.push(`Ред ${r.line}: разширеното име „${r.bzs}“ сочи към няколко БЗС.`); continue }
      if (cand.length === 1) { hit = cand[0]; viaAlias = true }
    }
    if (!hit) { unmatched.push(r); continue }
    const g = groups.get(hit.fcy_id) ?? { fcy: hit, rows: [], viaAlias: false, legal: null, buffer: 0 }
    g.rows.push(r)
    g.viaAlias = g.viaAlias || viaAlias
    groups.set(hit.fcy_id, g)
  }
  const matches = Array.from(groups.values())
  for (const g of matches) {
    const direct = g.rows.filter((r) => normName(r.bzs) === normName(g.fcy.field_name))
    if (direct.length > 1) g.err = `„${g.fcy.field_name}“ е във файла ${direct.length} пъти (редове ${direct.map((r) => r.line).join(', ')})`
    else if (direct.length === 1 && g.rows.length > 1) g.err = `„${g.fcy.field_name}“ е във файла и като цяло, и на части (${g.rows.filter((r) => r !== direct[0]).map((r) => r.bzs).join(', ')})`
    else {
      const nulls = g.rows.filter((r) => r.legal == null).length
      if (nulls && nulls < g.rows.length) g.err = `частите на „${g.fcy.field_name}“ са с непълна площ по правно основание`
      g.legal = nulls ? null : round3(g.rows.reduce((a, r) => a + (r.legal ?? 0), 0))
      g.buffer = round3(g.rows.reduce((a, r) => a + r.buffer, 0))
      if (!g.err && g.legal != null && g.buffer > g.legal) g.err = `„${g.fcy.field_name}“: буферната ивица е по-голяма от площта по правно основание`
    }
    if (g.err) errors.push(g.err + '.')
  }
  const matchedIds = new Set(matches.map((m) => m.fcy.fcy_id))
  const missing = fcys.filter((f) => !matchedIds.has(f.fcy_id)).sort((a, b) => a.field_name.localeCompare(b.field_name, 'bg'))
  const changed = matches.filter((m) => !m.err && (!same(m.legal, m.fcy.legal) || !same(m.buffer, m.fcy.buffer)))
  const firmDiff: { row: FileRow; fcy: Fcy }[] = []
  for (const m of matches) for (const r of m.rows) if (r.firm && normName(r.firm) !== normName(m.fcy.company)) firmDiff.push({ row: r, fcy: m.fcy })
  const sumFile = { legal: round3(fileRows.reduce((a, r) => a + (r.legal != null && !Number.isNaN(r.legal) ? r.legal : 0), 0)), buffer: round3(fileRows.reduce((a, r) => a + (Number.isNaN(r.buffer) ? 0 : r.buffer), 0)) }
  // суми в базата след записа (за сезоните във файла)
  const after = new Map(matches.filter((m) => !m.err).map((m) => [m.fcy.fcy_id, m]))
  let L = 0, B = 0, W = 0
  for (const f of fcys) {
    const m = after.get(f.fcy_id)
    const legal = m ? m.legal : f.legal, buffer = m ? m.buffer : f.buffer
    L += legal ?? 0; B += buffer; W += legal != null ? legal - buffer : 0
  }
  return {
    fileRows, matches, unmatched, missing, changed, firmDiff, errors, seasons,
    sumFile, sumAfter: { legal: round3(L), buffer: round3(B), wo: round3(W) },
  }
}

function List({ title, n, children, tone }: { title: string; n: number; children: ReactNode; tone?: 'err' | 'warn' | 'ok' }) {
  const [open, setOpen] = useState(n > 0 && n <= 30)
  return (
    <div className={`banner${tone === 'err' ? ' err' : tone === 'ok' ? ' ok' : ''}`} style={{ display: 'grid', gap: 8 }}>
      <button className="btn outline" style={{ justifySelf: 'start', minHeight: 28 }} onClick={() => setOpen((o) => !o)} disabled={n === 0} aria-expanded={open}>
        {open ? '▾' : '▸'} {title}: <strong>{n}</strong>
      </button>
      {open && n > 0 && <div className="modal-list" style={{ background: 'var(--surface-card)', color: 'var(--ink)' }}>{children}</div>}
    </div>
  )
}

export function LegalImportModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [pv, setPv] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (!file) return
    let off = false
    setLoading(true); setPv(null); setError(null); setOk(false); setResult(null)
    buildPreview(file).then((p) => { if (!off) setPv(p) }).catch((e) => { if (!off) setError((e as Error).message) }).finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [file])

  const aliasGroups = useMemo(() => pv?.matches.filter((m) => m.viaAlias) ?? [], [pv])
  const blocked = !pv || pv.errors.length > 0 || pv.changed.length === 0

  async function apply() {
    if (!pv) return
    setBusy(true); setError(null)
    try {
      const n = await saveAll(pv.changed.map((m) => ({ fcy_id: m.fcy.fcy_id, legal: m.legal, buffer: m.buffer })))
      // контролни суми от базата след записа
      const sids = Array.from(new Set(pv.matches.map((m) => m.fcy.season_id)))
      const rows = await fetchAll<{ legal_area_dka: number | null; buffer_strip_dka: number; area_wo_buffer_dka: number | null }>((a, b) =>
        supabase.from('field_crop_year').select('legal_area_dka,buffer_strip_dka,area_wo_buffer_dka').in('season_id', sids).order('fcy_id').range(a, b))
      const s = rows.reduce((a, r) => ({ l: a.l + (r.legal_area_dka ?? 0), b: a.b + (r.buffer_strip_dka ?? 0), w: a.w + (r.area_wo_buffer_dka ?? 0) }), { l: 0, b: 0, w: 0 })
      setResult(`Записани ${n} БЗС. В базата за ${pv.seasons.join(', ')}: правно основание ${fmtDka(round3(s.l))} дка · буферни ивици ${fmtDka(round3(s.b))} дка · без буферна ивица ${fmtDka(round3(s.w))} дка.`)
      setBusy(false)
    } catch (e) { setError(`Нищо не е записано: ${(e as Error).message}`); setBusy(false) }
  }

  const cell = (v: number | null) => (v == null ? <span className="empty">празно</span> : fmtDka(v))
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Импорт на площи">
      <div className="modal" style={{ maxWidth: 1000 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Импорт площи (правно основание и буферни ивици)</h2>
          <button className="btn outline" onClick={() => (result ? onDone(result) : onClose())} disabled={busy}>Затвори</button>
        </div>
        <span className="muted">Excel (.xlsx) или CSV (UTF-8). Колони: bzs_name, season, firm, region, land, legal_area_dka, buffer_strip_dka, area_wo_buffer_dka (последната се игнорира – смята се в базата). Съпоставяне по bzs_name + season; части от БЗС (разширени имена) се сумират към БЗС. Фирмата не се сменя.</span>
        {!result && <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />}
        {loading && <span className="muted">Четене и съпоставяне…</span>}
        {error && <div className="banner err" role="alert">{error}</div>}
        {result && <div className="banner ok" role="status">{result}</div>}
        {pv && !result && (
          <>
            <div className="banner ok">
              Редове във файла: <strong>{pv.fileRows.length}</strong> · съвпадения: <strong>{pv.matches.reduce((a, m) => a + m.rows.length, 0)}</strong> реда → <strong>{pv.matches.length}</strong> БЗС
              {aliasGroups.length > 0 && <> (от тях {aliasGroups.reduce((a, m) => a + m.rows.length, 0)} части, сумирани в {aliasGroups.length} БЗС)</>}
              {' '}· сезон: {pv.seasons.join(', ')}
              <br />Суми във файла: правно основание <strong>{fmtDka(pv.sumFile.legal)}</strong> дка · буферни ивици <strong>{fmtDka(pv.sumFile.buffer)}</strong> дка · без буферна ивица <strong>{fmtDka(round3(pv.sumFile.legal - pv.sumFile.buffer))}</strong> дка
              <br />В базата след записа: <strong>{fmtDka(pv.sumAfter.legal)}</strong> · <strong>{fmtDka(pv.sumAfter.buffer)}</strong> · <strong>{fmtDka(pv.sumAfter.wo)}</strong> дка
            </div>
            {pv.errors.length > 0 && (
              <List title="Грешки (импортът е спрян, поправи файла)" n={pv.errors.length} tone="err">
                <ul style={{ margin: 8 }}>{pv.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </List>
            )}
            <List title="Несъвпаднали БЗС от файла (ще се пропуснат)" n={pv.unmatched.length} tone={pv.unmatched.length ? 'err' : 'ok'}>
              <table className="grid"><thead><tr><th>Ред</th><th>bzs_name</th><th>Фирма</th><th className="num">Правно осн.</th><th className="num">Буфер</th></tr></thead><tbody>
                {pv.unmatched.map((r) => <tr key={r.line}><td>{r.line}</td><td>{r.bzs}</td><td>{r.firm}</td><td className="num">{cell(r.legal)}</td><td className="num">{fmtDka(r.buffer)}</td></tr>)}
              </tbody></table>
            </List>
            <List title="БЗС в базата, които ги няма във файла (остават непроменени)" n={pv.missing.length} tone={pv.missing.length ? undefined : 'ok'}>
              <table className="grid"><thead><tr><th>БЗС</th><th>Сезон</th><th>Фирма</th><th className="num">Правно осн. сега</th><th className="num">Буфер сега</th></tr></thead><tbody>
                {pv.missing.map((f) => <tr key={f.fcy_id}><td>{f.field_name}</td><td>{f.season}</td><td>{f.company ?? '—'}</td><td className="num">{cell(f.legal)}</td><td className="num">{fmtDka(f.buffer)}</td></tr>)}
              </tbody></table>
            </List>
            {aliasGroups.length > 0 && (
              <List title="Части от БЗС, сумирани към БЗС" n={aliasGroups.length}>
                <table className="grid"><thead><tr><th>БЗС в базата</th><th>Части във файла</th><th className="num">Правно осн.</th><th className="num">Буфер</th></tr></thead><tbody>
                  {aliasGroups.map((m) => <tr key={m.fcy.fcy_id}><td>{m.fcy.field_name}</td><td style={{ whiteSpace: 'normal' }}>{m.rows.map((r) => r.bzs).join(', ')}</td><td className="num">{cell(m.legal)}</td><td className="num">{fmtDka(m.buffer)}</td></tr>)}
                </tbody></table>
              </List>
            )}
            <List title="Редове, в които стойността се променя" n={pv.changed.length}>
              <table className="grid"><thead><tr><th>БЗС</th><th className="num">Правно осн. сега</th><th className="num">→ ново</th><th className="num">Буфер сега</th><th className="num">→ ново</th></tr></thead><tbody>
                {pv.changed.map((m) => (
                  <tr key={m.fcy.fcy_id}><td>{m.fcy.field_name}</td>
                    <td className="num">{cell(m.fcy.legal)}</td><td className="num" style={same(m.legal, m.fcy.legal) ? undefined : { fontWeight: 600 }}>{cell(m.legal)}</td>
                    <td className="num">{fmtDka(m.fcy.buffer)}</td><td className="num" style={same(m.buffer, m.fcy.buffer) ? undefined : { fontWeight: 600 }}>{fmtDka(m.buffer)}</td></tr>
                ))}
              </tbody></table>
            </List>
            <List title="Различна фирма във файла (само предупреждение – фирмата НЕ се сменя)" n={pv.firmDiff.length} tone={pv.firmDiff.length ? undefined : 'ok'}>
              <table className="grid"><thead><tr><th>Ред</th><th>bzs_name</th><th>Фирма във файла</th><th>Фирма в базата</th></tr></thead><tbody>
                {pv.firmDiff.map(({ row, fcy }) => <tr key={row.line}><td>{row.line}</td><td>{row.bzs}</td><td>{row.firm}</td><td>{fcy.company ?? '—'}</td></tr>)}
              </tbody></table>
            </List>
            {!blocked && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Прегледах промените – запиши ги</label>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={apply} disabled={busy || blocked || !ok}>
                {busy ? 'Записване…' : pv.errors.length ? 'Има грешки – не може да се запише' : pv.changed.length ? `Запиши ${pv.changed.length} БЗС (една транзакция)` : 'Няма промени'}
              </button>
              <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadXlsx } from '../lib/xlsx'
import { MultiFilter, anyToken } from '../lib/multifilter'

// Оферти от доставчици за ПРЗ и торове: регистриране, редакция, статус, основна цена по продукт.
export type Module = 'prz' | 'fert'
type Sup = { supplier_id: string; organization_id: string; name: string; eik: string | null; is_active: boolean }
type Offer = { offer_id: string; organization_id: string; season_id: number; module: Module; supplier_id: string; offer_no: string | null; offer_date: string; valid_until: string | null; status: Status; note: string | null }
type Line = { offer_line_id: string; offer_id: string; prz_product_id: string | null; fertilizer_product_id: string | null; price: number; price_unit: Unit; is_preferred: boolean; note: string | null }
type Status = 'received' | 'accepted' | 'rejected'
type Unit = 'l' | 'kg' | 't'
type Prod = { id: string; name: string; sub: string; form?: string }
type Season = { season_id: number; label: string; is_current: boolean }
type Draft = { key: string; line_id?: string; product_id: string; price: string; unit: Unit; pref: boolean }

const PAGE = 1000
const STATUS: Record<Status, string> = { received: 'Получена', accepted: 'Приета', rejected: 'Отхвърлена' }
const fmtP = (n: number) => n.toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const perBase = (price: number, unit: Unit) => (unit === 't' ? price / 1000 : price)
let seq = 0
const nk = () => `k${++seq}`

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

export default function Offers({ module }: { module: Module }) {
  const isPrz = module === 'prz'
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonId, setSeasonId] = useState<number | null>(null)
  const [sups, setSups] = useState<Sup[]>([])
  const [offers, setOffers] = useState<Offer[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [prods, setProds] = useState<Prod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [fSup, setFSup] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [edit, setEdit] = useState<null | { offer: Offer | null }>(null)
  const [supOpen, setSupOpen] = useState(false)
  const [reload, setReload] = useState(0)

  // еднократно: сезони и каталог
  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const s = await supabase.from('season').select('season_id,label,is_current').order('year_end', { ascending: false })
        if (s.error) throw new Error(s.error.message)
        const list = (s.data ?? []) as Season[]
        const cat: Prod[] = isPrz
          ? (await fetchAll<{ prz_product_id: string; trade_name: string; active_substances: string | null }>((f, t) =>
              supabase.from('prz_product').select('prz_product_id,trade_name,active_substances').eq('is_active', true).order('trade_name').order('prz_product_id').range(f, t)))
              .map((x) => ({ id: x.prz_product_id, name: x.trade_name, sub: x.active_substances ?? '' }))
          : (await fetchAll<{ product_id: string; name: string; form: string; code: string }>((f, t) =>
              supabase.from('fertilizer_product').select('product_id,name,form,code').eq('is_active', true).order('name').order('product_id').range(f, t)))
              .map((x) => ({ id: x.product_id, name: x.name, sub: x.code, form: x.form }))
        if (off) return
        setSeasons(list); setProds(cat)
        setSeasonId((cur) => cur ?? list.find((x) => x.is_current)?.season_id ?? list[0]?.season_id ?? null)
      } catch (e) { if (!off) setError((e as Error).message) }
    })()
    return () => { off = true }
  }, [isPrz])

  useEffect(() => {
    if (seasonId == null) return
    let off = false
    setLoading(true)
    ;(async () => {
      try {
        const su = await fetchAll<Sup>((f, t) => supabase.from('supplier').select('*').order('name').range(f, t))
        const of = await fetchAll<Offer>((f, t) => supabase.from('offer').select('*').eq('season_id', seasonId).eq('module', module).order('offer_date', { ascending: false }).order('offer_id').range(f, t))
        const ln = await fetchAll<Line>((f, t) => supabase.from('offer_line').select('*').eq('season_id', seasonId)
          .not(isPrz ? 'prz_product_id' : 'fertilizer_product_id', 'is', null).order('offer_line_id').range(f, t))
        if (off) return
        setSups(su); setOffers(of); setLines(ln); setError(null)
      } catch (e) { if (!off) setError((e as Error).message) }
      if (!off) setLoading(false)
    })()
    return () => { off = true }
  }, [seasonId, module, isPrz, reload])

  const supName = useMemo(() => new Map(sups.map((s) => [s.supplier_id, s.name])), [sups])
  const prodById = useMemo(() => new Map(prods.map((p) => [p.id, p])), [prods])
  const pid = (l: Line) => (isPrz ? l.prz_product_id : l.fertilizer_product_id) ?? ''
  const linesBy = useMemo(() => {
    const m = new Map<string, Line[]>()
    for (const l of lines) { const a = m.get(l.offer_id) ?? []; a.push(l); m.set(l.offer_id, a) }
    return m
  }, [lines])
  // най-ниска нормализирана цена по продукт от неотхвърлените оферти
  const rejected = useMemo(() => new Set(offers.filter((o) => o.status === 'rejected').map((o) => o.offer_id)), [offers])
  const minBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of lines) { if (rejected.has(l.offer_id)) continue; const v = perBase(l.price, l.price_unit); const k = pid(l); if (!m.has(k) || v < (m.get(k) as number)) m.set(k, v) }
    return m
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, rejected])

  const view = useMemo(() => {
    const n = q.trim().toLowerCase()
    return offers.filter((o) => {
      if (!anyToken(fSup, (t) => o.supplier_id === t)) return false
      if (!anyToken(fStatus, (t) => o.status === t)) return false
      if (n) {
        const hay = `${supName.get(o.supplier_id) ?? ''} ${o.offer_no ?? ''} ${o.note ?? ''} ${(linesBy.get(o.offer_id) ?? []).map((l) => prodById.get(pid(l))?.name ?? '').join(' ')}`.toLowerCase()
        if (!hay.includes(n)) return false
      }
      return true
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers, fSup, fStatus, q, supName, linesBy, prodById])

  const seasonLabel = seasons.find((s) => s.season_id === seasonId)?.label ?? ''
  function exportXlsx() {
    const rows: (string | number | boolean | null)[][] = []
    for (const o of offers) for (const l of linesBy.get(o.offer_id) ?? []) {
      rows.push([seasonLabel, o.offer_date, o.offer_no, supName.get(o.supplier_id) ?? '', STATUS[o.status], o.valid_until, prodById.get(pid(l))?.name ?? '', l.price, l.price_unit === 't' ? 'евро/т' : l.price_unit === 'kg' ? 'евро/кг' : 'евро/л', l.is_preferred, o.note])
    }
    downloadXlsx(`оферти_${isPrz ? 'ПРЗ' : 'торове'}_${seasonLabel.replace('/', '-')}.xlsx`, 'Оферти', ['Сезон', 'Дата', '№ оферта', 'Доставчик', 'Статус', 'Валидна до', 'Продукт', 'Цена', 'Единица', 'Основна', 'Бележка'], rows)
  }
  const done = (m: string) => { setEdit(null); setFlash(m); setReload((r) => r + 1) }

  return (
    <>
      <div className="page-head">
        <h1>Оферти · {isPrz ? 'ПРЗ' : 'торове'}</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${view.length} от ${offers.length} оферти · ${lines.length} реда`}</span>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}
      {flash && <div className="banner" role="status" onClick={() => setFlash(null)}>{flash}</div>}

      <div className="filters">
        <label className="field">Сезон
          <select className="input" value={seasonId ?? ''} onChange={(e) => setSeasonId(Number(e.target.value))}>
            {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текущ)' : ''}</option>)}
          </select>
        </label>
        <label className="field grow">Търсене (доставчик, №, продукт)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">Доставчик
          <MultiFilter value={fSup} onChange={setFSup} ariaLabel="Доставчик" options={sups.map((s) => ({ value: s.supplier_id, label: s.name }))} />
        </label>
        <label className="field">Статус
          <MultiFilter value={fStatus} onChange={setFStatus} ariaLabel="Статус" options={(Object.keys(STATUS) as Status[]).map((k) => ({ value: k, label: STATUS[k] }))} />
        </label>
        <button className="btn outline" onClick={() => setSupOpen(true)}>Доставчици…</button>
        <button className="btn outline" onClick={exportXlsx} disabled={lines.length === 0}>Експорт в Excel</button>
        <button className="btn" onClick={() => setEdit({ offer: null })} disabled={seasonId == null}>+ Нова оферта</button>
      </div>

      <div className="card">
        <table className="grid">
          <thead>
            <tr><th>Дата</th><th>№</th><th>Доставчик</th><th>Валидна до</th><th className="num">Редове</th><th>Статус</th><th /></tr>
          </thead>
          <tbody>
            {view.map((o) => {
              const ls = linesBy.get(o.offer_id) ?? []
              const open = openId === o.offer_id
              return (
                <Fragment key={o.offer_id}>
                  <tr className={`row ${open ? 'open' : ''}`} onClick={() => setOpenId(open ? null : o.offer_id)}>
                    <td>{o.offer_date}</td>
                    <td>{o.offer_no ?? <span className="empty">—</span>}</td>
                    <td>{supName.get(o.supplier_id) ?? '—'}</td>
                    <td>{o.valid_until ?? <span className="empty">—</span>}</td>
                    <td className="num">{ls.length}</td>
                    <td><span className="chip">{STATUS[o.status]}</span></td>
                    <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn outline" style={{ minHeight: 28, padding: '0 7px' }} title="Редакция" aria-label="Редакция" onClick={() => setEdit({ offer: o })}>✎</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="detail"><td colSpan={7}>
                      <table className="grid">
                        <thead><tr><th>Продукт</th><th className="num">Цена</th><th>Единица</th><th>Основна</th><th>Спрямо най-ниската</th></tr></thead>
                        <tbody>
                          {ls.map((l) => {
                            const mn = minBy.get(pid(l)); const v = perBase(l.price, l.price_unit)
                            return (
                              <tr key={l.offer_line_id}>
                                <td>{prodById.get(pid(l))?.name ?? '—'}</td>
                                <td className="num">{fmtP(l.price)}</td>
                                <td>евро/{l.price_unit === 't' ? 'т' : l.price_unit === 'kg' ? 'кг' : 'л'}</td>
                                <td>{l.is_preferred ? '✓' : ''}</td>
                                <td>{mn == null || rejected.has(o.offer_id) ? '' : v <= mn + 1e-9 ? 'най-ниска' : `+${(((v / mn) - 1) * 100).toFixed(1)}%`}</td>
                              </tr>
                            )
                          })}
                          {ls.length === 0 && <tr><td colSpan={5} className="empty">Няма редове.</td></tr>}
                        </tbody>
                      </table>
                      {o.note && <div className="muted" style={{ marginTop: 6 }}>{o.note}</div>}
                    </td></tr>
                  )}
                </Fragment>
              )
            })}
            {!loading && view.length === 0 && <tr><td colSpan={7} className="empty">Още няма оферти за този сезон. Натисни „+ Нова оферта“.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && seasonId != null && (
        <OfferModal module={module} seasonId={seasonId} offer={edit.offer} sups={sups} prods={prods} lines={edit.offer ? linesBy.get(edit.offer.offer_id) ?? [] : []}
          pid={pid} onClose={() => setEdit(null)} onDone={done} onSuppliers={() => setSupOpen(true)} />
      )}
      {supOpen && <SuppliersModal sups={sups} onClose={() => setSupOpen(false)} onChanged={() => setReload((r) => r + 1)} />}
    </>
  )
}

// ───────── избор на продукт с търсене ─────────
function ProductPick({ value, prods, onChange, taken }: { value: string; prods: Prod[]; onChange: (id: string) => void; taken: Set<string> }) {
  const cur = prods.find((p) => p.id === value)
  const [text, setText] = useState(cur?.name ?? '')
  const [open, setOpen] = useState(false)
  useEffect(() => { setText(prods.find((p) => p.id === value)?.name ?? '') }, [value, prods])
  const n = norm(text)
  const list = open ? prods.filter((p) => !n || norm(p.name).includes(n) || norm(p.sub).includes(n)).slice(0, 30) : []
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <input className="input fi" placeholder="Продукт…" value={text} aria-label="Продукт"
        onChange={(e) => { setText(e.target.value); setOpen(true); if (value) onChange('') }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && list.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 60, left: 0, right: 0, top: '100%', maxHeight: 260, overflow: 'auto' }}>
          {list.map((p) => (
            <button key={p.id} type="button" className="nav-item" style={{ color: 'inherit', display: 'block', opacity: taken.has(p.id) ? 0.45 : 1 }}
              onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(p.id); setText(p.name); setOpen(false) }}>
              {p.name} {p.sub && <span className="muted" style={{ fontSize: 12 }}>· {p.sub.slice(0, 60)}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// ───────── оферта: заглавие + редове ─────────
function OfferModal({ module, seasonId, offer, sups, prods, lines, pid, onClose, onDone, onSuppliers }: {
  module: Module; seasonId: number; offer: Offer | null; sups: Sup[]; prods: Prod[]; lines: Line[]; pid: (l: Line) => string
  onClose: () => void; onDone: (m: string) => void; onSuppliers: () => void
}) {
  const isPrz = module === 'prz'
  const defUnit = (id: string): Unit => (isPrz ? 'l' : prods.find((p) => p.id === id)?.form === 'liquid' ? 'l' : 't')
  const [h, setH] = useState({
    supplier: offer?.supplier_id ?? '', no: offer?.offer_no ?? '', date: offer?.offer_date ?? new Date().toISOString().slice(0, 10),
    until: offer?.valid_until ?? '', status: (offer?.status ?? 'received') as Status, note: offer?.note ?? '',
  })
  const [rows, setRows] = useState<Draft[]>(() => lines.map((l) => ({ key: nk(), line_id: l.offer_line_id, product_id: pid(l), price: String(l.price), unit: l.price_unit, pref: l.is_preferred })))
  const [paste, setPaste] = useState('')
  const [pasteMsg, setPasteMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taken = new Set(rows.map((r) => r.product_id).filter(Boolean))
  const upd = (k: string, p: Partial<Draft>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...p } : r)))
  const num = (s: string) => Number(s.replace(',', '.'))

  function importPaste() {
    const out: Draft[] = []; const miss: string[] = []
    const byName = new Map(prods.map((p) => [norm(p.name), p]))
    for (const raw of paste.split('\n')) {
      const t = raw.trim(); if (!t) continue
      const parts = t.split(/\t|;/).map((x) => x.trim())
      if (parts.length < 2) { miss.push(t); continue }
      const price = num(parts[1].replace(/[^\d.,]/g, ''))
      const p = byName.get(norm(parts[0])) ?? prods.find((x) => norm(x.name).startsWith(norm(parts[0])))
      if (!p || !(price > 0)) { miss.push(parts[0]); continue }
      const u = (parts[2] ?? '').toLowerCase()
      const unit: Unit = u.startsWith('т') || u === 't' ? (isPrz ? 'kg' : 't') : u.startsWith('кг') || u === 'kg' ? 'kg' : u.startsWith('л') || u === 'l' ? 'l' : defUnit(p.id)
      if (!taken.has(p.id) && !out.some((r) => r.product_id === p.id)) out.push({ key: nk(), product_id: p.id, price: String(price), unit, pref: false })
    }
    setRows((rs) => [...rs, ...out]); setPaste('')
    setPasteMsg(`Добавени ${out.length} реда${miss.length ? `; не са разпознати (${miss.length}): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '…' : ''}` : ''}.`)
  }

  async function save() {
    setError(null)
    const sup = sups.find((s) => s.supplier_id === h.supplier)
    if (!sup) return setError('Избери доставчик (или го добави от „Доставчици…“).')
    if (h.until && h.until < h.date) return setError('„Валидна до“ не може да е преди датата на офертата.')
    const live = rows.filter((r) => r.product_id || r.price.trim())
    if (live.length === 0) return setError('Добави поне един ред.')
    const seen = new Set<string>()
    for (const r of live) {
      if (!r.product_id) return setError('Има ред без избран продукт (избери от списъка).')
      if (!(num(r.price) > 0)) return setError(`Цената на „${prods.find((p) => p.id === r.product_id)?.name}“ трябва да е число над 0.`)
      if (seen.has(r.product_id)) return setError(`„${prods.find((p) => p.id === r.product_id)?.name}“ е два пъти в офертата.`)
      seen.add(r.product_id)
    }
    setBusy(true)
    try {
      const head = { supplier_id: h.supplier, offer_no: h.no.trim() || null, offer_date: h.date, valid_until: h.until || null, status: h.status, note: h.note.trim() || null }
      let offerId = offer?.offer_id ?? ''
      if (offer) {
        const r = await supabase.from('offer').update(head).eq('offer_id', offerId).select('offer_id')
        if (r.error) throw new Error(r.error.message)
        if (!r.data?.length) throw new Error('Не е записано – вероятно нямате права.')
      } else {
        const r = await supabase.from('offer').insert({ ...head, organization_id: sup.organization_id, season_id: seasonId, module }).select('offer_id')
        if (r.error) throw new Error(r.error.message)
        offerId = (r.data ?? [])[0]?.offer_id
        if (!offerId) throw new Error('Офертата не е създадена – вероятно нямате права.')
      }
      const keep = new Set(live.filter((r) => r.line_id).map((r) => r.line_id))
      const gone = lines.filter((l) => !keep.has(l.offer_line_id)).map((l) => l.offer_line_id)
      if (gone.length) { const r = await supabase.from('offer_line').delete().in('offer_line_id', gone); if (r.error) throw new Error(r.error.message) }
      const col = isPrz ? 'prz_product_id' : 'fertilizer_product_id'
      for (const r of live.filter((x) => x.line_id)) {
        const u = await supabase.from('offer_line').update({ [col]: r.product_id, price: num(r.price), price_unit: r.unit, is_preferred: false }).eq('offer_line_id', r.line_id).select('offer_line_id')
        if (u.error) throw new Error(u.error.message)
      }
      const fresh = live.filter((x) => !x.line_id)
      if (fresh.length) {
        const ins = await supabase.from('offer_line').insert(fresh.map((r) => ({ offer_id: offerId, organization_id: sup.organization_id, season_id: seasonId, [col]: r.product_id, price: num(r.price), price_unit: r.unit, is_preferred: false }))).select('offer_line_id,' + col)
        if (ins.error) throw new Error(ins.error.message)
      }
      const prefProducts = live.filter((r) => r.pref).map((r) => r.product_id)
      if (prefProducts.length) {
        const ids = await supabase.from('offer_line').select(`offer_line_id,${col}`).eq('offer_id', offerId).in(col, prefProducts)
        if (ids.error) throw new Error(ids.error.message)
        for (const x of (ids.data ?? []) as { offer_line_id: string }[]) {
          const u = await supabase.from('offer_line').update({ is_preferred: true }).eq('offer_line_id', x.offer_line_id)
          if (u.error) throw new Error(u.error.message)
        }
      }
      onDone(`Оферта от „${sup.name}“ е записана (${live.length} реда).`)
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  async function del() {
    if (!offer) return
    setBusy(true); setError(null)
    const r = await supabase.from('offer').delete().eq('offer_id', offer.offer_id).select('offer_id')
    if (r.error) { setError(r.error.message); setBusy(false); return }
    if (!r.data?.length) { setError('Не е изтрита – вероятно нямате права.'); setBusy(false); return }
    onDone('Офертата е изтрита.')
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Оферта">
      <div className="modal" style={{ maxWidth: 980 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>{offer ? 'Редакция на оферта' : 'Нова оферта'} · {isPrz ? 'ПРЗ' : 'торове'}</h2>
          <button className="btn outline" onClick={onClose} disabled={busy}>Затвори</button>
        </div>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div className="filters" style={{ alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: '1 1 220px' }}>Доставчик *
            <select className="input" value={h.supplier} onChange={(e) => (e.target.value === '__new' ? onSuppliers() : setH({ ...h, supplier: e.target.value }))}>
              <option value="">—</option>
              {sups.filter((s) => s.is_active || s.supplier_id === h.supplier).map((s) => <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>)}
              <option value="__new">+ Нов доставчик…</option>
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 140px' }}>№ оферта<input className="input" value={h.no} onChange={(e) => setH({ ...h, no: e.target.value })} /></label>
          <label className="field" style={{ flex: '1 1 140px' }}>Дата *<input className="input" type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></label>
          <label className="field" style={{ flex: '1 1 140px' }}>Валидна до<input className="input" type="date" value={h.until} onChange={(e) => setH({ ...h, until: e.target.value })} /></label>
          <label className="field" style={{ flex: '1 1 160px' }}>Статус
            <select className="input" value={h.status} onChange={(e) => setH({ ...h, status: e.target.value as Status })}>
              {(Object.keys(STATUS) as Status[]).map((k) => <option key={k} value={k}>{STATUS[k]}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 100%' }}>Бележка<input className="input" value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} /></label>
        </div>

        <strong>Редове</strong>
        <div style={{ maxHeight: '40vh', overflow: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Продукт</th><th className="num" style={{ width: 120 }}>Цена (евро)</th><th style={{ width: 110 }}>Единица</th><th style={{ width: 80 }} title="Цената, която се ползва в плана за този продукт и сезон">Основна</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><ProductPick value={r.product_id} prods={prods} taken={taken} onChange={(id) => upd(r.key, { product_id: id, ...(id ? { unit: defUnit(id) } : {}) })} /></td>
                  <td className="num"><input className="input fi" style={{ textAlign: 'right' }} inputMode="decimal" aria-label="Цена" value={r.price} onChange={(e) => upd(r.key, { price: e.target.value.replace(',', '.') })} /></td>
                  <td>
                    <select className="input fi" aria-label="Единица" value={r.unit} onChange={(e) => upd(r.key, { unit: e.target.value as Unit })}>
                      <option value="l">евро/л</option><option value="kg">евро/кг</option>{!isPrz && <option value="t">евро/т</option>}
                    </select>
                  </td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" aria-label="Основна" checked={r.pref} onChange={(e) => upd(r.key, { pref: e.target.checked })} /></td>
                  <td><button className="btn outline" style={{ minHeight: 28, padding: '0 7px' }} aria-label="Премахни реда" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="empty">Няма редове. Добави ред или постави от Excel.</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn outline" onClick={() => setRows((rs) => [...rs, { key: nk(), product_id: '', price: '', unit: isPrz ? 'l' : 't', pref: false }])}>+ Добави ред</button>
        </div>
        <details>
          <summary style={{ cursor: 'pointer' }}>Постави редове от Excel</summary>
          <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>Всеки ред: продукт, цена и (по избор) единица – разделени с табулация или „;“. Продуктът се разпознава по име.</span>
            <textarea className="input" rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'БЕЛКАР\t18,50\tл\nПРОТИОСТАР\t42,00\tл'} />
            <div><button className="btn outline" onClick={importPaste} disabled={!paste.trim()}>Добави от текста</button></div>
            {pasteMsg && <span className="muted">{pasteMsg}</span>}
          </div>
        </details>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" onClick={save} disabled={busy}>{busy ? 'Записване…' : 'Запиши'}</button>
          <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
        </div>
        {offer && (
          <div style={{ borderTop: '1px solid var(--border, #ddd)', paddingTop: 12, textAlign: 'center' }}>
            {!confirmDel
              ? <button className="btn outline" style={{ color: '#a12b2b', borderColor: '#a12b2b', width: '100%' }} onClick={() => setConfirmDel(true)} disabled={busy}>Изтрий офертата…</button>
              : (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div className="banner err">Офертата и всичките ѝ {lines.length} реда ще бъдат изтрити. Не може да се върне.</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn" style={{ background: '#a12b2b', borderColor: '#a12b2b' }} onClick={del} disabled={busy}>Да, изтрий</button>
                    <button className="btn outline" onClick={() => setConfirmDel(false)} disabled={busy}>Отказ</button>
                  </div>
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  )
}

// ───────── доставчици ─────────
function SuppliersModal({ sups, onClose, onChanged }: { sups: Sup[]; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<Sup[]>(sups)
  const [name, setName] = useState('')
  const [eik, setEik] = useState('')
  const [org, setOrg] = useState<string | null>(sups[0]?.organization_id ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setList(sups) }, [sups])
  useEffect(() => {
    if (org) return
    supabase.from('organization').select('organization_id').limit(1).then((r: { data: { organization_id: string }[] | null }) => setOrg(r.data?.[0]?.organization_id ?? null))
  }, [org])

  async function add() {
    if (!name.trim()) return setError('Въведи име на доставчик.')
    if (!org) return setError('Не е намерена организация.')
    setBusy(true); setError(null)
    const r = await supabase.from('supplier').insert({ organization_id: org, name: name.trim(), eik: eik.trim() || null }).select('*')
    setBusy(false)
    if (r.error) return setError(/duplicate|unique/i.test(r.error.message) ? 'Доставчик с това име вече има.' : r.error.message)
    if (!r.data?.length) return setError('Не е записано – вероятно нямате права.')
    setList((l) => [...l, ...(r.data as Sup[])].sort((a, b) => a.name.localeCompare(b.name, 'bg'))); setName(''); setEik(''); onChanged()
  }
  async function patch(s: Sup, p: Partial<Sup>) {
    setError(null)
    const r = await supabase.from('supplier').update(p).eq('supplier_id', s.supplier_id).select('supplier_id')
    if (r.error) return setError(/duplicate|unique/i.test(r.error.message) ? 'Доставчик с това име вече има.' : r.error.message)
    if (!r.data?.length) return setError('Не е записано – вероятно нямате права.')
    setList((l) => l.map((x) => (x.supplier_id === s.supplier_id ? { ...x, ...p } : x))); onChanged()
  }
  async function remove(s: Sup) {
    if (!window.confirm(`Изтриване на доставчик „${s.name}“?`)) return
    setError(null)
    const r = await supabase.from('supplier').delete().eq('supplier_id', s.supplier_id).select('supplier_id')
    if (r.error) return setError(/foreign key|violates/i.test(r.error.message) ? `„${s.name}“ има оферти и не може да се изтрие. Маркирай го като неактивен.` : r.error.message)
    if (!r.data?.length) return setError('Не е изтрито – вероятно нямате права.')
    setList((l) => l.filter((x) => x.supplier_id !== s.supplier_id)); onChanged()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Доставчици">
      <div className="modal" style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Доставчици</h2>
          <button className="btn outline" onClick={onClose}>Затвори</button>
        </div>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div className="filters">
          <label className="field grow">Ново име<input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} /></label>
          <label className="field">ЕИК<input className="input" value={eik} onChange={(e) => setEik(e.target.value)} /></label>
          <button className="btn" onClick={add} disabled={busy}>+ Добави</button>
        </div>
        <div style={{ maxHeight: '45vh', overflow: 'auto' }}>
          <table className="grid">
            <thead><tr><th>Име</th><th>ЕИК</th><th>Активен</th><th /></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.supplier_id}>
                  <td><input className="input fi" defaultValue={s.name} aria-label="Име" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) void patch(s, { name: v }); else e.target.value = s.name }} /></td>
                  <td><input className="input fi" defaultValue={s.eik ?? ''} aria-label="ЕИК" onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== s.eik) void patch(s, { eik: v }) }} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={s.is_active} aria-label="Активен" onChange={(e) => void patch(s, { is_active: e.target.checked })} /></td>
                  <td><button className="btn outline" style={{ minHeight: 28, padding: '0 7px' }} aria-label={`Изтрий ${s.name}`} onClick={() => void remove(s)}>🗑</button></td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={4} className="empty">Още няма доставчици.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

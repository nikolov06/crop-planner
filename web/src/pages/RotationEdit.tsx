import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Редакция, добавяне и изтриване на БЗС от екрана „Сеитбооборот“.
// Работи върху текущия сезон (основна култура) и – по избор – върху предходните четири.

type Opt = { id: string; label: string }
type Lookups = {
  season: { season_id: number; year_end: number; label: string; start_date: string }
  crops: Opt[]
  companies: (Opt & { org: string })[]
  bases: (Opt & { org: string })[]
  settlements: Opt[]
  potentials: Opt[]
  tillages: Opt[]
  t2Ok: boolean // има ли колона tillage2_id (миграция 20261116130000)
}

const msg = (e: { message: string } | null) => e?.message ?? ''

function useLookups() {
  const [d, setD] = useState<Lookups | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const [season, crops, companies, bases, settlements, pot, til] = await Promise.all([
          supabase.from('season').select('season_id,year_end,label,start_date').eq('is_current', true).limit(1),
          supabase.from('crop').select('crop_id,name_bg').eq('is_active', true).order('name_bg'),
          supabase.from('company').select('company_id,name,organization_id').eq('is_active', true).order('name'),
          supabase.from('farm_base').select('farm_base_id,name,organization_id').eq('is_active', true).order('name'),
          supabase.from('settlement').select('settlement_id,name,ekatte').order('name').limit(5000),
          supabase.from('potential_class').select('potential_id,name_bg').order('sort_order'),
          supabase.from('tillage_type').select('tillage_id,name_bg').eq('is_active', true).order('name_bg'),
        ])
        for (const r of [season, crops, companies, bases, settlements, pot, til]) if (r.error) throw new Error(r.error.message)
        const t2 = await supabase.from('field_planting').select('tillage2_id').limit(1)
        const s = (season.data ?? [])[0]
        if (!s) throw new Error('Няма текущ сезон.')
        if (off) return
        setD({
          season: s as Lookups['season'],
          crops: (crops.data ?? []).map((x: { crop_id: string; name_bg: string }) => ({ id: x.crop_id, label: x.name_bg })),
          companies: (companies.data ?? []).map((x: { company_id: string; name: string; organization_id: string }) => ({ id: x.company_id, label: x.name, org: x.organization_id })),
          bases: (bases.data ?? []).map((x: { farm_base_id: string; name: string; organization_id: string }) => ({ id: x.farm_base_id, label: x.name, org: x.organization_id })),
          settlements: (settlements.data ?? []).map((x: { settlement_id: string; name: string; ekatte: string | null }) => ({ id: x.settlement_id, label: x.name + (x.ekatte ? ' · ' + x.ekatte : '') })),
          potentials: (pot.data ?? []).map((x: { potential_id: number; name_bg: string }) => ({ id: String(x.potential_id), label: x.name_bg })),
          tillages: (til.data ?? []).map((x: { tillage_id: number; name_bg: string }) => ({ id: String(x.tillage_id), label: x.name_bg })),
          t2Ok: !t2.error,
        })
      } catch (e) { if (!off) setErr((e as Error).message) }
    })()
    return () => { off = true }
  }, [])
  return { d, err }
}

const Sel = ({ label, value, onChange, opts, empty = '—', required, disabled }: { label: string; value: string; onChange: (v: string) => void; opts: Opt[]; empty?: string; required?: boolean; disabled?: boolean }) => (
  <label className="field" style={{ flex: '1 1 240px' }}>
    {label}{required ? ' *' : ''}
    <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  </label>
)
const Txt = ({ label, value, onChange, required, num, hint }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; num?: boolean; hint?: string }) => (
  <label className="field" style={{ flex: '1 1 240px' }}>
    {label}{required ? ' *' : ''}
    <input className="input" inputMode={num ? 'decimal' : undefined} value={value} onChange={(e) => onChange(num ? e.target.value.replace(',', '.') : e.target.value)} />
    {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
  </label>
)

const parseArea = (s: string): number | null => {
  const n = Number(s.replace(',', '.'))
  return s.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

// проверка на двете почвообработки
function tillageProblem(t1: string, t2: string): string | null {
  if (t2 && !t1) return 'Втората обработка изисква първа.'
  if (t2 && t1 === t2) return 'Втората обработка не може да съвпада с първата.'
  return null
}

// ───────────────────────── редакция ─────────────────────────
type PL = { planting_id: string; fcy_id: string; season_year_end: number; crop_id: string; planted_area_da: number; tillage_id: number | null; company_id: string | null; potential_id: number | null; field_name: string | null; isak_number: string | null; is_locked: boolean }

export function FieldEditModal({ fieldId, fieldName, onClose, onDone, onDelete }: { fieldId: string; fieldName: string; onClose: () => void; onDone: (m: string) => void; onDelete?: () => void }) {
  const { d, err } = useLookups()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [org, setOrg] = useState<string | null>(null)
  const [pls, setPls] = useState<Record<number, PL>>({}) // по година на сезона
  const [t2, setT2] = useState<Record<string, number | null>>({}) // planting_id -> tillage2_id
  const [seeds, setSeeds] = useState<Record<string, number>>({}) // planting_id -> брой сортове
  const [fcyCur, setFcyCur] = useState<string | null>(null)
  const [f, setF] = useState({ name: '', isak: '', company: '', potential: '', crop: '', area: '', t1: '', t2: '' })

  useEffect(() => {
    if (!d) return
    let off = false
    ;(async () => {
      try {
        const ye = d.season.year_end
        const fl = await supabase.from('field').select('organization_id').eq('field_id', fieldId).limit(1)
        if (fl.error) throw new Error(fl.error.message)
        const ctx = await supabase.from('v_planting_context')
          .select('planting_id,fcy_id,season_year_end,crop_id,planted_area_da,tillage_id,company_id,potential_id,field_name,isak_number,is_locked')
          .eq('field_id', fieldId).eq('role', 'main').eq('season_year_end', ye)
        if (ctx.error) throw new Error(ctx.error.message)
        const map: Record<number, PL> = {}
        for (const r of (ctx.data ?? []) as PL[]) map[r.season_year_end] = r
        const ids = Object.values(map).map((p) => p.planting_id)
        const t2m: Record<string, number | null> = {}
        if (d.t2Ok && ids.length) {
          const r = await supabase.from('field_planting').select('planting_id,tillage2_id').in('planting_id', ids)
          for (const x of (r.data ?? []) as { planting_id: string; tillage2_id: number | null }[]) t2m[x.planting_id] = x.tillage2_id
        }
        const sm: Record<string, number> = {}
        if (ids.length) {
          const r = await supabase.from('planting_seed').select('planting_id').in('planting_id', ids)
          for (const x of (r.data ?? []) as { planting_id: string }[]) sm[x.planting_id] = (sm[x.planting_id] ?? 0) + 1
        }
        let fcy: string | null = map[ye]?.fcy_id ?? null
        let curRow: { field_name: string | null; isak_number: string | null; company_id: string | null; potential_id: number | null } | null = map[ye] ?? null
        if (!fcy) {
          const r = await supabase.from('field_crop_year').select('fcy_id,field_name,isak_number,company_id,potential_id').eq('field_id', fieldId).eq('season_id', d.season.season_id).limit(1)
          const x = (r.data ?? [])[0] as { fcy_id: string; field_name: string | null; isak_number: string | null; company_id: string | null; potential_id: number | null } | undefined
          if (x) { fcy = x.fcy_id; curRow = x }
        }
        if (off) return
        setOrg(((fl.data ?? [])[0] as { organization_id: string } | undefined)?.organization_id ?? null)
        setPls(map); setT2(t2m); setSeeds(sm); setFcyCur(fcy)
        const cp = map[ye]
        setF({
          name: curRow?.field_name ?? fieldName, isak: curRow?.isak_number ?? '', company: curRow?.company_id ?? '',
          potential: curRow?.potential_id != null ? String(curRow.potential_id) : '',
          crop: cp?.crop_id ?? '', area: cp ? String(cp.planted_area_da) : '',
          t1: cp?.tillage_id != null ? String(cp.tillage_id) : '', t2: cp && t2m[cp.planting_id] != null ? String(t2m[cp.planting_id]) : '',
        })
      } catch (e) { if (!off) setError((e as Error).message) }
      if (!off) setLoading(false)
    })()
    return () => { off = true }
  }, [d, fieldId, fieldName])

  const ye = d?.season.year_end ?? 0
  const cur = pls[ye]
  const cropChanged = !!cur && f.crop !== cur.crop_id
  const seedsAffected = cropChanged ? seeds[cur.planting_id] ?? 0 : 0
  const problem = tillageProblem(f.t1, f.t2)

  async function removeSeeds(plantingId: string) {
    const r = await supabase.from('planting_seed').delete().eq('planting_id', plantingId)
    if (r.error) throw new Error(msg(r.error))
  }

  async function save() {
    if (!d || !org) return
    setError(null)
    if (problem) return setError(problem)
    if (!f.name.trim()) return setError('Наименованието е задължително.')
    const area = f.area.trim() === '' ? null : parseArea(f.area)
    if (f.area.trim() !== '' && area == null) return setError('Площта трябва да е число над 0.')
    if (!cur && (f.crop || area != null) && !(f.crop && area != null)) return setError('За нов запис в сезона са нужни и култура, и площ.')
    setBusy(true)
    const steps: string[] = []
    try {
      // 1. годишна регистрация (име, ИСАК, фирма, потенциал)
      const fcyData = { field_name: f.name.trim(), isak_number: f.isak.trim() || null, company_id: f.company || null, potential_id: f.potential ? Number(f.potential) : null }
      let fcyId = fcyCur
      if (fcyId) {
        const before = cur ?? null
        const changed = !before || before.field_name !== fcyData.field_name || (before.isak_number ?? null) !== fcyData.isak_number
          || (before.company_id ?? null) !== fcyData.company_id || (before.potential_id ?? null) !== fcyData.potential_id
        if (changed) {
          const r = await supabase.from('field_crop_year').update(fcyData).eq('fcy_id', fcyId).select('fcy_id')
          if (r.error) throw new Error(msg(r.error))
          if (!r.data?.length) throw new Error('Данните за БЗС не са записани – вероятно нямате права.')
          steps.push('данни за БЗС')
        }
      } else if (f.crop && area != null) {
        const r = await supabase.from('field_crop_year').insert({ organization_id: org, field_id: fieldId, season_id: d.season.season_id, ...fcyData }).select('fcy_id')
        if (r.error) throw new Error(msg(r.error))
        fcyId = (r.data ?? [])[0]?.fcy_id ?? null
        steps.push('регистрация за сезона')
      }
      // 2. основна култура на сезона
      const t1 = f.t1 ? Number(f.t1) : null
      const t2v = f.t1 && f.t2 ? Number(f.t2) : null
      if (cur) {
        if (seedsAffected > 0) await removeSeeds(cur.planting_id)
        const patch: Record<string, unknown> = {}
        if (f.crop && f.crop !== cur.crop_id) patch.crop_id = f.crop
        if (area != null && area !== Number(cur.planted_area_da)) patch.planted_area_da = area
        if (t1 !== (cur.tillage_id ?? null)) patch.tillage_id = t1
        if (d.t2Ok && (t2v !== (t2[cur.planting_id] ?? null) || t1 !== (cur.tillage_id ?? null))) patch.tillage2_id = t2v
        // при смяна на първата към празна втората се чисти; при нова първа записът може да изисква ред: първо чистим втората
        if (Object.keys(patch).length) {
          if (d.t2Ok && 'tillage_id' in patch && t2v == null && (t2[cur.planting_id] ?? null) != null) patch.tillage2_id = null
          const r = await supabase.from('field_planting').update(patch).eq('planting_id', cur.planting_id).select('planting_id')
          if (r.error) throw new Error(msg(r.error))
          if (!r.data?.length) throw new Error('Културата/площта не са записани – вероятно нямате права или периодът е заключен.')
          steps.push('култура / площ / почвообработка')
        }
      } else if (fcyId && f.crop && area != null) {
        const row: Record<string, unknown> = { organization_id: org, fcy_id: fcyId, role: 'main', crop_id: f.crop, planted_area_da: area, tillage_id: t1 }
        if (d.t2Ok) row.tillage2_id = t2v
        const r = await supabase.from('field_planting').insert(row).select('planting_id')
        if (r.error) throw new Error(msg(r.error))
        steps.push('нова култура за сезона')
      }
      onDone(steps.length ? `БЗС „${f.name.trim()}“: записано (${steps.join(', ')}).` : 'Няма промени за записване.')
    } catch (e) {
      setError(`${(e as Error).message}${steps.length ? ` (вече записано: ${steps.join(', ')})` : ''}`)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Редакция на БЗС">
      <div className="modal" style={{ maxWidth: 820 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Редакция: {fieldName}{d ? ` · ${d.season.label}` : ''}</h2>
          <button className="btn outline" onClick={onClose} disabled={busy}>Затвори</button>
        </div>
        {(err || error) && <div className="banner err" role="alert">{err ?? error}</div>}
        {(loading || !d) && !err ? <span className="muted">Зареждане…</span> : d && (
          <>
            <div className="filters" style={{ alignItems: 'flex-start' }}>
              <Txt label="Наименование" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
              <Txt label="БЗС № (ИСАК)" value={f.isak} onChange={(v) => setF({ ...f, isak: v })} />
              <Sel label="Фирма" value={f.company} onChange={(v) => setF({ ...f, company: v })} opts={d.companies} />
              <Sel label="Потенциал" value={f.potential} onChange={(v) => setF({ ...f, potential: v })} opts={d.potentials} />
              <Sel label={`Култура ${d.season.label}`} value={f.crop} onChange={(v) => setF({ ...f, crop: v })} opts={d.crops} />
              <Txt label="Площ, дка" value={f.area} onChange={(v) => setF({ ...f, area: v })} num />
              <Sel label="Почвообработка" value={f.t1} onChange={(v) => setF({ ...f, t1: v, t2: v ? f.t2 : '' })} opts={d.tillages} />
              {d.t2Ok && <Sel label="Втора обработка (по избор)" value={f.t2} onChange={(v) => setF({ ...f, t2: v })} opts={d.tillages} disabled={!f.t1} />}
            </div>
            {!cur && <div className="banner">За този сезон полето още няма култура. Ако зададеш култура и площ, ще се създаде запис.</div>}
            {cur?.is_locked && <div className="banner err">Периодът е заключен – записът ще бъде отказан.</div>}
            {seedsAffected > 0 && <div className="banner err">Смяна на културата ще премахне {seedsAffected} ред(а) със сортове за този сезон (сортът е на старата култура). Ще трябва да ги зададеш наново в „Планиране семена“.</div>}
            {problem && <div className="banner err" role="alert">{problem}</div>}
            <span className="muted" style={{ fontSize: 13 }}>Стопанската база и землището не се променят оттук (имат история по периоди).</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={save} disabled={busy || !!problem}>{busy ? 'Записване…' : 'Запиши'}</button>
              <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
            </div>
            {onDelete && (
              <div style={{ borderTop: '1px solid var(--border, #ddd)', paddingTop: 12, marginTop: 4, textAlign: 'center' }}>
                <button className="btn outline" style={{ color: '#a12b2b', borderColor: '#a12b2b', width: '100%' }} onClick={onDelete} disabled={busy}>Изтрий БЗС…</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ───────────────────────── ново БЗС ─────────────────────────
export function FieldAddModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { d, err } = useLookups()
  const [f, setF] = useState({ name: '', isak: '', company: '', base: '', settlement: '', potential: '', crop: '', area: '', t1: '', t2: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = tillageProblem(f.t1, f.t2)

  async function save() {
    if (!d) return
    setError(null)
    if (problem) return setError(problem)
    if (!f.name.trim()) return setError('Наименованието е задължително.')
    if (!f.company) return setError('Изберете фирма.')
    if (!f.base) return setError('Изберете стопанска база.')
    if (!f.crop) return setError('Изберете култура.')
    const area = parseArea(f.area)
    if (area == null) return setError('Площта трябва да е число над 0.')
    const base = d.bases.find((b) => b.id === f.base)
    if (!base) return setError('Невалидна стопанска база.')
    setBusy(true)
    let fieldId: string | null = null
    try {
      const fr = await supabase.from('field').insert({ organization_id: base.org, current_farm_base_id: base.id, settlement_id: f.settlement || null }).select('field_id')
      if (fr.error) throw new Error(msg(fr.error))
      fieldId = (fr.data ?? [])[0]?.field_id ?? null
      if (!fieldId) throw new Error('Полето не е създадено – вероятно нямате права.')
      const fb = await supabase.from('field_base').insert({ organization_id: base.org, field_id: fieldId, farm_base_id: base.id, valid_from: d.season.start_date })
      if (fb.error) throw new Error(msg(fb.error))
      const fy = await supabase.from('field_crop_year').insert({
        organization_id: base.org, field_id: fieldId, season_id: d.season.season_id, company_id: f.company, field_name: f.name.trim(),
        isak_number: f.isak.trim() || null, potential_id: f.potential ? Number(f.potential) : null,
      }).select('fcy_id')
      if (fy.error) throw new Error(msg(fy.error))
      const fcyId = (fy.data ?? [])[0]?.fcy_id
      const row: Record<string, unknown> = {
        organization_id: base.org, fcy_id: fcyId, role: 'main', crop_id: f.crop, planted_area_da: area, tillage_id: f.t1 ? Number(f.t1) : null,
      }
      if (d.t2Ok) row.tillage2_id = f.t1 && f.t2 ? Number(f.t2) : null
      const pl = await supabase.from('field_planting').insert(row).select('planting_id')
      if (pl.error) throw new Error(msg(pl.error))
      onDone(`Ново БЗС „${f.name.trim()}“ е добавено (${d.season.label}).`)
    } catch (e) {
      // връщане: изтриваме полето (каскадно махa и записаното към него)
      if (fieldId) await supabase.from('field').delete().eq('field_id', fieldId)
      setError(`${(e as Error).message} Нищо не е записано.`)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Ново БЗС">
      <div className="modal" style={{ maxWidth: 820 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Ново БЗС{d ? ` · ${d.season.label}` : ''}</h2>
          <button className="btn outline" onClick={onClose} disabled={busy}>Затвори</button>
        </div>
        {(err || error) && <div className="banner err" role="alert">{err ?? error}</div>}
        {!d && !err ? <span className="muted">Зареждане…</span> : d && (
          <>
            <div className="filters" style={{ alignItems: 'flex-start' }}>
              <Txt label="Наименование" value={f.name} onChange={(v) => setF({ ...f, name: v })} required />
              <Txt label="БЗС № (ИСАК)" value={f.isak} onChange={(v) => setF({ ...f, isak: v })} />
              <Sel label="Фирма" value={f.company} onChange={(v) => setF({ ...f, company: v })} opts={d.companies} required />
              <Sel label="Стопанска база" value={f.base} onChange={(v) => setF({ ...f, base: v })} opts={d.bases} required />
              <Sel label="Землище" value={f.settlement} onChange={(v) => setF({ ...f, settlement: v })} opts={d.settlements} />
              <Sel label="Потенциал" value={f.potential} onChange={(v) => setF({ ...f, potential: v })} opts={d.potentials} />
              <Sel label={`Култура ${d.season.label}`} value={f.crop} onChange={(v) => setF({ ...f, crop: v })} opts={d.crops} required />
              <Txt label="Площ, дка" value={f.area} onChange={(v) => setF({ ...f, area: v })} num required />
              <Sel label="Почвообработка" value={f.t1} onChange={(v) => setF({ ...f, t1: v, t2: v ? f.t2 : '' })} opts={d.tillages} />
              {d.t2Ok && <Sel label="Втора обработка (по избор)" value={f.t2} onChange={(v) => setF({ ...f, t2: v })} opts={d.tillages} disabled={!f.t1} />}
            </div>
            {problem && <div className="banner err" role="alert">{problem}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={save} disabled={busy || !!problem}>{busy ? 'Записване…' : 'Добави'}</button>
              <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ───────────────────────── изтриване ─────────────────────────
export function FieldDeleteModal({ fieldId, fieldName, onClose, onDone }: { fieldId: string; fieldName: string; onClose: () => void; onDone: (m: string) => void }) {
  const [counts, setCounts] = useState<{ years: number; plantings: number; seeds: number } | null>(null)
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const y = await supabase.from('field_crop_year').select('fcy_id').eq('field_id', fieldId)
        if (y.error) throw new Error(y.error.message)
        const fcys = (y.data ?? []).map((x: { fcy_id: string }) => x.fcy_id)
        let plantings: string[] = []
        if (fcys.length) {
          const p = await supabase.from('field_planting').select('planting_id').in('fcy_id', fcys)
          plantings = (p.data ?? []).map((x: { planting_id: string }) => x.planting_id)
        }
        let seeds = 0
        if (plantings.length) {
          const s = await supabase.from('planting_seed').select('planting_seed_id', { count: 'exact', head: true }).in('planting_id', plantings)
          seeds = s.count ?? 0
        }
        if (!off) setCounts({ years: fcys.length, plantings: plantings.length, seeds })
      } catch (e) { if (!off) setError((e as Error).message) }
    })()
    return () => { off = true }
  }, [fieldId])

  async function del() {
    setBusy(true); setError(null)
    const r = await supabase.from('field').delete().eq('field_id', fieldId).select('field_id')
    setBusy(false)
    if (r.error) {
      return setError(/foreign key|violates/i.test(r.error.message)
        ? `БЗС е свързано с други записи (напр. произход от деление) и не може да се изтрие. (${r.error.message})` : r.error.message)
    }
    if (!r.data?.length) return setError('Не е изтрито – вероятно нямате права.')
    onDone(`БЗС „${fieldName}“ е изтрито.`)
  }

  return (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Изтриване на БЗС">
      <div className="modal" style={{ maxWidth: 560 }}>
        <h2>Изтриване на БЗС</h2>
        <p style={{ margin: 0 }}>
          Ще изтриеш „<strong>{fieldName}</strong>“ <strong>напълно</strong>, с цялата му история. Действието не може да се върне.
        </p>
        {counts && (
          <div className="banner err">
            Заедно с него се изтриват: {counts.years} годишни записа, {counts.plantings} култури по сезони
            {counts.seeds > 0 ? `, ${counts.seeds} реда със сортове` : ''}, както и свързаните торове и ПРЗ по тези периоди.
          </div>
        )}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Разбирам, че цялата история на това БЗС се изтрива
        </label>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" style={{ background: '#a12b2b', borderColor: '#a12b2b' }} onClick={del} disabled={!ok || busy || !counts}>{busy ? 'Изтриване…' : 'Изтрий'}</button>
          <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────── групова промяна (текущ сезон) ─────────────────────────
const CLEAR = '__clear'
const chunk = <T,>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }

export function BulkModal({ fieldIds, onClose, onDone }: { fieldIds: string[]; onClose: () => void; onDone: (m: string) => void }) {
  const { d, err } = useLookups()
  const [pls, setPls] = useState<{ planting_id: string; field_id: string; crop_id: string; tillage_id: number | null; t2: number | null; seeds: number }[] | null>(null)
  const [crop, setCrop] = useState('')
  const [t1, setT1] = useState('')
  const [t2, setT2] = useState('')
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!d) return
    let off = false
    ;(async () => {
      try {
        const ye = d.season.year_end
        const out: { planting_id: string; field_id: string; crop_id: string; tillage_id: number | null; t2: number | null; seeds: number }[] = []
        for (const ids of chunk(fieldIds, 80)) {
          const r = await supabase.from('v_planting_context').select('planting_id,field_id,crop_id,tillage_id').eq('role', 'main').eq('season_year_end', ye).in('field_id', ids)
          if (r.error) throw new Error(r.error.message)
          for (const x of (r.data ?? []) as { planting_id: string; field_id: string; crop_id: string; tillage_id: number | null }[]) out.push({ ...x, t2: null, seeds: 0 })
        }
        const byPl = new Map(out.map((p) => [p.planting_id, p]))
        for (const ids of chunk(out.map((p) => p.planting_id), 80)) {
          if (d.t2Ok) {
            const r = await supabase.from('field_planting').select('planting_id,tillage2_id').in('planting_id', ids)
            for (const x of (r.data ?? []) as { planting_id: string; tillage2_id: number | null }[]) { const p = byPl.get(x.planting_id); if (p) p.t2 = x.tillage2_id }
          }
          const s = await supabase.from('planting_seed').select('planting_id').in('planting_id', ids)
          for (const x of (s.data ?? []) as { planting_id: string }[]) { const p = byPl.get(x.planting_id); if (p) p.seeds++ }
        }
        if (!off) setPls(out)
      } catch (e) { if (!off) setError((e as Error).message) }
    })()
    return () => { off = true }
  }, [d, fieldIds])

  const skipped = pls ? fieldIds.length - pls.length : 0
  const cropChanging = pls && crop ? pls.filter((p) => p.crop_id !== crop) : []
  const seedsLost = cropChanging.reduce((a, p) => a + (p.seeds > 0 ? 1 : 0), 0)
  // резултатни стойности на обработките и проверка на правилата
  const fin = (p: NonNullable<typeof pls>[number]) => {
    const a = t1 === '' ? p.tillage_id : t1 === CLEAR ? null : Number(t1)
    let b = t2 === '' ? p.t2 : t2 === CLEAR ? null : Number(t2)
    if (a == null) b = (t2 !== '' && t2 !== CLEAR) ? b : null
    return { a, b }
  }
  const bad = pls ? pls.filter((p) => { const { a, b } = fin(p); return b != null && (a == null || a === b) }).length : 0
  const nothing = !crop && !t1 && !t2

  async function apply() {
    if (!pls || !d) return
    setBusy(true); setError(null)
    const ids = pls.map((p) => p.planting_id)
    const patch: Record<string, unknown> = {}
    if (crop) patch.crop_id = crop
    if (t1) patch.tillage_id = t1 === CLEAR ? null : Number(t1)
    if (d.t2Ok) {
      if (t2) patch.tillage2_id = t2 === CLEAR ? null : Number(t2)
      else if (t1 === CLEAR) patch.tillage2_id = null
    }
    let done = 0
    try {
      if (crop) {
        const withSeeds = cropChanging.filter((p) => p.seeds > 0).map((p) => p.planting_id)
        for (const c of chunk(withSeeds, 80)) {
          const r = await supabase.from('planting_seed').delete().in('planting_id', c)
          if (r.error) throw new Error(r.error.message)
        }
      }
      for (const c of chunk(ids, 80)) {
        const r = await supabase.from('field_planting').update(patch).in('planting_id', c).select('planting_id')
        if (r.error) throw new Error(r.error.message)
        done += r.data?.length ?? 0
      }
      if (done < ids.length) throw new Error(`Записани са само ${done} от ${ids.length} – вероятно липсват права или периодът е заключен за част от БЗС.`)
      onDone(`Променени ${done} БЗС (${[crop ? 'култура' : '', t1 || t2 ? 'почвообработка' : ''].filter(Boolean).join(' и ')}).`)
    } catch (e) {
      setError(`${(e as Error).message}${done ? ` (вече записани: ${done})` : ''}`)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Групова промяна">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Промяна за {fieldIds.length} БЗС{d ? ` · ${d.season.label}` : ''}</h2>
          <button className="btn outline" onClick={onClose} disabled={busy}>Затвори</button>
        </div>
        {(err || error) && <div className="banner err" role="alert">{err ?? error}</div>}
        {!d || !pls ? (!err && !error && <span className="muted">Зареждане…</span>) : (
          <>
            <span className="muted">Променя само основната култура на текущия сезон. Полетата, оставени на „без промяна“, не се пипат.</span>
            <div className="filters" style={{ alignItems: 'flex-start' }}>
              <Sel label="Култура" value={crop} onChange={setCrop} opts={d.crops} empty="— без промяна —" />
              <Sel label="Почвообработка" value={t1} onChange={setT1} opts={[{ id: CLEAR, label: '— изчисти —' }, ...d.tillages]} empty="— без промяна —" />
              {d.t2Ok && <Sel label="Втора обработка" value={t2} onChange={setT2} opts={[{ id: CLEAR, label: '— изчисти —' }, ...d.tillages]} empty="— без промяна —" />}
            </div>
            {skipped > 0 && <div className="banner">{skipped} от избраните БЗС нямат основна култура за този сезон и ще бъдат пропуснати.</div>}
            {bad > 0 && <div className="banner err" role="alert">За {bad} БЗС резултатът е невалиден: втората обработка изисква първа и не може да е равна на нея.</div>}
            {seedsLost > 0 && (
              <>
                <div className="banner err">Смяната на културата ще изтрие редовете със сортове при {seedsLost} БЗС (за тях се задават наново в „Планиране семена“).</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Разбирам и съм съгласен</label>
              </>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={apply} disabled={busy || nothing || bad > 0 || pls.length === 0 || (seedsLost > 0 && !ok)}>{busy ? 'Записване…' : `Приложи за ${pls.length} БЗС`}</button>
              <button className="btn outline" onClick={onClose} disabled={busy}>Отказ</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

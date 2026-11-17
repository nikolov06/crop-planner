import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import shp from 'shpjs'
import { supabase } from '../lib/supabase'
import { fmtArea } from '../lib/format'
import {
  MISSING_MSG, areaDa, closestName, createMap, escapeHtml, fetchPaged, looksWgs84, missingViews, normName, to2D,
  type GeoRow, type SeasonRow,
} from '../lib/geo'
import { countBzs, emptyOf, loadWorkFields, moveBzs, type Bzs, type WFStat } from '../lib/workfields'

// Геометрии: качване на SHP (.zip) от JD Operations Center, автоматично мачване по име,
// ръчно свързване, ново обработваемо поле от полигон + преместване на БЗС, изтриване на празни полета.
type WF = WFStat & { bzsArea: number | null }
type Poly = { idx: number; name: string; jdId: string | null; geom: GeoJSON.Geometry; area: number; matchId: string | null; linked: boolean }
type Tab = 'unmatched' | 'nogeom' | 'empty'
type Mode = 'existing' | 'new'

const C_UNMATCHED = '#f97316'
const C_MATCHED = '#22c55e'
const C_SELECTED = '#facc15'
const C_LINKED = '#38bdf8'

function rpcError(msg: string): string {
  if (/duplicate key|23505|work_field_organization_id_name_key/i.test(msg) && /name/i.test(msg)) return 'Вече има обработваемо поле с това име.'
  if (/duplicate key|23505/i.test(msg) && /jd_field/i.test(msg)) return 'Този JD идентификатор вече е записан на друго обработваемо поле.'
  if (/permission denied|42501|row-level security|нямаш право/i.test(msg)) return `Нямаш права за редакция на обработваемите полета. (${msg})`
  if (missingViews(msg)) return MISSING_MSG
  return msg
}
const pct = (a: number, b: number | null) => (b && b > 0 ? Math.round(((a - b) / b) * 100) : null)
const pctText = (p: number | null) => (p == null ? '' : `${p > 0 ? '+' : ''}${p}%`)

export default function Geometries() {
  const [wfs, setWfs] = useState<WF[]>([])
  const [bzs, setBzs] = useState<Bzs[]>([])
  const [existing, setExisting] = useState<GeoRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  const [fileName, setFileName] = useState('')
  const [rawProps, setRawProps] = useState<Record<string, unknown>[]>([])
  const [rawGeoms, setRawGeoms] = useState<GeoJSON.Geometry[]>([])
  const [attrs, setAttrs] = useState<string[]>([])
  const [nameAttr, setNameAttr] = useState('')
  const [idAttr, setIdAttr] = useState('')
  const [linked, setLinked] = useState<Set<number>>(new Set())
  const [parseErr, setParseErr] = useState<string | null>(null)

  const [tab, setTab] = useState<Tab>('unmatched')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<Mode>('existing')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [tq, setTq] = useState('')
  const [newName, setNewName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [pickBzs, setPickBzs] = useState<string[]>([])
  const [bq, setBq] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<{ text: string; err: boolean } | null>(null)

  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const exLayer = useRef<L.GeoJSON | null>(null)
  const fileLayer = useRef<L.GeoJSON | null>(null)
  const fitted = useRef(false)

  // обработваеми полета с броя БЗС, съществуващи граници и площ на БЗС за текущия сезон
  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const [{ wfs: w, bzs: b }, g] = await Promise.all([
          loadWorkFields(),
          fetchPaged<GeoRow>((f, t) => supabase.from('v_work_field_geojson')
            .select('work_field_id,name,name_bg,jd_field_id,geojson,polygon_area_da').order('work_field_id').range(f, t)),
        ])
        const s = await supabase.from('season').select('season_id').eq('is_current', true).limit(1)
        if (s.error) throw new Error(s.error.message)
        const sid = (s.data?.[0] as { season_id: number } | undefined)?.season_id
        const sr = sid == null ? [] : await fetchPaged<Pick<SeasonRow, 'work_field_id' | 'bzs_area_da'>>((f, t) =>
          supabase.from('v_work_field_season').select('work_field_id,bzs_area_da').eq('season_id', sid).order('work_field_id').range(f, t))
        if (off) return
        const area = new Map(sr.map((x) => [x.work_field_id, Number(x.bzs_area_da)]))
        setWfs(w.map((x) => ({ ...x, bzsArea: area.get(x.work_field_id) ?? null })))
        setBzs(b)
        setExisting(g)
        setError(null)
      } catch (e) {
        if (!off) { const m = (e as Error).message; setError(missingViews(m) ? MISSING_MSG : m) }
      }
      if (!off) setLoading(false)
    })()
    return () => { off = true }
  }, [reload])

  const wfById = useMemo(() => new Map(wfs.map((w) => [w.work_field_id, w])), [wfs])
  const withBzs = wfs.filter((w) => w.nBzs > 0)
  const noGeom = withBzs.filter((w) => !w.hasGeom)
  const empties = wfs.filter((w) => w.nBzs === 0)

  // мачване: точно име, после без разлика в регистър и интервали (само ако е еднозначно)
  const polys = useMemo<Poly[]>(() => {
    const exact = new Map(wfs.map((w) => [w.name, w.work_field_id]))
    const loose = new Map<string, string | null>()
    for (const w of wfs) { const k = normName(w.name); loose.set(k, loose.has(k) ? null : w.work_field_id) }
    return rawGeoms.map((geom, idx) => {
      const p = rawProps[idx] ?? {}
      const name = nameAttr && p[nameAttr] != null ? String(p[nameAttr]).trim() : ''
      const jd = idAttr && p[idAttr] != null && String(p[idAttr]).trim() ? String(p[idAttr]).trim() : null
      const matchId = (name && (exact.get(name) ?? loose.get(normName(name)))) || null
      return { idx, name: name || `Полигон ${idx + 1}`, jdId: jd, geom, area: areaDa(geom), matchId, linked: linked.has(idx) }
    })
  }, [rawGeoms, rawProps, nameAttr, idAttr, wfs, linked])

  const unmatched = polys.filter((p) => !p.matchId && !p.linked)
  // „свързани“ се броят само полигоните към обработваеми полета с БЗС
  const matched = polys.filter((p) => p.matchId && (wfById.get(p.matchId)?.nBzs ?? 0) > 0)
  const matchedEmpty = polys.filter((p) => p.matchId && (wfById.get(p.matchId)?.nBzs ?? 0) === 0)
  const autoNew = useMemo(() => {
    const m = new Map<string, Poly[]>()
    for (const p of polys) {
      const w = p.matchId ? wfById.get(p.matchId) : null
      if (w && !p.linked && !w.hasGeom && w.nBzs > 0) m.set(w.work_field_id, [...(m.get(w.work_field_id) ?? []), p])
    }
    return m
  }, [polys, wfById])

  const unmatchedKey = unmatched.map((p) => p.idx).join(',')
  const suggest = useMemo(() => {
    const m = new Map<number, WF | null>()
    for (const p of unmatched) {
      const b = closestName(p.name, wfs, (w) => w.name)
      m.set(p.idx, b && b.score >= 0.5 ? b.item : null)
    }
    return m
  }, [unmatchedKey, wfs])

  const selPolys = polys.filter((p) => selected.has(p.idx))
  const selArea = selPolys.reduce((a, p) => a + p.area, 0)

  // име по подразбиране за ново поле = FIELD_NAME на първия избран полигон
  const firstName = selPolys[0]?.name ?? ''
  useEffect(() => { if (!nameTouched) setNewName(firstName) }, [firstName, nameTouched])

  async function onFile(file: File | undefined) {
    if (!file) return
    setParseErr(null); setFlash(null); setSelected(new Set()); setLinked(new Set()); setTargetId(null)
    try {
      const res = await shp(await file.arrayBuffer())
      const fcs = Array.isArray(res) ? res : [res]
      const feats = fcs.flatMap((fc) => fc.features).filter((f) => f.geometry && /Polygon/.test(f.geometry.type))
      if (feats.length === 0) throw new Error('Във файла няма полигони.')
      const geoms = feats.map((f) => to2D(f.geometry))
      if (!geoms.every(looksWgs84)) throw new Error('Координатите не са в WGS84 (градуси). Провери дали в .zip има .prj файл.')
      const props = feats.map((f) => (f.properties ?? {}) as Record<string, unknown>)
      const keys = Array.from(new Set(props.flatMap((p) => Object.keys(p))))
      const find = (re: RegExp) => keys.find((k) => re.test(k)) ?? ''
      setAttrs(keys)
      setNameAttr(find(/^field_?name$/i) || find(/name/i) || keys[0] || '')
      setIdAttr(find(/^field_?id$/i))
      setRawProps(props); setRawGeoms(geoms); setFileName(file.name)
    } catch (e) {
      setRawGeoms([]); setRawProps([]); setFileName('')
      setParseErr(`Файлът не може да се прочете: ${(e as Error).message}`)
    }
  }

  async function saveGeom(wfId: string, ps: Poly[]): Promise<void> {
    const gc: GeoJSON.GeometryCollection = { type: 'GeometryCollection', geometries: ps.map((p) => p.geom) }
    const { error: err } = await supabase.rpc('set_work_field_geom', {
      p_work_field_id: wfId, p_geojson: gc, p_jd_field_id: ps.length === 1 ? ps[0].jdId : null,
    })
    if (err) throw new Error(err.message)
  }

  const resetConnect = () => { setSelected(new Set()); setTargetId(null); setTq(''); setPickBzs([]); setBq(''); setNameTouched(false) }

  async function connect() {
    const target = targetId ? wfById.get(targetId) : null
    if (!target || selPolys.length === 0) return
    if (target.hasGeom && !window.confirm(`„${target.name}“ вече има граница. Да бъде ли презаписана с ${selPolys.length} избран${selPolys.length === 1 ? '' : 'и'} полигон${selPolys.length === 1 ? '' : 'а'}?`)) return
    setBusy(true); setFlash(null)
    try {
      await saveGeom(target.work_field_id, selPolys)
      setLinked((s) => new Set([...s, ...selPolys.map((p) => p.idx)]))
      setFlash({ text: `Записано: „${target.name}“ ← ${selPolys.map((p) => p.name).join(', ')} (${fmtArea(selArea)} дка).${target.nBzs === 0 ? ' Внимание: това обработваемо поле няма БЗС.' : ''}`, err: false })
      resetConnect(); setReload((k) => k + 1)
    } catch (e) {
      setFlash({ text: rpcError((e as Error).message), err: true })
    }
    setBusy(false)
  }

  // ново обработваемо поле: insert → граница → преместване на БЗС; при грешка се връща всичко
  const nameClash = useMemo(() => {
    const n = normName(newName)
    return n ? wfs.find((w) => normName(w.name) === n) ?? null : null
  }, [newName, wfs])
  const chosenBzs = bzs.filter((b) => pickBzs.includes(b.field_id))
  const sources = wfs.filter((w) => chosenBzs.some((b) => b.work_field_id === w.work_field_id))
  const willEmpty = sources.filter((w) => w.nBzs === chosenBzs.filter((b) => b.work_field_id === w.work_field_id).length)
  const bzsHits = useMemo(() => {
    const n = bq.trim().toLowerCase()
    if (!n) return []
    return bzs.filter((b) => !pickBzs.includes(b.field_id) && [b.field_name, b.isak_number, wfById.get(b.work_field_id ?? '')?.name].filter(Boolean).join(' ').toLowerCase().includes(n)).slice(0, 10)
  }, [bq, bzs, pickBzs, wfById])

  async function createNew() {
    const name = newName.trim()
    if (!name || selPolys.length === 0 || chosenBzs.length === 0 || nameClash) return
    const orgs = Array.from(new Set(chosenBzs.map((b) => b.organization_id)))
    if (orgs.length !== 1) { setFlash({ text: 'Избраните БЗС са от различни организации – не може да се съберат в едно обработваемо поле.', err: true }); return }
    if (!window.confirm(`Ново обработваемо поле „${name}“ с ${selPolys.length} полигон${selPolys.length === 1 ? '' : 'а'} (${fmtArea(selArea)} дка) и ${chosenBzs.length} БЗС?${willEmpty.length ? `\n\nЩе останат празни: ${willEmpty.map((w) => w.name).join(', ')}.` : ''}`)) return
    setBusy(true); setFlash(null)
    let newId: string | null = null
    let stage = 'създаване на обработваемото поле'
    try {
      const ins = await supabase.from('work_field').insert({ organization_id: orgs[0], name }).select('work_field_id')
      if (ins.error) throw new Error(ins.error.message)
      newId = (ins.data?.[0] as { work_field_id: string } | undefined)?.work_field_id ?? null
      if (!newId) throw new Error('Обработваемото поле не е създадено – вероятно нямаш права.')
      stage = 'запис на границата'
      await saveGeom(newId, selPolys)
      stage = 'преместване на БЗС'
      await moveBzs(chosenBzs.map((b) => b.field_id), newId)
      const emptied = await emptyOf(sources.map((w) => w.work_field_id))
      const names = sources.filter((w) => emptied.includes(w.work_field_id)).map((w) => `„${w.name}“`)
      setLinked((s) => new Set([...s, ...selPolys.map((p) => p.idx)]))
      setFlash({
        text: `Създадено „${name}“ с граница ${fmtArea(selArea)} дка и ${chosenBzs.length} БЗС.${names.length ? ` Останаха празни: ${names.join(', ')} – виж таба „Празни обработваеми полета“.` : ''}`,
        err: false,
      })
      if (names.length) setTab('empty')
      resetConnect(); setReload((k) => k + 1)
    } catch (e) {
      // компенсация: БЗС се връщат в moveBzs; новото поле се трие, ако е празно
      let undo = ''
      if (newId) {
        try {
          if ((await countBzs(newId)) === 0) {
            const d = await supabase.from('work_field').delete().eq('work_field_id', newId)
            undo = d.error ? ` Новото поле „${name}“ НЕ можа да се изтрие (${d.error.message}) – изтрий го ръчно от „Празни обработваеми полета“.` : ' Новото поле е изтрито, нищо не е променено.'
          } else undo = ` Новото поле „${name}“ има БЗС и не е изтрито – провери го.`
        } catch (x) { undo = ` Проверката за връщане не успя (${(x as Error).message}).` }
        setReload((k) => k + 1)
      }
      setFlash({ text: `Грешка при ${stage}: ${rpcError((e as Error).message)}.${undo}`, err: true })
    }
    setBusy(false)
  }

  async function saveAuto() {
    const n = autoNew.size
    if (n === 0 || !window.confirm(`Да се запишат границите на ${n} автоматично свързани полета, които още нямат граница?`)) return
    setBusy(true); setFlash(null)
    let ok = 0
    const done: number[] = []
    try {
      for (const [wfId, ps] of autoNew) {
        await saveGeom(wfId, ps)
        ok += 1; done.push(...ps.map((p) => p.idx))
      }
      setFlash({ text: `Записани граници на ${ok} полета.`, err: false })
    } catch (e) {
      setFlash({ text: `Записани ${ok} от ${n}. Грешка: ${rpcError((e as Error).message)}`, err: true })
    }
    setLinked((s) => new Set([...s, ...done]))
    setReload((k) => k + 1)
    setBusy(false)
  }

  async function deleteEmpty(w: WF) {
    setFlash(null)
    if (!window.confirm(`Изтриване на обработваемо поле „${w.name}“${w.hasGeom ? ' (има граница – тя също ще се изтрие)' : ' (без граница)'}.\n\nТова не може да се върне.`)) return
    setBusy(true)
    try {
      const n = await countBzs(w.work_field_id)
      if (n > 0) throw new Error(`„${w.name}“ все още има ${n} БЗС – първо ги премести.`)
      const d = await supabase.from('work_field').delete().eq('work_field_id', w.work_field_id).select('work_field_id')
      if (d.error) throw new Error(d.error.message)
      if (!d.data?.length) throw new Error('Нищо не е изтрито – вероятно нямаш права.')
      setFlash({ text: `Изтрито обработваемо поле „${w.name}“.`, err: false })
      setReload((k) => k + 1)
    } catch (e) {
      setFlash({ text: rpcError((e as Error).message), err: true })
    }
    setBusy(false)
  }

  const toggle = (idx: number) => setSelected((s) => { const n = new Set(s); if (n.has(idx)) n.delete(idx); else n.add(idx); return n })
  const pick = (idx: number, wf: WF | null) => {
    setSelected((s) => new Set([...s, idx]))
    if (wf) { setMode('existing'); setTargetId(wf.work_field_id); setTq(wf.name) }
    zoomTo([idx])
  }

  // карта
  useEffect(() => {
    if (!box.current || map.current) return
    map.current = createMap(box.current)
    return () => { map.current?.remove(); map.current = null }
  }, [])

  // съществуващите граници — тънък бял контур (празните полета — пунктир)
  useEffect(() => {
    const m = map.current
    if (!m) return
    exLayer.current?.remove()
    exLayer.current = L.geoJSON({ type: 'FeatureCollection', features: existing.map((g) => ({ type: 'Feature', geometry: g.geojson, properties: { id: g.work_field_id } })) } as GeoJSON.FeatureCollection, {
      interactive: false,
      style: (ft) => (wfById.get(ft?.properties?.id)?.nBzs === 0
        ? { color: '#f87171', weight: 1.5, dashArray: '4 4', opacity: 0.9, fillOpacity: 0 }
        : { color: '#ffffff', weight: 1, opacity: 0.7, fillOpacity: 0 }),
    }).addTo(m)
    fileLayer.current?.bringToFront()
    // приближаване само при първото зареждане (не след всяко записване)
    if (!fitted.current && rawGeoms.length === 0 && existing.length > 0) {
      const b = exLayer.current.getBounds()
      if (b.isValid()) { m.fitBounds(b, { padding: [24, 24] }); fitted.current = true }
    }
  }, [existing, wfById, rawGeoms.length])

  // полигоните от файла
  useEffect(() => {
    const m = map.current
    if (!m) return
    fileLayer.current?.remove()
    if (polys.length === 0) { fileLayer.current = null; return }
    const byIdx = new Map(polys.map((p) => [p.idx, p]))
    fileLayer.current = L.geoJSON({ type: 'FeatureCollection', features: polys.map((p) => ({ type: 'Feature', geometry: p.geom, properties: { idx: p.idx } })) } as GeoJSON.FeatureCollection, {
      style: (ft) => {
        const p = byIdx.get(ft?.properties?.idx) as Poly
        const c = selected.has(p.idx) ? C_SELECTED : p.linked ? C_LINKED : p.matchId ? C_MATCHED : C_UNMATCHED
        return { color: c, weight: selected.has(p.idx) ? 3 : 1.5, fillColor: c, fillOpacity: p.matchId && !selected.has(p.idx) ? 0.2 : 0.4 }
      },
      onEachFeature: (ft, lyr) => {
        const p = byIdx.get(ft.properties?.idx) as Poly
        const wf = p.matchId ? wfById.get(p.matchId) : null
        lyr.bindTooltip(`${escapeHtml(p.name)} · ${fmtArea(p.area)} дка${wf ? ` → ${escapeHtml(wf.name)}${wf.nBzs === 0 ? ' (празно)' : ''}` : p.linked ? ' · записан' : ' · без поле'}`, { sticky: true, className: 'map-tip' })
        lyr.on('click', () => toggle(p.idx))
      },
    }).addTo(m)
  }, [polys, selected, wfById])

  useEffect(() => {
    const b = fileLayer.current?.getBounds()
    if (b?.isValid()) map.current?.fitBounds(b, { padding: [24, 24] })
  }, [fileName, rawGeoms.length])

  function zoomTo(idxs: number[]) {
    const ps = polys.filter((p) => idxs.includes(p.idx))
    if (!ps.length || !map.current) return
    const b = L.geoJSON({ type: 'FeatureCollection', features: ps.map((p) => ({ type: 'Feature', geometry: p.geom, properties: {} })) } as GeoJSON.FeatureCollection).getBounds()
    if (b.isValid()) map.current.fitBounds(b, { padding: [40, 40], maxZoom: 17 })
  }
  function zoomToWf(id: string) {
    const g = existing.find((x) => x.work_field_id === id)
    if (!g || !map.current) return
    const b = L.geoJSON(g.geojson).getBounds()
    if (b.isValid()) map.current.fitBounds(b, { padding: [40, 40], maxZoom: 17 })
  }

  const target = targetId ? wfById.get(targetId) ?? null : null
  const tql = normName(tq)
  const targetHits = tql && (!target || target.name !== tq) ? wfs.filter((w) => normName(w.name).includes(tql) || normName(w.name_bg ?? '').includes(tql)).slice(0, 8) : []
  const chosenCompanies = Array.from(new Set(chosenBzs.map((b) => b.company_name).filter(Boolean) as string[]))

  return (
    <>
      <div className="page-head">
        <h1>Геометрии</h1>
        <span className="muted">
          {loading ? 'Зареждане…' : `${withBzs.length} обработваеми полета с БЗС · ${withBzs.length - noGeom.length} с граница · ${noGeom.length} без граница`}
          {!loading && empties.length > 0 && ` · ${empties.length} празни (без БЗС)`}
        </span>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}
      {flash && <div className={flash.err ? 'banner err' : 'banner ok'} role={flash.err ? 'alert' : 'status'}>{flash.text}</div>}

      <div className="filters">
        <label className="field">Shapefile (.zip) от JD Operations Center
          <input className="input" type="file" accept=".zip,application/zip" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        </label>
        {attrs.length > 0 && (
          <>
            <label className="field">Колона с име
              <select className="input" value={nameAttr} onChange={(e) => setNameAttr(e.target.value)}>
                {attrs.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="field">Колона с JD идентификатор
              <select className="input" value={idAttr} onChange={(e) => setIdAttr(e.target.value)}>
                <option value="">— няма —</option>
                {attrs.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </>
        )}
        {fileName && <span className="muted">{fileName} · {polys.length} полигона</span>}
      </div>
      {parseErr && <div className="banner err" role="alert">{parseErr}</div>}

      <div className="filters" style={{ alignItems: 'stretch' }}>
        {polys.length > 0 && (
          <>
            <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_MATCHED }} /> Свързани по име</div><div className="stat-n">{matched.length}</div>
              <div className="muted">{autoNew.size} от тях към полета без граница{matchedEmpty.length > 0 && ` · ${matchedEmpty.length} към празни полета (не се броят)`}</div></div>
            <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_UNMATCHED }} /> Полигони без поле</div><div className="stat-n">{unmatched.length}</div></div>
          </>
        )}
        <div className="card pad stat"><div className="muted">Полета с БЗС без полигон</div><div className="stat-n">{noGeom.length}</div></div>
        <div className="card pad stat"><div className="muted">Празни обработваеми полета</div><div className="stat-n">{empties.length}</div>{empties.length > 0 && <div className="muted">без нито едно БЗС</div>}</div>
        {polys.length > 0 && <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_LINKED }} /> Записани сега</div><div className="stat-n">{linked.size}</div></div>}
      </div>
      {autoNew.size > 0 && (
        <div className="filters">
          <button className="btn" disabled={busy} onClick={saveAuto}>Запиши автоматично свързаните без граница ({autoNew.size})</button>
          <span className="muted">Полетата, които вече имат граница, не се презаписват автоматично — за тях използвай „Свържи“.</span>
        </div>
      )}

      <div className="geo-grid">
        <div className="card geo-side">
          <div className="seg" role="tablist" style={{ padding: 10 }}>
            <button role="tab" aria-selected={tab === 'unmatched'} className={tab === 'unmatched' ? 'btn' : 'btn outline'} onClick={() => setTab('unmatched')}>Полигони без поле ({unmatched.length})</button>
            <button role="tab" aria-selected={tab === 'nogeom'} className={tab === 'nogeom' ? 'btn' : 'btn outline'} onClick={() => setTab('nogeom')}>Полета без полигон ({noGeom.length})</button>
            <button role="tab" aria-selected={tab === 'empty'} className={tab === 'empty' ? 'btn' : 'btn outline'} onClick={() => setTab('empty')}>Празни обработваеми полета ({empties.length})</button>
          </div>
          <div className="geo-list">
            {tab === 'unmatched' && (
              polys.length === 0
                ? <p className="empty" style={{ padding: 12 }}>Качи .zip със SHP, за да видиш полигоните.</p>
                : unmatched.length === 0
                  ? <p className="empty" style={{ padding: 12 }}>Всички полигони са свързани.</p>
                  : (
                    <table className="grid">
                      <thead><tr><th /><th>Полигон</th><th className="num">дка</th><th>Предложение</th></tr></thead>
                      <tbody>
                        {unmatched.map((p) => {
                          const s = suggest.get(p.idx)
                          return (
                            <tr key={p.idx} className={selected.has(p.idx) ? 'sel' : undefined}>
                              <td><input type="checkbox" aria-label={`Избери ${p.name}`} checked={selected.has(p.idx)} onChange={() => toggle(p.idx)} /></td>
                              <td><button className="linkish" onClick={() => zoomTo([p.idx])}>{p.name}</button></td>
                              <td className="num">{fmtArea(p.area)}</td>
                              <td>{s ? <button className="linkish" title="Избери полигона и това поле" onClick={() => pick(p.idx, s)}>{s.name}{s.hasGeom ? ' (има граница)' : ''}</button> : <span className="muted">—</span>}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )
            )}
            {tab === 'nogeom' && (
              noGeom.length === 0
                ? <p className="empty" style={{ padding: 12 }}>Всички обработваеми полета с БЗС имат граница.</p>
                : (
                  <table className="grid">
                    <thead><tr><th>Обработваемо поле</th><th className="num">БЗС</th><th className="num">дка по БЗС</th></tr></thead>
                    <tbody>
                      {noGeom.map((w) => (
                        <tr key={w.work_field_id} className={targetId === w.work_field_id ? 'sel' : undefined}>
                          <td><button className="linkish" onClick={() => { setMode('existing'); setTargetId(w.work_field_id); setTq(w.name) }}>{w.name}</button>{w.name_bg && <span className="muted"> · {w.name_bg}</span>}</td>
                          <td className="num">{w.nBzs}</td>
                          <td className="num">{w.bzsArea != null ? fmtArea(w.bzsArea) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            )}
            {tab === 'empty' && (
              empties.length === 0
                ? <p className="empty" style={{ padding: 12 }}>Няма празни обработваеми полета.</p>
                : (
                  <table className="grid">
                    <thead><tr><th>Обработваемо поле</th><th>Граница</th><th /></tr></thead>
                    <tbody>
                      {empties.map((w) => (
                        <tr key={w.work_field_id}>
                          <td>{w.hasGeom ? <button className="linkish" onClick={() => zoomToWf(w.work_field_id)}>{w.name}</button> : w.name}{w.jd_field_id && <div className="muted" style={{ fontSize: 12 }}>JD: {w.jd_field_id}</div>}</td>
                          <td>{w.hasGeom ? <span className="chip">да</span> : <span className="muted">няма</span>}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn outline danger" disabled={busy || w.nBzs > 0} title={w.nBzs > 0 ? 'Има БЗС – не може да се изтрие' : undefined} onClick={() => deleteEmpty(w)}>Изтрий…</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            )}
          </div>

          <div className="geo-connect">
            <div className="seg" role="group" aria-label="Действие с избраните полигони">
              <button className={mode === 'existing' ? 'btn' : 'btn outline'} aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>Свържи със съществуващо</button>
              <button className={mode === 'new' ? 'btn' : 'btn outline'} aria-pressed={mode === 'new'} onClick={() => setMode('new')}>Ново обработваемо поле</button>
            </div>
            <div className="muted">
              Избрани полигони: {selPolys.length}{selPolys.length > 0 && ` · ${fmtArea(selArea)} дка`}
              {selPolys.length > 0 && <> · <button className="linkish" onClick={() => setSelected(new Set())}>изчисти</button></>}
            </div>

            {mode === 'existing' && (
              <>
                <label className="field" style={{ position: 'relative' }}>Обработваемо поле
                  <input className="input" type="search" value={tq} placeholder="Търси по име…" onChange={(e) => { setTq(e.target.value); setTargetId(null) }} />
                  {targetHits.length > 0 && (
                    <div className="col-pop" style={{ position: 'absolute', top: '100%', left: 0, right: 0, width: 'auto' }}>
                      <div className="col-pop-list">
                        {targetHits.map((w) => (
                          <button key={w.work_field_id} type="button" className="wf-hit" onClick={() => { setTargetId(w.work_field_id); setTq(w.name) }}>
                            <span>{w.name}</span><span className="muted">{w.nBzs} БЗС · {w.hasGeom ? 'с граница' : 'без граница'}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </label>
                {target && (
                  <div className="muted">
                    {target.hasGeom ? <span className="chip warn">има граница — ще бъде презаписана</span> : <span className="chip">без граница</span>}
                    {target.nBzs === 0 && <> <span className="chip warn">празно – без БЗС</span></>}
                    {' '}{target.nBzs} БЗС · площ по БЗС: {target.bzsArea != null ? `${fmtArea(target.bzsArea)} дка` : '—'}
                    {selPolys.length > 0 && target.bzsArea != null && <> · полигони: {fmtArea(selArea)} дка ({pctText(pct(selArea, target.bzsArea))})</>}
                  </div>
                )}
                <button className="btn" disabled={busy || !target || selPolys.length === 0} onClick={connect}>{busy ? 'Записване…' : 'Свържи'}</button>
              </>
            )}

            {mode === 'new' && (
              <>
                <label className="field">Име на новото обработваемо поле
                  <input className="input" value={newName} onChange={(e) => { setNewName(e.target.value); setNameTouched(true) }} placeholder="FIELD_NAME от SHP" />
                </label>
                {nameClash && (
                  <div className="banner">
                    Вече има обработваемо поле „{nameClash.name}“ ({nameClash.nBzs} БЗС, {nameClash.hasGeom ? 'с граница' : 'без граница'}).{' '}
                    <button className="linkish" onClick={() => { setMode('existing'); setTargetId(nameClash.work_field_id); setTq(nameClash.name) }}>Свържи полигона с него</button> или смени името.
                  </div>
                )}
                <label className="field" style={{ position: 'relative' }}>БЗС, които да се преместят в новото поле
                  <input className="input" type="search" value={bq} placeholder="Търси по име, БЗС № или обработваемо поле…" onChange={(e) => setBq(e.target.value)} />
                  {bzsHits.length > 0 && (
                    <div className="col-pop" style={{ position: 'absolute', top: '100%', left: 0, right: 0, width: 'auto' }}>
                      <div className="col-pop-list">
                        {bzsHits.map((b) => (
                          <button key={b.field_id} type="button" className="wf-hit" onClick={() => { setPickBzs((s) => [...s, b.field_id]); setBq('') }}>
                            <span>{b.field_name ?? '—'}{b.isak_number ? ` · ${b.isak_number}` : ''}</span>
                            <span className="muted">{wfById.get(b.work_field_id ?? '')?.name ?? 'без обработваемо поле'}{b.company_name ? ` · ${b.company_name}` : ''}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </label>
                {chosenBzs.length > 0 && (
                  <ul className="pick-list">
                    {chosenBzs.map((b) => {
                      const from = wfById.get(b.work_field_id ?? '')
                      return (
                        <li key={b.field_id}>
                          <span><strong>{b.field_name ?? '—'}</strong>{b.isak_number ? ` · ${b.isak_number}` : ''}<span className="muted"> · от „{from?.name ?? '—'}“{b.company_name ? ` · ${b.company_name}` : ''}</span></span>
                          <button className="linkish" aria-label={`Махни ${b.field_name ?? ''}`} onClick={() => setPickBzs((s) => s.filter((x) => x !== b.field_id))}>махни</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {chosenCompanies.length > 1 && <div className="muted">За сведение: БЗС са от различни фирми ({chosenCompanies.join(', ')}). Това е допустимо.</div>}
                {willEmpty.length > 0 && <div className="banner">След преместването ще останат празни: {willEmpty.map((w) => `„${w.name}“`).join(', ')}. Ще можеш да ги изтриеш от таба „Празни обработваеми полета“.</div>}
                <button className="btn" disabled={busy || !newName.trim() || !!nameClash || selPolys.length === 0 || chosenBzs.length === 0} onClick={createNew}>
                  {busy ? 'Записване…' : 'Създай и премести БЗС'}
                </button>
                {(selPolys.length === 0 || chosenBzs.length === 0) && <span className="muted" style={{ fontSize: 13 }}>Нужни са поне един избран полигон и поне едно БЗС.</span>}
              </>
            )}
          </div>
        </div>

        <div className="map-card">
          <div ref={box} className="map-box" style={{ height: '72vh' }} />
          <div className="map-legend">
            <span className="item"><span className="swatch" style={{ background: C_UNMATCHED }} />без поле</span>
            <span className="item"><span className="swatch" style={{ background: C_MATCHED }} />свързан по име</span>
            <span className="item"><span className="swatch" style={{ background: C_SELECTED }} />избран</span>
            <span className="item"><span className="swatch" style={{ background: C_LINKED }} />записан сега</span>
            <span className="item"><span className="swatch outline" />съществуваща граница</span>
            {empties.some((w) => w.hasGeom) && <span className="item"><span className="swatch dashed red" />празно обработваемо поле</span>}
          </div>
        </div>
      </div>
    </>
  )
}

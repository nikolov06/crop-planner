import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import shp from 'shpjs'
import { supabase } from '../lib/supabase'
import { fmtArea } from '../lib/format'
import {
  MISSING_MSG, areaDa, closestName, createMap, escapeHtml, fetchPaged, looksWgs84, missingViews, normName, to2D,
  type GeoRow, type SeasonRow,
} from '../lib/geo'

// Геометрии: качване на SHP (.zip) от JD Operations Center, автоматично мачване по име и ръчно свързване на останалите.
type WF = { work_field_id: string; name: string; name_bg: string | null; hasGeom: boolean; bzsArea: number | null }
type Poly = { idx: number; name: string; jdId: string | null; geom: GeoJSON.Geometry; area: number; matchId: string | null; linked: boolean }
type Tab = 'unmatched' | 'nogeom'

const C_UNMATCHED = '#f97316'
const C_MATCHED = '#22c55e'
const C_SELECTED = '#facc15'
const C_LINKED = '#38bdf8'

function rpcError(msg: string): string {
  if (/permission denied|42501|row-level security|нямаш право/i.test(msg)) return `Нямаш права за редакция на обработваемите полета. (${msg})`
  if (missingViews(msg)) return MISSING_MSG
  return msg
}
const pct = (a: number, b: number | null) => (b && b > 0 ? Math.round(((a - b) / b) * 100) : null)
const pctText = (p: number | null) => (p == null ? '' : `${p > 0 ? '+' : ''}${p}%`)

export default function Geometries() {
  const [wfs, setWfs] = useState<WF[]>([])
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
  const [targetId, setTargetId] = useState<string | null>(null)
  const [tq, setTq] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<{ text: string; err: boolean } | null>(null)

  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const exLayer = useRef<L.GeoJSON | null>(null)
  const fileLayer = useRef<L.GeoJSON | null>(null)

  // обработваеми полета, съществуващи граници и площ на БЗС за текущия сезон
  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const w = await fetchPaged<{ work_field_id: string; name: string; name_bg: string | null }>((f, t) =>
          supabase.from('work_field').select('work_field_id,name,name_bg').order('name').order('work_field_id').range(f, t))
        const g = await fetchPaged<GeoRow>((f, t) => supabase.from('v_work_field_geojson')
          .select('work_field_id,name,name_bg,jd_field_id,geojson,polygon_area_da').order('work_field_id').range(f, t))
        const s = await supabase.from('season').select('season_id').eq('is_current', true).limit(1)
        if (s.error) throw new Error(s.error.message)
        const sid = (s.data?.[0] as { season_id: number } | undefined)?.season_id
        const sr = sid == null ? [] : await fetchPaged<Pick<SeasonRow, 'work_field_id' | 'bzs_area_da'>>((f, t) =>
          supabase.from('v_work_field_season').select('work_field_id,bzs_area_da').eq('season_id', sid).order('work_field_id').range(f, t))
        if (off) return
        const has = new Set(g.map((x) => x.work_field_id))
        const area = new Map(sr.map((x) => [x.work_field_id, Number(x.bzs_area_da)]))
        setWfs(w.map((x) => ({ ...x, hasGeom: has.has(x.work_field_id), bzsArea: area.get(x.work_field_id) ?? null })))
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
  const matched = polys.filter((p) => p.matchId)
  const noGeom = wfs.filter((w) => !w.hasGeom)
  // автоматично свързани към полета, които още нямат граница (могат да се запишат наведнъж)
  const autoNew = useMemo(() => {
    const m = new Map<string, Poly[]>()
    for (const p of polys) if (p.matchId && !p.linked && !wfById.get(p.matchId)?.hasGeom) m.set(p.matchId, [...(m.get(p.matchId) ?? []), p])
    return m
  }, [polys, wfById])

  const suggest = useMemo(() => {
    const m = new Map<number, WF | null>()
    for (const p of unmatched) {
      const b = closestName(p.name, wfs, (w) => w.name)
      m.set(p.idx, b && b.score >= 0.5 ? b.item : null)
    }
    return m
  }, [unmatched.map((p) => p.idx).join(','), wfs])

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

  async function save(wfId: string, ps: Poly[]): Promise<void> {
    const gc: GeoJSON.GeometryCollection = { type: 'GeometryCollection', geometries: ps.map((p) => p.geom) }
    const { error: err } = await supabase.rpc('set_work_field_geom', {
      p_work_field_id: wfId, p_geojson: gc, p_jd_field_id: ps.length === 1 ? ps[0].jdId : null,
    })
    if (err) throw new Error(err.message)
  }

  async function connect() {
    const target = targetId ? wfById.get(targetId) : null
    const ps = polys.filter((p) => selected.has(p.idx))
    if (!target || ps.length === 0) return
    if (target.hasGeom && !window.confirm(`„${target.name}“ вече има граница. Да бъде ли презаписана с ${ps.length} избран${ps.length === 1 ? '' : 'и'} полигон${ps.length === 1 ? '' : 'а'}?`)) return
    setBusy(true); setFlash(null)
    try {
      await save(target.work_field_id, ps)
      setLinked((s) => new Set([...s, ...ps.map((p) => p.idx)]))
      setSelected(new Set()); setTargetId(null); setTq('')
      setFlash({ text: `Записано: „${target.name}“ ← ${ps.map((p) => p.name).join(', ')} (${fmtArea(ps.reduce((a, p) => a + p.area, 0))} дка).`, err: false })
      setReload((k) => k + 1)
    } catch (e) {
      setFlash({ text: rpcError((e as Error).message), err: true })
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
        await save(wfId, ps)
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

  const toggle = (idx: number) => setSelected((s) => { const n = new Set(s); if (n.has(idx)) n.delete(idx); else n.add(idx); return n })
  const pick = (idx: number, wf: WF | null) => {
    setSelected((s) => new Set([...s, idx]))
    if (wf) { setTargetId(wf.work_field_id); setTq(wf.name) }
    zoomTo([idx])
  }

  // карта
  useEffect(() => {
    if (!box.current || map.current) return
    map.current = createMap(box.current)
    return () => { map.current?.remove(); map.current = null }
  }, [])

  // съществуващите граници — тънък бял контур, само за ориентация
  useEffect(() => {
    const m = map.current
    if (!m) return
    exLayer.current?.remove()
    exLayer.current = L.geoJSON({ type: 'FeatureCollection', features: existing.map((g) => ({ type: 'Feature', geometry: g.geojson, properties: { name: g.name } })) } as GeoJSON.FeatureCollection, {
      interactive: false,
      style: { color: '#ffffff', weight: 1, opacity: 0.7, fillOpacity: 0 },
    }).addTo(m)
    fileLayer.current?.bringToFront()
    if (rawGeoms.length === 0 && existing.length > 0) {
      const b = exLayer.current.getBounds()
      if (b.isValid()) m.fitBounds(b, { padding: [24, 24] })
    }
  }, [existing])

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
        lyr.bindTooltip(`${escapeHtml(p.name)} · ${fmtArea(p.area)} дка${wf ? ` → ${escapeHtml(wf.name)}` : p.linked ? ' · записан' : ' · без поле'}`, { sticky: true, className: 'map-tip' })
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

  const target = targetId ? wfById.get(targetId) ?? null : null
  const selPolys = polys.filter((p) => selected.has(p.idx))
  const selArea = selPolys.reduce((a, p) => a + p.area, 0)
  const tql = normName(tq)
  const targetHits = tql && (!target || target.name !== tq) ? wfs.filter((w) => normName(w.name).includes(tql) || normName(w.name_bg ?? '').includes(tql)).slice(0, 8) : []

  return (
    <>
      <div className="page-head">
        <h1>Геометрии</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${wfs.length} обработваеми полета · ${wfs.length - noGeom.length} с граница · ${noGeom.length} без граница`}</span>
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

      {polys.length > 0 && (
        <div className="filters" style={{ alignItems: 'stretch' }}>
          <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_MATCHED }} /> Свързани по име</div><div className="stat-n">{matched.length}</div><div className="muted">{autoNew.size} от тях към полета без граница</div></div>
          <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_UNMATCHED }} /> Полигони без поле</div><div className="stat-n">{unmatched.length}</div></div>
          <div className="card pad stat"><div className="muted">Полета без полигон</div><div className="stat-n">{noGeom.length}</div></div>
          <div className="card pad stat"><div className="muted"><span className="swatch" style={{ background: C_LINKED }} /> Записани сега</div><div className="stat-n">{linked.size}</div></div>
        </div>
      )}
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
                            <tr key={p.idx} aria-selected={selected.has(p.idx)} className={selected.has(p.idx) ? 'sel' : undefined}>
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
                ? <p className="empty" style={{ padding: 12 }}>Всички обработваеми полета имат граница.</p>
                : (
                  <table className="grid">
                    <thead><tr><th>Обработваемо поле</th><th className="num">дка по БЗС</th></tr></thead>
                    <tbody>
                      {noGeom.map((w) => (
                        <tr key={w.work_field_id} className={targetId === w.work_field_id ? 'sel' : undefined}>
                          <td><button className="linkish" onClick={() => { setTargetId(w.work_field_id); setTq(w.name) }}>{w.name}</button>{w.name_bg && <span className="muted"> · {w.name_bg}</span>}</td>
                          <td className="num">{w.bzsArea != null ? fmtArea(w.bzsArea) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
            )}
          </div>

          <div className="geo-connect">
            <strong>Ръчно свързване</strong>
            <div className="muted">
              Избрани полигони: {selPolys.length}{selPolys.length > 0 && ` · ${fmtArea(selArea)} дка`}
              {selPolys.length > 0 && <> · <button className="linkish" onClick={() => setSelected(new Set())}>изчисти</button></>}
            </div>
            <label className="field" style={{ position: 'relative' }}>Обработваемо поле
              <input className="input" type="search" value={tq} placeholder="Търси по име…" onChange={(e) => { setTq(e.target.value); setTargetId(null) }} />
              {targetHits.length > 0 && (
                <div className="col-pop" style={{ position: 'absolute', top: '100%', left: 0, right: 0, width: 'auto' }}>
                  <div className="col-pop-list">
                    {targetHits.map((w) => (
                      <button key={w.work_field_id} className="linkish" style={{ display: 'block', textAlign: 'left', padding: '4px 10px' }} onClick={() => { setTargetId(w.work_field_id); setTq(w.name) }}>
                        {w.name}{w.hasGeom ? ' · има граница' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </label>
            {target && (
              <div className="muted">
                {target.hasGeom ? <span className="chip warn">има граница — ще бъде презаписана</span> : <span className="chip">без граница</span>}
                {' '}Площ по БЗС: {target.bzsArea != null ? `${fmtArea(target.bzsArea)} дка` : '—'}
                {selPolys.length > 0 && target.bzsArea != null && <> · полигони: {fmtArea(selArea)} дка ({pctText(pct(selArea, target.bzsArea))})</>}
              </div>
            )}
            <button className="btn" disabled={busy || !target || selPolys.length === 0} onClick={connect}>
              {busy ? 'Записване…' : 'Свържи'}
            </button>
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
          </div>
        </div>
      </div>
    </>
  )
}

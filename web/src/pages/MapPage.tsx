import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { supabase } from '../lib/supabase'
import { cropColor, cropLabel, fmtArea } from '../lib/format'
import { MultiFilter, anyToken } from '../lib/multifilter'
import {
  BASE_PALETTE, MISSING_MSG, createMap, escapeHtml, fetchPaged, missingViews, resolveColor,
  type GeoRow, type SeasonRow,
} from '../lib/geo'

// Карта на обработваемите полета: граници от work_field.geom, оцветени по култура или стопанска база за избран сезон.
type Season = { season_id: number; label: string; is_current: boolean }
type Mode = 'crop' | 'base' | 'none'
const MODES: { key: Mode; label: string }[] = [
  { key: 'crop', label: 'По култура' }, { key: 'base', label: 'По стопанска база' }, { key: 'none', label: 'Без култура' },
]
const NO_CROP = '__none'
const NEUTRAL = '#f8fafc'
const MISMATCH = 0.1

type Feat = { g: GeoRow; s: SeasonRow | undefined; mismatch: boolean }
const areaOf = (f: Feat) => (f.s ? Number(f.s.bzs_area_da) : Number(f.g.polygon_area_da))

export default function MapPage() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonId, setSeasonId] = useState<number | null>(null)
  const [geo, setGeo] = useState<GeoRow[]>([])
  const [srows, setSrows] = useState<SeasonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('crop')
  const [fCrop, setFCrop] = useState('')
  const [fBase, setFBase] = useState('')
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.GeoJSON | null>(null)

  const fail = (e: unknown) => {
    const m = (e as Error).message ?? String(e)
    setError(missingViews(m) ? MISSING_MSG : m)
  }

  // сезони + граници (веднъж)
  useEffect(() => {
    let off = false
    ;(async () => {
      try {
        const s = await supabase.from('season').select('season_id,label,is_current').order('year_end', { ascending: false })
        if (s.error) throw new Error(s.error.message)
        const list = (s.data ?? []) as Season[]
        const g = await fetchPaged<GeoRow>((f, t) => supabase.from('v_work_field_geojson')
          .select('work_field_id,name,name_bg,jd_field_id,geojson,polygon_area_da').order('name').order('work_field_id').range(f, t))
        if (off) return
        setSeasons(list)
        setSeasonId((c) => c ?? list.find((x) => x.is_current)?.season_id ?? list[0]?.season_id ?? null)
        setGeo(g)
      } catch (e) {
        if (!off) { fail(e); setLoading(false) }
      }
    })()
    return () => { off = true }
  }, [])

  // данни по сезон
  useEffect(() => {
    if (seasonId == null) return
    let off = false
    setLoading(true)
    fetchPaged<SeasonRow>((f, t) => supabase.from('v_work_field_season')
      .select('work_field_id,season_id,bzs_count,bzs_area_da,main_crop,crops,farm_base,bzs').eq('season_id', seasonId).order('work_field_id').range(f, t))
      .then((r) => { if (!off) { setSrows(r); setError(null) } })
      .catch((e) => { if (!off) fail(e) })
      .finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [seasonId])

  const feats = useMemo<Feat[]>(() => {
    const byId = new Map(srows.map((s) => [s.work_field_id, s]))
    return geo.map((g) => {
      const s = byId.get(g.work_field_id)
      const bzs = s ? Number(s.bzs_area_da) : 0
      return { g, s, mismatch: !!s && bzs > 0 && Math.abs(Number(g.polygon_area_da) - bzs) / bzs > MISMATCH }
    })
  }, [geo, srows])

  const crops = useMemo(() => Array.from(new Set(srows.flatMap((s) => s.crops ?? []))).sort((a, b) => a.localeCompare(b, 'bg')), [srows])
  const bases = useMemo(() => Array.from(new Set(feats.map((f) => f.s?.farm_base ?? '—'))).sort((a, b) => a.localeCompare(b, 'bg')), [feats])
  const baseColor = useMemo(() => new Map(bases.map((b, i) => [b, b === '—' ? '#9a9a90' : BASE_PALETTE[i % BASE_PALETTE.length]])), [bases])

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return feats.filter((f) => {
      const cs = f.s?.crops ?? []
      if (!anyToken(fCrop, (t) => (t === NO_CROP ? cs.length === 0 : cs.includes(t)))) return false
      if (!anyToken(fBase, (t) => (f.s?.farm_base ?? '—') === t)) return false
      if (!needle) return true
      const hay = [f.g.name, f.g.name_bg, ...(f.s?.bzs ?? []).map((b) => b.field_name)].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [feats, fCrop, fBase, q])

  const colorOf = useMemo(() => {
    const cache = new Map<string, string>()
    const crop = (c: string | null | undefined) => {
      const k = c ?? ''
      if (!cache.has(k)) cache.set(k, resolveColor(cropColor(c)))
      return cache.get(k) as string
    }
    return (f: Feat) => (mode === 'crop' ? crop(f.s?.main_crop) : mode === 'base' ? (baseColor.get(f.s?.farm_base ?? '—') as string) : NEUTRAL)
  }, [mode, baseColor])

  const legend = useMemo(() => {
    const m = new Map<string, { label: string; color: string; area: number; n: number }>()
    for (const f of view) {
      const key = mode === 'crop' ? f.s?.main_crop ?? '' : mode === 'base' ? f.s?.farm_base ?? '—' : 'all'
      const label = mode === 'crop' ? (key ? cropLabel(key) : 'Без култура') : mode === 'base' ? key : 'Обработваеми полета'
      const e = m.get(key) ?? { label, color: colorOf(f), area: 0, n: 0 }
      e.area += areaOf(f); e.n += 1
      m.set(key, e)
    }
    return Array.from(m.values()).sort((a, b) => b.area - a.area)
  }, [view, mode, colorOf])

  const totalArea = view.reduce((a, f) => a + areaOf(f), 0)
  const nMismatch = view.filter((f) => f.mismatch).length
  const withoutGeom = Math.max(0, srows.length - feats.filter((f) => f.s).length)
  const seasonLabel = seasons.find((s) => s.season_id === seasonId)?.label ?? ''

  // картата
  useEffect(() => {
    if (!box.current || map.current) return
    map.current = createMap(box.current)
    return () => { map.current?.remove(); map.current = null }
  }, [])

  // слой с полигоните (при смяна на филтри или оцветяване)
  useEffect(() => {
    const m = map.current
    if (!m) return
    layer.current?.remove()
    const byId = new Map(view.map((f) => [f.g.work_field_id, f]))
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: view.map((f) => ({ type: 'Feature', geometry: f.g.geojson, properties: { id: f.g.work_field_id } })),
    }
    layer.current = L.geoJSON(fc, {
      style: (ft) => {
        const f = byId.get(ft?.properties?.id) as Feat
        const c = colorOf(f)
        return f.mismatch
          ? { color: '#fde047', weight: 2, dashArray: '6 4', fillColor: c, fillOpacity: 0.4 }
          : { color: mode === 'none' ? '#ffffff' : c, weight: 1.2, fillColor: c, fillOpacity: mode === 'none' ? 0.12 : 0.4 }
      },
      onEachFeature: (ft, lyr) => {
        const f = byId.get(ft.properties?.id) as Feat
        lyr.bindTooltip(escapeHtml(f.g.name), { sticky: true, className: 'map-tip' })
        lyr.bindPopup(() => popupHtml(f), { maxWidth: 360 })
      },
    }).addTo(m)
  }, [view, colorOf, mode])

  // приближаване към показаните (само при смяна на филтрите, не при оцветяване)
  const viewKey = view.map((f) => f.g.work_field_id).join(',')
  useEffect(() => {
    const m = map.current, l = layer.current
    if (!m || !l || view.length === 0) return
    const b = l.getBounds()
    if (b.isValid()) m.fitBounds(b, { padding: [24, 24], maxZoom: 16 })
  }, [viewKey])

  const activeCount = (fCrop ? 1 : 0) + (fBase ? 1 : 0) + (q ? 1 : 0)

  return (
    <>
      <div className="page-head">
        <h1>Карта</h1>
        <span className="muted">
          {loading ? 'Зареждане…' : `сезон ${seasonLabel} · показани ${view.length} от ${feats.length} полета с граница · ${fmtArea(totalArea)} дка`}
          {!loading && nMismatch > 0 && ` · ${nMismatch} с разлика в площта над 10%`}
          {!loading && withoutGeom > 0 && ` · ${withoutGeom} полета от сезона без граница`}
        </span>
      </div>
      {error && <div className="banner err" role="alert">{error}</div>}

      <div className="filters">
        <label className="field">Сезон
          <select className="input" value={seasonId ?? ''} onChange={(e) => setSeasonId(Number(e.target.value))}>
            {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текущ)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Култура
          <MultiFilter value={fCrop} onChange={setFCrop} ariaLabel="Култура" options={crops.map((c) => ({ value: c, label: cropLabel(c) }))} specials={[{ value: NO_CROP, label: 'Без култура' }]} />
        </label>
        <label className="field">Стопанска база
          <MultiFilter value={fBase} onChange={setFBase} ariaLabel="Стопанска база" options={bases.map((b) => ({ value: b, label: b }))} />
        </label>
        <label className="field grow">Търсене (обработваемо поле или БЗС)
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn outline" onClick={() => { setFCrop(''); setFBase(''); setQ('') }} disabled={activeCount === 0}>
          Изчисти филтрите{activeCount ? ` (${activeCount})` : ''}
        </button>
      </div>

      <div className="filters">
        <div className="field">Оцветяване
          <div className="seg" role="group" aria-label="Оцветяване">
            {MODES.map((m) => <button key={m.key} className={mode === m.key ? 'btn' : 'btn outline'} aria-pressed={mode === m.key} onClick={() => setMode(m.key)}>{m.label}</button>)}
          </div>
        </div>
      </div>

      <div className="map-card">
        <div ref={box} className="map-box" style={{ height: '70vh' }} />
        {legend.length > 0 && (
          <div className="map-legend" aria-label="Легенда">
            {legend.map((e) => (
              <span className="item" key={e.label}>
                <span className="swatch" style={{ background: e.color }} />
                {e.label} <span className="muted">{fmtArea(e.area)} дка</span>
              </span>
            ))}
            {nMismatch > 0 && (
              <span className="item"><span className="swatch dashed" /> площ на полигона ≠ площ на БЗС (&gt;10%)</span>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function popupHtml(f: Feat): string {
  const e = escapeHtml
  const poly = Number(f.g.polygon_area_da)
  const bzs = f.s ? Number(f.s.bzs_area_da) : null
  const rows = (f.s?.bzs ?? []).map((b) =>
    `<tr><td>${e(b.field_name ?? '—')}</td><td>${e(b.crop ? cropLabel(b.crop) : '—')}</td><td class="num">${fmtArea(Number(b.area_da))}</td></tr>`).join('')
  const diff = bzs && bzs > 0 ? Math.round(((poly - bzs) / bzs) * 100) : null
  return `
    <div class="map-pop">
      <strong>${e(f.g.name)}</strong>${f.g.name_bg ? ` <span class="muted">${e(f.g.name_bg)}</span>` : ''}
      <div class="muted">${e(f.s?.farm_base ?? 'без стопанска база за сезона')}</div>
      <div>Площ на полигона: <strong>${fmtArea(poly)} дка</strong>${bzs != null ? ` · по БЗС: <strong>${fmtArea(bzs)} дка</strong>` : ''}</div>
      ${f.mismatch ? `<div class="map-warn">Площта на полигона се различава от площта на БЗС с ${diff! > 0 ? '+' : ''}${diff}%.</div>` : ''}
      ${rows
        ? `<table class="map-pop-table"><thead><tr><th>БЗС</th><th>Култура</th><th class="num">дка</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="muted">Няма БЗС с култура за сезона.</div>'}
      <a class="btn outline" href="#/rotation?q=${encodeURIComponent(f.g.name)}">Отвори в Сеитбооборот</a>
    </div>`
}

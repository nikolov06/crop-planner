import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Общи неща за картите (Карта, Геометрии): подложки, цветове, площи, имена.

export const SATELLITE = 'Сателит'
export const STREETS = 'Улична карта'
const LAYER_KEY = 'crop-planner:map-base-layer'

function storedLayer(): string {
  try {
    return localStorage.getItem(LAYER_KEY) === STREETS ? STREETS : SATELLITE
  } catch {
    return SATELLITE
  }
}

// Създава карта с canvas рендерер, подложки Esri World Imagery (по подразбиране) и OSM, превключвател и мащаб.
export function createMap(el: HTMLElement): L.Map {
  const map = L.map(el, { preferCanvas: true, zoomControl: true }).setView([43.2, 27.3], 10)
  const layers: Record<string, L.TileLayer> = {
    [SATELLITE]: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Изображения &copy; Esri, Maxar, Earthstar Geographics',
    }),
    [STREETS]: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
  }
  layers[storedLayer()].addTo(map)
  L.control.layers(layers, undefined, { position: 'topright' }).addTo(map)
  L.control.scale({ imperial: false }).addTo(map)
  map.on('baselayerchange', (e: L.LayersControlEvent) => {
    try {
      localStorage.setItem(LAYER_KEY, e.name)
    } catch {
      /* изборът просто няма да се запомни */
    }
  })
  return map
}

// Canvas не разбира var(--x): превеждаме CSS променливите в реални цветове.
export function resolveColor(css: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(css.trim())
  if (!m) return css
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()
  return v || '#9a9a90'
}

// Различими цветове за стопанските бази (по реда на сортираните имена).
export const BASE_PALETTE = ['#2a78d6', '#d97706', '#16a34a', '#c026d3', '#dc2626', '#0891b2', '#ca8a04', '#7c3aed', '#db2777', '#65a30d', '#ea580c', '#0d9488']

// Геодезична площ (сферично приближение, както в Turf) в дка.
const R = 6378137
const rad = (d: number) => (d * Math.PI) / 180
function ringArea(ring: number[][]): number {
  let area = 0
  const n = ring.length
  if (n < 3) return 0
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n]
    area += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]))
  }
  return Math.abs((area * R * R) / 2)
}
function polyArea(rings: number[][][]): number {
  if (!rings.length) return 0
  return rings.slice(1).reduce((a, r) => a - ringArea(r), ringArea(rings[0]))
}
export function areaDa(g: GeoJSON.Geometry | null | undefined): number {
  if (!g) return 0
  if (g.type === 'Polygon') return polyArea(g.coordinates as number[][][]) / 1000
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).reduce((a, p) => a + polyArea(p), 0) / 1000
  if (g.type === 'GeometryCollection') return g.geometries.reduce((a, x) => a + areaDa(x), 0)
  return 0
}

// Махаме Z/M координатите: колоната в базата е 2D MultiPolygon.
export function to2D(g: GeoJSON.Geometry): GeoJSON.Geometry {
  const strip = (c: unknown): unknown => (typeof (c as unknown[])[0] === 'number' ? (c as number[]).slice(0, 2) : (c as unknown[]).map(strip))
  if (g.type === 'GeometryCollection') return { type: 'GeometryCollection', geometries: g.geometries.map(to2D) }
  return { ...g, coordinates: strip((g as GeoJSON.Polygon).coordinates) } as GeoJSON.Geometry
}

// Грубо: координатите приличат ли на WGS84 градуси (а не на метри от проекция)?
export function looksWgs84(g: GeoJSON.Geometry | null): boolean {
  if (!g) return false
  let ok = true
  const walk = (c: unknown) => {
    if (!ok) return
    if (typeof (c as unknown[])[0] === 'number') {
      const [x, y] = c as number[]
      if (Math.abs(x) > 180 || Math.abs(y) > 90) ok = false
    } else (c as unknown[]).forEach(walk)
  }
  if (g.type === 'GeometryCollection') return g.geometries.every(looksWgs84)
  walk((g as GeoJSON.Polygon).coordinates)
  return ok
}

// Сравнение на имена: точно, после без разлика в регистър и интервали.
export const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const looseName = (s: string) => normName(s).replace(/[^\p{L}\p{N}]+/gu, '')

function lev(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

// Най-близко име (сходство 0..1) — само за предложение, никога не се свързва автоматично.
export function closestName<T>(name: string, items: T[], key: (t: T) => string): { item: T; score: number } | null {
  const a = looseName(name)
  let best: { item: T; score: number } | null = null
  for (const it of items) {
    const b = looseName(key(it))
    if (!a || !b) continue
    const score = 1 - lev(a, b) / Math.max(a.length, b.length)
    if (!best || score > best.score) best = { item: it, score }
  }
  return best
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

// Типове и зареждане на изгледите с границите.
export type GeoRow = { work_field_id: string; name: string; name_bg: string | null; jd_field_id: string | null; geojson: GeoJSON.Geometry; polygon_area_da: number }
export type SeasonRow = {
  work_field_id: string; season_id: number; bzs_count: number; bzs_area_da: number; main_crop: string | null; crops: string[]; farm_base: string | null
  bzs: { field_id: string; field_name: string | null; crop: string | null; area_da: number }[]
}

export const PAGE = 1000
export async function fetchPaged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
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

export const missingViews = (msg: string) => /v_work_field_(geojson|season)|set_work_field_geom|does not exist|schema cache|relation/i.test(msg)
export const MISSING_MSG = 'Картата още не е налична: изгледите v_work_field_geojson и v_work_field_season липсват в базата (миграцията 20261118140000_map_views не е приложена).'

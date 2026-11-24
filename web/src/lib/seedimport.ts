// Бърз импорт на сортове: разчитане на таблица (Excel/ChatGPT), разпознаване на колони,
// съпоставяне на БЗС и сортове, статус на всеки ред. Без React и без Supabase – за да се тества с node --test.

import { parseCsv, type Table } from './tableread.ts'
import { calcRow, type Batch, type Calc, type Crop, type Variety } from './seedcalc.ts'

// ───────── Нормализиране ─────────
const LAT = 'AEOKMHPCTXB'
const CYR = 'АЕОКМНРСТХВ'
const LAT2CYR: Record<string, string> = Object.fromEntries(LAT.split('').map((c, i) => [c, CYR[i]]))
const toCyr = (s: string) => s.replace(/[AEOKMHPCTXB]/g, (c) => LAT2CYR[c])

/** Име на БЗС: главни букви, trim, един интервал, „-“/„–“/„—“ с или без интервали → „-“, латинските look-alike → кирилица. */
export function normBzs(s: string | null | undefined): string {
  return toCyr((s ?? '').toUpperCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim()
    .replace(/\s*-\s*/g, '-').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'))
}

/** Ключ на сорт: главни букви, без интервали, точки, тирета, долни черти и запетаи; „+“ остава. */
export function varietyKey(s: string | null | undefined): string {
  return toCyr((s ?? '').toUpperCase().replace(/[\s.\-‐-―−_,'"`’]/g, ''))
}

const normHeader = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9№]/g, '')

/** Номер на БЗС (ИСАК): 21645-86-1-1, 03602-197-1-1 */
export const looksLikeBzsNumber = (s: string) => /^\d{3,6}(-\d+){1,4}$/.test(s.replace(/\s+/g, '').replace(/[–—]/g, '-'))

/** Число от клетка: „6 500“, „6,5“, „6500.0“ */
export function parseNum(s: string | null | undefined): number | null {
  const t = (s ?? '').replace(/[\s ]/g, '').replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Норма в мерната единица на културата: редови (семена/дка) – стойност < 100 е на м² (×1000); слети (к.с./м²) – стойност > 1000 е на дка (÷1000). */
export function toCropRate(v: number | null, rateBasis: string | null | undefined): number | null {
  if (v == null || !(v > 0)) return null
  if (rateBasis === 'seeds_da' && v < 100) return Math.round(v * 1000)
  if (rateBasis === 'germ_seeds_m2' && v > 1000) return Math.round((v / 1000) * 10) / 10
  return v
}

// ───────── Разчитане на поставен текст ─────────
/** TSV (копирано от Excel), markdown таблица (ChatGPT) или CSV. */
export function parsePasted(text: string): Table {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  const pipeLines = lines.filter((l) => l.trim().startsWith('|'))
  if (pipeLines.length >= 2 && pipeLines.length >= lines.length / 2) {
    return pipeLines
      .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/^\*\*(.*)\*\*$/, '$1')))
      .filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''))
  }
  if (lines.some((l) => l.includes('\t'))) return lines.map((l) => l.split('\t').map((c) => c.trim()))
  return parseCsv(text).map((r) => r.map((c) => c.trim()))
}

// ───────── Колони ─────────
export type ColKey = 'bzs' | 'variety' | 'rate' | 'crop' | 'base' | 'area'
export type ColMap = Partial<Record<ColKey, number>>
export const COL_LABEL: Record<ColKey, string> = {
  bzs: 'БЗС (име или номер)', variety: 'Сорт / хибрид', rate: 'Норма', crop: 'Култура', base: 'Стопанство / база', area: 'Площ',
}

const EXACT: Record<ColKey, string[]> = {
  bzs: ['бзс', 'блок', 'имебзс', '№бзс', 'номербзс', 'нобзс', 'бзсимe', 'наименование'],
  variety: ['предложенхибрид', 'предложенсорт', 'хибрид', 'сорт', 'сортхибрид', 'хибридсорт', 'новхибрид', 'новсорт'],
  rate: ['норма'],
  crop: ['култура'],
  base: ['стопанство', 'база', 'стопанскабаза'],
  area: ['площ', 'площдка', 'площдка'],
}
const PREFIX: Partial<Record<ColKey, string[]>> = { rate: ['норма'], area: ['площ'], variety: ['сортхибрид'] }

/** Разпознава колоните по заглавията. `ambiguous` = има колона БЗС/сорт, която не е еднозначна. */
export function detectColumns(headers: string[]): { map: ColMap; ambiguous: boolean } {
  const h = headers.map((x) => normHeader(x ?? ''))
  const map: ColMap = {}
  for (const key of Object.keys(EXACT) as ColKey[]) {
    let i = h.findIndex((x) => EXACT[key].includes(x))
    if (i < 0 && PREFIX[key]) i = h.findIndex((x) => PREFIX[key]!.some((p) => x.startsWith(p)))
    if (i >= 0 && !Object.values(map).includes(i)) map[key] = i
  }
  let ambiguous = false
  // резервно: единствена колона, която съдържа „хибрид“/„сорт“ (но не „история“/„предходен“)
  if (map.variety == null) {
    const c = h.map((x, i) => ({ x, i })).filter(({ x, i }) => /хибрид|сорт/.test(x) && !/истори|предход|стар/.test(x) && !Object.values(map).includes(i))
    if (c.length === 1) map.variety = c[0].i
    else ambiguous = true
  }
  if (map.bzs == null) {
    const c = h.map((x, i) => ({ x, i })).filter(({ x, i }) => /бзс|блок/.test(x) && !Object.values(map).includes(i))
    if (c.length === 1) map.bzs = c[0].i
    else ambiguous = true
  }
  return { map, ambiguous }
}

/** Първият ред, в който се разпознават колоните за БЗС и сорт (в първите 10). */
export function findHeaderRow(table: Table): number {
  for (let r = 0; r < Math.min(10, table.length); r++) {
    const { map } = detectColumns(table[r])
    if (map.bzs != null && map.variety != null) return r
  }
  return 0
}

// ───────── Сходство (fuzzy) ─────────
function lev(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  let s = 1 - lev(a, b) / Math.max(a.length, b.length)
  if (a.includes(b) || b.includes(a)) s = Math.max(s, 0.6 + 0.4 * Math.min(a.length, b.length) / Math.max(a.length, b.length))
  return s
}
export function topMatches<T>(key: string, items: T[], keyOf: (t: T) => string, n = 3, min = 0.45): T[] {
  return items.map((t) => ({ t, s: similarity(key, keyOf(t)) }))
    .filter((x) => x.s >= min).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.t)
}

// ───────── Данни от базата ─────────
export type PlantingRef = {
  planting_id: string
  organization_id: string
  field_id: string
  field_name: string
  isak_number: string | null
  company_name: string | null
  farm_base_name: string | null
  crop_id: string
  crop_name: string
  planted_area_da: number | null
}
export type SeedRow = { planting_id: string; variety_id: string; batch_id: string | null; target_rate: number; overage_pct: number | null; addon?: string | null }
export type AliasRow = { crop_id: string; alias_normalized: string; variety_id: string }
export type FieldAlias = { field_id: string; alias_name: string }

export type BzsIndex = {
  byName: Map<string, PlantingRef[]>
  byAlias: Map<string, PlantingRef[]>
  byNumber: Map<string, PlantingRef[]>
  all: PlantingRef[]
}
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k); if (a) { if (!a.includes(v)) a.push(v) } else m.set(k, [v]) }

export function buildBzsIndex(plantings: PlantingRef[], fieldAliases: FieldAlias[] = []): BzsIndex {
  const byName = new Map<string, PlantingRef[]>(), byAlias = new Map<string, PlantingRef[]>(), byNumber = new Map<string, PlantingRef[]>()
  const byField = new Map<string, PlantingRef[]>()
  for (const p of plantings) {
    push(byName, normBzs(p.field_name), p)
    if (p.isak_number) push(byNumber, p.isak_number.replace(/\s+/g, ''), p)
    push(byField, p.field_id, p)
  }
  for (const a of fieldAliases) for (const p of byField.get(a.field_id) ?? []) push(byAlias, normBzs(a.alias_name), p)
  return { byName, byAlias, byNumber, all: plantings }
}

export type BzsMatch =
  | { kind: 'name' | 'alias' | 'number'; candidates: PlantingRef[] }
  | { kind: 'none'; candidates: []; suggestions: PlantingRef[] }

export function matchBzs(raw: string, idx: BzsIndex): BzsMatch {
  const v = (raw ?? '').trim()
  if (looksLikeBzsNumber(v)) {
    const c = idx.byNumber.get(v.replace(/\s+/g, '').replace(/[–—]/g, '-'))
    if (c?.length) return { kind: 'number', candidates: c }
  }
  const k = normBzs(v)
  const byName = idx.byName.get(k)
  if (byName?.length) return { kind: 'name', candidates: byName }
  const byAlias = idx.byAlias.get(k)
  if (byAlias?.length) return { kind: 'alias', candidates: byAlias }
  return { kind: 'none', candidates: [], suggestions: topMatches(k, idx.all, (p) => normBzs(p.field_name), 3, 0.4) }
}

// ───────── Сортове ─────────
export type VarietyResolution =
  | { how: 'exact' | 'alias' | 'manual'; variety_id: string; addon: string | null }
  | { how: 'split'; variety_id: string; addon: string | null }           // намерена е частта преди „+“
  | { how: 'other_crop'; variety_id: string; addon: string | null }      // намерен е само в друга култура
  | { how: 'none'; variety_id: null; addon: string | null; suggestions: Variety[] }

export type VarietyIndex = { byCropKey: Map<string, Variety>; aliasByCropKey: Map<string, string>; byKeyAnyCrop: Map<string, Variety[]>; all: Variety[] }

export function buildVarietyIndex(varieties: Variety[], aliases: AliasRow[]): VarietyIndex {
  const byCropKey = new Map<string, Variety>(), byKeyAnyCrop = new Map<string, Variety[]>(), aliasByCropKey = new Map<string, string>()
  for (const v of varieties) {
    const k = varietyKey(v.name)
    if (!byCropKey.has(`${v.crop_id}|${k}`)) byCropKey.set(`${v.crop_id}|${k}`, v)
    push(byKeyAnyCrop, k, v)
  }
  for (const a of aliases) aliasByCropKey.set(`${a.crop_id}|${a.alias_normalized}`, a.variety_id)
  return { byCropKey, aliasByCropKey, byKeyAnyCrop, all: varieties }
}

function findInCrop(key: string, cropId: string, idx: VarietyIndex): { id: string; how: 'exact' | 'alias' } | null {
  const v = idx.byCropKey.get(`${cropId}|${key}`)
  if (v) return { id: v.variety_id, how: 'exact' }
  const a = idx.aliasByCropKey.get(`${cropId}|${key}`)
  if (a) return { id: a, how: 'alias' }
  return null
}

/** а) целият текст (с „+“) като сорт или псевдоним; б) частта преди „+“, остатъкът е добавка; иначе – предложения. */
export function resolveVariety(raw: string, cropId: string, idx: VarietyIndex): VarietyResolution {
  const full = varietyKey(raw)
  const f = findInCrop(full, cropId, idx)
  if (f) return { how: f.how, variety_id: f.id, addon: null }
  const plus = raw.indexOf('+')
  let addon: string | null = null
  if (plus > 0) {
    addon = raw.slice(plus + 1).replace(/\s+/g, ' ').trim() || null
    const head = varietyKey(raw.slice(0, plus))
    const h = findInCrop(head, cropId, idx)
    if (h) return { how: 'split', variety_id: h.id, addon }
  }
  const other = idx.byKeyAnyCrop.get(full)?.find((v) => v.crop_id !== cropId)
  if (other) return { how: 'other_crop', variety_id: other.variety_id, addon: null }
  const key = plus > 0 ? varietyKey(raw.slice(0, plus)) : full
  const sameCrop = idx.all.filter((v) => v.crop_id === cropId)
  return { how: 'none', variety_id: null, addon, suggestions: topMatches(key, sameCrop, (v) => varietyKey(v.name), 3, 0.35) }
}

// ───────── Редове от файла ─────────
export type ImportLine = { line: number; bzsRaw: string; varietyRaw: string; rateRaw: string; cropRaw: string; baseRaw: string; areaRaw: string }

export function extractLines(table: Table, headerRow: number, map: ColMap): ImportLine[] {
  const g = (r: string[], k: ColKey) => (map[k] != null ? (r[map[k]!] ?? '').toString().trim() : '')
  const out: ImportLine[] = []
  for (let i = headerRow + 1; i < table.length; i++) {
    const r = table[i]
    const bzsRaw = g(r, 'bzs'), varietyRaw = g(r, 'variety')
    if (!bzsRaw && !varietyRaw) continue
    if (/^(общо|всичко|total)/i.test(bzsRaw)) continue
    out.push({ line: i + 1, bzsRaw, varietyRaw, rateRaw: g(r, 'rate'), cropRaw: g(r, 'crop'), baseRaw: g(r, 'base'), areaRaw: g(r, 'area') })
  }
  return out
}

/** Група за съпоставяне на сорт: един непознат хибрид се решава веднъж за цялата култура. */
export const groupKey = (cropId: string, varietyRaw: string) => `${cropId}|${varietyKey(varietyRaw)}`

export type GroupChoice = {
  /** ръчно избран сорт (замества автоматичното съпоставяне) */
  variety_id?: string | null
  /** норма от блока с хибридите, в мерната единица на културата (или както е въведена – превръща се) */
  rate?: string
  remember?: boolean
}

export type Status = 'green' | 'yellow' | 'red'
export type PreviewRow = {
  line: ImportLine
  bzs: BzsMatch
  planting: PlantingRef | null
  bzsPicked: 'auto' | 'manual'
  group: string | null
  resolution: VarietyResolution | null
  variety: Variety | null
  addon: string | null
  oldVariety: Variety | null
  oldRate: number | null
  oldCount: number
  rate: number | null
  rateFrom: 'file' | 'group' | 'variety' | 'current' | null
  batchDropped: boolean
  /** записът ще промени вече назначени семена */
  overwrites: boolean
  /** вече е назначено точно това – не се записва */
  unchanged: boolean
  calc: Calc | null
  status: Status
  reasons: string[]
  writable: boolean
}

export type PreviewInput = {
  lines: ImportLine[]
  bzsIdx: BzsIndex
  varIdx: VarietyIndex
  crops: Map<string, Crop>
  varieties: Map<string, Variety>
  batches: Map<string, Batch>
  seedsByPlanting: Map<string, SeedRow[]>
  /** ръчен избор на БЗС по номер на ред във файла */
  bzsChoice: Map<number, string>
  groupChoice: Map<string, GroupChoice>
  /** култура по подразбиране от обхвата (за редове без намерено БЗС) */
  scopeCropId: string | null
  overwrite: boolean
}

export function buildPreview(inp: PreviewInput): PreviewRow[] {
  const rows: PreviewRow[] = inp.lines.map((line) => {
    const bzs = matchBzs(line.bzsRaw, inp.bzsIdx)
    const reasons: string[] = []
    let status: Status = 'green'
    const warn = (r: string) => { reasons.push(r); if (status === 'green') status = 'yellow' }
    const err = (r: string) => { reasons.push(r); status = 'red' }

    let planting: PlantingRef | null = null
    let bzsPicked: 'auto' | 'manual' = 'auto'
    const pickedId = inp.bzsChoice.get(line.line)
    if (pickedId) {
      planting = inp.bzsIdx.all.find((p) => p.planting_id === pickedId) ?? null
      bzsPicked = 'manual'
      if (planting && bzs.kind === 'none') warn('БЗС е избрано от близки имена')
    } else if (bzs.candidates.length === 1) planting = bzs.candidates[0]
    if (!line.bzsRaw) err('Липсва БЗС')
    else if (!planting) err(bzs.kind === 'none' ? 'БЗС не е намерено' : `${bzs.candidates.length} БЗС съвпадат – избери кое`)

    const candCrops = new Set(bzs.candidates.map((p) => p.crop_id))
    const cropId = planting?.crop_id ?? (candCrops.size === 1 ? [...candCrops][0] : null) ?? inp.scopeCropId
    const crop = cropId ? inp.crops.get(cropId) ?? null : null
    let group: string | null = null, resolution: VarietyResolution | null = null, variety: Variety | null = null, addon: string | null = null
    if (!line.varietyRaw) err('Липсва сорт')
    else if (cropId) {
      group = groupKey(cropId, line.varietyRaw)
      resolution = resolveVariety(line.varietyRaw, cropId, inp.varIdx)
      const choice = inp.groupChoice.get(group)
      addon = resolution.addon
      if (choice?.variety_id) {
        variety = inp.varieties.get(choice.variety_id) ?? null
        resolution = { how: 'manual', variety_id: choice.variety_id, addon }
      } else if (resolution.variety_id) variety = inp.varieties.get(resolution.variety_id) ?? null
      if (resolution.how === 'none') err('Непознат сорт – съпостави го в блока „Непознати хибриди“')
      else if (resolution.how === 'other_crop' || (variety && variety.crop_id !== cropId)) err('Сортът е от друга култура')
      else if (resolution.how === 'split') warn(`Сортът е намерен без „+ ${addon}“ – „${addon}“ е добавка`)
    } else err('Не е ясна културата')

    // норма: файл → блок с хибридите → норма за сорта → текуща норма → липсва
    const seeds = planting ? inp.seedsByPlanting.get(planting.planting_id) ?? [] : []
    const old = seeds[0]
    const oldVariety = old ? inp.varieties.get(old.variety_id) ?? null : null
    let rate: number | null = null, rateFrom: PreviewRow['rateFrom'] = null
    const basis = crop?.rate_basis
    const fileRate = toCropRate(parseNum(line.rateRaw), basis)
    const choice = group ? inp.groupChoice.get(group) : undefined
    const groupRate = toCropRate(parseNum(choice?.rate), basis)
    if (fileRate) { rate = fileRate; rateFrom = 'file' }
    else if (groupRate) { rate = groupRate; rateFrom = 'group' }
    else if (variety?.default_rate) { rate = Number(variety.default_rate); rateFrom = 'variety' }
    else if (old?.target_rate) { rate = Number(old.target_rate); rateFrom = 'current' }
    if (line.rateRaw && parseNum(line.rateRaw) == null) err(`Норма „${line.rateRaw}“ не е число`)
    else if (!rate) err('Липсва норма')

    if (planting && !((planting.planted_area_da ?? 0) > 0)) err('БЗС няма засята площ')

    let batchDropped = false, overwrites = false, unchanged = false
    if (seeds.length > 0) {
      const same = variety && seeds.length === 1 && old.variety_id === variety.variety_id
      if (variety && !same) {
        overwrites = true
        warn(`Ще презапише ${oldVariety?.name ?? 'сорт'}${seeds.length > 1 ? ` (+${seeds.length - 1})` : ''} → ${variety.name}`)
        if (seeds.some((s) => s.batch_id)) { batchDropped = true; warn('Партидата ще бъде премахната') }
      } else if (same && rate != null && Number(old.target_rate) !== rate) { overwrites = true; warn(`Норма ${old.target_rate} → ${rate}`) }
      else if (same && (old.addon ?? null) !== addon) { overwrites = true; warn('Сменя се добавката') }
      else { unchanged = true; reasons.push('Без промяна – вече е назначено същото') }
    }

    // количество по сегашната логика
    let calc: Calc | null = null
    if (crop && variety && rate && planting && (planting.planted_area_da ?? 0) > 0) {
      const keepBatch = seeds.length === 1 && old.variety_id === variety.variety_id && old.batch_id ? inp.batches.get(old.batch_id) : undefined
      calc = calcRow(crop, { area_da: Number(planting.planted_area_da), target_rate: rate, overage_pct: keepBatch ? old.overage_pct : null }, keepBatch, variety)
    }

    return {
      line, bzs, planting, bzsPicked, group, resolution, variety, addon, oldVariety, oldRate: old ? Number(old.target_rate) : null, oldCount: seeds.length,
      rate, rateFrom, batchDropped, overwrites, unchanged, calc, status, reasons, writable: false,
    }
  })

  // дублирано БЗС в импорта
  const count = new Map<string, number>()
  for (const r of rows) if (r.planting) count.set(r.planting.planting_id, (count.get(r.planting.planting_id) ?? 0) + 1)
  for (const r of rows) if (r.planting && (count.get(r.planting.planting_id) ?? 0) > 1) { r.status = 'red'; r.reasons.push('БЗС се среща повече от веднъж в импорта') }

  // записват се зелените и жълтите; редовете, които променят вече назначени семена – само при „Презапиши вече назначените“
  for (const r of rows) r.writable = r.status !== 'red' && !r.unchanged && (!r.overwrites || inp.overwrite)
  return rows
}

/** Обобщение по сорт за редовете, които ще се запишат. */
export type Summary = { name: string; bzs: number; area: number; t: number; packs: number; missing: number }
export function summarize(rows: PreviewRow[]): Summary[] {
  const m = new Map<string, Summary>()
  for (const r of rows) {
    if (!r.writable || !r.variety) continue
    const k = r.variety.variety_id
    const s = m.get(k) ?? { name: r.variety.name, bzs: 0, area: 0, t: 0, packs: 0, missing: 0 }
    s.bzs++
    s.area += Number(r.planting?.planted_area_da ?? 0)
    if (r.calc && !r.calc.missing) { s.t += r.calc.t ?? 0; s.packs += r.calc.packs ?? 0 } else s.missing++
    m.set(k, s)
  }
  return [...m.values()].sort((a, b) => b.area - a.area)
}

/** Уникалните хибриди, които не са разпознати автоматично (за блока „Непознати хибриди“). */
export type UnknownGroup = { key: string; crop_id: string; raw: string; rows: number; area: number; resolution: VarietyResolution }
export function hybridGroups(rows: PreviewRow[]): UnknownGroup[] {
  const m = new Map<string, UnknownGroup>()
  for (const r of rows) {
    if (!r.group || !r.resolution) continue
    const g = m.get(r.group) ?? { key: r.group, crop_id: r.group.split('|')[0], raw: r.line.varietyRaw, rows: 0, area: 0, resolution: r.resolution }
    g.rows++
    g.area += Number(r.planting?.planted_area_da ?? 0)
    m.set(r.group, g)
  }
  return [...m.values()].sort((a, b) => a.raw.localeCompare(b.raw, 'bg'))
}

/** Инструкция за ChatGPT с колоните на шаблона и позволените хибриди. */
export function chatGptInstruction(rateUnit: string, cropNames: string[], allowed: Map<string, string[]>): string {
  const lists = [...allowed.entries()].map(([crop, names]) => `${crop}:\n${names.map((n) => `- ${n}`).join('\n')}`).join('\n\n')
  return [
    'Върни разпределението на сортовете/хибридите като markdown таблица с ТОЧНО тези колони, в този ред:',
    `| БЗС | Култура | Площ | Стопанство | Сорт/Хибрид | Норма (${rateUnit}) |`,
    '',
    'Правила:',
    '- По един ред на БЗС. Не пропускай и не повтаряй БЗС.',
    '- Имената на БЗС пиши точно както са в шаблона (без да ги превеждаш, съкращаваш или поправяш).',
    '- В „Сорт/Хибрид“ избирай САМО от списъка по-долу и пиши името точно както е там.',
    '- Ако към хибрида има добавка/технология (напр. Артемид), пиши я след „+“: „P64 LE 162 + Артемид“.',
    `- „Норма“ е по избор: ${rateUnit}. Ако не я знаеш, остави клетката празна.`,
    '- Без обобщаващи редове, без бележки в таблицата.',
    '',
    `Позволени хибриди/сортове${cropNames.length ? ` (${cropNames.join(', ')})` : ''}:`,
    lists,
  ].join('\n')
}

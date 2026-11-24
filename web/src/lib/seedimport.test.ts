// Тестове за бързия импорт на сортове. Пускане: npm test
// Реалният файл (183 реда слънчоглед) се тества, ако е зададена папка със снимка на данните:
//   SEED_IMPORT_FIXTURES=/път/до/папка npm test
// В папката: plantings.json, varieties.json, crops.json, field_alias.json, seeds.json, variant1.tsv, variant3.tsv (не се комитват).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  normBzs, varietyKey, parsePasted, detectColumns, findHeaderRow, extractLines, buildBzsIndex, buildVarietyIndex,
  buildPreview, hybridGroups, summarize, toCropRate, matchBzs, resolveVariety, groupKey,
  type PlantingRef, type SeedRow, type GroupChoice, type AliasRow, type FieldAlias, type PreviewInput,
} from './seedimport.ts'
import type { Crop, Variety, Batch } from './seedcalc.ts'

// ───────── Нормализиране ─────────
test('normBzs: тирета, интервали, латински look-alike', () => {
  assert.equal(normBzs('КАЙСИЕВА ГРАДИНА - ДРЯНОВЕЦ'), normBzs('Кайсиева  градина–Дряновец'))
  assert.equal(normBzs('ЛИВАДИТЕ 3 (РЕАЛНА ГРАНИЦА)-1'), normBzs(' ливадите 3 ( реална граница ) — 1 '))
  assert.equal(normBzs('БAБУКA'), 'БАБУКА')            // латински A
  assert.equal(normBzs('123-ТО ДЕРМЕН СЪРТ 2-2'), normBzs('123 - ТО ДЕРМЕН СЪРТ 2 - 2'))
  assert.notEqual(normBzs('МЕРАТА 1-1'), normBzs('МЕРАТА 1-2'))
})

test('varietyKey: без интервали, точки и тирета; „+“ остава', () => {
  assert.equal(varietyKey('P64 LP 146'), varietyKey('P64LP146'))
  assert.equal(varietyKey('LG 50.550 CLP'), varietyKey('LG50550CLP'))
  assert.equal(varietyKey('P64 LE 162 + Артемид'), varietyKey('P64 LE 162+Артемид'))
  assert.equal(varietyKey('P64 HE 244+АРТЕМИД'), varietyKey('p64 he 244 + артемид'))
  assert.notEqual(varietyKey('P64 LE 162'), varietyKey('P64 LE 162+Артемид'))
})

test('toCropRate: превръщане към мерната единица на културата', () => {
  assert.equal(toCropRate(6.5, 'seeds_da'), 6500)     // м² → дка
  assert.equal(toCropRate(6500, 'seeds_da'), 6500)
  assert.equal(toCropRate(450, 'germ_seeds_m2'), 450)
  assert.equal(toCropRate(450000, 'germ_seeds_m2'), 450) // дка → м²
  assert.equal(toCropRate(null, 'seeds_da'), null)
  assert.equal(toCropRate(0, 'seeds_da'), null)
})

test('detectColumns: „Предложен хибрид“, не „История хибрид“', () => {
  const h = ['База', 'Землище', 'БЗС', 'Площ дка', 'Потенциал', 'Тип', 'История сезон', 'История хибрид', 'Предходна технология', 'Предложен хибрид', 'Нова технология', 'Контрол']
  const { map, ambiguous } = detectColumns(h)
  assert.equal(map.bzs, 2)
  assert.equal(map.variety, 9)
  assert.equal(map.area, 3)
  assert.equal(map.base, 0)
  assert.equal(map.rate, undefined)
  assert.equal(ambiguous, false)
  assert.deepEqual(detectColumns(['№ БЗС', 'Сорт/Хибрид', 'Норма (сем./дка)']).map, { bzs: 0, variety: 1, rate: 2 })
  assert.equal(detectColumns(['Поле', 'Нещо']).ambiguous, true)
})

// ───────── Синтетични 10 реда ─────────
const SUN = 'sun', WHEAT = 'wheat'
const crops: Crop[] = [
  { crop_id: SUN, name_bg: 'СЛЪНЧОГЛЕД', seeding_method: 'row', rate_basis: 'seeds_da', order_unit: 'packs', default_seeds_per_pack: 150000, seed_overage_pct: 0, rate_rounding_step: null },
  { crop_id: WHEAT, name_bg: 'ПШЕНИЦА', seeding_method: 'solid', rate_basis: 'germ_seeds_m2', order_unit: 'kg', default_seeds_per_pack: null, seed_overage_pct: 0, rate_rounding_step: 1 },
]
const V = (id: string, crop: string, name: string, extra: Partial<Variety> = {}): Variety => ({ variety_id: id, crop_id: crop, name, seeds_per_pack: null, ...extra })
const varieties: Variety[] = [
  V('v146', SUN, 'P64 LP 146'), V('v550', SUN, 'LG 50.550 CLP'), V('v162', SUN, 'P64 LE 162'),
  V('v162a', SUN, 'P64 LE 162+Артемид'), V('vmich', SUN, 'СИ Мичиган CLP'), V('v244', SUN, 'P64 HE 244'),
  V('vsubeo', SUN, 'Субео HTS'), V('vavenue', WHEAT, 'Авеню'),
]
const P = (id: string, name: string, isak: string, area: number, crop = SUN): PlantingRef => ({
  planting_id: id, organization_id: 'org', field_id: 'f' + id, field_name: name, isak_number: isak, company_name: 'ФИРМА', farm_base_name: 'БАЗА',
  crop_id: crop, crop_name: crop === SUN ? 'СЛЪНЧОГЛЕД' : 'ПШЕНИЦА', planted_area_da: area,
})
const plantings: PlantingRef[] = [
  P('p1', 'БАБУКА', '03602-197-1-1', 209),
  P('p2', 'ЛИВАДИТЕ 3 (РЕАЛНА ГРАНИЦА)-1', '21645-86-1-1', 41),
  P('p3', '123-ТО ДЕРМЕН СЪРТ 2-1', '39829-523-3-2', 73),
  P('p4', '123-ТО ДЕРМЕН СЪРТ 2-2', '39829-523-3-2', 84),
  P('p5', 'КАЙСИЕВА ГРАДИНА - ДРЯНОВЕЦ', '54105-898-4-1', 22),
  P('p6', 'МЕРАТА 1-1', '56143-506-2-3', 45),
  P('p7', '30-ТИ МАСИВ', '29458-750-3-1', 255),
  P('p8', 'ПРЕД РАБОТИЛНИЦАТА 2', '03602-113-1-1', 100, WHEAT),
]
const aliases: AliasRow[] = [{ crop_id: SUN, alias_normalized: varietyKey('Michigan CLP'), variety_id: 'vmich' }]
const seeds: SeedRow[] = [{ planting_id: 'p6', variety_id: 'v244', batch_id: 'b1', target_rate: 6000, overage_pct: null }]
const batches: Batch[] = [{ batch_id: 'b1', variety_id: 'v244', reproduction_id: null, tkw_g: null, germination_pct: null, seeds_per_pack: 150000 }]

const SYNTH = `Ето разпределението:

| БЗС | Култура | Площ | Стопанство | Предложен хибрид | Норма |
|---|---|---|---|---|---|
| БAБУКA | Слънчоглед | 209 | БАЗА | P64LP146 | 6,5 |
| ЛИВАДИТЕ 3 (РЕАЛНА ГРАНИЦА) – 1 | Слънчоглед | 41 | БАЗА | LG 50.550 CLP |  |
| 39829-523-3-2 | Слънчоглед | 73 | БАЗА | P64 LE 162 + Артемид | 6200 |
| 123-ТО ДЕРМЕН СЪРТ 2-2 | Слънчоглед | 84 | БАЗА | P64 HE 244 + Пума | 6000 |
| КАЙСИЕВА ГРАДИНА-ДРЯНОВЕЦ | Слънчоглед | 22 | БАЗА | Michigan CLP | 6000 |
| МЕРАТА 1-1 | Слънчоглед | 45 | БАЗА | P64 LP 146 | 6000 |
| 30-ТИ МАСИВ | Слънчоглед | 255 | БАЗА | Субео ХТС | 6000 |
| ПРЕД РАБОТИЛНИЦАТА 2 | Пшеница | 100 | БАЗА | P64 LP 146 | 500 |
| НЕСЪЩЕСТВУВАЩО ПОЛЕ | Слънчоглед | 10 | БАЗА | P64 LP 146 | 6000 |
| БАБУКА | Слънчоглед | 209 | БАЗА | LG 50.550 CLP | 6000 |
`

function synthInput(over: Partial<PreviewInput> = {}): PreviewInput {
  const table = parsePasted(SYNTH)
  const hr = findHeaderRow(table)
  const { map } = detectColumns(table[hr])
  return {
    lines: extractLines(table, hr, map),
    bzsIdx: buildBzsIndex(plantings),
    varIdx: buildVarietyIndex(varieties, aliases),
    crops: new Map(crops.map((c) => [c.crop_id, c])),
    varieties: new Map(varieties.map((v) => [v.variety_id, v])),
    batches: new Map(batches.map((b) => [b.batch_id, b])),
    seedsByPlanting: new Map([['p6', seeds]]),
    bzsChoice: new Map(), groupChoice: new Map(), scopeCropId: null, overwrite: false,
    ...over,
  }
}

test('синтетични 10 реда: разчитане на markdown от ChatGPT', () => {
  const table = parsePasted(SYNTH)
  assert.equal(table.length, 11)                     // заглавие + 10 реда; разделителят |---| е махнат
  assert.equal(extractLines(table, findHeaderRow(table), detectColumns(table[0]).map).length, 10)
  // TSV (копиране от Excel)
  const tsv = parsePasted('БЗС\tПредложен хибрид\nБАБУКА\tP64 LP 146\n')
  assert.deepEqual(tsv, [['БЗС', 'Предложен хибрид'], ['БАБУКА', 'P64 LP 146']])
})

test('синтетични 10 реда: статуси без ръчни решения', () => {
  const rows = buildPreview(synthInput())
  const st = rows.map((r) => r.status)
  assert.deepEqual(st, ['red', 'red', 'red', 'yellow', 'green', 'yellow', 'red', 'red', 'red', 'red'])

  // 1: латински букви в името, норма 6,5 → 6500 сем./дка; но БАБУКА е и на ред 10 → дубликат
  assert.equal(rows[0].planting?.planting_id, 'p1')
  assert.equal(rows[0].rate, 6500)
  assert.ok(rows[0].reasons.includes('БЗС се среща повече от веднъж в импорта'))
  // 2: тире с интервали; няма норма
  assert.equal(rows[1].planting?.planting_id, 'p2')
  assert.ok(rows[1].reasons.includes('Липсва норма'))
  // 3: номер с две БЗС; хибридът с „+“ се намира цял
  assert.equal(rows[2].bzs.kind, 'number')
  assert.equal(rows[2].bzs.candidates.length, 2)
  assert.equal(rows[2].resolution?.variety_id, 'v162a')
  assert.equal(rows[2].addon, null)
  // 4: целият текст не е сорт → частта преди „+“, добавка „Пума“, жълто
  assert.equal(rows[3].resolution?.how, 'split')
  assert.equal(rows[3].variety?.variety_id, 'v244')
  assert.equal(rows[3].addon, 'Пума')
  assert.equal(rows[3].writable, true)
  // 5: псевдоним
  assert.equal(rows[4].resolution?.how, 'alias')
  assert.equal(rows[4].variety?.variety_id, 'vmich')
  assert.equal(rows[4].writable, true)
  // 6: презаписва P64 HE 244 → P64 LP 146, партидата отпада; без „Презапиши“ не се записва
  assert.equal(rows[5].oldVariety?.name, 'P64 HE 244')
  assert.equal(rows[5].batchDropped, true)
  assert.equal(rows[5].writable, false)
  // 7: „Субео ХТС“ (кирилица) → непознат, с предложение „Субео HTS“
  assert.equal(rows[6].resolution?.how, 'none')
  assert.ok(rows[6].resolution?.how === 'none' && rows[6].resolution.suggestions.some((v) => v.variety_id === 'vsubeo'))
  // 8: пшеница + слънчогледов хибрид → друга култура
  assert.equal(rows[7].resolution?.how, 'other_crop')
  assert.ok(rows[7].reasons.includes('Сортът е от друга култура'))
  // 9: несъществуващо БЗС
  assert.equal(rows[8].bzs.kind, 'none')
  // 10: дубликат
  assert.ok(rows[9].reasons.includes('БЗС се среща повече от веднъж в импорта'))

  // групи по хибрид: 7 уникални за слънчоглед + 1 за пшеница
  const groups = hybridGroups(rows)
  assert.equal(groups.filter((g) => g.crop_id === SUN).length, 6)
  assert.equal(groups.find((g) => g.raw === 'P64 LP 146')?.rows, 1)
})

test('синтетични 10 реда: след ръчните решения', () => {
  const groupChoice = new Map<string, GroupChoice>([
    [groupKey(SUN, 'LG 50.550 CLP'), { rate: '6000' }],
    [groupKey(SUN, 'Субео ХТС'), { variety_id: 'vsubeo' }],
  ])
  const line3 = buildPreview(synthInput())[2].line.line   // редът с 39829-523-3-2
  const bzsChoice = new Map<number, string>([[line3, 'p3']])
  const rows = buildPreview(synthInput({ groupChoice, bzsChoice, overwrite: true }))
  assert.equal(rows[1].status, 'green')
  assert.equal(rows[1].rate, 6000)
  assert.equal(rows[1].rateFrom, 'group')
  assert.equal(rows[2].planting?.planting_id, 'p3')
  assert.equal(rows[2].status, 'green')
  assert.equal(rows[5].writable, true)                // с „Презапиши“
  assert.equal(rows[6].status, 'green')
  assert.equal(rows[6].resolution?.how, 'manual')
  // торби по сегашната логика: 6000 сем./дка × 41 дка / 150 000
  assert.ok(Math.abs((rows[1].calc?.packs ?? 0) - (6000 * 41) / 150000) < 1e-9)
  const sum = summarize(rows)
  assert.equal(sum.reduce((s, x) => s + x.bzs, 0), rows.filter((r) => r.writable).length)
})

test('норма: файл → блок → норма за сорта → текуща', () => {
  const vs = varieties.map((v) => (v.variety_id === 'v550' ? { ...v, default_rate: 5800 } : v))
  const rows = buildPreview(synthInput({ varieties: new Map(vs.map((v) => [v.variety_id, v])), varIdx: buildVarietyIndex(vs, aliases) }))
  assert.equal(rows[1].rate, 5800)
  assert.equal(rows[1].rateFrom, 'variety')
})

// ───────── Реалният файл ─────────
const FX = process.env.SEED_IMPORT_FIXTURES
const fx = (f: string) => JSON.parse(readFileSync(join(FX!, f), 'utf8'))

test('реален файл: 183 реда слънчоглед, 13 хибрида (Вариант 1)', { skip: !FX || !existsSync(join(FX ?? '', 'variant1.tsv')) ? 'няма SEED_IMPORT_FIXTURES' : false }, () => {
  const pl = (fx('plantings.json') as PlantingRef[])
  const cr = fx('crops.json') as Crop[]
  const va = fx('varieties.json') as Variety[]
  const fa = fx('field_alias.json') as FieldAlias[]
  const sd = fx('seeds.json') as SeedRow[]
  const sun = cr.find((c) => c.name_bg === 'СЛЪНЧОГЛЕД')!
  const scope = pl.filter((p) => p.crop_id === sun.crop_id)
  const sbp = new Map<string, SeedRow[]>()
  for (const s of sd) sbp.set(s.planting_id, [...(sbp.get(s.planting_id) ?? []), s])

  for (const file of ['variant1.tsv', 'variant3.tsv']) {
    const table = parsePasted(readFileSync(join(FX!, file), 'utf8'))
    const hr = findHeaderRow(table)
    const { map } = detectColumns(table[hr])
    const lines = extractLines(table, hr, map)
    assert.equal(lines.length, 183, file)
    const rows = buildPreview({
      lines, bzsIdx: buildBzsIndex(scope, fa), varIdx: buildVarietyIndex(va, []),
      crops: new Map(cr.map((c) => [c.crop_id, c])), varieties: new Map(va.map((v) => [v.variety_id, v])), batches: new Map(),
      seedsByPlanting: sbp, bzsChoice: new Map(), groupChoice: new Map(), scopeCropId: sun.crop_id, overwrite: false,
    })
    const notFound = rows.filter((r) => !r.planting)
    assert.deepEqual(notFound.map((r) => r.line.bzsRaw), [], `${file}: ненамерени БЗС`)
    assert.equal(new Set(rows.map((r) => r.planting!.planting_id)).size, 183, `${file}: всички БЗС са различни`)
    const groups = hybridGroups(rows)
    const unknown = groups.filter((g) => g.resolution.how === 'none' || g.resolution.how === 'other_crop')
    console.log(`  ${file}: ${groups.length} хибрида; разпознати: ${groups.filter((g) => !unknown.includes(g)).map((g) => `${g.raw} [${g.resolution.how}]`).join(', ')}`)
    console.log(`  ${file}: непознати: ${unknown.map((g) => `${g.raw} → ${g.resolution.how === 'none' ? g.resolution.suggestions.map((v) => v.name).join(' / ') : 'друга култура'}`).join('; ') || 'няма'}`)
    // „P64 LE 162 + Артемид“ трябва да намери съществуващия сорт „P64 LE 162+Артемид“ цял
    const art = groups.find((g) => g.raw.startsWith('P64 LE 162'))
    assert.equal(art && va.find((v) => v.variety_id === art.resolution.variety_id)?.name, 'P64 LE 162+Артемид')
    // без норма във файла и без норми за сортовете → всички са червени с „Липсва норма“, докато не се попълни блокът
    assert.ok(rows.every((r) => r.status === 'red' && r.reasons.includes('Липсва норма')))
    if (file === 'variant1.tsv') assert.equal(groups.length, 13)
  }
})

test('matchBzs и resolveVariety поотделно', () => {
  const idx = buildBzsIndex(plantings, [{ field_id: 'fp6', alias_name: 'МЕРАТА 1 ПАРЧЕ А' }])
  assert.equal(matchBzs('мерата 1 парче а', idx).kind, 'alias')
  assert.equal(matchBzs('21645-86-1-1', idx).candidates[0]?.planting_id, 'p2')
  const n = matchBzs('БАБУКАА', idx)
  assert.equal(n.kind, 'none')
  assert.equal(n.kind === 'none' && n.suggestions[0]?.planting_id, 'p1')
  const vi = buildVarietyIndex(varieties, [])
  assert.equal(resolveVariety('p64 le 162 + артемид', SUN, vi).variety_id, 'v162a')
  assert.equal(resolveVariety('LG50550CLP', SUN, vi).variety_id, 'v550')
})

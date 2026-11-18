// Тестове с данните от „РЕКАПИТУЛАЦИЯ 2026-2027“ (площ по правно основание). Пускане: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCompany, statusText, placeLabel, type EcoRule, type GroupArea } from './recap.ts'

const RULE: EcoRule = {
  dzes_first_max: 0.75, dzes_first_two_max: 0.95, dzes_third_min: 0.05,
  ekorok_first_max: 0.75, ekorok_first_three_max: 0.95, ekorok_fourth_min: 0.05,
  enp_min: 0.04, dzes_min_crops: 3, ekorok_min_crops: 4, min_crops_from_dka: 300,
}
// Колони от Excel: ЕЧЕМИК, ПШЕНИЦА, РАПИЦА, СЛЪНЧОГЛЕД, ЦАРЕВИЦА, СОРГО, НПП, ЛЮЦЕРНА, ГРАХ, ЛОЗЯ
type XRow = [number, number, number, number, number, number, number, number, number, number]
function groups([ech, psh, rap, sl, car, sor, npp, lu, gr, lo]: XRow): GroupArea[] {
  const g = (group: string, area: number, inTotal = true, ranks = true): GroupArea => ({ group, area, inTotal, ranks })
  return [g('ЕЧЕМИК', ech), g('ПШЕНИЦА', psh), g('РАПИЦА', rap), g('СЛЪНЧОГЛЕД', sl), g('ЦАРЕВИЦА', car), g('СОРГО', sor),
    g('ЕНП РЕАЛНО', npp), g('ЕНП РЕАЛНО', lu), g('ЕНП РЕАЛНО', gr), g('ЛОЗЯ', lo, false, false)]
}
const pct = (v: number) => Math.round(v * 10000) / 100

// Площи и дялове (O, P, R, T, U от листа), %.
const EXCEL: Record<string, { row: XRow; total: number; I: number; I_II: number; III: number; I_II_III: number; IV: number }> = {
  'АГРА ЕАД': { row: [594, 3889, 944, 3504, 0, 0, 0, 0, 0, 0], total: 8931, I: 43.54, I_II: 82.78, III: 10.57, I_II_III: 93.35, IV: 6.65 },
  'АГРО ЕООД': { row: [945, 2450, 1389, 3902, 0, 605, 0, 43, 0, 0], total: 9334, I: 41.80, I_II: 68.05, III: 14.88, I_II_III: 82.93, IV: 10.12 },
  'БД АГРИ ЕООД': { row: [2257, 14695, 2012, 11185, 0, 1253, 115, 386, 0, 0], total: 31903, I: 46.06, I_II: 81.12, III: 7.07, I_II_III: 88.20, IV: 6.31 },
  'ГРУВЪР ЕООД': { row: [1186, 1638, 632, 2897, 0, 739, 0, 0, 0, 0], total: 7092, I: 40.85, I_II: 63.95, III: 16.72, I_II_III: 80.67, IV: 10.42 },
  'КОМЕРС ЕООД': { row: [1381, 3409, 836, 3378, 0, 0, 0, 0, 0, 0], total: 9004, I: 37.86, I_II: 75.38, III: 15.34, I_II_III: 90.72, IV: 9.28 },
  'КРИСТЕРА АГРО ЕООД': { row: [1420, 15913, 2706, 11200, 7857, 1159, 135, 179, 0, 0], total: 40569, I: 39.22, I_II: 66.83, III: 19.37, I_II_III: 86.20, IV: 6.67 },
  'ТОНИ М ЕООД': { row: [1271, 3572, 0, 2359, 0, 0, 0, 51, 0, 0], total: 7253, I: 49.25, I_II: 81.77, III: 17.52, I_II_III: 99.30, IV: 0.70 },
  'АГРИКОРН СТАР ЕАД': { row: [937, 8517, 0, 6709, 0, 0, 0, 116, 0, 0], total: 16279, I: 52.32, I_II: 93.53, III: 5.76, I_II_III: 99.29, IV: 0.71 },
  'ЕКО ХЕРБС ЕАД': { row: [160, 0, 0, 642, 0, 0, 0, 0, 0, 0], total: 802, I: 80.05, I_II: 100, III: 0, I_II_III: 100, IV: 0 },
}

for (const [firm, x] of Object.entries(EXCEL)) {
  test(`${firm}: дялове като в Excel`, () => {
    const r = computeCompany(groups(x.row), RULE)
    assert.equal(r.total, x.total)
    assert.deepEqual([pct(r.I), pct(r.I_II), pct(r.III), pct(r.I_II_III), pct(r.IV)], [x.I, x.I_II, x.III, x.I_II_III, x.IV])
  })
}

test('АГРА ЕАД: покрива ДЗЕС и ЕКОРОК', () => {
  const r = computeCompany(groups(EXCEL['АГРА ЕАД'].row), RULE)
  assert.equal(r.dzes.ok, true); assert.equal(r.ekorok.ok, true)
  assert.equal(statusText(r.dzes), 'Покрива')
  assert.deepEqual(r.ranked.map((x) => x.group), ['ПШЕНИЦА', 'СЛЪНЧОГЛЕД', 'РАПИЦА', 'ЕЧЕМИК'])
})

test('ТОНИ М ЕООД: ДЗЕС покрива, ЕКОРОК не (I+II+III и IV)', () => {
  const r = computeCompany(groups(EXCEL['ТОНИ М ЕООД'].row), RULE)
  assert.equal(r.dzes.ok, true)
  assert.equal(r.ekorok.ok, false)
  assert.deepEqual(r.ekorok.fails.map((f) => f.key), ['I+II+III', 'IV'])
  assert.equal(statusText(r.ekorok), 'I+II+III 99,30 % ≥ 95,00 % +1')
  assert.equal(r.ranked[3].group, 'ЕНП РЕАЛНО')
})

test('ЕКО ХЕРБС ЕАД: не покрива и двете, всички условия, 2 култури при 802 дка', () => {
  const r = computeCompany(groups(EXCEL['ЕКО ХЕРБС ЕАД'].row), RULE)
  assert.equal(r.nCrops, 2)
  assert.equal(r.dzesCountFails, true)
  assert.equal(r.ekorokCountFails, true)
  assert.deepEqual(r.dzes.fails.map((f) => f.key), ['I', 'I+II', 'III', 'count'])
  assert.deepEqual(r.ekorok.fails.map((f) => f.key), ['I', 'I+II+III', 'IV', 'count'])
  assert.match(r.dzes.fails[0].text, /80,05/)
  assert.match(r.dzes.fails[3].text, /2 култури при 802 дка \(нужни 3\)/)
  assert.match(r.ekorok.fails[3].text, /2 култури при 802 дка \(нужни 4\)/)
})

test('лозя не влизат в общата площ и не се класират', () => {
  const r = computeCompany(groups([100, 100, 100, 100, 0, 0, 0, 0, 0, 500]), RULE)
  assert.equal(r.total, 400)
  assert.equal(r.ranked.length, 4)
})

test('праг: точно 75 % не покрива (≥), точно 5 % за III покрива (<)', () => {
  const r = computeCompany(groups([5, 75, 0, 0, 0, 0, 0, 0, 0, 0]).concat([{ group: 'СОРГО', area: 20, inTotal: true, ranks: true }]), RULE)
  assert.equal(pct(r.I), 75)
  assert.ok(r.dzes.fails.some((f) => f.key === 'I'))
  assert.ok(!r.dzes.fails.some((f) => f.key === 'III'))
})

test('равни площи: класиране по име', () => {
  const r = computeCompany(groups([100, 100, 0, 0, 0, 0, 0, 0, 0, 0]), RULE)
  assert.deepEqual(r.ranked.map((x) => x.group), ['ЕЧЕМИК', 'ПШЕНИЦА'])
})

test('под min_crops_from_dka броят култури не се проверява', () => {
  const r = computeCompany(groups([100, 150, 0, 0, 0, 0, 0, 0, 0, 0]), RULE)
  assert.equal(r.dzesCountFails, false)
  assert.equal(r.ekorokCountFails, false)
})

test('3 култури над 300 дка: ДЗЕС стига (3), ЕКОРОК не (4)', () => {
  const r = computeCompany(groups([300, 400, 300, 0, 0, 0, 0, 0, 0, 0]), RULE)
  assert.equal(r.nCrops, 3)
  assert.equal(r.dzesCountFails, false)
  assert.equal(r.ekorokCountFails, true)
  assert.ok(r.dzes.ok)
  assert.deepEqual(r.ekorok.fails.map((f) => f.key), ['I+II+III', 'IV', 'count'])
})

test('ЕНП: дял, необходимо и разлика', () => {
  const r = computeCompany(groups(EXCEL['БД АГРИ ЕООД'].row), RULE)
  assert.equal(r.enpArea, 501)
  assert.equal(Math.round(r.enpNeeded * 100) / 100, 1276.12)
  assert.equal(Math.round(r.enpDiff * 100) / 100, -775.12)
  assert.equal(r.enpBelow, true)
})

test('място в класирането', () => {
  assert.equal(placeLabel(1), 'ДЗЕС I · ЕКОРОК I')
  assert.equal(placeLabel(4), 'ЕКОРОК IV')
  assert.equal(placeLabel(5), '—')
})

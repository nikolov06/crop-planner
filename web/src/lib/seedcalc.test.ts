// Формулите за семена (сверени с Excel сеитбооборота) и рекапитулацията. Пускане: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calcRow, totalSeeds, kgPerDa, seedCost, round1, type Crop } from './seedcalc.ts'
import { buildSeedRecap, orderLines, type RecapInput } from './seedrecap.ts'

const crop = (o: Partial<Crop>): Crop => ({
  crop_id: 'c', name_bg: 'ЕЧЕМИК', seeding_method: 'solid', rate_basis: 'germ_seeds_m2', order_unit: 'kg',
  default_seeds_per_pack: null, seed_overage_pct: 3, rate_rounding_step: null, ...o,
})
const BARLEY = crop({})
const RAPE = crop({ name_bg: 'РАПИЦА', order_unit: 'packs', default_seeds_per_pack: 1_500_000, seed_overage_pct: 1.5, rate_rounding_step: 0.1 })
const SUN = crop({ name_bg: 'СЛЪНЧОГЛЕД', seeding_method: 'row', rate_basis: 'seeds_da', order_unit: 'packs', default_seeds_per_pack: 150_000, seed_overage_pct: 1.5 })

// МХЗ г | кълняемост % | кълняеми сем./м² → брой сем./м² → кг/дка
const ROWS: [number, number, number, number, number][] = [
  [42.5, 95, 500, 527, 22],
  [45.4, 91, 470, 517, 23],
  [43, 90, 470, 523, 22],
  [42.5, 95, 470, 495, 21],
  [35.1, 97, 500, 516, 18],
  [54, 95, 400, 422, 23],
]

test('шестте тестови реда от Excel', () => {
  for (const [tkw, germ, rate, seeds, kg] of ROWS) {
    assert.equal(totalSeeds(rate, germ), seeds, `${tkw}/${germ}/${rate}: сем./м²`)
    assert.equal(kgPerDa(seeds, tkw), kg, `${tkw}/${germ}/${rate}: кг/дка`)
    const c = calcRow(BARLEY, { area_da: 100, target_rate: rate, overage_pct: null, tkw_g: tkw, germination_pct: germ }, undefined)
    assert.equal(c.totalSeedsM2, seeds); assert.equal(c.kgDa, kg); assert.equal(c.missing, false)
  }
})

test('точно деление не се закръгля нагоре (470 / 94 % = 500)', () => {
  assert.equal(totalSeeds(470, 94), 500)
  assert.equal(totalSeeds(450, 90), 500)
})

test('количество: нужда без и с преразход', () => {
  const c = calcRow(BARLEY, { area_da: 88, target_rate: 500, overage_pct: null, tkw_g: 42.5, germination_pct: 95 }, undefined)
  assert.equal(c.needT, 22 * 88 / 1000)           // 1,936 → показва се 1,94
  assert.equal(c.t, 22 * 88 * 1.03 / 1000)
  assert.equal(c.overagePct, 3)
})

test('МХЗ и кълняемост: БЗС → партида → сорт', () => {
  const b = { batch_id: 'b', variety_id: 'v', reproduction_id: null, tkw_g: 45.4, germination_pct: 91, seeds_per_pack: null }
  const v = { variety_id: 'v', crop_id: 'c', name: 'Зебра', seeds_per_pack: null, tkw_g: 50, germination_pct: 80 }
  const base = { area_da: 10, target_rate: 470, overage_pct: null }
  assert.equal(calcRow(BARLEY, base, undefined, v).tkwSource, 'variety')
  const fromBatch = calcRow(BARLEY, base, b, v)
  assert.equal(fromBatch.tkwSource, 'batch'); assert.equal(fromBatch.kgDa, 23)
  const own = calcRow(BARLEY, { ...base, tkw_g: 43, germination_pct: 90 }, b, v)
  assert.equal(own.tkwSource, 'bzs'); assert.equal(own.germSource, 'bzs'); assert.equal(own.kgDa, 22)
})

test('ръчна норма кг/дка презаписва изчислената', () => {
  const c = calcRow(BARLEY, { area_da: 100, target_rate: 500, overage_pct: null, tkw_g: 35.1, germination_pct: 97, rate_kg_da_manual: 18.3 }, undefined)
  assert.equal(c.kgDaCalc, 18); assert.equal(c.kgDa, 18.3); assert.equal(c.manual, true)
  assert.equal(round1(c.needT! * 1000) / 1000, 1.83)
})

test('липсващи МХЗ/кълняемост → „липсват данни“', () => {
  assert.equal(calcRow(BARLEY, { area_da: 10, target_rate: 500, overage_pct: null }, undefined).missing, true)
})

test('рапица: торби през семената, кг/дка с 2 знака само за информация', () => {
  const c = calcRow(RAPE, { area_da: 100, target_rate: 55, overage_pct: null, tkw_g: 5.2, germination_pct: 92 }, undefined)
  assert.equal(c.totalSeedsM2, 60)                // 55 / 0,92 = 59,8 → 60
  assert.equal(c.kgDaInfo, 0.31)                  // 60 × 5,2 / 1000 = 0,312
  assert.equal(c.kgDa, null)
  assert.equal(c.needPacks, 60 * 1000 * 100 / 1_500_000)
  assert.equal(c.packs, c.needPacks! * 1.015)
})

test('слънчоглед: сем./дка × дка ÷ семена в торба', () => {
  const c = calcRow(SUN, { area_da: 257, target_rate: 6000, overage_pct: null }, undefined)
  assert.equal(c.needPacks, 6000 * 257 / 150_000)  // 10,28
  assert.equal(round1(c.packs!), 10.4)            // × 1,015 = 10,43
})

test('мерни единици на цената: кг ↔ т се превръща, торба ↔ маса не', () => {
  assert.deepEqual(seedCost(2, 't', { price: 300, unit: 't', supplier: null }), { value: 600, mismatch: false })
  assert.deepEqual(seedCost(2, 't', { price: 0.3, unit: 'kg', supplier: null }), { value: 600, mismatch: false })
  assert.deepEqual(seedCost(41, 'packs', { price: 165, unit: 'pack', supplier: null }), { value: 6765, mismatch: false })
  assert.deepEqual(seedCost(41, 'packs', { price: 300, unit: 't', supplier: null }), { value: null, mismatch: true })
  assert.deepEqual(seedCost(2, 't', { price: 165, unit: 'pack', supplier: null }), { value: null, mismatch: true })
})

// ---------- рекапитулация ----------
const r = (o: Partial<RecapInput>): RecapInput => ({
  company: 'Ф1', base: 'Б1', crop: 'СЛЪНЧОГЛЕД', varietyId: 'v1', variety: 'Хибрид 1', unit: 'packs',
  area: 100, rate: 6000, rateUnit: 'сем./дка', need: 0, withOverage: 0, ...o,
})

test('закръгляне: 3,5 + 4,8 + 32,3 → нужда 40,6, за заявка 41', () => {
  const rows = [3.5, 4.8, 32.3].map((x) => r({ need: x, withOverage: x }))
  const tree = buildSeedRecap(rows, new Map([['v1', { price: 165, unit: 'pack' as const, supplier: 'Доставчик' }]]))
  const v = tree.children[0].children[0].children[0]
  assert.equal(v.withOverage.packs, 40.6)
  assert.equal(v.order.packs, 41)
  assert.equal(v.value, 41 * 165)
})

test('торбите на БЗС се закръглят до 1 знак преди сумата', () => {
  // 3,46 → 3,5; 4,84 → 4,8; 32,26 → 32,3 → 40,6 → 41
  const rows = [3.46, 4.84, 32.26].map((x) => r({ need: x, withOverage: x }))
  const v = buildSeedRecap(rows, new Map()).children[0].children[0].children[0]
  assert.equal(v.withOverage.packs, 40.6); assert.equal(v.order.packs, 41)
  assert.equal(v.priceMissing, true); assert.equal(v.value, null)
})

test('фирмите не делят заявката: една база, две фирми → закръгля се веднъж', () => {
  const rows = [r({ company: 'Ф1', need: 0.4, withOverage: 0.4 }), r({ company: 'Ф2', need: 0.4, withOverage: 0.4 })]
  const tree = buildSeedRecap(rows, new Map())
  assert.equal(tree.children.length, 1)
  assert.equal(tree.order.packs, 1)               // ⌈0,8⌉ = 1, не 1 + 1
  assert.equal(orderLines(tree)[0].bzs, 2)
})

test('тоталът е сума на закръглените по бази (не се закръгля отново)', () => {
  const rows = [
    r({ base: 'Б1', need: 0.3, withOverage: 0.3 }), r({ base: 'Б2', need: 0.3, withOverage: 0.3 }), r({ base: 'Б3', need: 0.3, withOverage: 0.3 }),
  ]
  const tree = buildSeedRecap(rows, new Map())
  assert.equal(tree.withOverage.packs, 0.9)
  assert.equal(tree.order.packs, 3)               // 1 + 1 + 1, не ⌈0,9⌉ = 1
  const lines = orderLines(tree)
  assert.equal(lines.length, 3); assert.equal(lines[0].order, 1)
})

test('тонове: сума с 2 знака, без закръгляне нагоре; цена в кг се превръща', () => {
  const rows = [r({ crop: 'ЕЧЕМИК', unit: 't', rate: 22, rateUnit: 'кг/дка', need: 1.936, withOverage: 1.99408 }), r({ crop: 'ЕЧЕМИК', unit: 't', rate: 23, rateUnit: 'кг/дка', area: 300, need: 6.9, withOverage: 7.107 })]
  const tree = buildSeedRecap(rows, new Map([['v1', { price: 0.31, unit: 'kg' as const, supplier: 'Собствено производство' }]]))
  const crop = tree.children[0].children[0]
  const v = crop.children[0]
  assert.equal(v.need.t, 8.84)                    // 1,94 + 6,90
  assert.equal(v.withOverage.t, 9.1)              // 1,99 + 7,11
  assert.equal(v.order.t, 9.1)
  assert.equal(v.value, 2821)                     // 9,10 т × 310 EUR/т
  assert.equal(crop.avgRate, (22 * 100 + 23 * 300) / 400)
})

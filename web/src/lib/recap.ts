// Рекапитулация по фирма: обща площ, класиране на групите и проверка за ДЗЕС / ЕКОРОК.
// Чисти функции без външни зависимости (тестват се с `npm test`).

export type EcoRule = {
  dzes_first_max: number
  dzes_first_two_max: number
  dzes_third_min: number
  ekorok_first_max: number
  ekorok_first_three_max: number
  ekorok_fourth_min: number
  enp_min: number
  dzes_min_crops: number
  ekorok_min_crops: number
  min_crops_from_dka: number
}

export const ENP_GROUP = 'ЕНП РЕАЛНО'

/** Площ на една група за фирмата (основна култура). */
export type GroupArea = { group: string; area: number; inTotal: boolean; ranks: boolean }

export type Ranked = { group: string; area: number; share: number; place: number }
export type Fail = { scheme: 'ДЗЕС' | 'ЕКОРОК'; key: 'I' | 'I+II' | 'III' | 'I+II+III' | 'IV' | 'count'; text: string }
export type SchemeResult = { ok: boolean; fails: Fail[] }

export type CompanyRecap = {
  total: number
  ranked: Ranked[]
  I: number
  II: number
  III: number
  IV: number
  I_II: number
  I_II_III: number
  nCrops: number
  dzesCountFails: boolean
  ekorokCountFails: boolean
  dzes: SchemeResult
  ekorok: SchemeResult
  enpArea: number
  enpShare: number
  enpNeeded: number
  enpDiff: number
  enpBelow: boolean
}

const EPS = 1e-9
export const fmtPct = (v: number) => `${(Math.round(v * 10000) / 100).toFixed(2).replace('.', ',')} %`
const fmtNum = (v: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(v).replace(/,/g, ' ').replace('.', ',')

/** Сумира площите по група (няколко култури в една група, напр. ЦАРЕВИЦА + ПОЛИВНА ЦАРЕВИЦА). */
export function mergeGroups(items: GroupArea[]): GroupArea[] {
  const m = new Map<string, GroupArea>()
  for (const x of items) {
    const g = m.get(x.group)
    if (g) { g.area += x.area; g.inTotal = g.inTotal || x.inTotal; g.ranks = g.ranks || x.ranks }
    else m.set(x.group, { ...x })
  }
  return Array.from(m.values())
}

export function computeCompany(items: GroupArea[], rule: EcoRule): CompanyRecap {
  const groups = mergeGroups(items)
  const total = groups.filter((g) => g.inTotal).reduce((a, g) => a + g.area, 0)
  const share = (a: number) => (total > 0 ? a / total : 0)
  const ranked: Ranked[] = groups
    .filter((g) => g.ranks && g.area > 0)
    .sort((a, b) => b.area - a.area || a.group.localeCompare(b.group, 'bg'))
    .map((g, i) => ({ group: g.group, area: g.area, share: share(g.area), place: i + 1 }))
  const at = (n: number) => ranked[n - 1]?.share ?? 0
  const I = at(1), II = at(2), III = at(3), IV = at(4)
  const I_II = I + II, I_II_III = I + II + III
  const nCrops = ranked.length
  const big = total > rule.min_crops_from_dka + EPS
  const dzesCountFails = big && nCrops < rule.dzes_min_crops
  const ekorokCountFails = big && nCrops < rule.ekorok_min_crops
  const ge = (v: number, max: number) => v >= max - EPS
  const lt = (v: number, min: number) => v < min - EPS

  const countText = (min: number) => `${nCrops} ${nCrops === 1 ? 'култура' : 'култури'} при ${fmtNum(total)} дка (нужни ${min})`
  const dz: Fail[] = []
  if (ge(I, rule.dzes_first_max)) dz.push({ scheme: 'ДЗЕС', key: 'I', text: `I култура ${fmtPct(I)} ≥ ${fmtPct(rule.dzes_first_max)}` })
  if (ge(I_II, rule.dzes_first_two_max)) dz.push({ scheme: 'ДЗЕС', key: 'I+II', text: `I+II ${fmtPct(I_II)} ≥ ${fmtPct(rule.dzes_first_two_max)}` })
  if (lt(III, rule.dzes_third_min)) dz.push({ scheme: 'ДЗЕС', key: 'III', text: `III култура ${fmtPct(III)} < ${fmtPct(rule.dzes_third_min)}` })
  if (dzesCountFails) dz.push({ scheme: 'ДЗЕС', key: 'count', text: countText(rule.dzes_min_crops) })

  const ek: Fail[] = []
  if (ge(I, rule.ekorok_first_max)) ek.push({ scheme: 'ЕКОРОК', key: 'I', text: `I култура ${fmtPct(I)} ≥ ${fmtPct(rule.ekorok_first_max)}` })
  if (ge(I_II_III, rule.ekorok_first_three_max)) ek.push({ scheme: 'ЕКОРОК', key: 'I+II+III', text: `I+II+III ${fmtPct(I_II_III)} ≥ ${fmtPct(rule.ekorok_first_three_max)}` })
  if (lt(IV, rule.ekorok_fourth_min)) ek.push({ scheme: 'ЕКОРОК', key: 'IV', text: `IV култура ${fmtPct(IV)} < ${fmtPct(rule.ekorok_fourth_min)}` })
  if (ekorokCountFails) ek.push({ scheme: 'ЕКОРОК', key: 'count', text: countText(rule.ekorok_min_crops) })

  const enpArea = groups.filter((g) => g.group === ENP_GROUP).reduce((a, g) => a + g.area, 0)
  const enpNeeded = total * rule.enp_min
  return {
    total, ranked, I, II, III, IV, I_II, I_II_III, nCrops, dzesCountFails, ekorokCountFails,
    dzes: { ok: dz.length === 0, fails: dz },
    ekorok: { ok: ek.length === 0, fails: ek },
    enpArea, enpShare: share(enpArea), enpNeeded, enpDiff: enpArea - enpNeeded, enpBelow: lt(share(enpArea), rule.enp_min),
  }
}

/** „Покрива“ или първата причина + „+N“. */
export function statusText(r: SchemeResult): string {
  if (r.ok) return 'Покрива'
  return r.fails.length > 1 ? `${r.fails[0].text} +${r.fails.length - 1}` : r.fails[0].text
}

/** Място на групата в класирането: 1 → „ДЗЕС I · ЕКОРОК I“, 4 → „ЕКОРОК IV“. */
export function placeLabel(place: number): string {
  const R = ['I', 'II', 'III', 'IV']
  if (place <= 3) return `ДЗЕС ${R[place - 1]} · ЕКОРОК ${R[place - 1]}`
  if (place === 4) return 'ЕКОРОК IV'
  return '—'
}

// Нормализиране на имена (БЗС, фирма) за съпоставяне: trim, един интервал, главни букви,
// латинските букви, които приличат на кирилски, стават кирилски.
const LAT = 'AEOKMHPCTXB'
const CYR = 'АЕОКМНРСТХВ'
const MAP: Record<string, string> = Object.fromEntries(LAT.split('').map((c, i) => [c, CYR[i]]))

export function normName(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toUpperCase().replace(/[AEOKMHPCTXB]/g, (c) => MAP[c])
}

// „2026-2027“, „2026 / 2027“ → „2026/2027“
export const normSeason = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').replace(/[-–]/g, '/')

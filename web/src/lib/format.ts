const nf0 = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 1 })

export const fmtInt = (v: number | null | undefined) => (v == null ? '' : nf0.format(v))
export const fmtArea = (v: number | null | undefined) => (v == null ? '' : nf1.format(v))

// Сеитбена норма: кълняеми семена/м² (слети култури) или семена/дка (редови).
export function fmtRate(rate: number | null | undefined, basis: string | null | undefined) {
  if (rate == null) return ''
  const n = nf1.format(rate)
  if (basis === 'germ_seeds_m2') return `${n} к.с./м²`
  if (basis === 'seeds_da') return `${nf0.format(rate)} сем./дка`
  return n
}

// Цветове на културите (от дизайн системата Crop Planner).
const CROP_COLOR: Record<string, string> = {
  'ПШЕНИЦА': 'var(--crop-wheat)',
  'СЛЪНЧОГЛЕД': 'var(--crop-sunflower)',
  'ЕЧЕМИК': 'var(--crop-barley)',
  'РАПИЦА': 'var(--crop-rapeseed)',
  'ПОЛИВНА ЦАРЕВИЦА': 'var(--crop-irrigated-maize)',
  'ЦАРЕВИЦА': 'var(--crop-maize)',
  'СОРГО': 'var(--crop-sorghum)',
  'ЛЮЦЕРНА': 'var(--crop-alfalfa)',
  'НПП': 'var(--crop-npp)',
  'ЛОЗЯ': 'var(--crop-vineyard)',
}
export const cropColor = (crop: string | null | undefined) =>
  (crop && CROP_COLOR[crop]) || 'var(--crop-other)'

// ПШЕНИЦА -> Пшеница
export const cropLabel = (crop: string | null | undefined) =>
  crop ? crop.charAt(0) + crop.slice(1).toLowerCase() : ''

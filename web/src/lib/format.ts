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

// Площи в дка с интервал за хилядите винаги (bg-BG не групира 4-цифрени числа): 1 768,5
const nfDka = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })
export const fmtDka = (v: number | null | undefined) =>
  v == null ? '' : nfDka.format(v).replace(/,/g, ' ').replace('.', ',')

// Въведен текст → число в дка (до 3 знака). '' → null; невалидно → NaN.
export function parseDka(s: string | number | null | undefined): number | null {
  if (s == null) return null
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s * 1000) / 1000 : NaN
  let t = s.replace(/[\s  ]/g, '')
  if (t === '') return null
  if (t.includes(',') && t.includes('.')) {
    // последният разделител е десетичният, другите са за хилядите
    const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.'
    t = t.split(dec === ',' ? '.' : ',').join('')
  }
  t = t.replace(',', '.')
  if (!/^-?\d*\.?\d+$/.test(t) && !/^-?\d+\.$/.test(t)) return NaN
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN
}

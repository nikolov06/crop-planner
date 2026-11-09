import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Col = { key: string; label: string; num?: boolean; bool?: boolean }
type Nom = { id: string; label: string; table: string; order: string; cols: Col[]; select?: string }

const NOMS: Nom[] = [
  { id: 'crop', label: 'Култури', table: 'crop', order: 'name_bg', cols: [
    { key: 'name_bg', label: 'Култура' }, { key: 'name_en', label: 'Англ.' }, { key: 'crop_group', label: 'Група' },
    { key: 'culture_code', label: 'Код' }, { key: 'short_name', label: 'Кратко' }, { key: 'seeding_method', label: 'Сеитба' },
    { key: 'rate_basis', label: 'Норма по' }, { key: 'order_unit', label: 'Ед. поръчка' }, { key: 'seed_overage_pct', label: 'Запас, %', num: true }, { key: 'default_seeds_per_pack', label: 'Семена в торба', num: true } ] },
  { id: 'variety', label: 'Сортове / хибриди', table: 'variety', order: 'name', cols: [
    { key: 'name', label: 'Сорт / хибрид' }, { key: 'crop(name_bg)', label: 'Култура' }, { key: 'breeder', label: 'Селекционер' },
    { key: 'technology', label: 'Технология' }, { key: 'seeds_per_pack', label: 'Семена в торба', num: true }, { key: 'is_active', label: 'Активен', bool: true } ],
    select: '*, crop(name_bg)' },
  { id: 'reproduction', label: 'Размножения', table: 'reproduction', order: 'sort_order', cols: [
    { key: 'name', label: 'Размножение' }, { key: 'sort_order', label: 'Ред', num: true } ] },
  { id: 'tillage', label: 'Видове обработка', table: 'tillage_type', order: 'name_bg', cols: [
    { key: 'name_bg', label: 'Обработка' }, { key: 'is_active', label: 'Активна', bool: true } ] },
  { id: 'potential', label: 'Потенциал', table: 'potential_class', order: 'sort_order', cols: [
    { key: 'potential_id', label: 'Клас', num: true }, { key: 'name_bg', label: 'Наименование' }, { key: 'sort_order', label: 'Ред', num: true } ] },
  { id: 'season', label: 'Стопански години', table: 'season', order: 'year_end', cols: [
    { key: 'label', label: 'Година' }, { key: 'start_date', label: 'Начало' }, { key: 'end_date', label: 'Край' },
    { key: 'is_current', label: 'Текуща', bool: true } ] },
  { id: 'settlement', label: 'Землища', table: 'settlement', order: 'name', cols: [
    { key: 'name', label: 'Землище' }, { key: 'ekatte', label: 'ЕКАТТЕ' }, { key: 'municipality', label: 'Община' }, { key: 'region', label: 'Област' } ] },
  { id: 'company', label: 'Фирми', table: 'company', order: 'name', cols: [
    { key: 'name', label: 'Фирма' }, { key: 'is_active', label: 'Активна', bool: true } ] },
  { id: 'farm_base', label: 'Стопански бази', table: 'farm_base', order: 'name', cols: [
    { key: 'name', label: 'Стопанска база' }, { key: 'settlement(name)', label: 'Землище' }, { key: 'is_active', label: 'Активна', bool: true } ],
    select: '*, settlement(name)' },
  { id: 'work_field', label: 'Обработваеми полета', table: 'work_field', order: 'name', cols: [
    { key: 'name', label: 'Име (латиница)' }, { key: 'name_bg', label: 'Име (кирилица)' } ] },
  { id: 'fert_stage', label: 'Етапи на торене', table: 'fertilization_stage', order: 'sort_order', cols: [
    { key: 'name_bg', label: 'Етап' }, { key: 'name_en', label: 'Англ.' }, { key: 'method', label: 'Метод' },
    { key: 'sort_order', label: 'Ред', num: true }, { key: 'is_active', label: 'Активен', bool: true } ] },
  { id: 'fert_product', label: 'Торове (продукти)', table: 'fertilizer_product', order: 'name', cols: [
    { key: 'code', label: 'Код' }, { key: 'name', label: 'Наименование' }, { key: 'category', label: 'Категория' }, { key: 'form', label: 'Форма' },
    { key: 'n_pct', label: 'N %', num: true }, { key: 'p2o5_pct', label: 'P₂O₅ %', num: true }, { key: 'k2o_pct', label: 'K₂O %', num: true },
    { key: 'manufacturer', label: 'Производител' }, { key: 'is_active', label: 'Активен', bool: true } ] },
  { id: 'div_rule', label: 'Правила за диверсификация', table: 'diversification_rule', order: 'rule_set', cols: [
    { key: 'rule_set', label: 'Набор' }, { key: 'check_type', label: 'Проверка' }, { key: 'n', label: 'N', num: true },
    { key: 'threshold_pct', label: 'Праг, %', num: true }, { key: 'message_bg', label: 'Съобщение' } ] },
]

function getVal(row: Record<string, unknown>, key: string): unknown {
  const m = key.match(/^(\w+)\((\w+)\)$/)
  if (m) {
    const rel = row[m[1]] as Record<string, unknown> | null
    return rel ? rel[m[2]] : null
  }
  return row[key]
}

export default function Nomenclatures() {
  const [sel, setSel] = useState<Nom>(NOMS[0])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      const all: Record<string, unknown>[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from(sel.table)
          .select(sel.select ?? '*')
          .order(sel.order)
          .range(from, from + 999)
        if (error) {
          if (!cancelled) setError(error.message)
          break
        }
        all.push(...((data ?? []) as unknown as Record<string, unknown>[]))
        if (!data || data.length < 1000) break
      }
      if (!cancelled) {
        setRows(all)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sel])

  return (
    <>
      <div className="page-head">
        <h1>Номенклатури</h1>
      </div>
      <div className="nom">
        <div className="nom-list" role="list">
          {NOMS.map((n) => (
            <button key={n.id} className="nom-btn" aria-current={sel.id === n.id} onClick={() => setSel(n)}>
              {n.label}
            </button>
          ))}
        </div>
        <div className="nom-view">
          <div className="page-head">
            <h2>{sel.label}</h2>
            <span className="muted">{loading ? 'Зареждане…' : `${rows.length} записа`}</span>
          </div>
          {error && <div className="banner err" role="alert">Грешка: {error}</div>}
          <div className="card">
            <table className="grid narrow">
              <thead>
                <tr>{sel.cols.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {sel.cols.map((c) => {
                      const v = getVal(r, c.key)
                      return (
                        <td key={c.key} className={c.num ? 'num' : ''}>
                          {c.bool ? (v ? <span className="chip ok">Да</span> : <span className="chip">Не</span>) : v == null || v === '' ? <span className="empty">—</span> : String(v)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={sel.cols.length} className="empty">Няма записи.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

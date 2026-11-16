import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadXlsx, type Cell } from '../lib/xlsx'

type Col = { key: string; label: string; num?: boolean; bool?: boolean }
type Opt = { value: string; label: string }
type Fk = { table: string; id: string; select: string; order: string; label: (r: Record<string, unknown>) => string }
type Field = {
  key: string
  label: string
  type: 'text' | 'num' | 'bool' | 'date' | 'select' | 'fk' | 'array' | 'longtext'
  options?: Opt[]
  fk?: Fk
  required?: boolean
  def?: string | boolean
  lockOnEdit?: boolean // не се променя при редакция (напр. ръчно зададен ключ)
  hint?: string
}
type Nom = {
  id: string
  label: string
  table: string
  pk: string
  order: string
  cols: Col[]
  select?: string
  fields: Field[]
  orgScoped?: boolean // таблицата иска organization_id при добавяне
  nameOf: (r: Record<string, unknown>) => string
  beforeSave?: (p: Record<string, unknown>) => Record<string, unknown>
}

const BOOL_ACTIVE = (label = 'Активен'): Field => ({ key: 'is_active', label, type: 'bool', def: true })
const cropFk: Fk = { table: 'crop', id: 'crop_id', select: 'crop_id,name_bg', order: 'name_bg', label: (r) => String(r.name_bg) }

const NOMS: Nom[] = [
  { id: 'crop', label: 'Култури', table: 'crop', pk: 'crop_id', order: 'name_bg',
    cols: [
      { key: 'name_bg', label: 'Култура' }, { key: 'name_en', label: 'Англ.' }, { key: 'crop_group', label: 'Група' },
      { key: 'culture_code', label: 'Код' }, { key: 'short_name', label: 'Кратко' }, { key: 'seeding_method', label: 'Сеитба' },
      { key: 'rate_basis', label: 'Норма по' }, { key: 'order_unit', label: 'Ед. поръчка' }, { key: 'seed_overage_pct', label: 'Запас, %', num: true },
      { key: 'default_seeds_per_pack', label: 'Семена в торба', num: true } ],
    fields: [
      { key: 'name_bg', label: 'Култура', type: 'text', required: true }, { key: 'name_en', label: 'Англ. име', type: 'text' },
      { key: 'crop_group', label: 'Група', type: 'text' }, { key: 'culture_code', label: 'Код', type: 'text' },
      { key: 'short_name', label: 'Кратко име', type: 'text' },
      { key: 'seeding_method', label: 'Сеитба', type: 'select', hint: 'Празно = култура без сеитбено планиране. „Норма по“ се определя автоматично.',
        options: [{ value: 'solid', label: 'Плътна (solid)' }, { value: 'row', label: 'Редова (row)' }] },
      { key: 'order_unit', label: 'Единица за поръчка', type: 'select', options: [{ value: 'kg', label: 'кг' }, { value: 'packs', label: 'торби' }] },
      { key: 'default_seeds_per_pack', label: 'Семена в торба (по подразбиране)', type: 'num' },
      { key: 'seed_overage_pct', label: 'Запас, %', type: 'num' }, { key: 'rate_rounding_step', label: 'Стъпка на закръгляване', type: 'num' },
      BOOL_ACTIVE() ],
    nameOf: (r) => String(r.name_bg),
    beforeSave: (p) => {
      // правилата на таблицата: solid ⇒ germ_seeds_m2 + convert_to_kg; row ⇒ seeds_da; празно ⇒ всичко празно
      if (p.seeding_method === 'solid') return { ...p, rate_basis: 'germ_seeds_m2', convert_to_kg: true }
      if (p.seeding_method === 'row') return { ...p, rate_basis: 'seeds_da', convert_to_kg: false }
      return { ...p, rate_basis: null, convert_to_kg: false, order_unit: null }
    } },
  { id: 'variety', label: 'Сортове / хибриди', table: 'variety', pk: 'variety_id', order: 'name',
    cols: [
      { key: 'name', label: 'Сорт / хибрид' }, { key: 'crop(name_bg)', label: 'Култура' }, { key: 'breeder', label: 'Селекционер' },
      { key: 'technology', label: 'Технология' }, { key: 'seeds_eff', label: 'Семена в торба', num: true }, { key: 'is_active', label: 'Активен', bool: true } ],
    select: '*, crop(name_bg, default_seeds_per_pack)',
    fields: [
      { key: 'crop_id', label: 'Култура', type: 'fk', fk: cropFk, required: true }, { key: 'name', label: 'Сорт / хибрид', type: 'text', required: true },
      { key: 'breeder', label: 'Селекционер', type: 'text' }, { key: 'technology', label: 'Технология', type: 'text' },
      { key: 'seeds_per_pack', label: 'Семена в торба', type: 'num', hint: 'Попълва се само ако се различава от стойността по подразбиране за културата.' },
      BOOL_ACTIVE() ],
    nameOf: (r) => String(r.name) },
  { id: 'reproduction', label: 'Размножения', table: 'reproduction', pk: 'reproduction_id', order: 'sort_order',
    cols: [{ key: 'name', label: 'Размножение' }, { key: 'sort_order', label: 'Ред', num: true }],
    fields: [{ key: 'name', label: 'Размножение', type: 'text', required: true }, { key: 'sort_order', label: 'Ред', type: 'num', def: '0' }],
    nameOf: (r) => String(r.name) },
  { id: 'tillage', label: 'Видове обработка', table: 'tillage_type', pk: 'tillage_id', order: 'name_bg',
    cols: [{ key: 'name_bg', label: 'Обработка' }, { key: 'is_active', label: 'Активна', bool: true }],
    fields: [{ key: 'name_bg', label: 'Обработка', type: 'text', required: true }, BOOL_ACTIVE('Активна')],
    nameOf: (r) => String(r.name_bg) },
  { id: 'potential', label: 'Потенциал', table: 'potential_class', pk: 'potential_id', order: 'sort_order',
    cols: [{ key: 'potential_id', label: 'Клас', num: true }, { key: 'name_bg', label: 'Наименование' }, { key: 'sort_order', label: 'Ред', num: true }],
    fields: [
      { key: 'potential_id', label: 'Клас (номер)', type: 'num', required: true, lockOnEdit: true },
      { key: 'name_bg', label: 'Наименование', type: 'text', required: true }, { key: 'sort_order', label: 'Ред', type: 'num', required: true }],
    nameOf: (r) => String(r.name_bg) },
  { id: 'season', label: 'Стопански години', table: 'season', pk: 'season_id', order: 'year_end',
    cols: [{ key: 'label', label: 'Година' }, { key: 'start_date', label: 'Начало' }, { key: 'end_date', label: 'Край' }, { key: 'is_current', label: 'Текуща', bool: true }],
    fields: [
      { key: 'year_end', label: 'Година на прибиране (напр. 2027 за 2026/2027)', type: 'num', required: true },
      { key: 'start_date', label: 'Начало', type: 'date', required: true }, { key: 'end_date', label: 'Край', type: 'date', required: true },
      { key: 'is_current', label: 'Текуща', type: 'bool', def: false }],
    nameOf: (r) => String(r.label) },
  { id: 'settlement', label: 'Землища', table: 'settlement', pk: 'settlement_id', order: 'name',
    cols: [{ key: 'name', label: 'Землище' }, { key: 'ekatte', label: 'ЕКАТТЕ' }, { key: 'municipality', label: 'Община' }, { key: 'region', label: 'Област' }],
    fields: [
      { key: 'name', label: 'Землище', type: 'text', required: true }, { key: 'ekatte', label: 'ЕКАТТЕ', type: 'text' },
      { key: 'municipality', label: 'Община', type: 'text' }, { key: 'region', label: 'Област', type: 'text' }],
    nameOf: (r) => String(r.name) },
  { id: 'company', label: 'Фирми', table: 'company', pk: 'company_id', order: 'name', orgScoped: true,
    cols: [{ key: 'name', label: 'Фирма' }, { key: 'is_active', label: 'Активна', bool: true }],
    fields: [{ key: 'name', label: 'Фирма', type: 'text', required: true }, BOOL_ACTIVE('Активна')],
    nameOf: (r) => String(r.name) },
  { id: 'farm_base', label: 'Стопански бази', table: 'farm_base', pk: 'farm_base_id', order: 'name', orgScoped: true,
    cols: [{ key: 'name', label: 'Стопанска база' }, { key: 'settlement(name)', label: 'Землище' }, { key: 'is_active', label: 'Активна', bool: true }],
    select: '*, settlement(name)',
    fields: [
      { key: 'name', label: 'Стопанска база', type: 'text', required: true },
      { key: 'settlement_id', label: 'Землище', type: 'fk', fk: { table: 'settlement', id: 'settlement_id', select: 'settlement_id,name,ekatte', order: 'name', label: (r) => `${r.name}${r.ekatte ? ' · ' + r.ekatte : ''}` } },
      BOOL_ACTIVE('Активна')],
    nameOf: (r) => String(r.name) },
  { id: 'work_field', label: 'Обработваеми полета', table: 'work_field', pk: 'work_field_id', order: 'name', orgScoped: true,
    cols: [{ key: 'name', label: 'Име (латиница)' }, { key: 'name_bg', label: 'Име (кирилица)' }],
    fields: [{ key: 'name', label: 'Име (латиница)', type: 'text', required: true }, { key: 'name_bg', label: 'Име (кирилица)', type: 'text' }],
    nameOf: (r) => String(r.name) },
  { id: 'fert_stage', label: 'Етапи на торене', table: 'fertilization_stage', pk: 'stage_id', order: 'sort_order',
    cols: [
      { key: 'name_bg', label: 'Етап' }, { key: 'name_en', label: 'Англ.' }, { key: 'method', label: 'Метод' },
      { key: 'sort_order', label: 'Ред', num: true }, { key: 'is_active', label: 'Активен', bool: true } ],
    fields: [
      { key: 'name_bg', label: 'Етап', type: 'text', required: true }, { key: 'name_en', label: 'Англ. име', type: 'text' },
      { key: 'method', label: 'Метод', type: 'select', required: true,
        options: [{ value: 'soil', label: 'Почвено' }, { value: 'foliar', label: 'Листно' }, { value: 'fertigation', label: 'Фертигация' }] },
      { key: 'sort_order', label: 'Ред', type: 'num', required: true }, BOOL_ACTIVE()],
    nameOf: (r) => String(r.name_bg) },
  { id: 'fert_product', label: 'Торове (продукти)', table: 'fertilizer_product', pk: 'product_id', order: 'name',
    cols: [
      { key: 'code', label: 'Код' }, { key: 'name', label: 'Наименование' }, { key: 'category', label: 'Категория' }, { key: 'form', label: 'Форма' },
      { key: 'n_pct', label: 'N %', num: true }, { key: 'p2o5_pct', label: 'P₂O₅ %', num: true }, { key: 'k2o_pct', label: 'K₂O %', num: true },
      { key: 's_pct', label: 'S %', num: true }, { key: 'application', label: 'Приложение' },
      { key: 'manufacturer', label: 'Производител' }, { key: 'data_status', label: 'Данни' }, { key: 'is_active', label: 'Активен', bool: true } ],
    fields: [
      { key: 'code', label: 'Код', type: 'text', required: true }, { key: 'name', label: 'Наименование', type: 'text', required: true },
      { key: 'category', label: 'Категория', type: 'select', required: true,
        options: [{ value: 'mineral', label: 'Минерален' }, { value: 'organic', label: 'Органичен' }, { value: 'foliar', label: 'Листен' },
          { value: 'specialty', label: 'Специализиран' }, { value: 'biostimulant', label: 'Биостимулатор' }] },
      { key: 'form', label: 'Форма', type: 'select', required: true, options: [{ value: 'solid', label: 'Твърд (кг)' }, { value: 'liquid', label: 'Течен (л)' }] },
      { key: 'density_kg_l', label: 'Плътност, кг/л', type: 'num', hint: 'Нужна за течните, за да се пресметнат активните вещества.' },
      { key: 'n_pct', label: 'N %', type: 'num' }, { key: 'p2o5_pct', label: 'P₂O₅ %', type: 'num' }, { key: 'k2o_pct', label: 'K₂O %', type: 'num' },
      { key: 's_pct', label: 'S %', type: 'num' }, { key: 'ca_pct', label: 'Ca %', type: 'num' }, { key: 'mg_pct', label: 'Mg %', type: 'num' },
      { key: 'b_pct', label: 'B %', type: 'num' }, { key: 'zn_pct', label: 'Zn %', type: 'num' }, { key: 'mn_pct', label: 'Mn %', type: 'num' },
      { key: 'application', label: 'Приложение', type: 'text' }, { key: 'manufacturer', label: 'Производител', type: 'text' },
      { key: 'price_per_unit', label: 'Цена за единица', type: 'num' },
      { key: 'data_status', label: 'Статус на данните', type: 'select', def: 'needs_check',
        options: [{ value: 'verified', label: 'Потвърдени' }, { value: 'needs_check', label: 'За доуточняване' }, { value: 'generic', label: 'Типов продукт' }] },
      { key: 'check_note', label: 'Бележка', type: 'longtext' }, BOOL_ACTIVE()],
    nameOf: (r) => String(r.name) },
  { id: 'prz_product', label: 'ПРЗ продукти (БАБХ)', table: 'prz_product', pk: 'prz_product_id', order: 'trade_name',
    cols: [
      { key: 'trade_name', label: 'Продукт' }, { key: 'function_groups', label: 'Функция' }, { key: 'active_substances', label: 'Активно вещество' },
      { key: 'holder', label: 'Притежател' }, { key: 'permit_text', label: 'Разрешение' }, { key: 'source', label: 'Източник' },
      { key: 'register_status', label: 'Статус' } ],
    fields: [
      { key: 'trade_name', label: 'Търговско име', type: 'text', required: true },
      { key: 'source', label: 'Източник', type: 'select', required: true, def: 'own', options: [{ value: 'own', label: 'Собствен' }, { value: 'bfsa', label: 'БАБХ' }] },
      { key: 'function_groups', label: 'Функция (разделени със запетая)', type: 'array',
        hint: 'fungicide, herbicide, insecticide, acaricide, growth_regulator, desiccant, molluscicide, rodenticide, nematicide, bactericide, repellent, fumigant, adjuvant, other' },
      { key: 'active_substances', label: 'Активно вещество', type: 'longtext' }, { key: 'holder', label: 'Притежател', type: 'text' },
      { key: 'permit_text', label: 'Разрешение (текст)', type: 'text' }, { key: 'permit_no', label: 'Номер на разрешение', type: 'text' },
      { key: 'permit_date', label: 'Дата на разрешение', type: 'date' }, { key: 'use_category', label: 'Категория на употреба', type: 'text' },
      { key: 'register_status', label: 'Статус по регистъра', type: 'text' }, { key: 'note', label: 'Бележка', type: 'longtext' }, BOOL_ACTIVE()],
    nameOf: (r) => String(r.trade_name),
    beforeSave: (p) => ({ ...p, function_groups: p.function_groups ?? [] }) },
  { id: 'prz_use', label: 'ПРЗ употреби (по култура)', table: 'prz_use', pk: 'prz_use_id', order: 'prz_use_id',
    cols: [
      { key: 'prz_product(trade_name)', label: 'Продукт' }, { key: 'crop(name_bg)', label: 'Култура' }, { key: 'dose_text', label: 'Доза (по регистър)' },
      { key: 'dose_min', label: 'Доза от', num: true }, { key: 'dose_max', label: 'Доза до', num: true }, { key: 'dose_unit', label: 'Ед.' },
      { key: 'phi_days', label: 'Карантина, дни', num: true }, { key: 'max_applications', label: 'Макс. третирания', num: true },
      { key: 'interval_days', label: 'Интервал, дни', num: true }, { key: 'bbch_from', label: 'BBCH от', num: true }, { key: 'bbch_to', label: 'BBCH до', num: true } ],
    select: '*, prz_product(trade_name), crop(name_bg)',
    fields: [
      { key: 'prz_product_id', label: 'Продукт', type: 'fk', required: true,
        fk: { table: 'prz_product', id: 'prz_product_id', select: 'prz_product_id,trade_name,permit_no', order: 'trade_name', label: (r) => `${r.trade_name}${r.permit_no ? ' · ' + r.permit_no : ''}` } },
      { key: 'crop_id', label: 'Култура (от нашите)', type: 'fk', fk: cropFk },
      { key: 'crop_text', label: 'Култура по регистър', type: 'text' }, { key: 'target_text', label: 'Вредител / цел', type: 'text' },
      { key: 'use_type', label: 'Вид употреба', type: 'text' }, { key: 'dose_text', label: 'Доза (текст)', type: 'text' },
      { key: 'dose_min', label: 'Доза от', type: 'num' }, { key: 'dose_max', label: 'Доза до', type: 'num' },
      { key: 'dose_unit', label: 'Единица', type: 'select',
        options: ['ml_da', 'g_da', 'l_da', 'kg_da', 'ml_100l', 'l_100l', 'g_100l', 'kg_1000kg', 'ml_1000kg', 'other'].map((v) => ({ value: v, label: v })) },
      { key: 'phi_text', label: 'Карантина (текст)', type: 'text' }, { key: 'phi_days', label: 'Карантина, дни', type: 'num' },
      { key: 'max_applications', label: 'Макс. третирания', type: 'num' }, { key: 'interval_days', label: 'Интервал, дни', type: 'num' },
      { key: 'bbch_from', label: 'BBCH от', type: 'num' }, { key: 'bbch_to', label: 'BBCH до', type: 'num' },
      { key: 'water_min_l_da', label: 'Вода от, л/дка', type: 'num' }, { key: 'water_max_l_da', label: 'Вода до, л/дка', type: 'num' },
      { key: 'remarks', label: 'Забележки', type: 'longtext' }],
    nameOf: (r) => `${(r['prz_product'] as { trade_name?: string } | null)?.trade_name ?? 'употреба'}${r.crop_text ? ' · ' + r.crop_text : ''}` },
  { id: 'div_rule', label: 'Правила за диверсификация', table: 'diversification_rule', pk: 'rule_id', order: 'rule_set',
    cols: [
      { key: 'rule_set', label: 'Набор' }, { key: 'check_type', label: 'Проверка' }, { key: 'n', label: 'N', num: true },
      { key: 'threshold_pct', label: 'Праг, %', num: true }, { key: 'message_bg', label: 'Съобщение' } ],
    fields: [
      { key: 'rule_set', label: 'Набор', type: 'text', required: true },
      { key: 'check_type', label: 'Проверка', type: 'select', required: true,
        options: [{ value: 'top_n_max', label: 'top_n_max (дял на първите N)' }, { value: 'nth_min', label: 'nth_min (минимум за N-тата)' }] },
      { key: 'n', label: 'N (1–4)', type: 'num', required: true }, { key: 'threshold_pct', label: 'Праг, %', type: 'num', required: true },
      { key: 'message_bg', label: 'Съобщение', type: 'longtext', required: true }],
    nameOf: (r) => `${r.rule_set} · ${r.check_type} ${r.n}` },
]

function getVal(row: Record<string, unknown>, key: string): unknown {
  if (key === 'seeds_eff') {
    const own = row.seeds_per_pack as number | null
    const crop = row.crop as { default_seeds_per_pack?: number | null } | null
    return own ?? crop?.default_seeds_per_pack ?? null
  }
  const m = key.match(/^(\w+)\((\w+)\)$/)
  if (m) {
    const rel = row[m[1]] as Record<string, unknown> | null
    return rel ? rel[m[2]] : null
  }
  return row[key]
}

function textOf(v: unknown, c: Col): string {
  if (c.bool) return v ? 'Да' : 'Не'
  if (v == null) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

async function fetchAll(table: string, select: string, order: string): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const all: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).order(order).range(from, from + 999)
    if (error) return { rows: all, error: error.message }
    all.push(...((data ?? []) as unknown as Record<string, unknown>[]))
    if (!data || data.length < 1000) break
  }
  return { rows: all, error: null }
}

type FormVal = string | boolean
const PAGE = 300

export default function Nomenclatures() {
  const [sel, setSel] = useState<Nom>(NOMS[0])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const [showFilters, setShowFilters] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [reload, setReload] = useState(0)

  // редакция / добавяне
  const [editing, setEditing] = useState<{ row: Record<string, unknown> | null } | null>(null)
  const [form, setForm] = useState<Record<string, FormVal>>({})
  const [formErr, setFormErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [fkOpts, setFkOpts] = useState<Record<string, Opt[]>>({})
  // изтриване
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)
  const [busyDel, setBusyDel] = useState(false)

  const needle = q.trim().toLowerCase()
  const activeFilters = Object.entries(colFilters).filter(([, v]) => v !== '')

  const shown = useMemo(() => {
    const act = Object.entries(colFilters).filter(([, v]) => v !== '')
    return rows.filter((r) => {
      if (needle && !sel.cols.some((c) => textOf(getVal(r, c.key), c).toLowerCase().includes(needle))) return false
      for (const [key, val] of act) {
        const c = sel.cols.find((x) => x.key === key)
        if (!c) continue
        const t = textOf(getVal(r, key), c)
        if (c.bool) {
          if (t !== val) return false
        } else if (!t.toLowerCase().includes(val.toLowerCase())) return false
      }
      return true
    })
  }, [rows, needle, colFilters, sel])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows([])
    ;(async () => {
      const res = await fetchAll(sel.table, sel.select ?? '*', sel.order)
      if (cancelled) return
      if (res.error) setError(res.error)
      setRows(res.rows)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [sel, reload])

  function choose(n: Nom) {
    setSel(n)
    setQ('')
    setColFilters({})
    setLimit(PAGE)
    setInfo(null)
  }

  // ---------- експорт ----------
  function exportXlsx() {
    const headers = sel.cols.map((c) => c.label)
    const data: Cell[][] = shown.map((r) =>
      sel.cols.map((c) => {
        const v = getVal(r, c.key)
        if (c.bool) return v ? 'Да' : 'Не'
        if (v == null || v === '') return null
        if (typeof v === 'number') return v
        if (c.num && !Number.isNaN(Number(v))) return Number(v)
        return textOf(v, c)
      }),
    )
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    downloadXlsx(`${sel.label.replace(/[\\/:*?"<>|]/g, '')}_${stamp}.xlsx`, sel.label, headers, data)
    setInfo(`Експортирани редове: ${shown.length} (както са филтрирани на екрана).`)
  }

  // ---------- добавяне / редакция ----------
  async function loadFk(n: Nom) {
    for (const f of n.fields) {
      if (f.type !== 'fk' || !f.fk || fkOpts[f.fk.table]) continue
      const fk = f.fk
      const res = await fetchAll(fk.table, fk.select, fk.order)
      if (res.error) {
        setFormErr(`Списъкът „${f.label}“ не се зареди: ${res.error}`)
        continue
      }
      setFkOpts((o) => ({ ...o, [fk.table]: res.rows.map((r) => ({ value: String(r[fk.id]), label: fk.label(r) })) }))
    }
  }

  function openEditor(row: Record<string, unknown> | null) {
    const f: Record<string, FormVal> = {}
    for (const fd of sel.fields) {
      const v = row ? row[fd.key] : undefined
      if (fd.type === 'bool') f[fd.key] = row ? Boolean(v) : Boolean(fd.def ?? false)
      else if (fd.type === 'array') f[fd.key] = Array.isArray(v) ? v.join(', ') : ''
      else f[fd.key] = v == null ? (row ? '' : String(fd.def ?? '')) : String(v)
    }
    setForm(f)
    setFormErr(null)
    setEditing({ row })
    void loadFk(sel)
  }

  function fkLabelFor(fd: Field, value: FormVal): string {
    const list = fd.fk ? fkOpts[fd.fk.table] : undefined
    if (!list) return ''
    return list.find((o) => o.value === value)?.label ?? ''
  }

  async function save() {
    if (!editing) return
    const isNew = editing.row === null
    const payload: Record<string, unknown> = {}
    for (const fd of sel.fields) {
      if (!isNew && fd.lockOnEdit) continue
      const raw = form[fd.key]
      if (fd.type === 'bool') {
        payload[fd.key] = Boolean(raw)
        continue
      }
      const s = typeof raw === 'string' ? raw.trim() : ''
      if (s === '') {
        if (fd.required) return setFormErr(`Полето „${fd.label}“ е задължително.`)
        payload[fd.key] = fd.type === 'array' ? [] : null
        continue
      }
      if (fd.type === 'num') {
        const n = Number(s.replace(',', '.'))
        if (Number.isNaN(n)) return setFormErr(`„${fd.label}“ трябва да е число.`)
        payload[fd.key] = n
      } else if (fd.type === 'array') {
        payload[fd.key] = s.split(',').map((x) => x.trim()).filter(Boolean)
      } else if (fd.type === 'fk') {
        const list = fd.fk ? fkOpts[fd.fk.table] ?? [] : []
        const hit = list.find((o) => o.value === s) ?? list.find((o) => o.label === s)
        if (!hit) return setFormErr(`„${fd.label}“: изберете стойност от списъка.`)
        payload[fd.key] = hit.value
      } else payload[fd.key] = s
    }
    let final = sel.beforeSave ? sel.beforeSave(payload) : payload
    if (isNew && sel.orgScoped) {
      const org = rows[0]?.organization_id
      if (!org) return setFormErr('Не мога да определя организацията (списъкът е празен). Добавете първия запис през импорт или SQL.')
      final = { ...final, organization_id: org }
    }
    setSaving(true)
    setFormErr(null)
    const req = isNew
      ? supabase.from(sel.table).insert(final).select()
      : supabase.from(sel.table).update(final).eq(sel.pk, String(editing.row![sel.pk])).select()
    const { data, error } = await req
    setSaving(false)
    if (error) return setFormErr(error.message)
    if (!data || data.length === 0) return setFormErr('Записът не е променен – вероятно нямате права за тази номенклатура (нужен е администратор).')
    setEditing(null)
    setInfo(isNew ? 'Записът е добавен.' : 'Промените са записани.')
    setReload((x) => x + 1)
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyDel(true)
    setDelErr(null)
    const { data, error } = await supabase.from(sel.table).delete().eq(sel.pk, String(deleting[sel.pk])).select()
    setBusyDel(false)
    if (error) {
      const fkErr = /foreign key|violates/i.test(error.message)
      return setDelErr(fkErr ? `Записът се използва другаде и не може да се изтрие. (${error.message})` : error.message)
    }
    if (!data || data.length === 0) return setDelErr('Записът не е изтрит – вероятно нямате права (нужен е администратор).')
    setDeleting(null)
    setInfo('Записът е изтрит.')
    setReload((x) => x + 1)
  }

  const visible = shown.slice(0, limit)
  const colSpan = sel.cols.length + 1

  return (
    <>
      <div className="page-head">
        <h1>Номенклатури</h1>
      </div>
      <div className="nom">
        <div className="nom-list" role="list">
          {NOMS.map((n) => (
            <button key={n.id} className="nom-btn" aria-current={sel.id === n.id} onClick={() => choose(n)}>
              {n.label}
            </button>
          ))}
        </div>
        <div className="nom-view">
          <div className="page-head">
            <h2>{sel.label}</h2>
            <span className="muted">
              {loading ? 'Зареждане…' : needle || activeFilters.length ? `${shown.length} от ${rows.length} записа` : `${rows.length} записа`}
            </span>
          </div>
          <div className="filters">
            <label className="field grow">
              Търсене във всички колони
              <input className="input" type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} />
            </label>
            <button className="btn outline" onClick={() => setShowFilters((x) => !x)} aria-pressed={showFilters}>
              {showFilters ? 'Скрий филтрите по колони' : 'Филтри по колони'}{activeFilters.length ? ` (${activeFilters.length})` : ''}
            </button>
            {(needle || activeFilters.length > 0) && (
              <button className="btn outline" onClick={() => { setQ(''); setColFilters({}); setLimit(PAGE) }}>Изчисти филтрите</button>
            )}
            <button className="btn outline" onClick={exportXlsx} disabled={loading || shown.length === 0}>Експорт в Excel</button>
            <button className="btn" onClick={() => openEditor(null)} disabled={loading}>+ Добави</button>
          </div>
          {info && <div className="banner ok" role="status">{info}</div>}
          {error && <div className="banner err" role="alert">Грешка: {error}</div>}
          <div className="card">
            <table className="grid narrow">
              <thead>
                <tr>
                  <th aria-label="Действия" style={{ width: 84 }}></th>
                  {sel.cols.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}
                </tr>
                {showFilters && (
                  <tr className="filter-row">
                    <th></th>
                    {sel.cols.map((c) => (
                      <th key={c.key}>
                        {c.bool ? (
                          <select className="input fi" aria-label={`Филтър ${c.label}`} value={colFilters[c.key] ?? ''}
                            onChange={(e) => { setColFilters({ ...colFilters, [c.key]: e.target.value }); setLimit(PAGE) }}>
                            <option value="">Всички</option><option value="Да">Да</option><option value="Не">Не</option>
                          </select>
                        ) : (
                          <input className="input fi" type="search" placeholder="Филтър" aria-label={`Филтър ${c.label}`}
                            value={colFilters[c.key] ?? ''} onChange={(e) => { setColFilters({ ...colFilters, [c.key]: e.target.value }); setLimit(PAGE) }} />
                        )}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={String(r[sel.pk] ?? i)}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn outline" style={{ minHeight: 32, padding: '2px 8px' }} title="Редактирай" aria-label={`Редактирай ${sel.nameOf(r)}`} onClick={() => openEditor(r)}>✎</button>{' '}
                      <button className="btn outline" style={{ minHeight: 32, padding: '2px 8px', color: '#a12b2b' }} title="Изтрий" aria-label={`Изтрий ${sel.nameOf(r)}`} onClick={() => { setDelErr(null); setDeleting(r) }}>🗑</button>
                    </td>
                    {sel.cols.map((c) => {
                      const v = getVal(r, c.key)
                      return (
                        <td key={c.key} className={c.num ? 'num' : ''}>
                          {c.bool ? (v ? <span className="chip ok">Да</span> : <span className="chip">Не</span>) : v == null || v === '' ? <span className="empty">—</span> : c.key === 'seeds_eff' && r.seeds_per_pack == null ? <>{String(v)} <span className="muted" title="Стойност по подразбиране за културата">(по подр.)</span></> : textOf(v, c)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {!loading && shown.length === 0 && !error && (
                  <tr><td colSpan={colSpan} className="empty">Няма записи.</td></tr>
                )}
              </tbody>
            </table>
            {shown.length > limit && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                <button className="btn outline" onClick={() => setLimit(limit + PAGE)}>Покажи още {Math.min(PAGE, shown.length - limit)} (показани {limit} от {shown.length})</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing.row ? 'Редакция' : 'Нов запис'}>
          <div className="modal" style={{ maxWidth: 720 }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h2 style={{ flex: 1 }}>{editing.row ? `Редакция: ${sel.nameOf(editing.row)}` : `Нов запис · ${sel.label}`}</h2>
              <button className="btn outline" onClick={() => setEditing(null)}>Затвори</button>
            </div>
            <div className="filters" style={{ alignItems: 'flex-start' }}>
              {sel.fields.map((fd) => {
                const disabled = Boolean(editing.row) && fd.lockOnEdit
                const val = form[fd.key]
                const set = (v: FormVal) => setForm({ ...form, [fd.key]: v })
                const listId = `dl-${fd.key}`
                return (
                  <label key={fd.key} className="field" style={{ flex: fd.type === 'longtext' || fd.type === 'array' ? '1 1 100%' : '1 1 300px' }}>
                    {fd.label}{fd.required ? ' *' : ''}
                    {fd.type === 'bool' ? (
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
                        <input type="checkbox" checked={Boolean(val)} onChange={(e) => set(e.target.checked)} /> Да
                      </span>
                    ) : fd.type === 'select' ? (
                      <select className="input" value={String(val)} onChange={(e) => set(e.target.value)}>
                        <option value="">—</option>
                        {fd.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : fd.type === 'fk' ? (
                      <>
                        <input className="input" list={listId} placeholder="Започнете да пишете…" value={fkLabelFor(fd, val) || String(val)}
                          onChange={(e) => {
                            const t = e.target.value
                            const hit = (fkOpts[fd.fk!.table] ?? []).find((o) => o.label === t)
                            set(hit ? hit.value : t)
                          }} />
                        <datalist id={listId}>{(fkOpts[fd.fk!.table] ?? []).map((o) => <option key={o.value} value={o.label} />)}</datalist>
                      </>
                    ) : fd.type === 'longtext' || fd.type === 'array' ? (
                      <textarea className="input" rows={fd.type === 'array' ? 2 : 3} value={String(val)} onChange={(e) => set(e.target.value)} />
                    ) : (
                      <input className="input" type={fd.type === 'date' ? 'date' : 'text'} inputMode={fd.type === 'num' ? 'decimal' : undefined}
                        value={String(val)} disabled={disabled} onChange={(e) => set(e.target.value)} />
                    )}
                    {fd.hint && <span className="muted" style={{ fontSize: 12 }}>{fd.hint}</span>}
                  </label>
                )
              })}
            </div>
            {formErr && <div className="banner err" role="alert">{formErr}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={save} disabled={saving}>{saving ? 'Записване…' : 'Запиши'}</button>
              <button className="btn outline" onClick={() => setEditing(null)} disabled={saving}>Отказ</button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label="Потвърждение за изтриване">
          <div className="modal" style={{ maxWidth: 520 }}>
            <h2>Изтриване на запис</h2>
            <p style={{ margin: 0 }}>
              Ще изтриеш „<strong>{sel.nameOf(deleting)}</strong>“ от „{sel.label}“. Действието не може да се върне.
              Ако записът се използва другаде (например сорт в сеитбооборота), системата няма да позволи изтриването.
            </p>
            {delErr && <div className="banner err" role="alert">{delErr}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ background: '#a12b2b', borderColor: '#a12b2b' }} onClick={confirmDelete} disabled={busyDel}>
                {busyDel ? 'Изтриване…' : 'Изтрий'}
              </button>
              <button className="btn outline" onClick={() => setDeleting(null)} disabled={busyDel}>Отказ</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

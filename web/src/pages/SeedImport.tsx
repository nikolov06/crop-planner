// „Импорт от таблица“ в Планиране семена: поставяне (Excel/ChatGPT) или файл → преглед → запис през RPC.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtArea, fmtInt, cropLabel } from '../lib/format'
import { readTableSheets, type Table } from '../lib/tableread'
import { downloadXlsx } from '../lib/xlsx'
import { type Batch, type Crop, type Variety } from '../lib/seedcalc'
import {
  COL_LABEL, buildBzsIndex, buildPreview, buildVarietyIndex, chatGptInstruction, detectColumns, extractLines, findHeaderRow,
  hybridGroups, parsePasted, summarize, toCropRate, parseNum, varietyKey,
  type AliasRow, type ColKey, type ColMap, type FieldAlias, type GroupChoice, type PlantingRef, type PreviewRow, type SeedRow, type Status,
} from '../lib/seedimport'

type Season = { season_id: number; label: string; year_end: number; is_current: boolean }

const PAGE = 1000
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

const STATUS_LABEL: Record<Status, string> = { green: 'Готов', yellow: 'Внимание', red: 'Проблем' }
const STATUS_CLASS: Record<Status, string> = { green: 'chip ok', yellow: 'chip warn', red: 'chip err' }
const rateUnit = (c: Crop | undefined | null) => (c?.rate_basis === 'germ_seeds_m2' ? 'к.с./м²' : c?.rate_basis === 'seeds_da' ? 'сем./дка' : '')
const COLS: ColKey[] = ['bzs', 'variety', 'rate', 'crop', 'base', 'area']

export default function SeedImport({ defaults, onClose, onDone }: {
  defaults: { crop?: string; company?: string; base?: string }
  onClose: () => void
  onDone: (msg: string) => void
}) {
  // ---- справочници ----
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonId, setSeasonId] = useState<number | null>(null)
  const [plantings, setPlantings] = useState<PlantingRef[]>([])
  const [crops, setCrops] = useState<Crop[]>([])
  const [varieties, setVarieties] = useState<Variety[]>([])
  const [aliases, setAliases] = useState<AliasRow[]>([])
  const [fieldAliases, setFieldAliases] = useState<FieldAlias[]>([])
  const [seeds, setSeeds] = useState<SeedRow[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ---- обхват ----
  const [cropF, setCropF] = useState(defaults.crop ?? '')
  const [companyF, setCompanyF] = useState(defaults.company ?? '')
  const [baseF, setBaseF] = useState(defaults.base ?? '')

  // ---- вход ----
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [sheets, setSheets] = useState<{ name: string; rows: Table }[]>([])
  const [sheetIdx, setSheetIdx] = useState(0)
  const [table, setTable] = useState<Table | null>(null)
  const [headerRow, setHeaderRow] = useState(0)
  const [colMap, setColMap] = useState<ColMap>({})
  const [step, setStep] = useState<'input' | 'preview'>('input')

  // ---- решения в прегледа ----
  const [bzsChoice, setBzsChoice] = useState<Map<number, string>>(new Map())
  const [groupChoice, setGroupChoice] = useState<Map<string, GroupChoice>>(new Map())
  const [overwrite, setOverwrite] = useState(false)
  const [statusF, setStatusF] = useState<'' | Status>('')

  useEffect(() => {
    void (async () => {
      try {
        const [se, cr, va, al, fa, ba, me] = await Promise.all([
          supabase.from('season').select('season_id,label,year_end,is_current').order('year_end', { ascending: false }),
          fetchAll<Crop>((f, t) => supabase.from('crop').select('*').not('seeding_method', 'is', null).range(f, t)),
          fetchAll<Variety>((f, t) => supabase.from('variety').select('variety_id,crop_id,name,seeds_per_pack,default_rate').order('name').range(f, t)),
          fetchAll<AliasRow>((f, t) => supabase.from('variety_alias').select('crop_id,alias_normalized,variety_id').range(f, t)),
          fetchAll<FieldAlias>((f, t) => supabase.from('field_alias').select('field_id,alias_name').order('alias_id').range(f, t)),
          fetchAll<Batch>((f, t) => supabase.from('seed_batch').select('batch_id,variety_id,reproduction_id,tkw_g,germination_pct,seeds_per_pack').range(f, t)),
          supabase.auth.getUser(),
        ])
        if (se.error) throw new Error(se.error.message)
        const ss = (se.data ?? []) as Season[]
        setSeasons(ss)
        setSeasonId(ss.find((s) => s.is_current)?.season_id ?? ss[0]?.season_id ?? null)
        setCrops(cr); setVarieties(va); setAliases(al); setFieldAliases(fa); setBatches(ba)
        const uid = me.data.user?.id
        if (uid) {
          const r = await supabase.from('app_user_role').select('role').eq('user_id', uid).eq('role', 'admin').limit(1)
          setIsAdmin((r.data ?? []).length > 0)
        }
      } catch (e) { setError((e as Error).message) }
    })()
  }, [])

  async function loadSeason(id: number | null) {
    if (id == null) return
    setLoading(true)
    try {
      const pl = await fetchAll<PlantingRef>((f, t) => supabase.from('v_planting_context')
        .select('planting_id,organization_id,field_id,field_name,isak_number,company_name,farm_base_name,crop_id,crop_name,planted_area_da')
        .eq('season_id', id).eq('role', 'main').order('field_name').order('planting_id').range(f, t))
      const ids = new Set(pl.map((p) => p.planting_id))
      const ps = await fetchAll<SeedRow & { planting_seed_id: string }>((f, t) => supabase.from('planting_seed')
        .select('planting_seed_id,planting_id,variety_id,batch_id,target_rate,overage_pct,addon').order('planting_seed_id').range(f, t))
      setPlantings(pl); setSeeds(ps.filter((s) => ids.has(s.planting_id)))
    } catch (e) { setError((e as Error).message) }
    setLoading(false)
  }
  useEffect(() => { void loadSeason(seasonId) }, [seasonId])

  const cropById = useMemo(() => new Map(crops.map((c) => [c.crop_id, c])), [crops])
  const varById = useMemo(() => new Map(varieties.map((v) => [v.variety_id, v])), [varieties])
  const seedCrops = useMemo(() => new Set(crops.map((c) => c.crop_id)), [crops])
  const opts = useMemo(() => {
    const u = (f: (p: PlantingRef) => string | null) =>
      Array.from(new Set(plantings.filter((p) => seedCrops.has(p.crop_id)).map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    return { crops: u((p) => p.crop_name), companies: u((p) => p.company_name), bases: u((p) => p.farm_base_name) }
  }, [plantings, seedCrops])

  // БЗС в обхвата (търсенето е само тук)
  const scope = useMemo(() => plantings.filter((p) => seedCrops.has(p.crop_id)
    && (!cropF || p.crop_name === cropF) && (!companyF || p.company_name === companyF) && (!baseF || p.farm_base_name === baseF)), [plantings, seedCrops, cropF, companyF, baseF])
  const scopeCropId = useMemo(() => {
    const s = new Set(scope.map((p) => p.crop_id))
    return s.size === 1 ? [...s][0] : null
  }, [scope])

  // ---- вход: поставяне / файл ----
  function applyTable(t: Table) {
    const hr = findHeaderRow(t)
    setTable(t); setHeaderRow(hr)
    setColMap(detectColumns(t[hr] ?? []).map)
    setBzsChoice(new Map()); setGroupChoice(new Map())
  }
  function parseText() {
    setError(null)
    const t = parsePasted(text)
    if (t.length < 2) { setError('Няма разпознаваема таблица (нужни са заглавен ред и поне един ред с данни).'); return }
    setFileName(null); setSheets([]); applyTable(t)
  }
  async function onFile(f: File | undefined) {
    if (!f) return
    setError(null)
    try {
      const sh = await readTableSheets(f)
      // по подразбиране – първият лист с колони за БЗС и сорт
      const idx = Math.max(0, sh.findIndex((s) => { const m = detectColumns(s.rows[findHeaderRow(s.rows)] ?? []).map; return m.bzs != null && m.variety != null }))
      setFileName(f.name); setSheets(sh); setSheetIdx(idx); applyTable(sh[idx].rows)
    } catch (e) { setError((e as Error).message) }
  }

  const headers = table?.[headerRow] ?? []
  const lines = useMemo(() => (table && colMap.bzs != null && colMap.variety != null ? extractLines(table, headerRow, colMap) : []), [table, headerRow, colMap])
  const canPreview = lines.length > 0 && !loading

  // ---- преглед ----
  const bzsIdx = useMemo(() => buildBzsIndex(scope, fieldAliases), [scope, fieldAliases])
  const varIdx = useMemo(() => buildVarietyIndex(varieties, aliases), [varieties, aliases])
  const seedsByPlanting = useMemo(() => {
    const m = new Map<string, SeedRow[]>()
    for (const s of seeds) m.set(s.planting_id, [...(m.get(s.planting_id) ?? []), s])
    return m
  }, [seeds])
  const rows: PreviewRow[] = useMemo(() => step !== 'preview' ? [] : buildPreview({
    lines, bzsIdx, varIdx, crops: cropById, varieties: varById, batches: new Map(batches.map((b) => [b.batch_id, b])),
    seedsByPlanting, bzsChoice, groupChoice, scopeCropId, overwrite,
  }), [step, lines, bzsIdx, varIdx, cropById, varById, batches, seedsByPlanting, bzsChoice, groupChoice, scopeCropId, overwrite])
  const groups = useMemo(() => hybridGroups(rows), [rows])
  const summary = useMemo(() => summarize(rows), [rows])
  const counts = useMemo(() => ({
    green: rows.filter((r) => r.status === 'green').length, yellow: rows.filter((r) => r.status === 'yellow').length,
    red: rows.filter((r) => r.status === 'red').length, matched: rows.filter((r) => r.planting).length, writable: rows.filter((r) => r.writable).length,
    overwrites: rows.filter((r) => r.overwrites && r.status !== 'red').length,
  }), [rows])
  const shown = statusF ? rows.filter((r) => r.status === statusF) : rows

  const setGroup = (key: string, patch: Partial<GroupChoice>) =>
    setGroupChoice((m) => { const n = new Map(m); n.set(key, { ...(n.get(key) ?? {}), ...patch }); return n })

  async function createVariety(cropId: string, raw: string, key: string) {
    const name = (raw.includes('+') ? raw.slice(0, raw.indexOf('+')) : raw).replace(/\s+/g, ' ').trim()
    setBusy(true); setError(null)
    const ins = await supabase.from('variety').insert({ crop_id: cropId, name }).select('variety_id,crop_id,name,seeds_per_pack,default_rate').single()
    setBusy(false)
    if (ins.error) { setError(ins.error.message); return }
    const v = ins.data as Variety
    setVarieties((vs) => [...vs, v].sort((a, b) => a.name.localeCompare(b.name, 'bg')))
    setGroup(key, { variety_id: v.variety_id })
    setInfo(`Добавен сорт „${v.name}“ (${cropLabel(cropById.get(cropId)?.name_bg)}).`)
  }

  async function save() {
    const items = rows.filter((r) => r.writable && r.planting && r.variety && r.rate)
    if (items.length === 0) return
    setBusy(true); setError(null)
    // псевдоними: само за хибридите, съпоставени ръчно; за текст с „+“ – частта преди „+“
    const aliasList: { alias_normalized: string; alias_raw: string; variety_id: string }[] = []
    const rateList: { variety_id: string; rate: number }[] = []
    for (const g of groups) {
      const ch = groupChoice.get(g.key)
      const varietyId = ch?.variety_id
      if (varietyId) {
        const plus = g.raw.indexOf('+')
        const raw = plus > 0 ? g.raw.slice(0, plus).trim() : g.raw.trim()
        const vk = varietyKey(raw)
        if (vk && vk !== varietyKey(varById.get(varietyId)?.name)) aliasList.push({ alias_normalized: vk, alias_raw: raw, variety_id: varietyId })
      }
      const vid = varietyId ?? g.resolution.variety_id
      const rate = toCropRate(parseNum(ch?.rate), cropById.get(g.crop_id)?.rate_basis)
      if (ch?.remember && vid && rate) rateList.push({ variety_id: vid, rate })
    }
    const res = await supabase.rpc('apply_seed_import', {
      p_season_id: seasonId,
      p_scope: { crop: cropF || null, company: companyF || null, base: baseF || null, sheet: sheets[sheetIdx]?.name ?? null },
      p_file_name: fileName ?? 'поставен текст',
      p_rows_in_file: rows.length,
      p_overwrite: overwrite,
      p_items: items.map((r) => ({ planting_id: r.planting!.planting_id, variety_id: r.variety!.variety_id, target_rate: r.rate, addon: r.addon, source_name: r.line.bzsRaw })),
      p_aliases: aliasList,
      p_rates: rateList,
    })
    setBusy(false)
    if (res.error) { setError(res.error.message); return }
    onDone(`Импортът е записан: ${items.length} БЗС от ${rows.length} реда във файла.`)
  }

  // ---- шаблон и инструкция за ChatGPT ----
  const scopeCrops = useMemo(() => Array.from(new Set(scope.map((p) => p.crop_id))).map((id) => cropById.get(id)).filter((c): c is Crop => !!c), [scope, cropById])
  const templateUnit = new Set(scopeCrops.map((c) => rateUnit(c))).size === 1 ? rateUnit(scopeCrops[0]) : 'сем./дка за редови, к.с./м² за слети'
  function downloadTemplate() {
    const rowsX = scope.map((p) => {
      const s = seedsByPlanting.get(p.planting_id)?.[0]
      const v = s ? varById.get(s.variety_id) : undefined
      return [p.field_name, cropLabel(p.crop_name), p.planted_area_da, p.farm_base_name, v ? `${v.name}${s?.addon ? ` + ${s.addon}` : ''}` : '', s?.target_rate ?? null]
    })
    const season = seasons.find((s) => s.season_id === seasonId)?.label.replace('/', '-') ?? ''
    downloadXlsx(`Сортове_шаблон_${season}.xlsx`, 'Сортове', ['БЗС', 'Култура', 'Площ', 'Стопанство', 'Сорт/Хибрид', `Норма (${templateUnit})`], rowsX)
  }
  async function copyInstruction() {
    const allowed = new Map<string, string[]>()
    for (const c of scopeCrops) allowed.set(cropLabel(c.name_bg), varieties.filter((v) => v.crop_id === c.crop_id).map((v) => v.name))
    const t = chatGptInstruction(templateUnit, scopeCrops.map((c) => cropLabel(c.name_bg)), allowed)
    try { await navigator.clipboard.writeText(t); setInfo('Инструкцията за ChatGPT е копирана. Постави я в ChatGPT заедно с шаблона.') }
    catch { setText(t); setInfo('Браузърът не позволи копиране – инструкцията е поставена в полето, копирай я оттам.') }
  }

  // ---- изглед ----
  const bzsLabel = (p: PlantingRef) => `${p.field_name} · ${p.isak_number ?? 'без №'} · ${p.company_name ?? '—'} · ${p.farm_base_name ?? '—'} · ${fmtArea(p.planted_area_da)} дка`
  const qty = (r: PreviewRow) => {
    if (!r.calc) return ''
    if (r.calc.missing) return <span className="chip err" title={r.calc.missingWhat.length ? `Липсва: ${r.calc.missingWhat.join(', ')}` : undefined}>липсват данни</span>
    if ((r.calc.t ?? 0) > 0) return `${fmtArea(r.calc.t)} т`
    if ((r.calc.packs ?? 0) > 0) return `${fmtInt(Math.ceil(r.calc.packs ?? 0))} торби`
    return ''
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Импорт от таблица">
      <div className="modal seed-import" style={{ maxWidth: 1280 }}>
        <div className="page-head">
          <h2 style={{ margin: 0 }}>Импорт от таблица</h2>
          <button className="btn outline" onClick={onClose}>Затвори</button>
        </div>
        {error && <div className="banner err" role="alert">Грешка: {error}</div>}
        {info && <div className="banner ok" role="status">{info}</div>}

        {/* обхват */}
        <div className="filters">
          <label className="field">Сезон
            <select className="input" value={seasonId ?? ''} onChange={(e) => { setSeasonId(Number(e.target.value)); setStep('input') }}>
              {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текущ)' : ''}</option>)}
            </select>
          </label>
          <label className="field">Култура
            <select className="input" value={cropF} onChange={(e) => setCropF(e.target.value)}>
              <option value="">Всички</option>
              {opts.crops.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}
            </select>
          </label>
          <label className="field">Фирма
            <select className="input" value={companyF} onChange={(e) => setCompanyF(e.target.value)}>
              <option value="">Всички</option>
              {opts.companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field">Стопанска база
            <select className="input" value={baseF} onChange={(e) => setBaseF(e.target.value)}>
              <option value="">Всички</option>
              {opts.bases.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <span className="muted" style={{ alignSelf: 'center' }}>{loading ? 'Зареждане…' : `${scope.length} БЗС в обхвата · ${fmtArea(scope.reduce((s, p) => s + (p.planted_area_da ?? 0), 0))} дка`}</span>
        </div>

        {step === 'input' && (<>
          <div className="filters">
            <button className="btn outline" onClick={downloadTemplate} disabled={scope.length === 0}>Изтегли шаблон</button>
            <button className="btn outline" onClick={copyInstruction} disabled={scopeCrops.length === 0}>Копирай инструкция за ChatGPT</button>
          </div>
          <label className="field" style={{ flex: 'none' }}>Постави таблица (копирана от Excel или markdown таблица от ChatGPT)
            <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
              placeholder={'БЗС\tПредложен хибрид\tНорма\nБАБУКА\tP64 LP 146\t6500'} />
          </label>
          <div className="filters">
            <button className="btn outline" onClick={parseText} disabled={!text.trim()}>Разчети поставеното</button>
            <span className="muted">или</span>
            <label className="btn outline" style={{ cursor: 'pointer' }}>Качи .xlsx / .csv
              <input type="file" accept=".xlsx,.csv,.txt,.tsv" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {fileName && <span className="muted">{fileName}</span>}
            {sheets.length > 1 && (
              <label className="field">Лист
                <select className="input" value={sheetIdx} onChange={(e) => { const i = Number(e.target.value); setSheetIdx(i); applyTable(sheets[i].rows) }}>
                  {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {table && (
            <div className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <strong>Колони</strong>
              <div className="filters">
                <label className="field">Заглавен ред
                  <select className="input" value={headerRow} onChange={(e) => { const h = Number(e.target.value); setHeaderRow(h); setColMap(detectColumns(table[h] ?? []).map) }}>
                    {table.slice(0, 10).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 3).join(' | ')}</option>)}
                  </select>
                </label>
                {COLS.map((k) => (
                  <label key={k} className="field">{COL_LABEL[k]}{k === 'bzs' || k === 'variety' ? ' *' : ''}
                    <select className="input" value={colMap[k] ?? ''} onChange={(e) => setColMap((m) => ({ ...m, [k]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                      <option value="">— няма —</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h || `Колона ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              {(colMap.bzs == null || colMap.variety == null)
                ? <div className="banner">Не разпознах колоните за БЗС и сорт – избери ги ръчно.</div>
                : <span className="muted">{lines.length} реда с данни. БЗС колоната може да съдържа име или номер – разпознава се за всеки ред.</span>}
              <div><button className="btn" disabled={!canPreview} onClick={() => { setStep('preview'); setInfo(null) }}>Преглед</button></div>
            </div>
          )}
        </>)}

        {step === 'preview' && (<>
          {/* обобщение */}
          <div className="filters" style={{ alignItems: 'center' }}>
            <strong>Редове във файла: {rows.length} · съпоставени БЗС: {counts.matched} · за запис: {counts.writable}</strong>
            <span className="chip ok">{counts.green} готови</span>
            <span className="chip warn">{counts.yellow} внимание</span>
            <span className="chip err">{counts.red} проблем</span>
          </div>
          {summary.length > 0 && (
            <div className="card">
              <table className="grid narrow">
                <thead><tr><th>Сорт / хибрид</th><th className="num">БЗС</th><th className="num">дка</th><th className="num">Тона</th><th className="num">Торби</th></tr></thead>
                <tbody>
                  {summary.map((s) => (
                    <tr key={s.name}><td>{s.name}</td><td className="num">{s.bzs}</td><td className="num">{fmtArea(s.area)}</td>
                      <td className="num">{s.t > 0 ? fmtArea(s.t) : ''}</td><td className="num">{s.packs > 0 ? fmtInt(Math.ceil(s.packs)) : ''}{s.missing ? <> <span className="chip err">{s.missing} без данни</span></> : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* хибриди: всеки се решава веднъж */}
          <div className="card pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>Хибриди във файла ({groups.length})</strong>
            <span className="muted">Непознатите се съпоставят тук веднъж за всички редове. Ръчното съпоставяне се запомня и следващия път се разпознава автоматично.</span>
            <table className="grid narrow">
              <thead><tr><th>Във файла</th><th className="num">Редове</th><th className="num">дка</th><th>Сорт в каталога</th><th>Добавка</th><th>Норма</th></tr></thead>
              <tbody>
                {[...groups].sort((a, b) => Number(b.resolution.how === 'none' || b.resolution.how === 'other_crop') - Number(a.resolution.how === 'none' || a.resolution.how === 'other_crop')).map((g) => {
                  const ch = groupChoice.get(g.key) ?? {}
                  const crop = cropById.get(g.crop_id)
                  const cropVars = varieties.filter((v) => v.crop_id === g.crop_id)
                  const sugg = g.resolution.how === 'none' ? g.resolution.suggestions : []
                  const autoId = g.resolution.how !== 'none' && g.resolution.how !== 'other_crop' ? g.resolution.variety_id : ''
                  const cur = ch.variety_id ?? autoId ?? ''
                  const unknown = !cur
                  const tag = ch.variety_id ? 'ръчно' : g.resolution.how === 'exact' ? 'точно' : g.resolution.how === 'alias' ? 'запомнено' : g.resolution.how === 'split' ? 'без добавката' : g.resolution.how === 'other_crop' ? 'друга култура' : 'непознат'
                  const v = cur ? varById.get(cur) : undefined
                  return (
                    <tr key={g.key} className={unknown ? 'warn-row' : ''}>
                      <td><strong>{g.raw}</strong> <span className={unknown || g.resolution.how === 'other_crop' ? 'chip err' : g.resolution.how === 'split' ? 'chip warn' : 'chip ok'}>{tag}</span>
                        {!scopeCropId && <div className="muted">{cropLabel(crop?.name_bg)}</div>}</td>
                      <td className="num">{g.rows}</td>
                      <td className="num">{fmtArea(g.area)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select className="input" value={cur} onChange={(e) => setGroup(g.key, { variety_id: e.target.value || null })} aria-label={`Сорт за ${g.raw}`}>
                            <option value="">— избери —</option>
                            {sugg.length > 0 && <optgroup label="Най-близки">{sugg.map((s) => <option key={'s' + s.variety_id} value={s.variety_id}>{s.name}</option>)}</optgroup>}
                            <optgroup label={cropLabel(crop?.name_bg) || 'Сортове'}>{cropVars.map((s) => <option key={s.variety_id} value={s.variety_id}>{s.name}</option>)}</optgroup>
                          </select>
                          {unknown && (
                            <button className="btn outline" disabled={!isAdmin || busy} title={isAdmin ? undefined : 'Само администратор може да добавя сортове'}
                              onClick={() => void createVariety(g.crop_id, g.raw, g.key)}>Създай нов сорт</button>
                          )}
                        </div>
                      </td>
                      <td>{g.resolution.addon ?? <span className="empty">—</span>}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input className="input num" style={{ width: 90 }} inputMode="decimal" value={ch.rate ?? ''} placeholder={v?.default_rate ? String(v.default_rate) : ''}
                            onChange={(e) => setGroup(g.key, { rate: e.target.value.replace(',', '.') })} aria-label={`Норма за ${g.raw}`} />
                          <span className="muted">{rateUnit(crop)}</span>
                          <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                            <input type="checkbox" checked={!!ch.remember} disabled={!ch.rate} onChange={(e) => setGroup(g.key, { remember: e.target.checked })} /> Запомни за хибрида
                          </label>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="filters" style={{ alignItems: 'center' }}>
            <label className="field">Статус
              <select className="input" value={statusF} onChange={(e) => setStatusF(e.target.value as '' | Status)}>
                <option value="">Всички ({rows.length})</option>
                <option value="red">Проблем ({counts.red})</option>
                <option value="yellow">Внимание ({counts.yellow})</option>
                <option value="green">Готов ({counts.green})</option>
              </select>
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, flex: 'none' }}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Презапиши вече назначените{counts.overwrites ? ` (${counts.overwrites})` : ''}
            </label>
          </div>

          <div className="card" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
            <table className="grid">
              <thead>
                <tr><th>Ред</th><th>БЗС (файл → намерено)</th><th>Фирма / база</th><th>Култура</th><th className="num">Площ</th><th>Сорт (стар → нов)</th><th>Добавка</th><th className="num">Норма</th><th className="num">Количество</th><th>Статус</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const p = r.planting
                  const crop = p ? cropById.get(p.crop_id) : undefined
                  const choices = r.bzs.kind === 'none' ? r.bzs.suggestions : r.bzs.candidates
                  const needPick = !p || r.bzsPicked === 'manual' || r.bzs.candidates.length > 1
                  return (
                    <tr key={r.line.line} className={`imp-${r.status}`}>
                      <td className="muted">{r.line.line}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 260 }}>
                        <div>{r.line.bzsRaw || <span className="empty">—</span>}</div>
                        {needPick && choices.length > 0 ? (
                          <select className="input" value={p?.planting_id ?? ''} aria-label={`БЗС за ред ${r.line.line}`}
                            onChange={(e) => setBzsChoice((m) => { const n = new Map(m); if (e.target.value) n.set(r.line.line, e.target.value); else n.delete(r.line.line); return n })}>
                            <option value="">{r.bzs.kind === 'none' ? '— близки имена —' : `— ${choices.length} съвпадения, избери —`}</option>
                            {choices.map((c) => <option key={c.planting_id} value={c.planting_id}>{bzsLabel(c)}</option>)}
                          </select>
                        ) : p && p.field_name !== r.line.bzsRaw ? <div className="muted">→ {p.field_name}</div> : null}
                      </td>
                      <td>{p ? <>{p.company_name ?? '—'}<div className="muted">{p.farm_base_name ?? '—'}</div></> : ''}</td>
                      <td>{p ? cropLabel(p.crop_name) : ''}</td>
                      <td className="num">{p ? fmtArea(p.planted_area_da) : ''}</td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {r.oldVariety && r.oldVariety.variety_id !== r.variety?.variety_id && <><span className="muted" style={{ textDecoration: 'line-through' }}>{r.oldVariety.name}</span> → </>}
                        {r.variety?.name ?? <span className="muted">{r.line.varietyRaw}</span>}
                      </td>
                      <td>{r.addon ?? ''}</td>
                      <td className="num">{r.rate != null ? fmtInt(r.rate) : ''}{r.rate != null && <span className="muted"> {rateUnit(crop)}</span>}
                        {r.rateFrom && r.rateFrom !== 'file' && <div className="muted" style={{ fontSize: 12 }}>{r.rateFrom === 'group' ? 'от блока' : r.rateFrom === 'variety' ? 'за сорта' : 'текуща'}</div>}</td>
                      <td className="num">{qty(r)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                        <span className={STATUS_CLASS[r.status]}>{STATUS_LABEL[r.status]}</span>{!r.writable && r.status !== 'red' && <span className="muted"> · не се записва</span>}
                        {r.reasons.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.reasons.join(' · ')}</div>}
                      </td>
                    </tr>
                  )
                })}
                {shown.length === 0 && <tr><td colSpan={10} className="empty">Няма редове с този статус.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="filters" style={{ justifyContent: 'space-between' }}>
            <button className="btn outline" onClick={() => setStep('input')}>Назад</button>
            <div className="filters">
              <span className="muted" style={{ alignSelf: 'center' }}>
                Записват се зелените и жълтите редове; вече назначените – само при „Презапиши“. Червените не се записват.
              </span>
              <button className="btn" disabled={busy || counts.writable === 0} onClick={() => void save()}>
                {busy ? 'Записване…' : `Запиши ${counts.writable} БЗС`}
              </button>
            </div>
          </div>
        </>)}
      </div>
    </div>
  )
}

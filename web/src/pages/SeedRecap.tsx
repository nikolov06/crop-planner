import { Fragment, useEffect, useMemo, useState } from 'react'
import { cropLabel } from '../lib/format'
import { MultiFilter, anyToken } from '../lib/multifilter'
import { type Crop, type SeedPrice } from '../lib/seedcalc'
import { loadSeasons, loadSeedData, rateForAvg, rateUnitOf, seedLine, type Planting, type Season, type SeedLine } from '../lib/seeddata'
import { buildSeedRecap, orderLines, type Qty, type RecapInput, type RecapNode } from '../lib/seedrecap'
import { downloadXlsxBook, type Cell } from '../lib/xlsx'

// Рекапитулация / заявка за семена: База → Култура → Сорт (фирмата е филтър – заявката е по база).
// Торбите: сума на БЗС с 1 знак (с преразход) → нагоре до цяла торба за Сорт × База.
// Тонове: сума с 2 знака. Стойност от „За заявка“; по-горните нива сумират закръглените.

const nf = (d: number) => new Intl.NumberFormat('bg-BG', { minimumFractionDigits: d, maximumFractionDigits: d })
const NF = [nf(0), nf(1), nf(2)]
const fmtN = (v: number | null | undefined, d: 0 | 1 | 2) => (v == null ? '' : NF[d].format(v))
const UNIT_TEXT: Record<SeedPrice['unit'], string> = { pack: 'торба', t: 'т', kg: 'кг' }

/** количество, което може да е и в торби, и в т (на ниво база/общо) */
function QtyText({ q, packsDigits }: { q: Qty; packsDigits: 0 | 1 }) {
  const parts: string[] = []
  if (q.packs) parts.push(`${fmtN(q.packs, packsDigits)} торби`)
  if (q.t) parts.push(`${fmtN(q.t, 2)} т`)
  return <>{parts.join(' · ')}</>
}

type Row = { p: Planting; crop: Crop; line: SeedLine; variety: string }

export default function SeedRecap() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonId, setSeasonId] = useState<number | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [prices, setPrices] = useState<Map<string, SeedPrice>>(new Map())
  const [noSeed, setNoSeed] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [companyF, setCompanyF] = useState('')
  const [baseF, setBaseF] = useState('')
  const [cropF, setCropF] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadSeasons().then((s) => {
      setSeasons(s)
      setSeasonId(s.find((x) => x.is_current)?.season_id ?? s[0]?.season_id ?? null)
    }).catch((e) => setError((e as Error).message))
  }, [])

  useEffect(() => {
    if (seasonId == null) return
    let off = false
    setLoading(true)
    loadSeedData(seasonId).then((d) => {
      if (off) return
      const cropById = new Map(d.crops.map((c) => [c.crop_id, c]))
      const varById = new Map(d.varieties.map((v) => [v.variety_id, v]))
      const batchById = new Map(d.batches.map((b) => [b.batch_id, b]))
      const plById = new Map(d.plantings.map((p) => [p.planting_id, p]))
      const out: Row[] = []
      const withSeed = new Set<string>()
      for (const ps of d.pseeds) {
        const p = plById.get(ps.planting_id); const crop = p ? cropById.get(p.crop_id) : undefined
        if (!p || !crop) continue
        withSeed.add(p.planting_id)
        const line = seedLine(crop, ps, ps.batch_id ? batchById.get(ps.batch_id) : undefined, varById.get(ps.variety_id), d.prices.get(ps.variety_id))
        out.push({ p, crop, line, variety: varById.get(ps.variety_id)?.name ?? '—' })
      }
      setRows(out); setPrices(d.prices); setNoSeed(d.plantings.filter((p) => !withSeed.has(p.planting_id)).length); setError(null)
    }).catch((e) => { if (!off) setError((e as Error).message) }).finally(() => { if (!off) setLoading(false) })
    return () => { off = true }
  }, [seasonId])

  const opts = useMemo(() => {
    const u = (f: (r: Row) => string | null) => Array.from(new Set(rows.map(f).filter((x): x is string => !!x))).sort((a, b) => a.localeCompare(b, 'bg'))
    return { companies: u((r) => r.p.company_name), bases: u((r) => r.p.farm_base_name), crops: u((r) => r.p.crop_name) }
  }, [rows])

  const filtered = useMemo(() => rows.filter((r) =>
    anyToken(companyF, (t) => r.p.company_name === t) && anyToken(baseF, (t) => r.p.farm_base_name === t) && anyToken(cropF, (t) => r.p.crop_name === t)), [rows, companyF, baseF, cropF])

  const inputs: RecapInput[] = useMemo(() => filtered.map((r) => ({
    company: r.p.company_name ?? '—', base: r.p.farm_base_name ?? '— без база', crop: r.p.crop_name,
    varietyId: r.line.ps.variety_id, variety: r.variety, unit: r.line.unit,
    area: Number(r.line.ps.area_da), rate: rateForAvg(r.crop, r.line), rateUnit: rateUnitOf(r.crop),
    need: r.line.need, withOverage: r.line.withOverage,
  })), [filtered])
  const tree = useMemo(() => buildSeedRecap(inputs, prices), [inputs, prices])

  // по фирма – само за информация (заявката е по база, затова тук няма „За заявка“ и стойност)
  const byCompany = useMemo(() => {
    const m = new Map<string, { n: number; area: number; need: Qty; ov: Qty }>()
    for (const r of filtered) {
      const k = r.p.company_name ?? '—'
      const x = m.get(k) ?? { n: 0, area: 0, need: { packs: 0, t: 0 }, ov: { packs: 0, t: 0 } }
      x.n++; x.area += Number(r.line.ps.area_da)
      const key = r.line.unit === 'packs' ? 'packs' : 't'
      x.need[key] += r.line.need ?? 0; x.ov[key] += r.line.withOverage ?? 0
      m.set(k, x)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'bg'))
  }, [filtered])

  const seasonLabel = seasons.find((s) => s.season_id === seasonId)?.label ?? ''
  const toggle = (k: string) => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })

  function exportXlsx() {
    const ol = orderLines(tree)
    const order: Cell[][] = ol.map((l) => [l.base, l.crop, l.variety, l.unit === 'packs' ? 'торби' : 'т', l.bzs, Math.round(l.area * 100) / 100,
      l.need, l.withOverage, l.order, l.supplier, l.price?.price ?? null, l.price ? UNIT_TEXT[l.price.unit] : null, l.mismatch ? null : l.value])
    const detail: Cell[][] = filtered
      .slice().sort((a, b) => (a.p.farm_base_name ?? '').localeCompare(b.p.farm_base_name ?? '', 'bg') || a.p.crop_name.localeCompare(b.p.crop_name, 'bg') || a.variety.localeCompare(b.variety, 'bg') || a.p.field_name.localeCompare(b.p.field_name, 'bg'))
      .map((r) => [r.p.farm_base_name, r.p.company_name, r.p.crop_name, r.variety, r.line.ps.addon ?? null, r.p.field_name, Number(r.line.ps.area_da),
        rateForAvg(r.crop, r.line), rateUnitOf(r.crop), r.line.calc.overagePct, r.line.need, r.line.withOverage, r.line.unit === 'packs' ? 'торби' : 'т',
        r.line.price?.supplier ?? null, r.line.price?.price ?? null, r.line.price ? UNIT_TEXT[r.line.price.unit] : null, r.line.value])
    downloadXlsxBook(`заявка_семена_${seasonLabel.replace('/', '-')}.xlsx`, [
      { name: 'Заявка', headers: ['База', 'Култура', 'Сорт / хибрид', 'Мерна ед.', 'БЗС', 'дка', 'Нужда', 'С преразход', 'За заявка', 'Доставчик', 'Цена EUR без ДДС', 'Ед. цена', 'Стойност EUR'], rows: order },
      { name: 'Детайл по БЗС', headers: ['База', 'Фирма', 'Култура', 'Сорт / хибрид', 'Добавка', 'БЗС', 'дка', 'Норма', 'Ед. норма', 'Преразход, %', 'Нужда', 'С преразход', 'Мерна ед.', 'Доставчик', 'Цена EUR без ДДС', 'Ед. цена', 'Стойност EUR'], rows: detail },
    ])
  }

  const valueCell = (n: RecapNode) => (
    <td className="num">{n.value != null ? fmtN(n.value, 2) : ''}{n.priceMissing && <span className="chip warn" style={{ marginLeft: 4 }} title={n.unitMismatch ? 'Има цена в несъвместима мерна единица (торба ↔ маса)' : 'Има сорт без избрана оферта – стойността е непълна'}>{n.value != null ? '+ ?' : '—'}</span>}</td>
  )
  const perDa = (n: RecapNode) => <td className="num">{n.value != null && n.area > 0 && !n.priceMissing ? fmtN(n.value / n.area, 2) : ''}</td>

  const renderVariety = (v: RecapNode) => {
    const packs = v.unit === 'packs'
    const q = (x: Qty) => (packs ? x.packs : x.t)
    return (
      <tr key={v.key + v.label}>
        <td style={{ paddingLeft: 40 }}>{v.label}{v.missingQty > 0 && <span className="chip warn" style={{ marginLeft: 6 }} title="Има БЗС без МХЗ/кълняемост или семена в торба – не влизат в количеството">{v.missingQty} без данни</span>}</td>
        <td className="num">{v.n}</td>
        <td className="num">{fmtN(v.area, 0)}</td>
        <td className="num">{v.avgRate != null ? <>{fmtN(v.avgRate, v.rateUnit === 'кг/дка' ? 1 : 0)}<span className="muted"> {v.rateUnit}</span></> : ''}</td>
        <td className="num">{fmtN(q(v.need), packs ? 1 : 2)}</td>
        <td className="num">{fmtN(q(v.withOverage), packs ? 1 : 2)}</td>
        <td className="num"><strong>{fmtN(q(v.order), packs ? 0 : 2)}</strong><span className="muted"> {packs ? 'торби' : 'т'}</span></td>
        <td>{v.price ? <span title={v.price.own ? 'вътрешна цена' : undefined}>{v.price.supplier}</span> : <span className="chip warn" title="Няма избрана оферта (Планиране семена → Оферти)">няма избрана оферта</span>}</td>
        <td className="num">{v.price ? `${fmtN(v.price.price, 2)} /${UNIT_TEXT[v.price.unit]}` : '—'}</td>
        {v.unitMismatch ? <td className="num"><span className="chip warn" title="Цената е за торба, а количеството е в т (или обратно)">мерна единица</span></td> : <td className="num">{v.value != null ? fmtN(v.value, 2) : '—'}</td>}
        {perDa(v)}
      </tr>
    )
  }
  const groupRow = (n: RecapNode, cls: string, indent: number, extra?: React.ReactNode) => (
    <tr key={n.level + n.key} className={cls} onClick={() => toggle(n.level + n.key)} style={{ cursor: 'pointer' }}>
      <td style={{ paddingLeft: indent }}>{closed.has(n.level + n.key) ? '▸' : '▾'} {n.level === 'crop' ? cropLabel(n.label) : n.label}{extra}</td>
      <td className="num">{n.n}</td>
      <td className="num">{fmtN(n.area, 0)}</td>
      <td className="num">{n.avgRate != null ? <>{fmtN(n.avgRate, n.rateUnit === 'кг/дка' ? 1 : 0)}<span className="muted"> {n.rateUnit}</span></> : ''}</td>
      <td className="num"><QtyText q={n.need} packsDigits={1} /></td>
      <td className="num"><QtyText q={n.withOverage} packsDigits={1} /></td>
      <td className="num"><strong><QtyText q={n.order} packsDigits={0} /></strong></td>
      <td /><td />
      {valueCell(n)}
      {perDa(n)}
    </tr>
  )

  return (
    <>
      <div className="page-head">
        <h1>Планиране семена → Рекапитулация</h1>
        <span className="muted">{loading ? 'Зареждане…' : `${tree.n} реда семена · ${fmtN(tree.area, 0)} дка${noSeed ? ` · ${noSeed} БЗС без сорт (не влизат)` : ''}`}</span>
      </div>
      {error && <div className="banner err" role="alert">Грешка: {error}</div>}

      <div className="filters">
        <label className="field">Сезон
          <select className="input" value={seasonId ?? ''} onChange={(e) => setSeasonId(Number(e.target.value))}>
            {seasons.map((s) => <option key={s.season_id} value={s.season_id}>{s.label}{s.is_current ? ' (текущ)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Фирма
          <MultiFilter value={companyF} onChange={setCompanyF} ariaLabel="Фирма" options={opts.companies.map((c) => ({ value: c, label: c }))} />
        </label>
        <label className="field">База
          <MultiFilter value={baseF} onChange={setBaseF} ariaLabel="База" options={opts.bases.map((c) => ({ value: c, label: c }))} />
        </label>
        <label className="field">Култура
          <MultiFilter value={cropF} onChange={setCropF} ariaLabel="Култура" options={opts.crops.map((c) => ({ value: c, label: cropLabel(c) }))} />
        </label>
        <button className="btn outline" onClick={() => setClosed(new Set(tree.children.map((b) => 'base' + b.key)))}>Свий базите</button>
        <button className="btn outline" onClick={() => setClosed(new Set())}>Разгъни всичко</button>
        <button className="btn" onClick={exportXlsx} disabled={loading || tree.children.length === 0}>Excel – заявка</button>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>База / Култура / Сорт</th><th className="num">БЗС</th><th className="num">дка</th><th className="num" title="Претеглена по площ">Ср. норма</th>
              <th className="num" title="Сума на БЗС без преразход">Нужда</th><th className="num" title="Сума на БЗС с преразход (торби с 1 знак, т с 2 знака)">С преразход</th>
              <th className="num" title="Торби: нагоре до цяла торба за Сорт × База; т: без закръгляне нагоре">За заявка</th>
              <th>Доставчик</th><th className="num">Цена</th><th className="num" title="За заявка × цена">Стойност EUR</th><th className="num">EUR/дка</th>
            </tr>
          </thead>
          <tbody>
            {tree.children.map((b) => (
              <Fragment key={b.key}>
                {groupRow(b, 'lvl-base', 8)}
                {!closed.has('base' + b.key) && b.children.map((c) => (
                  <Fragment key={c.key}>
                    {groupRow(c, 'lvl-crop', 22)}
                    {!closed.has('crop' + c.key) && c.children.map(renderVariety)}
                  </Fragment>
                ))}
              </Fragment>
            ))}
            {!loading && tree.children.length === 0 && <tr><td colSpan={11} className="empty">Няма назначени семена по тези филтри.</td></tr>}
            {tree.children.length > 0 && (
              <tr className="lvl-total">
                <td>ОБЩО</td><td className="num">{tree.n}</td><td className="num">{fmtN(tree.area, 0)}</td><td />
                <td className="num"><QtyText q={tree.need} packsDigits={1} /></td>
                <td className="num"><QtyText q={tree.withOverage} packsDigits={1} /></td>
                <td className="num"><QtyText q={tree.order} packsDigits={0} /></td>
                <td /><td />{valueCell(tree)}{perDa(tree)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 13, margin: '6px 0 16px' }}>
        Заявката е по база: торбите на БЗС (с 1 знак, с преразход) се сумират и закръглят нагоре за Сорт × База; по-горните суми са от закръглените.
        Тоновете се сумират с 2 знака. Стойността е „За заявка“ × цената на избраната оферта (кг ↔ т се превръща; торба ↔ маса – не).
      </div>

      {byCompany.length > 0 && (
        <>
          <h2 style={{ fontSize: 16 }}>По фирма (за информация)</h2>
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Фирма</th><th className="num">Редове</th><th className="num">дка</th><th className="num">Нужда</th><th className="num">С преразход</th></tr></thead>
              <tbody>
                {byCompany.map(([k, x]) => (
                  <tr key={k}><td>{k}</td><td className="num">{x.n}</td><td className="num">{fmtN(x.area, 0)}</td>
                    <td className="num"><QtyText q={{ packs: Math.round(x.need.packs * 10) / 10, t: Math.round(x.need.t * 100) / 100 }} packsDigits={1} /></td>
                    <td className="num"><QtyText q={{ packs: Math.round(x.ov.packs * 10) / 10, t: Math.round(x.ov.t * 100) / 100 }} packsDigits={1} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>Една база може да обслужва няколко фирми; заявката се закръгля по база, затова тук няма „За заявка“.</div>
        </>
      )}
    </>
  )
}

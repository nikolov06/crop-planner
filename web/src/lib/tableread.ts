// Четене на таблица от файл: CSV (UTF-8, разделител , ; или таб) или .xlsx (първият лист или всички листове).
// Без външни пакети: .xlsx се разархивира с DecompressionStream('deflate-raw') на браузъра.

export type Table = string[][]

export async function readTableFile(file: File): Promise<Table> {
  return (await readTableSheets(file))[0]?.rows ?? []
}

/** Всички листове на .xlsx (за CSV – един лист). */
export async function readTableSheets(file: File): Promise<{ name: string; rows: Table }[]> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  if (isZip) return readXlsxSheets(buf)
  return [{ name: file.name, rows: await readTextTable(file.name, buf) }]
}

async function readTextTable(fileName: string, buf: Uint8Array): Promise<Table> {
  if (/\.xls$/i.test(fileName)) throw new Error('Старият формат .xls не се поддържа – запиши файла като .xlsx или CSV (UTF-8).')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { throw new Error('Файлът не е в UTF-8. В Excel: „Запиши като“ → „CSV UTF-8 (разделен със запетаи)“.') }
  return parseCsv(text)
}

// ───────── CSV ─────────
export function parseCsv(text: string): Table {
  text = text.replace(/^﻿/, '')
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string) => first.split(ch).length - 1
  const delim = [';', ',', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',')
  const rows: Table = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') q = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// ───────── XLSX ─────────
type Entry = { name: string; method: number; csize: number; offset: number }

function zipEntries(b: Uint8Array): Map<string, Entry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('Файлът не е валиден .xlsx.')
  const n = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const out = new Map<string, Entry>()
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Повреден .xlsx (централна директория).')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl))
    out.set(name, { name, method, csize, offset })
    p += 46 + nl + el + cl
  }
  return out
}

async function zipText(b: Uint8Array, e: Entry): Promise<string> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true)
  const raw = b.subarray(start, start + e.csize)
  if (e.method === 0) return new TextDecoder().decode(raw)
  if (e.method !== 8) throw new Error('Неподдържана компресия в .xlsx.')
  if (typeof DecompressionStream === 'undefined') throw new Error('Браузърът не може да отвори .xlsx – използвай CSV (UTF-8).')
  const ds = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(ds).text()
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
const tags = (n: Document | Element, name: string) => Array.from(n.getElementsByTagNameNS('*', name))
const colIdx = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }

async function readXlsxSheets(b: Uint8Array): Promise<{ name: string; rows: Table }[]> {
  const zip = zipEntries(b)
  const get = async (name: string) => { const e = zip.get(name); return e ? zipText(b, e) : null }
  // листовете по ред според workbook.xml и връзките му
  const list: { name: string; path: string }[] = []
  const wb = await get('xl/workbook.xml')
  const rels = await get('xl/_rels/workbook.xml.rels')
  if (wb && rels) {
    const relEls = tags(xml(rels), 'Relationship')
    for (const s of tags(xml(wb), 'sheet')) {
      const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      const t = relEls.find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target')
      if (t && s.getAttribute('state') !== 'hidden') list.push({ name: s.getAttribute('name') ?? '', path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}` })
    }
  }
  if (list.length === 0) list.push({ name: 'Лист 1', path: 'xl/worksheets/sheet1.xml' })
  const shared: string[] = []
  const ss = await get('xl/sharedStrings.xml')
  if (ss) for (const si of tags(xml(ss), 'si')) shared.push(tags(si, 't').map((t) => t.textContent ?? '').join(''))
  const out: { name: string; rows: Table }[] = []
  for (const s of list) {
    const sh = await get(s.path)
    if (sh) out.push({ name: s.name, rows: sheetTable(sh, shared) })
  }
  if (out.length === 0) throw new Error('В .xlsx няма лист с данни.')
  return out
}

function sheetTable(sh: string, shared: string[]): Table {
  const out: Table = []
  for (const r of tags(xml(sh), 'row')) {
    const row: string[] = []
    let next = 0
    for (const c of tags(r, 'c')) {
      const ref = c.getAttribute('r')
      const i = ref ? colIdx(ref) : next
      next = i + 1
      const t = c.getAttribute('t')
      const v = tags(c, 'v')[0]?.textContent ?? ''
      let val: string
      if (t === 's') val = shared[Number(v)] ?? ''
      else if (t === 'inlineStr') val = tags(c, 't').map((x) => x.textContent ?? '').join('')
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE'
      else if (!t || t === 'n') val = v === '' ? '' : String(Math.round(Number(v) * 1000) / 1000)   // плаваща запетая: 24.000000000000004 → 24
      else val = v
      while (row.length < i) row.push('')
      row[i] = val
    }
    out.push(row)
  }
  return out.filter((r) => r.some((c) => (c ?? '').trim() !== ''))
}

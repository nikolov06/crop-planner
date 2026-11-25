// Червен маркер и удебелен ред в Excel. Пускане: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildXlsxBook, bold, red } from './xlsx.ts'

test('xlsx: червен маркер (s=2) и удебелен ред (s=1); празната клетка остава празна', () => {
  const bytes = buildXlsxBook([{ name: 'Заявка', headers: ['А', 'Б', 'В'], rows: [[red('липсват данни'), bold(12.5), null]] }])
  const text = new TextDecoder().decode(bytes)
  assert.match(text, /<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">липсват данни<\/t><\/is><\/c>/)
  assert.match(text, /<c r="B2" s="1"><v>12.5<\/v><\/c>/)
  assert.doesNotMatch(text, /r="C2"/)
  assert.match(text, /<cellXfs count="3">/)
})

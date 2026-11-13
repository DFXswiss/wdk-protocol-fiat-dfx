import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const handbook = join(root, 'handbook')
const images = join(handbook, 'screens')
const digest = value => createHash('sha256').update(value).digest('hex')
const allow = new Set(JSON.parse(readFileSync(join(handbook, 'redaction-allow.json'), 'utf8')).values)
const words = new Set(JSON.parse(readFileSync(join(root, 'node_modules/bip39/src/wordlists/english.json'), 'utf8')))

function command (name, args, qr = false) {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (result.error?.code === 'ENOENT') {
    console.error(`Required tool missing: ${name}`)
    process.exit(2)
  }
  if (result.error || (result.status !== 0 && !(qr && result.status === 4))) throw new Error(`${name} failed`)
  return result.stdout
}

function findings (text) {
  const found = []
  const patterns = [
    ['address', /0x[0-9a-f]{40}\b/gi],
    ['hex', /\b[0-9a-f]{32,}\b/gi],
    ['IBAN', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi],
    ['session', /session=[^\s]*/gi],
    ['JWT', /\beyJ[A-Za-z0-9_.-]*/g],
    ['URL query', /https?:\/\/[^\s?#]+\?[^\s]*/gi]
  ]
  for (const [name, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) if (!allow.has(match[0])) found.push(name)
  }
  const tokens = text.toLowerCase().match(/[a-z]+/g) || []
  let sequence = []
  for (const token of [...tokens, '']) {
    if (words.has(token)) sequence.push(token)
    else {
      if (sequence.length >= 12 && !allow.has(sequence.join(' '))) found.push('BIP39 words')
      sequence = []
    }
  }
  return found
}

try {
  const tesseract = command('tesseract', ['--version']).split('\n')[0]
  const zbarimg = command('zbarimg', ['--version']).trim()
  const files = readdirSync(images).filter(name => name.endsWith('.png')).sort()
  if (!files.length) throw new Error('No screenshots found')
  const checked = []
  let failed = false
  for (const file of files) {
    const path = join(images, file)
    const ocr = command('tesseract', [path, 'stdout'])
    const qr = command('zbarimg', ['--quiet', '--raw', path], true).split('\n').filter(Boolean)
    const issues = findings(ocr)
    if (qr.some(code => !allow.has(code))) issues.push('QR code')
    if (issues.length) {
      failed = true
      console.error(`${file}: ${[...new Set(issues)].join(', ')}`)
    }
    checked.push({ file, sha256: digest(readFileSync(path)), ocrSha256: digest(ocr), qrCodes: qr.length, result: 'pass' })
  }
  if (failed) process.exitCode = 1
  else writeFileSync(join(handbook, 'redaction.json'), JSON.stringify({ tesseract, zbarimg, checkedAt: new Date().toISOString(), images: checked }, null, 2) + '\n')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

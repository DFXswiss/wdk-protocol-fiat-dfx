import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const handbook = join(root, 'handbook')
const images = join(handbook, 'screens')
const digest = value => createHash('sha256').update(value).digest('hex')
const allowFile = readFileSync(join(handbook, 'redaction-allow.json'))
const allowlist = JSON.parse(allowFile)
const allow = new Set(allowlist.values)
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
    ['address', /[0Oo]x[0-9a-fA-FIlOoS]{38,42}\b/gi],
    ['hex', /\b[0-9a-fA-FIlOoS]{32,}\b/g],
    ['token', /[0-9A-Za-z]{20,}/g],
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
  const args = process.argv.slice(2)
  const check = args.length === 1 && args[0] === '--check'
  const propose = args.length === 2 && args[0] === '--propose'
  if (args.length && !check && !propose) {
    console.error('Usage: redaction.mjs [--check | --propose <file>]')
    process.exit(2)
  }
  let proposalPath
  if (propose) {
    const target = resolve(args[1])
    proposalPath = join(realpathSync(dirname(target)), basename(target))
    const fromRoot = relative(realpathSync(root), proposalPath)
    if (!fromRoot || (!fromRoot.startsWith('..' + sep) && fromRoot !== '..' && !isAbsolute(fromRoot))) {
      console.error('Proposal file must be outside the repository')
      process.exit(2)
    }
  }
  const tesseract = command('tesseract', ['--version']).split('\n')[0]
  const zbarimg = command('zbarimg', ['--version']).trim()
  const files = readdirSync(images).filter(name => name.endsWith('.png')).sort()
  if (!files.length) throw new Error('No screenshots found')
  const checked = []
  const proposal = {}
  let failed = false
  if (!propose && (allowlist.version !== 2 || !allowlist.tokens || typeof allowlist.tokens !== 'object' || Array.isArray(allowlist.tokens))) throw new Error('Invalid allowlist format')
  if (!propose) {
    for (const file of Object.keys(allowlist.tokens)) {
      if (!files.includes(file)) {
        failed = true
        console.error(`${file}: allowlist entry without image`)
      }
    }
  }
  for (const file of files) {
    const path = join(images, file)
    const ocr = command('tesseract', [path, 'stdout'])
    const tokens = [...new Set(ocr.split(/\s+/).map(word => word.replace(/^[.,:;!?()[\]{}"'|<>«»]+|[.,:;!?()[\]{}"'|<>«»]+$/g, '').toLowerCase()).filter(word => word.length >= 2))].sort()
    if (propose) {
      proposal[file] = tokens
      console.log(`${file}: ${tokens.length} words`)
      continue
    }
    const qr = command('zbarimg', ['--quiet', '--raw', path], true).split('\n').filter(Boolean)
    const issues = findings(ocr)
    if (qr.some(code => !allow.has(code))) issues.push('QR code')
    if (!Object.hasOwn(allowlist.tokens, file) || !Array.isArray(allowlist.tokens[file])) issues.push(`missing token allowlist, unknown words: ${tokens.length}`)
    else {
      const allowedTokens = new Set(allowlist.tokens[file])
      const unknown = tokens.filter(token => !allowedTokens.has(token)).length
      if (unknown) issues.push(`unknown words: ${unknown}`)
    }
    if (issues.length) {
      failed = true
      console.error(`${file}: ${[...new Set(issues)].join(', ')}`)
    }
    checked.push({ file, sha256: digest(readFileSync(path)), ocrSha256: digest(ocr), allowSha256: digest(allowFile), qrCodes: qr.length, result: 'pass' })
  }
  if (propose) writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  else if (failed) process.exitCode = 1
  else if (!check) writeFileSync(join(handbook, 'redaction.json'), JSON.stringify({ tesseract, zbarimg, checkedAt: new Date().toISOString(), images: checked }, null, 2) + '\n')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

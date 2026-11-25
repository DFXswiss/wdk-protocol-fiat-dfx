// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

// Writes echter-lauf.json version 2 from one passing production purchase record
// and one passing production sale record of run-sale.mjs. It checks the records,
// the working tree, the production API version and the two Polygon receipts,
// then copies the screenshots. It does not sign in and it does not send.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Interface, getAddress } from 'ethers'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const VERSION_URL = 'https://api.dfx.swiss/version'
const RPC_URL = 'https://polygon-bor-rpc.publicnode.com'
const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'
const USER_OP_EVENT_ABI = 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEX_SHA = /^[0-9a-fA-F]{7,64}$/
const STARTER_SHA = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-fA-F]{64}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const BASE_UNITS = /^(0|[1-9][0-9]*)$/
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,256}$/
const FILE_NAME = /^[A-Za-z0-9._-]+$/
const BEFEHL = [
  'node wallet-ui/run-sale.mjs --target production-polygon --buy --fiat-cents <cents> --seed-file <seed file> --udid <simulator> --send --confirm --follow <minutes> --screenshots <dir> --record <file>',
  'node wallet-ui/run-sale.mjs --target production-polygon --amount <USDT> --seed-file <seed file> --udid <simulator> --send --confirm --follow <minutes> --screenshots <dir> --record <file>'
].join(' && ')

class CheckError extends Error {
  constructor (check, message) {
    super(message)
    this.check = check
  }
}

const state = { headDir: '', protocolFile: '' }

function fail (check, message) {
  throw new CheckError(check, message)
}

function git (args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail('git', 'git failed')
  }
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readNoFollow (path, check, message) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    return readFileSync(fd)
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail(check, message)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function parseArgs (argv) {
  const options = {}
  const valued = new Map([
    ['--purchase-record', 'purchaseRecord'],
    ['--purchase-screenshots', 'purchaseScreenshots'],
    ['--sale-record', 'saleRecord'],
    ['--sale-screenshots', 'saleScreenshots']
  ])
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (!valued.has(name)) fail('usage', 'Unknown argument')
    if (seen.has(name)) fail('usage', `Duplicate argument: ${name}`)
    seen.add(name)
    const value = argv[++i]
    if (!value || value.startsWith('--')) fail('usage', `Missing value for ${name}`)
    options[valued.get(name)] = value
  }
  for (const name of valued.keys()) {
    if (!seen.has(name)) fail('usage', `Required argument missing: ${name}`)
  }
  return options
}

function readRecord (path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail('records', `${label} record cannot be read`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('records', `${label} record is not a regular file`)
  const bytes = readNoFollow(path, 'records', `${label} record cannot be read`)
  const text = bytes.toString('utf8')
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body.length === 0 || body.includes('\n')) fail('records', `${label} record is not one JSON line`)
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    fail('records', `${label} record is not JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('records', `${label} record is not an object`)
  return parsed
}

function assertRehearsal (record) {
  if (Object.hasOwn(record, 'rehearsal') || record.result !== 'pass') {
    fail('rehearsal', 'record is a rehearsal or not a passing run')
  }
}

function assertPass (record, mode) {
  assertRehearsal(record)
  if (record.result !== 'pass') fail('result', `${mode} result is not pass`)
  if (record.mode !== mode) fail('mode', `${mode} mode is wrong`)
  if (record.dirty !== false) fail('dirty', `${mode} record is not a clean tree`)
  if (record.maestroStepRetries !== 0) fail('maestro-retries', `${mode} maestroStepRetries is not 0`)
}

function requireHex (value, pattern, check, message) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(check, message)
  return value
}

function requireAddress (value, check, message) {
  if (typeof value !== 'string') fail(check, message)
  try {
    return getAddress(value)
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail(check, message)
  }
}

function sameAddress (left, right) {
  try {
    return getAddress(left) === getAddress(right)
  } catch {
    return false
  }
}

function isZeroAddress (address) {
  return sameAddress(address, '0x0000000000000000000000000000000000000000')
}

// Same acceptance rule as assertBookedPayout in run-sale.mjs.
function finiteAmount (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const amount = Number(value)
    return Number.isFinite(amount) ? amount : undefined
  }
  return undefined
}

// Same cent conversion as amountCents in run-sale.mjs.
function amountCents (value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null
  const [whole, frac = ''] = text.split('.')
  if (frac.length > 2 && !/^0+$/.test(frac.slice(2))) return null
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  return cents
}

// Same 6-decimal scaling as scaled6 in run-sale.mjs.
function scaled6 (text) {
  const [whole, frac = ''] = text.split('.')
  if (frac.length > 6 && !/^0+$/.test(frac.slice(6))) return null
  return BigInt(`${whole}${frac.slice(0, 6).padEnd(6, '0')}`)
}

// Backend Util.roundReadable → roundByPrecision(amount, 5), ROUND_HALF_UP.
// Same rule as roundedSaleBase in run-sale.mjs.
function roundedSaleBase (base) {
  let scale = 6
  let coeff = base
  while (coeff > 0n && coeff % 10n === 0n) {
    coeff /= 10n
    scale -= 1
  }
  const digits = coeff.toString()
  if (digits.length <= 5) return base
  let kept = BigInt(digits.slice(0, 5))
  if (digits[5] >= '5') kept += 1n
  const exponent = digits.length - 5 - scale + 6
  return kept * (10n ** BigInt(exponent))
}

// Same USDT rendering as usdtDecimal in run-sale.mjs.
function usdtDecimal (base) {
  const whole = base / 1000000n
  const frac = (base % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac === '' ? whole.toString() : `${whole}.${frac}`
}

function requireHash (value, check, message = 'hash is not a 32-byte transaction hash') {
  return requireHex(value, TX_HASH, check, message)
}

function requireBlock (value, check) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(check, 'block is not a block number')
  return value
}

function baseUnits (value, check, message) {
  if (typeof value !== 'string' || !BASE_UNITS.test(value)) fail(check, message)
  return value
}

function requireTime (value, label) {
  if (typeof value !== 'string') fail('order', `${label} date is missing`)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) fail('order', `${label} date is not a time`)
  return time
}

function plainId (value, check) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && value !== '') return value
  fail(check, 'backend id is not a plain value')
}

function uidText (value, check) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(text)) fail(check, 'backend uid is empty')
  return text
}

function balanceRow (record, asset, account, check) {
  if (!Array.isArray(record.balances)) fail(check, 'balances are missing')
  const rows = record.balances.filter(row => {
    return row && row.asset === asset && typeof row.address === 'string' && sameAddress(row.address, account)
  })
  if (rows.length !== 1) fail(check, `found ${rows.length} ${asset} balance rows for the account`)
  return {
    before: baseUnits(rows[0].before, check, `${asset} balance before is not base units`),
    after: baseUnits(rows[0].after, check, `${asset} balance after is not base units`)
  }
}

function purchaseModuleLeg (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return value.cryptoAsset === 'USDT' && value.fiatCurrency === 'EUR' && value.status === 'completed'
}

function assertPurchase (record) {
  assertPass(record, 'purchase')
  const moduleHead = requireHex(record.moduleHead, HEX_SHA, 'module-head', 'purchase module head is not a full sha')
  const account = requireAddress(record.account, 'identity', 'purchase account is not an address')
  if (isZeroAddress(account)) fail('purchase', 'purchase account is zero')
  const starterCommit = requireHex(record.starterCommit, STARTER_SHA, 'identity', 'purchase starter commit is not a full sha')
  if (starterCommit !== readPinnedStarterCommit()) fail('identity', 'purchase starter commit is not the pinned commit')
  const patchSha256 = requireHex(record.patchSha256, HEX_64, 'identity', 'purchase patch digest is not hex')
  const mainJsbundleSha256 = requireHex(record.mainJsbundleSha256, HEX_64, 'identity', 'purchase bundle digest is not hex')
  const backendCommitStart = requireHex(record.backendCommitStart, HEX_SHA, 'backend-version', 'purchase backend commit is not hex')
  const backendCommitEnd = requireHex(record.backendCommitEnd, HEX_SHA, 'backend-version', 'purchase backend commit is not hex')
  const hash = requireHash(record.hash, 'purchase')
  const block = requireBlock(record.block, 'purchase')
  const payoutFrom = requireAddress(record.payoutFrom, 'purchase', 'payoutFrom is not an address')
  if (isZeroAddress(payoutFrom)) fail('purchase', 'payoutFrom is zero')
  const value = baseUnits(record.value, 'purchase', 'purchase value is not base units')
  if (!Number.isSafeInteger(record.fiatCents) || record.fiatCents <= 0) fail('purchase', 'fiatCents is not a positive integer')
  // The quote is the estimate from before payment. It is not the settled transfer.
  const quote = record.quote
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) fail('purchase', 'quote is missing')
  if (quote.fiatAmount !== String(record.fiatCents)) fail('purchase', 'quote fiatAmount is not the fiat amount')
  if (typeof quote.rate !== 'string' || quote.rate === '') fail('purchase', 'quote rate is not a non-empty string')
  const estimatedUsdtBase = baseUnits(quote.estimatedUsdtBase, 'purchase', 'quote estimated USDT is not base units')
  if (BigInt(estimatedUsdtBase) <= 0n) fail('purchase', 'quote estimated USDT is not greater than 0')
  if (quote.estimatedUsdt !== usdtDecimal(BigInt(estimatedUsdtBase))) {
    fail('purchase', 'quote estimated USDT does not match the base units')
  }
  baseUnits(quote.fee, 'purchase', 'quote fee is not base units')
  if (!Number.isSafeInteger(record.rpcReadRetries) || record.rpcReadRetries < 0) fail('purchase', 'rpcReadRetries is not a count')
  const backend = record.backend
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) fail('purchase', 'backend is missing')
  if (backend.state !== 'Completed') fail('purchase', 'backend state is not Completed')
  if (backend.outputAsset !== 'USDT') fail('purchase', 'outputAsset is not USDT')
  if (typeof backend.outputAmount !== 'number' || !Number.isFinite(backend.outputAmount) || !(backend.outputAmount > 0)) {
    fail('purchase', 'outputAmount is not a finite number greater than 0')
  }
  const cents = amountCents(backend.inputAmount)
  if (cents === null || cents !== record.fiatCents) fail('purchase', 'inputAmount is not the fiat amount')
  let scaledOutput = null
  try {
    scaledOutput = scaled6(String(backend.outputAmount))
  } catch (error) {
    if (error instanceof CheckError) throw error
    scaledOutput = null
  }
  if (scaledOutput === null || roundedSaleBase(BigInt(value)) !== scaledOutput) {
    fail('purchase', 'purchase value does not match outputAmount')
  }
  const externalId = typeof record.externalTransactionId === 'string' ? record.externalTransactionId : ''
  const backendExternalId = typeof backend.externalTransactionId === 'string' ? backend.externalTransactionId : ''
  if (!EXTERNAL_ID.test(externalId) || externalId !== backendExternalId) {
    fail('purchase', 'externalTransactionId does not match the backend record')
  }
  const status = record.moduleStatus
  if (!status || typeof status !== 'object' || Array.isArray(status) || !purchaseModuleLeg(status.byExternalId) || !purchaseModuleLeg(status.byUid)) {
    fail('purchase', 'module status is not completed')
  }
  const usdt = balanceRow(record, 'USDT', account, 'purchase')
  if (BigInt(record.value) <= 0n) fail('purchase', 'purchase value is not greater than 0')
  if (BigInt(usdt.after) - BigInt(usdt.before) !== BigInt(value)) {
    fail('purchase', 'USDT balance change is not the purchase value')
  }
  const pol = balanceRow(record, 'POL', account, 'purchase')
  if (pol.before !== pol.after) fail('purchase', 'POL balance changed')
  return {
    moduleHead,
    account,
    starterCommit,
    patchSha256,
    mainJsbundleSha256,
    backendCommitStart,
    backendCommitEnd,
    hash,
    block,
    payoutFrom,
    value,
    externalId,
    date: requireTime(record.date, 'purchase'),
    usdt,
    id: plainId(backend.id, 'purchase'),
    uid: uidText(backend.uid, 'purchase'),
    screenshots: record.screenshots
  }
}

function assertSale (record) {
  assertPass(record, 'sale')
  const moduleHead = requireHex(record.moduleHead, HEX_SHA, 'module-head', 'sale module head is not a full sha')
  const account = requireAddress(record.account, 'identity', 'sale account is not an address')
  if (isZeroAddress(account)) fail('sale', 'sale account is zero')
  const starterCommit = requireHex(record.starterCommit, STARTER_SHA, 'identity', 'sale starter commit is not a full sha')
  const patchSha256 = requireHex(record.patchSha256, HEX_64, 'identity', 'sale patch digest is not hex')
  const mainJsbundleSha256 = requireHex(record.mainJsbundleSha256, HEX_64, 'identity', 'sale bundle digest is not hex')
  const backendCommitStart = requireHex(record.backendCommitStart, HEX_SHA, 'backend-version', 'sale backend commit is not hex')
  const backendCommitEnd = requireHex(record.backendCommitEnd, HEX_SHA, 'backend-version', 'sale backend commit is not hex')
  const hash = requireHash(record.hash, 'sale')
  const userOperationHash = requireHash(record.userOperationHash, 'sale', 'userOperationHash is not a 32-byte hash')
  const block = requireBlock(record.block, 'sale')
  const paymaster = requireAddress(record.paymaster, 'sale', 'paymaster is not an address')
  if (isZeroAddress(paymaster)) fail('sale', 'paymaster is zero')
  const depositAddress = requireAddress(record.depositAddress, 'sale', 'depositAddress is not an address')
  if (isZeroAddress(depositAddress)) fail('sale', 'depositAddress is zero')
  if (record.feePaidBy !== 'paymaster') fail('sale', 'feePaidBy is not paymaster')
  if (record.walletConfirmations !== 1) fail('sale', 'walletConfirmations is not 1')
  const backend = record.backend
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) fail('sale', 'backend is missing')
  if (backend.state !== 'PayoutInProgress' && backend.state !== 'Completed') {
    fail('sale', 'backend state is not PayoutInProgress or Completed')
  }
  const outputAmount = finiteAmount(backend.outputAmount)
  if (outputAmount === undefined) fail('sale', 'outputAmount is not a finite number')
  if (!(outputAmount > 0)) fail('sale', 'outputAmount is not greater than 0')
  if (backend.outputAsset !== 'EUR') fail('sale', 'outputAsset is not EUR')
  const moduleStatus = record.moduleStatus
  const expectedStatus = backend.state === 'Completed' ? 'completed' : 'in_progress'
  if (!moduleStatus || typeof moduleStatus !== 'object' || Array.isArray(moduleStatus) || moduleStatus.status !== expectedStatus) {
    fail('sale', 'module status does not match the sale')
  }
  const usdt = balanceRow(record, 'USDT', account, 'sale')
  const pol = balanceRow(record, 'POL', account, 'sale')
  if (pol.before !== pol.after) fail('sale', 'POL balance changed')
  const sold = BigInt(usdt.before) - BigInt(usdt.after)
  if (sold <= 0n) fail('sale', 'sale USDT balance did not fall')
  return {
    moduleHead,
    account,
    starterCommit,
    patchSha256,
    mainJsbundleSha256,
    backendCommitStart,
    backendCommitEnd,
    hash,
    block,
    userOperationHash,
    paymaster,
    depositAddress,
    date: requireTime(record.date, 'sale'),
    usdt,
    state: backend.state,
    id: plainId(backend.id, 'sale'),
    uid: uidText(backend.uid, 'sale'),
    screenshots: record.screenshots
  }
}

function assertShared (purchase, sale) {
  if (purchase.moduleHead !== sale.moduleHead) fail('module-head', 'module heads differ')
  if (purchase.account !== sale.account) fail('identity', 'accounts differ')
  if (purchase.starterCommit !== sale.starterCommit) fail('identity', 'starter commits differ')
  if (purchase.patchSha256 !== sale.patchSha256) fail('identity', 'patch digests differ')
  if (purchase.mainJsbundleSha256 !== sale.mainJsbundleSha256) fail('identity', 'bundle digests differ')
  if (purchase.backendCommitStart !== purchase.backendCommitEnd) fail('backend-version', 'purchase backend commit changed during the run')
  if (sale.backendCommitStart !== sale.backendCommitEnd) fail('backend-version', 'sale backend commit changed during the run')
  if (sale.backendCommitStart !== purchase.backendCommitEnd) fail('backend-version', 'backend commit differs between the purchase and the sale')
}

async function readBackendCommit () {
  let response
  try {
    response = await fetch(VERSION_URL, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch {
    fail('backend-version', 'version unreachable')
  }
  if (!response.ok) fail('backend-version', `version returned HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    fail('backend-version', 'version returned no JSON')
  }
  if (!body || typeof body.commit !== 'string' || !HEX_SHA.test(body.commit)) fail('backend-version', 'version has no commit')
  return body.commit
}

async function assertBackend (expected) {
  const commit = await readBackendCommit()
  if (commit !== expected) fail('backend-version', 'version commit differs from the records')
}

function assertTree (expectedHead) {
  const head = git(['rev-parse', 'HEAD'])
  if (head !== expectedHead) fail('module-head', 'module head is not HEAD')
  if (git(['status', '--porcelain']) !== '') fail('clean-tree', 'the module tree is not clean')
}

function readPinnedStarterCommit () {
  const path = join(repoRoot, 'e2e', 'wallet-ui', 'build.sh')
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail('identity', 'build.sh cannot be read')
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('identity', 'build.sh cannot be read')
  const text = readNoFollow(path, 'identity', 'build.sh cannot be read').toString('utf8')
  let pin
  for (const line of text.split('\n')) {
    const match = /^PINNED_STARTER_COMMIT="([0-9a-f]{40})"$/.exec(line)
    if (!match) continue
    if (pin !== undefined) fail('identity', 'build.sh starter commit pin cannot be read')
    pin = match[1]
  }
  if (pin === undefined) fail('identity', 'build.sh starter commit pin cannot be read')
  return pin
}

function assertPatch (digest) {
  const path = join(repoRoot, 'e2e', 'wallet-ui', 'starter.patch')
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail('identity', 'starter.patch cannot be read')
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('identity', 'starter.patch cannot be read')
  const bytes = readNoFollow(path, 'identity', 'starter.patch cannot be read')
  if (sha256(bytes) !== digest) fail('identity', 'starter.patch does not match the record')
}

function assertOrder (purchase, sale) {
  if (!(purchase.date < sale.date)) fail('order', 'purchase is not before the sale')
  if (purchase.usdt.after !== sale.usdt.before) fail('order', 'purchase USDT after is not the sale USDT before')
  if (purchase.hash.toLowerCase() === sale.hash.toLowerCase()) fail('chain', 'purchase and sale hashes are the same')
}

function explorerName (hash) {
  return `explorer-${hash.slice(2, 12)}.png`
}

function bookingName (uid) {
  return `booking-${uid}.png`
}

function shotMap (screenshots, expected, check) {
  if (!Array.isArray(screenshots)) fail(check, 'screenshots are missing')
  const byName = new Map()
  for (const item of screenshots) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('screenshots', 'screenshot entry is incomplete')
    if (typeof item.file !== 'string' || !FILE_NAME.test(item.file)) fail('screenshots', 'screenshot name is not a file name')
    if (typeof item.sha256 !== 'string' || !HEX_64.test(item.sha256)) fail('screenshots', 'screenshot hash is not hex')
    if (byName.has(item.file)) fail('screenshots', `duplicate screenshot ${item.file}`)
    byName.set(item.file, item.sha256)
  }
  const names = [...byName.keys()]
  if (names.length !== expected.length || expected.some(name => !byName.has(name))) {
    fail('screenshots', `found ${names.join(', ') || 'none'}`)
  }
  return byName
}

function shotPath (dir, name) {
  let rootStat
  try {
    rootStat = statSync(dir)
  } catch {
    fail('screenshots', 'screenshots path cannot be read')
  }
  if (!rootStat.isDirectory()) fail('screenshots', 'screenshots path is not a directory')
  let root
  try {
    root = realpathSync(dir)
  } catch {
    fail('screenshots', 'screenshots path cannot be resolved')
  }
  const full = resolve(root, name)
  if (relative(root, full) !== name) fail('screenshots', 'screenshot path escapes the directory')
  return full
}

function readShot (dir, name, expectedSha) {
  const path = shotPath(dir, name)
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail('screenshots', `${name} cannot be read`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('screenshots', `${name} is not a regular file`)
  const bytes = readNoFollow(path, 'screenshots', `${name} cannot be read`)
  if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) fail('screenshots', `${name} is not a PNG`)
  const digest = sha256(bytes)
  if (digest !== expectedSha.toLowerCase()) fail('screenshots', `${name} hash does not match the record`)
  return digest
}

function assertShots (dirs, purchase, sale) {
  const purchaseNames = ['buy-widget-open.png', explorerName(purchase.hash), bookingName(purchase.uid)]
  const saleNames = ['send-review.png', 'send-success.png', explorerName(sale.hash), bookingName(sale.uid)]
  const purchaseShots = shotMap(purchase.screenshots, purchaseNames, 'purchase')
  const saleShots = shotMap(sale.screenshots, saleNames, 'sale')
  for (const name of purchaseNames) readShot(dirs.purchaseScreenshots, name, purchaseShots.get(name))
  for (const name of saleNames) readShot(dirs.saleScreenshots, name, saleShots.get(name))
  return { purchaseNames, saleNames, purchaseShots, saleShots }
}

function addressFromTopic (topic) {
  if (typeof topic !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null
  try {
    return getAddress(`0x${topic.slice(-40)}`)
  } catch {
    return null
  }
}

function hexQuantity (value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

async function readReceipt (hash) {
  let response
  try {
    response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    fail('chain', `receipt read failed for ${hash}`)
  }
  if (!response.ok) fail('chain', `receipt returned HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    fail('chain', 'receipt was not JSON')
  }
  if (!body || typeof body !== 'object' || body.error || !body.result || typeof body.result !== 'object') {
    fail('chain', `no receipt for ${hash}`)
  }
  const receipt = body.result
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    fail('chain', `receipt transactionHash does not match ${hash}`)
  }
  if (Array.isArray(receipt.logs) && receipt.logs.some(log => log && typeof log === 'object' && log.removed === true)) {
    fail('chain', `receipt for ${hash} has a removed log`)
  }
  return receipt
}

function assertReceiptStatus (receipt, info) {
  const status = hexQuantity(receipt.status)
  if (status !== 1n) fail('chain', `receipt status for ${info.hash} is not 1`)
  const block = hexQuantity(receipt.blockNumber)
  if (block !== BigInt(info.block)) fail('chain', `receipt block for ${info.hash} does not match the record`)
  const from = requireAddress(receipt.from, 'chain', `receipt for ${info.hash} has no sender`)
  if (isZeroAddress(from)) fail('chain', `receipt sender for ${info.hash} is zero`)
  return from
}

function isUsdtTransfer (log) {
  if (!log || typeof log !== 'object') return false
  let address
  try {
    address = getAddress(log.address)
  } catch {
    return false
  }
  const topic0 = typeof log.topics?.[0] === 'string' ? log.topics[0].toLowerCase() : ''
  return address === getAddress(USDT) && topic0 === TRANSFER_TOPIC
}

function usdtLogsTouching (logs, account) {
  const touching = []
  for (const log of logs) {
    if (!isUsdtTransfer(log)) continue
    const from = addressFromTopic(log.topics?.[1])
    const to = addressFromTopic(log.topics?.[2])
    if (from !== account && to !== account) continue
    touching.push({ log, from, to })
  }
  return touching
}

// Received is positive and sent is negative, the same sign as after minus before.
function assertSignedUsdtNet (touching, account, delta) {
  let net = 0n
  for (const item of touching) {
    const value = hexQuantity(item.log.data)
    if (value === null) fail('chain', 'USDT transfer value is not a quantity')
    if (item.to === account) net += value
    if (item.from === account) net -= value
  }
  if (net !== delta) fail('chain', 'USDT transfer net does not match the USDT balance change')
}

function assertPurchaseTransfer (receipt, purchase) {
  const logs = Array.isArray(receipt.logs) ? receipt.logs : null
  if (!logs) fail('chain', 'purchase receipt has no logs')
  const hits = logs.filter(log => isUsdtTransfer(log) && addressFromTopic(log.topics?.[2]) === purchase.account)
  if (hits.length !== 1) fail('chain', `found ${hits.length} USDT transfers to the account`)
  const from = addressFromTopic(hits[0].topics?.[1])
  const value = hexQuantity(hits[0].data)
  if (isZeroAddress(from)) fail('chain', 'USDT transfer sender is zero')
  if (sameAddress(purchase.payoutFrom, purchase.account)) fail('purchase', 'payoutFrom is the account')
  if (from === purchase.account) fail('chain', 'USDT transfer sender is the account')
  if (from !== purchase.payoutFrom) fail('chain', 'USDT transfer sender does not match payoutFrom')
  if (BigInt(purchase.value) <= 0n) fail('purchase', 'purchase value is not greater than 0')
  if (value !== BigInt(purchase.value)) fail('chain', 'USDT transfer value does not match the record')
  const touching = usdtLogsTouching(logs, purchase.account)
  if (touching.some(item => item.from === purchase.account)) fail('chain', 'purchase has a USDT transfer from the account')
  assertSignedUsdtNet(touching, purchase.account, BigInt(purchase.usdt.after) - BigInt(purchase.usdt.before))
}

function assertSaleTransfer (receipt, sale) {
  const logs = Array.isArray(receipt.logs) ? receipt.logs : null
  if (!logs) fail('chain', 'sale receipt has no logs')
  const iface = new Interface([USER_OP_EVENT_ABI])
  const event = iface.getEvent('UserOperationEvent')
  if (!event) fail('chain', 'UserOperationEvent is not in the interface')
  const eventTopic = event.topicHash.toLowerCase()
  const userOpHash = sale.userOperationHash.toLowerCase()
  const entryPoint = getAddress(ENTRY_POINT)
  const opLogs = logs.filter(log => {
    if (!log || typeof log !== 'object') return false
    let address
    try {
      address = getAddress(log.address)
    } catch {
      return false
    }
    const topic0 = typeof log.topics?.[0] === 'string' ? log.topics[0].toLowerCase() : ''
    const topic1 = typeof log.topics?.[1] === 'string' ? log.topics[1].toLowerCase() : ''
    return address === entryPoint && topic0 === eventTopic && topic1 === userOpHash
  })
  if (opLogs.length !== 1) fail('chain', `found ${opLogs.length} UserOperationEvent logs for the user operation`)
  let decoded
  try {
    decoded = iface.parseLog({ topics: opLogs[0].topics, data: opLogs[0].data })
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail('chain', 'UserOperationEvent did not decode')
  }
  if (!decoded || decoded.args.success !== true) fail('chain', 'UserOperationEvent success is not true')
  let sender
  try {
    sender = getAddress(decoded.args.sender)
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail('chain', 'UserOperationEvent sender is not an address')
  }
  let paymaster
  try {
    paymaster = getAddress(decoded.args.paymaster)
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail('chain', 'UserOperationEvent paymaster is not an address')
  }
  if (isZeroAddress(paymaster)) fail('chain', 'UserOperationEvent paymaster is zero')
  if (isZeroAddress(sender)) fail('chain', 'UserOperationEvent sender is zero')
  if (sender !== sale.account) fail('chain', 'UserOperationEvent sender is not the account')
  if (paymaster !== sale.paymaster) fail('chain', 'UserOperationEvent paymaster does not match the record')
  if (paymaster === sale.account) fail('chain', 'UserOperationEvent paymaster is the account')
  const transfers = logs.filter(log => isUsdtTransfer(log) && addressFromTopic(log.topics?.[1]) === sale.account)
  if (transfers.length !== 1) fail('chain', `found ${transfers.length} USDT transfers from the account`)
  const to = addressFromTopic(transfers[0].topics?.[2])
  const value = hexQuantity(transfers[0].data)
  const sold = BigInt(sale.usdt.before) - BigInt(sale.usdt.after)
  if (isZeroAddress(to)) fail('chain', 'USDT transfer recipient is zero')
  if (sameAddress(sale.depositAddress, sale.account)) fail('sale', 'depositAddress is the account')
  if (to === sale.account) fail('chain', 'USDT transfer recipient is the account')
  if (to !== sale.depositAddress) fail('chain', 'USDT transfer recipient is not the deposit address')
  if (value !== sold) fail('chain', 'USDT transfer value does not match the sold balance')
  const touching = usdtLogsTouching(logs, sale.account)
  if (touching.some(item => item.to === sale.account)) fail('chain', 'sale has a USDT transfer to the account')
  assertSignedUsdtNet(touching, sale.account, BigInt(sale.usdt.after) - BigInt(sale.usdt.before))
}

async function assertChain (purchase, sale) {
  const purchaseReceipt = await readReceipt(purchase.hash)
  const purchaseFrom = assertReceiptStatus(purchaseReceipt, purchase)
  assertPurchaseTransfer(purchaseReceipt, purchase)
  const saleReceipt = await readReceipt(sale.hash)
  const saleFrom = assertReceiptStatus(saleReceipt, sale)
  assertSaleTransfer(saleReceipt, sale)
  return { purchaseFrom, saleFrom }
}

function absent (path) {
  try {
    lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    fail('output', 'output path cannot be checked')
  }
  fail('output', 'output path already exists')
}

function ensureDir (path, track) {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') fail('output', 'evidence directory already exists')
    fail('output', 'evidence directory could not be created')
  }
  if (track) state.headDir = path
  chmodSync(path, 0o700)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail('output', 'evidence directory is not mode 0700')
  }
}

function copyShot (sourceDir, destDir, name, expectedSha) {
  const source = shotPath(sourceDir, name)
  const dest = join(destDir, name)
  const bytes = readNoFollow(source, 'screenshots', `${name} cannot be read`)
  let stat
  try {
    stat = lstatSync(source)
  } catch {
    fail('screenshots', `${name} cannot be read`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('screenshots', `${name} is not a regular file`)
  if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) fail('screenshots', `${name} is not a PNG`)
  if (sha256(bytes) !== expectedSha.toLowerCase()) fail('screenshots', `${name} hash does not match the record`)
  let fd
  try {
    fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, bytes)
    fchmodSync(fd, 0o600)
  } catch (error) {
    if (error instanceof CheckError) throw error
    fail('output', `${name} could not be copied`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const copied = readNoFollow(dest, 'output', `${name} copy cannot be read`)
  const digest = sha256(copied)
  if (digest !== expectedSha.toLowerCase()) fail('screenshots', `${name} copy hash does not match the record`)
  const rel = relative(repoRoot, dest).split(sep).join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) fail('output', 'evidence path is outside the repository')
  return { datei: rel, sha256: digest }
}

function shotEntry (schritt, copied, tx) {
  const entry = { schritt, datei: copied.datei, sha256: copied.sha256 }
  if (tx) entry.tx = tx
  return entry
}

function writeProtocol (path, text) {
  absent(path)
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') fail('output', 'protocol file already exists')
    fail('output', 'protocol file could not be created')
  }
  state.protocolFile = path
  try {
    writeFileSync(fd, text)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    fail('output', 'protocol file is not mode 0600')
  }
}

function protocolPath () {
  const listed = git(['rev-parse', '--git-path', 'echter-lauf.json'])
  if (listed === '') fail('output', 'protocol path is empty')
  return isAbsolute(listed) ? listed : resolve(repoRoot, listed)
}

function writeOutputs (dirs, purchase, sale, shots, from) {
  const headDir = join(repoRoot, 'e2e', 'wallet-ui', 'out', 'evidence', purchase.moduleHead)
  const purchaseDir = join(headDir, 'purchase')
  const saleDir = join(headDir, 'sale')
  const destination = protocolPath()
  absent(headDir)
  absent(destination)
  mkdirSync(join(repoRoot, 'e2e', 'wallet-ui', 'out', 'evidence'), { recursive: true })
  ensureDir(headDir, true)
  ensureDir(purchaseDir)
  ensureDir(saleDir)
  const copiedPurchase = new Map(shots.purchaseNames.map(name => {
    return [name, copyShot(dirs.purchaseScreenshots, purchaseDir, name, shots.purchaseShots.get(name))]
  }))
  const copiedSale = new Map(shots.saleNames.map(name => {
    return [name, copyShot(dirs.saleScreenshots, saleDir, name, shots.saleShots.get(name))]
  }))
  const protocol = {
    version: 2,
    art: 'echt',
    head: purchase.moduleHead,
    frontend_sha: purchase.starterCommit,
    backend_sha: purchase.backendCommitStart,
    backend_sha_ende: sale.backendCommitEnd,
    befehl: BEFEHL,
    chain_id: 137,
    lokal: false,
    vertraege: { USDT },
    wallet: {
      name: 'wdk-starter-react-native',
      version: `${purchase.starterCommit} + starter.patch ${purchase.patchSha256}`,
      oberflaeche: true
    },
    flags: 'production api.dfx.swiss; sale sponsored by a Pimlico paymaster on Polygon; purchase paid by bank transfer by the account holder',
    erkennung: 'selbst',
    gemockt: [],
    dirty: false,
    wiederholungen: 0,
    schalter: [],
    txs: [
      {
        hash: purchase.hash,
        rolle: 'funding',
        from: from.purchaseFrom,
        saldo: { vorher: purchase.usdt.before, nachher: purchase.usdt.after }
      },
      {
        hash: sale.hash,
        rolle: 'verkauf',
        from: from.saleFrom,
        saldo: { vorher: sale.usdt.before, nachher: sale.usdt.after },
        bestaetigungen: 1,
        buchung: { status: sale.state, uid: sale.uid }
      }
    ],
    screenshots: [
      shotEntry('kauf-widget', copiedPurchase.get('buy-widget-open.png')),
      shotEntry('explorer', copiedPurchase.get(explorerName(purchase.hash)), purchase.hash),
      shotEntry('buchung-kauf', copiedPurchase.get(bookingName(purchase.uid)), purchase.hash),
      shotEntry('verkauf-review', copiedSale.get('send-review.png')),
      shotEntry('verkauf-erfolg', copiedSale.get('send-success.png')),
      shotEntry('explorer', copiedSale.get(explorerName(sale.hash)), sale.hash),
      shotEntry('buchung', copiedSale.get(bookingName(sale.uid)), sale.hash)
    ],
    backend_beleg: {
      endpoint: 'GET /v1/transaction',
      antwort: {
        verkauf: { id: sale.id, uid: sale.uid, inputTxId: sale.hash, state: sale.state },
        kauf: {
          id: purchase.id,
          uid: purchase.uid,
          outputTxId: purchase.hash,
          state: 'Completed',
          externalTransactionId: purchase.externalId
        }
      }
    }
  }
  writeProtocol(destination, `${JSON.stringify(protocol, null, 2)}\n`)
  state.headDir = ''
  state.protocolFile = ''
  return destination
}

function cleanupPartial () {
  if (state.protocolFile) {
    try { unlinkSync(state.protocolFile) } catch { /* the partial file is already gone */ }
  }
  if (state.headDir) {
    try { rmSync(state.headDir, { recursive: true, force: true }) } catch { /* the partial directory is already gone */ }
  }
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  const purchase = assertPurchase(readRecord(options.purchaseRecord, 'purchase'))
  const sale = assertSale(readRecord(options.saleRecord, 'sale'))
  assertShared(purchase, sale)
  assertTree(purchase.moduleHead)
  assertPatch(purchase.patchSha256)
  await assertBackend(purchase.backendCommitStart)
  assertOrder(purchase, sale)
  const shots = assertShots(options, purchase, sale)
  const from = await assertChain(purchase, sale)
  assertTree(purchase.moduleHead)
  await assertBackend(sale.backendCommitEnd)
  const written = writeOutputs(options, purchase, sale, shots, from)
  console.log(`run protocol written: ${written}`)
}

try {
  await main()
} catch (error) {
  cleanupPartial()
  const check = error instanceof CheckError ? error.check : 'run'
  const message = error instanceof CheckError
    ? error.message
    : String(error?.message ?? 'failed').replace(/https?:\/\/\S+/g, '[redacted]')
  console.error(`write-protocol: ${check}: ${message}`)
  process.exitCode = 1
}

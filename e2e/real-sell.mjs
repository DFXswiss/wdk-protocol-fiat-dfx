// Real Sepolia sell against the DFX sandbox, the way a wallet user sells.
// One on-chain deposit per asset, then the DFX dev API must recognize that hash.
// It does not check the bank payout: a sell ends when the backend recognizes the deposit.
// WDK has no confirmation dialog, so a rejected wallet prompt is not covered.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, constants, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync, writeSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { Contract, JsonRpcProvider, formatUnits, getAddress, id, isAddress, parseUnits } from 'ethers'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const API = 'https://dev.api.dfx.swiss'
const APP = 'https://dev.app.dfx.swiss'
const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const CHAIN_ID = 11155111n
const USDT = getAddress('0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0')
const ETH_RESERVE = parseUnits('0.002', 18)
const TRANSFER_TOPIC = id('Transfer(address,address,uint256)')
const RECEIPT_TIMEOUT_MS = 4 * 60 * 1000
const BACKEND_TIMEOUT_MS = 10 * 60 * 1000
const BACKEND_POLL_MS = 15_000
const PAYMENT_TIMEOUT_MS = 60_000
const PAYMENT_QUIET_MS = 2_000
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const CASES = [
  { asset: 'USDT', amount: 1000000n, decimals: 6 },
  { asset: 'ETH', amount: 100000000000000n, decimals: 18 }
]

class UsageError extends Error {}
class NotRunError extends Error {}

const secrets = []
const state = { flow: false, lockHeld: false, lockDir: '', provider: null, browser: null, out: null }

function redact (value) {
  let text = String(value ?? 'Unknown error')
  const ordered = secrets.filter(Boolean).sort((a, b) => b.length - a.length)
  for (const secret of ordered) text = text.split(secret).join('[REDACTED]')
  for (const pattern of state.ibanPatterns || []) {
    pattern.lastIndex = 0
    text = text.replace(pattern, '[REDACTED]')
  }
  return text
    .replace(/([?&]session=)[^&\s"'<>]+/g, '$1[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/https:\/\/dev\.app\.dfx\.swiss\/sell\?[^ \n"']+/g, 'https://dev.app.dfx.swiss/sell?[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
}

function writeLine (fd, line) {
  const data = Buffer.from(line + '\n')
  let offset = 0
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset)
    if (written <= 0) throw new Error('--out write failed')
    offset += written
  }
}

function emit (record) {
  const line = redact(JSON.stringify(record, (_, value) => typeof value === 'bigint' ? value.toString() : value))
  process.stdout.write(line + '\n')
  if (state.out) writeLine(state.out.fd, line)
}

function compact (value) {
  return String(value ?? '').replace(/[\s\u00a0]/g, '')
}

function units (base, decimals) {
  return Number(formatUnits(base, decimals))
}

function amountIsSale (actual, base, decimals) {
  if (typeof actual === 'number') return Number.isFinite(actual) && actual === units(base, decimals)
  if (typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual))) {
    return Number(actual) === units(base, decimals)
  }
  return false
}

function currencyCode (currency) {
  if (typeof currency === 'string' && currency.trim() !== '') return currency.trim()
  if (currency && typeof currency === 'object' && typeof currency.name === 'string' && currency.name.trim() !== '') {
    return currency.name.trim()
  }
  throw new Error('paymentInfos currency is neither a string nor an object with name')
}

function rememberSecret (value) {
  if (typeof value === 'string' && value !== '') secrets.push(value)
}

function rememberIban (iban) {
  rememberSecret(iban)
  rememberSecret(compact(iban))
  const raw = compact(iban)
  const spaced = raw.replace(/(.{4})(?=.)/g, '$1 ')
  rememberSecret(spaced)
  rememberSecret(spaced.replace(/ /g, '\u00a0'))
  const body = [...raw].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\u00a0]*')
  state.ibanPatterns = [new RegExp(body, 'g')]
}

function parseArgs (args) {
  const options = { rpc: DEFAULT_RPC, asset: 'all', send: false, confirm: false }
  const valued = new Map([
    ['--seed-file', 'seedFile'], ['--iban-file', 'ibanFile'], ['--asset', 'asset'],
    ['--rpc', 'rpc'], ['--lock', 'lock'], ['--out', 'out']
  ])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (name === '--send' || name === '--confirm') {
      if (seen.has(name)) throw new UsageError(`Duplicate argument: ${name}`)
      seen.add(name)
      options[name === '--send' ? 'send' : 'confirm'] = true
    } else if (valued.has(name)) {
      if (seen.has(name)) throw new UsageError(`Duplicate argument: ${name}`)
      seen.add(name)
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${name}`)
      options[valued.get(name)] = value
    } else {
      throw new UsageError(`Unknown argument: ${name}`)
    }
  }
  if (!options.seedFile) throw new UsageError('Required argument missing: --seed-file <path>')
  if (!options.ibanFile) throw new UsageError('Required argument missing: --iban-file <path>')
  if (!['USDT', 'ETH', 'all'].includes(options.asset)) throw new UsageError('--asset must be USDT, ETH or all')
  if (options.send !== options.confirm) throw new UsageError('--send and --confirm are both required to send')
  let protocol
  try {
    protocol = new URL(options.rpc).protocol
  } catch {
    throw new UsageError('--rpc must use HTTP or HTTPS')
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new UsageError('--rpc must use HTTP or HTTPS')
  return options
}

async function readPrivateFile (path, label) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const text = (await file.readFile('utf8')).trim()
    if (!text) throw new Error()
    return text
  } catch {
    throw new NotRunError(`${label} must be a non-empty regular file owned by the current user with owner-only permissions (for example 0600), and must not be a symlink.`)
  } finally {
    if (file) await file.close().catch(() => {})
  }
}

function assertSingleWalletCopy () {
  const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
  const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
  if (dfxWalletPath !== wdkWalletPath) {
    throw new NotRunError('not run: duplicate @tetherto/wdk-wallet copies; reinstall e2e with install-links=true')
  }
}

function packageVersion (name) {
  let dir = dirname(require.resolve(name))
  let parent = ''
  while (dir !== parent) {
    const candidate = resolve(dir, 'package.json')
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (parsed && parsed.name === name) {
      if (typeof parsed.version !== 'string' || parsed.version === '') throw new Error(`No version in ${name}`)
      return parsed.version
    }
    parent = dir
    dir = dirname(dir)
  }
  throw new Error(`No version in ${name}`)
}

function git (args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function invocation () {
  const parts = [process.argv[0], process.argv[1]]
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i]
    if (name === '--seed-file' || name === '--iban-file') {
      i += 1
      continue
    }
    if (name === '--rpc') {
      parts.push(name, new URL(process.argv[i + 1]).origin)
      i += 1
      continue
    }
    parts.push(name)
  }
  return parts.join(' ')
}

function publicUrl (sellUrl) {
  const url = new URL(sellUrl)
  return { origin: url.origin, path: url.pathname, params: [...url.searchParams.keys()] }
}

function quantity (value, source) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new NotRunError(`not run: ${source} was not a quantity`)
  }
  try {
    return BigInt(value)
  } catch {
    throw new NotRunError(`not run: ${source} was not a quantity`)
  }
}

async function readVersion (preflight) {
  let response
  try {
    response = await fetch(`${API}/version`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    const message = `https://dev.api.dfx.swiss/version unreachable (${error.message})`
    if (preflight) throw new NotRunError(`not run: ${message}`)
    throw new Error(message)
  }
  if (!response.ok) {
    const message = `https://dev.api.dfx.swiss/version returned HTTP ${response.status}`
    if (preflight) throw new NotRunError(`not run: ${message}`)
    throw new Error(message)
  }
  let body
  try {
    body = await response.json()
  } catch {
    const message = 'https://dev.api.dfx.swiss/version returned no JSON'
    if (preflight) throw new NotRunError(`not run: ${message}`)
    throw new Error(message)
  }
  if (!body || typeof body.commit !== 'string' || body.commit === '') {
    const message = 'https://dev.api.dfx.swiss/version has no commit'
    if (preflight) throw new NotRunError(`not run: ${message}`)
    throw new Error(message)
  }
  return { commit: body.commit, startedAt: body.startedAt == null ? '' : String(body.startedAt) }
}

function takeLock (dir) {
  try {
    mkdirSync(dir)
  } catch (error) {
    if (error.code === 'EEXIST') throw new NotRunError('not run: wallet locked')
    throw new NotRunError(`not run: cannot create lock (${error.code || 'failed'})`)
  }
  state.lockHeld = true
  state.lockDir = dir
}

async function openOut (path) {
  let file
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    throw new UsageError(`--out cannot be opened (${error.code || 'failed'})`)
  }
  const stat = await file.stat()
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    await file.close()
    throw new UsageError('--out must be a regular file owned by the current user with owner-only permissions')
  }
  await file.chmod(0o600)
  state.out = file
}

function quoteFields (quote) {
  return {
    cryptoAmount: quote?.cryptoAmount == null ? null : String(quote.cryptoAmount),
    fiatAmount: quote?.fiatAmount == null ? null : String(quote.fiatAmount),
    fee: quote?.fee == null ? null : String(quote.fee),
    rate: quote?.rate == null ? null : String(quote.rate)
  }
}

function assertSellUrl (sellUrl, ext) {
  rememberSecret(sellUrl)
  let url
  try {
    url = new URL(sellUrl)
  } catch {
    throw new Error('sellUrl is not a URL')
  }
  if (url.origin !== APP) throw new Error(`sellUrl origin is ${url.origin}`)
  if (url.pathname !== '/sell') throw new Error(`sellUrl path is ${url.pathname}`)
  if (url.searchParams.get('external-transaction-id') !== ext) {
    throw new Error('sellUrl external-transaction-id does not match')
  }
  const session = url.searchParams.get('session')
  if (!session) throw new Error('sellUrl has no session')
  rememberSecret(session)
  rememberSecret(encodeURIComponent(session))
  return session
}

async function clickExactText (page, expected, timeoutMs, absentMessage) {
  const deadline = Date.now() + timeoutMs
  let lastCount = 0
  while (Date.now() <= deadline) {
    const outcome = await page.evaluate(wanted => {
      const compactText = el => (el.innerText || '').replace(/[\s\u00a0]/g, '')
      const shown = el => {
        const style = globalThis.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const matches = []
      for (const el of globalThis.document.querySelectorAll('body *')) {
        if (compactText(el) !== wanted) continue
        if ([...el.children].some(child => compactText(child) === wanted)) continue
        if (!shown(el)) continue
        matches.push(el)
      }
      if (matches.length !== 1) return { count: matches.length }
      matches[0].click()
      return { count: 1 }
    }, expected)
    lastCount = outcome.count
    if (outcome.count === 1) return
    await delay(250)
  }
  if (lastCount === 0) throw new Error(absentMessage)
  throw new Error(`${absentMessage} (${lastCount} matches)`)
}

function paymentCandidate (capture, ext, iban, spec) {
  if (capture.status !== 200 || !capture.body || capture.body.isValid !== true) return false
  const request = capture.request
  if (!request || request.externalTransactionId !== ext) return false
  if (compact(request.iban) !== compact(iban)) return false
  if (!amountIsSale(request.amount, spec.amount, spec.decimals)) return false
  if (!amountIsSale(capture.body.amount, spec.amount, spec.decimals)) return false
  return true
}

function paymentFacts (capture) {
  const body = capture.body
  if (typeof body.id !== 'number' || !Number.isFinite(body.id)) throw new Error('paymentInfos response has no id')
  if (typeof body.depositAddress !== 'string' || !isAddress(body.depositAddress)) {
    throw new Error('paymentInfos depositAddress is not an address')
  }
  return {
    id: body.id,
    depositAddress: getAddress(body.depositAddress),
    currency: currencyCode(body.currency)
  }
}

async function openSell (browser, sellUrl, iban, ext, spec) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  page.setDefaultTimeout(45_000)
  const captures = []
  const pending = new Set()
  let contextClosed = false
  page.on('response', response => {
    let url
    try {
      url = new URL(response.url())
    } catch {
      return
    }
    if (url.origin !== API || url.pathname !== '/v1/sell/paymentInfos' || response.request().method() !== 'PUT') return
    const task = (async () => {
      const bodyText = await response.text()
      let body = null
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = null
      }
      let request = null
      try {
        request = response.request().postDataJSON()
      } catch {
        request = null
      }
      captures.push({ status: response.status(), request, body })
    })().catch(error => captures.push({ captureError: error.message }))
    pending.add(task)
    task.finally(() => pending.delete(task))
  })
  try {
    await page.goto(sellUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await clickExactText(page, compact('Add or select your IBAN'), 60_000, 'Add or select your IBAN is not shown')
    await clickExactText(page, compact(iban), 30_000, 'No IBAN option matches the IBAN file')
    // The widget PUTs paymentInfos more than once and may switch fiat, so the visible address has to stay still.
    const deadline = Date.now() + PAYMENT_TIMEOUT_MS
    let stableKey = null
    let stableSince = 0
    let facts = null
    let acceptedKey = null
    let rejected = null
    while (Date.now() <= deadline) {
      await Promise.allSettled([...pending])
      const matches = captures.filter(capture => paymentCandidate(capture, ext, iban, spec))
      const latest = matches[matches.length - 1]
      if (latest) {
        let next = null
        try {
          next = paymentFacts(latest)
        } catch (error) {
          rejected = error
          stableKey = null
          stableSince = 0
        }
        if (next) {
          rejected = null
          const heading = await page.getByRole('heading', { name: 'Payment Information', exact: true }).isVisible().catch(() => false)
          const text = await page.locator('body').innerText().catch(() => '')
          const visible = text.toLowerCase().includes(next.depositAddress.toLowerCase())
          const key = `${matches.length}:${next.id}:${next.depositAddress}:${next.currency}`
          if (heading && visible && key === stableKey && Date.now() - stableSince >= PAYMENT_QUIET_MS) {
            facts = next
            acceptedKey = key
            break
          }
          if (heading && visible && key !== stableKey) {
            stableKey = key
            stableSince = Date.now()
          }
          if (!heading || !visible) {
            stableKey = null
            stableSince = 0
          }
        }
      }
      await delay(250)
    }
    if (!facts) throw rejected || new Error('No valid paymentInfos response with the deposit address visible')
    const text = await page.locator('body').innerText().catch(() => '')
    await context.close()
    contextClosed = true
    await Promise.allSettled([...pending])
    if (captures.some(capture => capture.captureError != null)) {
      throw new Error('a paymentInfos response could not be read')
    }
    const matches = captures.filter(capture => paymentCandidate(capture, ext, iban, spec))
    const latest = matches[matches.length - 1]
    let confirmedKey = null
    if (latest) {
      try {
        const confirmed = paymentFacts(latest)
        confirmedKey = `${matches.length}:${confirmed.id}:${confirmed.depositAddress}:${confirmed.currency}`
      } catch {
        confirmedKey = null
      }
    }
    const visible = text.toLowerCase().includes(facts.depositAddress.toLowerCase())
    if (confirmedKey !== acceptedKey || !visible) {
      throw new Error('paymentInfos changed after the address was taken')
    }
    return facts
  } finally {
    await Promise.allSettled([...pending])
    if (!contextClosed) await context.close()
  }
}

async function waitForReceipt (provider, hash) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  while (Date.now() <= deadline) {
    const receipt = await provider.getTransactionReceipt(hash)
    if (receipt) return receipt
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(2_000, remaining))
  }
  throw new Error(`Receipt for ${hash} was not available within 4 minutes`)
}

function addressOf (topic) {
  if (typeof topic !== 'string' || topic.length < 40) throw new Error('Transfer topic is not an address')
  return getAddress(`0x${topic.slice(-40)}`)
}

function assertTransfer (receipt, account, depositAddress, amount) {
  const logs = receipt.logs.filter(log => {
    return getAddress(log.address) === USDT && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase()
  })
  if (logs.length !== 1) throw new Error(`Expected exactly one USDT Transfer log, found ${logs.length}`)
  const from = addressOf(logs[0].topics[1])
  const to = addressOf(logs[0].topics[2])
  const value = BigInt(logs[0].data)
  if (from !== account) throw new Error('USDT Transfer from is not the account')
  if (to !== depositAddress) throw new Error('USDT Transfer to is not the deposit address')
  if (value !== amount) throw new Error(`USDT Transfer value is ${value}; expected ${amount}`)
}

async function assertChain (provider, hash, receipt, spec, account, depositAddress) {
  if (receipt.status !== 1) throw new Error(`Receipt status is ${receipt.status}; expected 1`)
  if (getAddress(receipt.from) !== account) throw new Error('Receipt from is not the account')
  const tx = await provider.getTransaction(hash)
  if (!tx) throw new Error(`Transaction ${hash} was not returned by the RPC`)
  if (getAddress(tx.from) !== account) throw new Error('Transaction from is not the account')
  if (spec.asset === 'USDT') {
    if (!tx.to || getAddress(tx.to) !== USDT) throw new Error('USDT transaction to is not the token contract')
    if (!receipt.to || getAddress(receipt.to) !== USDT) throw new Error('USDT receipt to is not the token contract')
    assertTransfer(receipt, account, depositAddress, spec.amount)
  } else {
    if (!tx.to || getAddress(tx.to) !== depositAddress) throw new Error('ETH transaction to is not the deposit address')
    if (tx.value !== spec.amount) throw new Error(`ETH value is ${tx.value}; expected ${spec.amount}`)
  }
  if (typeof receipt.gasUsed !== 'bigint' || typeof receipt.gasPrice !== 'bigint') {
    throw new Error('Receipt has no gasUsed or gasPrice')
  }
  return { gasCost: receipt.gasUsed * receipt.gasPrice, value: tx.value }
}

async function readBalances (provider, usdt, account, blockTag) {
  const [usdtBalance, ethBalance, nonce] = await Promise.all([
    usdt.balanceOf(account, { blockTag }),
    provider.getBalance(account, blockTag),
    provider.getTransactionCount(account, blockTag)
  ])
  return { usdtBalance, ethBalance, nonce: BigInt(nonce) }
}

function assertAfter (spec, before, after, gasCost) {
  if (after.nonce !== before.nonce + 1n) {
    throw new Error(`Nonce is ${after.nonce}; expected ${before.nonce + 1n}`)
  }
  if (spec.asset === 'USDT') {
    const expected = before.usdtBalance - spec.amount
    if (after.usdtBalance !== expected) {
      throw new Error(`USDT balance is ${after.usdtBalance}; expected ${expected}`)
    }
  } else {
    const expected = before.ethBalance - spec.amount - gasCost
    if (after.ethBalance !== expected) {
      throw new Error(`ETH balance is ${after.ethBalance}; expected ${expected}`)
    }
  }
}

async function findTransaction (session, hash) {
  const deadline = Date.now() + BACKEND_TIMEOUT_MS
  let lastError = null
  while (true) {
    try {
      const response = await fetch(`${API}/v1/transaction`, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${session}` }
      })
      if (!response.ok) throw new Error(`GET /v1/transaction HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body)) throw new Error('GET /v1/transaction did not return a list')
      const found = body.find(entry => String(entry?.inputTxId ?? '').toLowerCase() === hash.toLowerCase())
      if (found) return found
      lastError = null
    } catch (error) {
      lastError = error
    }
    if (Date.now() + BACKEND_POLL_MS > deadline) break
    await delay(BACKEND_POLL_MS)
  }
  if (lastError) throw new Error(`GET /v1/transaction failed: ${lastError.message}`)
  throw new Error('No transaction with this inputTxId within 10 minutes')
}

function assertBackend (entry, spec, ext) {
  if (entry.type !== 'Sell') throw new Error(`Backend type is ${entry.type}; expected Sell`)
  if (entry.inputAsset !== spec.asset) throw new Error(`Backend inputAsset is ${entry.inputAsset}; expected ${spec.asset}`)
  if (Number(entry.inputAmount) !== units(spec.amount, spec.decimals)) {
    throw new Error(`Backend inputAmount is ${entry.inputAmount}; expected ${units(spec.amount, spec.decimals)}`)
  }
  if (entry.externalTransactionId !== ext) throw new Error('Backend externalTransactionId does not match')
  if (typeof entry.uid !== 'string' || entry.uid === '') throw new Error('Backend uid is missing')
  if (typeof entry.state !== 'string') throw new Error('Backend state is not a string')
  return {
    id: entry.id,
    uid: entry.uid,
    type: entry.type,
    state: entry.state,
    inputTxId: entry.inputTxId,
    inputAmount: entry.inputAmount,
    inputAsset: entry.inputAsset,
    externalTransactionId: entry.externalTransactionId
  }
}

function assertDetail (detail, spec, currency, label) {
  if (detail?.status !== 'in_progress' && detail?.status !== 'completed') {
    throw new Error(`Module ${label} status is ${detail?.status}`)
  }
  if (detail.cryptoAsset !== spec.asset) throw new Error(`Module ${label} cryptoAsset is ${detail.cryptoAsset}`)
  if (detail.fiatCurrency !== currency) throw new Error(`Module ${label} fiatCurrency is ${detail.fiatCurrency}`)
  return { cryptoAsset: detail.cryptoAsset, fiatCurrency: detail.fiatCurrency, status: detail.status }
}

function strip0x (sha) {
  return sha.startsWith('0x') || sha.startsWith('0X') ? sha.slice(2) : sha
}

function writeProtocol (record) {
  const gitPath = git(['rev-parse', '--git-path', 'echter-lauf.json'])
  const target = isAbsolute(gitPath) ? gitPath : resolve(repoRoot, gitPath)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
  return target
}

async function sendOnce (account, spec, depositAddress) {
  const sent = spec.asset === 'USDT'
    ? await account.transfer({ token: USDT, recipient: depositAddress, amount: spec.amount })
    : await account.sendTransaction({ to: depositAddress, value: spec.amount })
  if (typeof sent?.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sent.hash)) {
    throw new Error('WDK did not return a transaction hash')
  }
  return sent.hash
}

async function runCase (spec, tools, evidence) {
  const ext = `wdk-real-sell-${tools.runId}-${spec.asset}`
  let step = 'quoteSell'
  try {
    state.flow = true
    const quote = await tools.fiat.quoteSell({
      cryptoAsset: spec.asset,
      fiatCurrency: 'EUR',
      cryptoAmount: spec.amount
    })
    emit({ step, asset: spec.asset, ok: true, ...quoteFields(quote) })

    step = 'sellUrl'
    const sold = await tools.fiat.sell({
      cryptoAsset: spec.asset,
      fiatCurrency: 'EUR',
      cryptoAmount: spec.amount,
      config: { externalTransactionId: ext }
    })
    const session = assertSellUrl(sold?.sellUrl, ext)
    emit({ step, asset: spec.asset, ok: true, externalTransactionId: ext, ...publicUrl(sold.sellUrl) })

    step = 'paymentInfos'
    const payment = await openSell(tools.browser, sold.sellUrl, tools.iban, ext, spec)
    emit({
      step,
      asset: spec.asset,
      ok: true,
      id: payment.id,
      depositAddress: payment.depositAddress,
      currency: payment.currency
    })
    if (!tools.send) return

    step = 'balances-before'
    const before = await readBalances(tools.provider, tools.usdt, tools.accountAddress, 'latest')
    emit({
      step,
      asset: spec.asset,
      ok: true,
      usdt: before.usdtBalance.toString(),
      eth: before.ethBalance.toString(),
      nonce: before.nonce.toString()
    })

    step = 'send'
    const hash = await sendOnce(tools.account, spec, payment.depositAddress)
    emit({ step, asset: spec.asset, ok: true, hash })

    step = 'receipt'
    const receipt = await waitForReceipt(tools.provider, hash)
    const spent = await assertChain(tools.provider, hash, receipt, spec, tools.accountAddress, payment.depositAddress)
    emit({
      step,
      asset: spec.asset,
      ok: true,
      hash,
      status: receipt.status,
      block: String(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice.toString()
    })

    step = 'balances-after'
    const after = await readBalances(tools.provider, tools.usdt, tools.accountAddress, receipt.blockNumber)
    assertAfter(spec, before, after, spent.gasCost)
    emit({
      step,
      asset: spec.asset,
      ok: true,
      usdt: after.usdtBalance.toString(),
      eth: after.ethBalance.toString(),
      nonce: after.nonce.toString()
    })

    step = 'backend'
    const found = await findTransaction(session, hash)
    const trimmed = assertBackend(found, spec, ext)
    emit({ step, asset: spec.asset, ok: true, transaction: trimmed })
    evidence.backend.push(trimmed)
    evidence.txs.push({ hash, rolle: 'einzahlung', from: tools.accountAddress })

    step = 'module'
    const byExternal = await tools.fiat.getTransactionDetail(ext, { idType: 'externalTransactionId' })
    const externalDetail = assertDetail(byExternal, spec, payment.currency, 'externalTransactionId')
    const byUid = await tools.fiat.getTransactionDetail(trimmed.uid)
    const uidDetail = assertDetail(byUid, spec, payment.currency, 'uid')
    emit({ step, asset: spec.asset, ok: true, externalTransactionId: externalDetail, uid: uidDetail })
  } catch (error) {
    emit({ step, asset: spec.asset, ok: false, error: redact(error?.message ?? error) })
    throw error
  }
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  rememberSecret(options.rpc)
  if (options.lock) takeLock(options.lock)
  if (options.out) await openOut(options.out)
  assertSingleWalletCopy()
  const walletVersion = packageVersion('@tetherto/wdk-wallet-evm')
  const seed = await readPrivateFile(options.seedFile, 'Seed file')
  const iban = await readPrivateFile(options.ibanFile, 'IBAN file')
  rememberSecret(seed)
  rememberSecret(seed.trim().split(/\s+/).join(' '))
  rememberIban(iban)

  state.provider = new JsonRpcProvider(options.rpc, 11155111, { staticNetwork: true, cacheTimeout: -1 })
  let chainId
  try {
    chainId = quantity(await state.provider.send('eth_chainId', []), 'eth_chainId')
  } catch (error) {
    if (error instanceof NotRunError) throw error
    throw new NotRunError(`not run: RPC unreachable (${error.message})`)
  }
  if (chainId !== CHAIN_ID) throw new NotRunError(`not run: chain id is ${chainId}; expected 11155111`)
  emit({ step: 'chain', asset: null, ok: true, chainId: 11155111 })

  const started = await readVersion(true)
  const runIso = new Date().toISOString()
  emit({ step: 'version', asset: null, ok: true, commit: started.commit, startedAt: started.startedAt })

  const wdk = new WDK(seed)
    .registerWallet('sepolia', WalletManagerEvm, { provider: options.rpc })
    .registerProtocol('sepolia', 'dfx', DfxProtocol, { environment: 'sandbox', network: 'sepolia' })
  const account = await wdk.getAccount('sepolia', 0)
  const accountAddress = getAddress(await account.getAddress())
  const fiat = account.getFiatProtocol('dfx')
  if (!(fiat instanceof DfxProtocol)) throw new NotRunError('not run: getFiatProtocol(\'dfx\') did not return the DFX module')
  const usdt = new Contract(USDT, ERC20_ABI, state.provider)
  const cases = CASES.filter(spec => options.asset === 'all' || spec.asset === options.asset)
  if (options.send) {
    const usdtNeed = cases.reduce((sum, spec) => spec.asset === 'USDT' ? sum + spec.amount : sum, 0n)
    const ethNeed = cases.reduce((sum, spec) => spec.asset === 'ETH' ? sum + spec.amount : sum, ETH_RESERVE)
    const usdtBalance = await usdt.balanceOf(accountAddress)
    const ethBalance = await state.provider.getBalance(accountAddress)
    if (usdtBalance < usdtNeed || ethBalance < ethNeed) {
      throw new NotRunError(`not run: balance too small (USDT ${usdtBalance} need ${usdtNeed}, ETH ${ethBalance} need ${ethNeed})`)
    }
    emit({
      step: 'balance',
      asset: null,
      ok: true,
      usdt: usdtBalance.toString(),
      eth: ethBalance.toString(),
      usdtNeed: usdtNeed.toString(),
      ethNeed: ethNeed.toString()
    })
  }

  state.browser = await chromium.launch({ headless: true })
  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`
  emit({ step: 'ready', asset: null, ok: true, runId, address: accountAddress, send: options.send })
  const evidence = { txs: [], backend: [] }
  const tools = { runId, fiat, account, accountAddress, iban, provider: state.provider, usdt, browser: state.browser, send: options.send }
  for (const spec of cases) await runCase(spec, tools, evidence)

  const finished = await readVersion(false)
  if (finished.commit !== started.commit) {
    throw new Error(`Backend commit changed during the run (${started.commit} -> ${finished.commit})`)
  }
  if (!options.send) {
    emit({ step: 'send', asset: null, ok: true, result: 'dry run: nothing sent' })
    return
  }
  const head = git(['rev-parse', 'HEAD'])
  const protocol = {
    version: 1,
    art: 'echt',
    head,
    frontend_sha: strip0x(head),
    backend_sha: strip0x(finished.commit),
    befehl: invocation(),
    chain_id: 11155111,
    lokal: false,
    vertraege: { USDT: '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0' },
    wallet: { name: '@tetherto/wdk-wallet-evm', version: walletVersion },
    flags: `dev.api.dfx.swiss /version commit ${finished.commit} startedAt ${finished.startedAt} run ${runIso}`,
    erkennung: 'selbst',
    gemockt: [],
    dirty: git(['status', '--porcelain']) !== '',
    txs: evidence.txs,
    backend_beleg: { endpoint: 'GET /v1/transaction', antwort: evidence.backend }
  }
  const written = writeProtocol(protocol)
  emit({ step: 'protocol', asset: null, ok: true, path: written, head, backend: finished.commit })
}

try {
  await main()
} catch (error) {
  let failure = error
  if (!state.flow && !(error instanceof UsageError) && !(error instanceof NotRunError)) {
    failure = new NotRunError(`not run: ${error?.message ?? error}`)
  }
  const message = redact(failure?.message ?? failure)
  console.error(`real-sell failed: ${message}`)
  if (failure instanceof UsageError) process.exitCode = 2
  else if (failure instanceof NotRunError) process.exitCode = 3
  else process.exitCode = 1
} finally {
  if (state.browser) await state.browser.close().catch(() => {})
  state.provider?.destroy()
  if (state.out) await state.out.close().catch(() => {})
  if (state.lockHeld) {
    try {
      rmdirSync(state.lockDir)
      state.lockHeld = false
    } catch (error) {
      console.error(`real-sell failed: ${redact(error.message)}`)
      if (!process.exitCode) process.exitCode = 1
    }
  }
}

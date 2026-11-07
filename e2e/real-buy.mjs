// Production purchase handoff and payout verification. The bank transfer is manual.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import { Contract, JsonRpcProvider, getAddress, id, parseUnits, zeroPadValue } from 'ethers'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const API = 'https://api.dfx.swiss'
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const TRANSFER = id('Transfer(address,address,uint256)')
const secrets = []
const state = { flow: false, out: null, provider: null, wdk: null, retries: 0 }
class UsageError extends Error {}
class NotRunError extends Error {}

function redact (value) {
  let text = String(value ?? 'Unknown error')
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  return text.replace(/https?:\/\/[^\s<>"']+/gi, '[URL REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[TOKEN REDACTED]')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:session|token|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[REDACTED]')
}

function emit (record) {
  const line = redact(JSON.stringify({ time: new Date().toISOString(), ...record }, (_, value) => typeof value === 'bigint' ? value.toString() : value)) + '\n'
  process.stdout.write(line)
  if (state.out) {
    const data = Buffer.from(line)
    let offset = 0
    while (offset < data.length) {
      const count = writeSync(state.out.fd, data, offset, data.length - offset)
      if (count <= 0) throw new Error('--out write failed')
      offset += count
    }
  }
}

function parseArgs (args) {
  const options = { account: 'smart', index: '0', asset: 'USDC', amount: '15', rpc: 'https://mainnet.base.org', explorer: 'https://base.blockscout.com', wait: '240', confirm: false }
  const fields = new Map([['--seed-file', 'seedFile'], ['--account', 'account'], ['--index', 'index'], ['--asset', 'asset'], ['--amount', 'amount'], ['--rpc', 'rpc'], ['--url-file', 'urlFile'], ['--out', 'out'], ['--wait-minutes', 'wait'], ['--screenshots', 'screenshots'], ['--explorer', 'explorer']])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (seen.has(flag)) throw new UsageError('Duplicate argument')
    seen.add(flag)
    if (flag === '--confirm') options.confirm = true
    else if (fields.has(flag)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`)
      options[fields.get(flag)] = value
    } else throw new UsageError('Unknown argument')
  }
  if (!options.seedFile) throw new UsageError('--seed-file is required')
  if (options.confirm && !options.screenshots) throw new UsageError('--confirm requires --screenshots')
  if (options.confirm && !options.urlFile) throw new UsageError('--url-file is required with --confirm')
  if (!['smart', 'eoa'].includes(options.account)) throw new UsageError('--account must be smart or eoa')
  if (options.asset !== 'USDC') throw new UsageError('Only USDC on Base is supported')
  if (!/^\d+$/.test(options.index) || !Number.isSafeInteger(Number(options.index)) || Number(options.index) >= 2 ** 31) throw new UsageError('Invalid --index')
  try { if (!/^\d+(?:\.\d{1,2})?$/.test(options.amount) || parseUnits(options.amount, 2) <= 0n) throw new Error() } catch { throw new UsageError('Invalid EUR --amount') }
  if (!/^\d+$/.test(options.wait) || !Number.isSafeInteger(Number(options.wait)) || Number(options.wait) < 1 || Number(options.wait) > 10080) throw new UsageError('Invalid --wait-minutes')
  try { if (!['http:', 'https:'].includes(new URL(options.rpc).protocol)) throw new Error() } catch { throw new UsageError('--rpc must use HTTP or HTTPS') }
  try {
    const explorer = new URL(options.explorer)
    if (!['http:', 'https:'].includes(explorer.protocol) || explorer.origin !== options.explorer || explorer.username || explorer.password) throw new Error()
  } catch { throw new UsageError('--explorer must be an HTTP or HTTPS origin') }
  return options
}

function prepareScreenshots (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new UsageError('--screenshots must be a non-symlink directory owned by the current user with mode 0700')
  }
}

function invocation () {
  const parts = [process.argv[0], process.argv[1]]
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i]
    if (name === '--seed-file' || name === '--url-file') { i++; continue }
    if (name === '--rpc') { parts.push(name, new URL(process.argv[++i]).origin); continue }
    parts.push(name)
  }
  return parts.join(' ')
}

async function screenshotExplorer (options, runId, hash) {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
    const page = await context.newPage()
    const deadline = Date.now() + 90_000
    let reloads = 0
    while (Date.now() < deadline) {
      if (reloads > 0) emit({ step: 'explorer-reload', hash, attempt: reloads })
      try {
        await page.goto(`${options.explorer}/tx/${hash}`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) })
      } catch (error) {
        if (error.name === 'TimeoutError' && Date.now() >= deadline) break
        throw error
      }
      try {
        await page.waitForFunction(value => {
          const text = globalThis.document.body?.innerText || ''
          return text.toLowerCase().includes(value.toLowerCase()) && /\bSuccess\b/.test(text)
        }, hash, { timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) })
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error
        if (Date.now() >= deadline) break
        reloads++
        continue
      }
      const datei = resolve(options.screenshots, `${runId}-buy-${options.asset}-explorer.png`)
      await page.screenshot({ path: datei })
      const sha256 = createHash('sha256').update(readFileSync(datei)).digest('hex')
      emit({ step: 'screenshot', schritt: 'explorer', file: basename(datei), sha256, tx: hash })
      return { schritt: 'explorer', datei, sha256, tx: hash }
    }
    throw new Error(`Explorer ${options.explorer} did not show ${hash} and Success within 90 seconds`)
  } finally { await browser.close() }
}

async function privateSeed (path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const seed = (await file.readFile('utf8')).trim()
    if (!seed) throw new Error()
    return seed
  } catch {
    throw new NotRunError('Seed file must be a non-empty regular file owned by the current user with owner-only permissions and must not be a symlink')
  } finally { if (file) await file.close().catch(() => {}) }
}

async function createPrivate (path) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Not a private regular file')
    await file.chmod(0o600)
    return file
  } catch (error) { await file.close(); throw error }
}

function packageVersion (name) {
  let dir = dirname(require.resolve(name))
  while (dirname(dir) !== dir) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
      if (pkg.name === name && typeof pkg.version === 'string' && pkg.version) return pkg.version
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    dir = dirname(dir)
  }
  throw new Error(`Package version unavailable: ${name}`)
}

function git (args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function version () {
  const response = await fetch(`${API}/version`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Version endpoint HTTP ${response.status}`)
  const body = await response.json()
  if (typeof body?.commit !== 'string' || !body.commit) throw new Error('Version endpoint has no commit')
  return body.commit
}

// Public RPC nodes can lag behind a receipt block.
async function readAtBlock (blockNumber, read) {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('A fixed block number is required')
  const deadline = Date.now() + 60_000
  while (true) {
    try { return await read() } catch (error) {
      const pending = [error]
      const seen = new Set()
      let missing = false
      while (pending.length) {
        const item = pending.pop()
        if (!item || typeof item !== 'object' || seen.has(item)) continue
        seen.add(item)
        if (item.code === -32001 || (typeof item.message === 'string' && /(?:block|header) not found/i.test(item.message))) { missing = true; break }
        pending.push(item.error, item.info)
      }
      if (!missing || Date.now() + 2_000 >= deadline) throw error
      state.retries++
      emit({ step: 'retry', what: 'readAtBlock', error: redact(error?.message ?? error) })
      await delay(2_000)
    }
  }
}

async function backendDetail (session, externalId) {
  const query = new URLSearchParams({ 'external-id': externalId })
  const response = await fetch(`${API}/v1/transaction/detail/single?${query}`, {
    headers: { authorization: `Bearer ${session}` }, redirect: 'error', signal: AbortSignal.timeout(20_000)
  })
  if (response.status === 401 || response.status === 403) return { expired: true }
  if (response.status === 404) return { missing: true }
  if (!response.ok) throw new Error(`Backend detail HTTP ${response.status}`)
  const data = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid backend detail')
  return { data }
}

function assertDetail (detail) {
  if (detail?.status !== 'completed' || detail.cryptoAsset !== 'USDC' || detail.fiatCurrency !== 'EUR') throw new Error('Module detail does not match completed USDC/EUR')
}

function matchesRoundedAmount (amount, output) {
  const text = String(output)
  if (!/^\d+(?:\.\d+)?$/.test(text)) return false
  const decimals = (text.split('.')[1] || '').length
  if (decimals > 6) return false
  const factor = 10n ** BigInt(6 - decimals)
  const rounded = (amount + factor / 2n) / factor
  return rounded === parseUnits(text, decimals)
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  secrets.push(options.rpc)
  if (options.screenshots) prepareScreenshots(options.screenshots)
  if (options.out) {
    try { state.out = await createPrivate(options.out) } catch { throw new UsageError('--out must be a new private file') }
  }
  const seed = await privateSeed(options.seedFile)
  secrets.push(seed, seed.split(/\s+/).join(' '))
  const walletName = options.account === 'smart' ? '@tetherto/wdk-wallet-evm-erc-4337' : '@tetherto/wdk-wallet-evm'
  const walletVersion = packageVersion(walletName)
  const dfxWallet = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
  if (dfxWallet !== createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')) throw new NotRunError('Duplicate @tetherto/wdk-wallet copies')
  state.provider = new JsonRpcProvider(options.rpc, 8453, { staticNetwork: true, cacheTimeout: -1 })
  const chain = await state.provider.send('eth_chainId', [])
  if (chain !== '0x2105') throw new NotRunError('RPC chain id is not Base (0x2105)')
  const started = await version()
  const manager = options.account === 'smart' ? WalletManagerEvmErc4337 : WalletManagerEvm
  const config = options.account === 'smart' ? { chainId: 8453, provider: options.rpc, bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true } : { provider: options.rpc }
  state.wdk = new WDK(seed).registerWallet('base', manager, config).registerProtocol('base', 'dfx', DfxProtocol, { environment: 'production', network: 'base' })
  const account = await state.wdk.getAccount('base', Number(options.index))
  const address = getAddress(await account.getAddress())
  const fiat = account.getFiatProtocol('dfx')
  if (!(fiat instanceof DfxProtocol)) throw new NotRunError('DFX protocol unavailable')
  const fiatAmount = parseUnits(options.amount, 2)
  const quote = await fiat.quoteBuy({ cryptoAsset: options.asset, fiatCurrency: 'EUR', fiatAmount })
  emit({ step: 'quote', address, account: options.account, index: Number(options.index), cryptoAmount: quote.cryptoAmount, fiatAmount: quote.fiatAmount, fee: quote.fee, rate: quote.rate })
  if (!options.confirm) return
  const head = git(['rev-parse', 'HEAD'])
  if (git(['status', '--porcelain']) !== '') throw new NotRunError('the working tree is not clean, so the run would not belong to a commit')
  const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`
  const token = new Contract(USDC, ['function balanceOf(address) view returns (uint256)'], state.provider)
  const block = await state.provider.getBlockNumber()
  const [assetBefore, ethBefore] = await Promise.all([
    readAtBlock(block, () => token.balanceOf(address, { blockTag: block })),
    readAtBlock(block, () => state.provider.getBalance(address, block))
  ])
  emit({ step: 'before', block, assetBalance: assetBefore, ethBalance: ethBefore })
  let urlFile
  try { urlFile = await createPrivate(options.urlFile) } catch { throw new NotRunError('--url-file must not exist and must be creatable with owner-only permissions') }
  const externalId = `wdk-real-buy-${Date.now()}-${randomBytes(8).toString('hex')}`
  emit({ step: 'purchase', externalTransactionId: externalId })
  state.flow = true
  let session
  try {
    const result = await fiat.buy({ cryptoAsset: options.asset, fiatCurrency: 'EUR', fiatAmount, config: { externalTransactionId: externalId } })
    secrets.push(result.buyUrl)
    let url
    try { url = new URL(result.buyUrl) } catch { throw new Error('Invalid buy URL') }
    session = url.searchParams.get('session')
    if (session) secrets.push(session, encodeURIComponent(session))
    if (url.origin !== 'https://app.dfx.swiss' || url.pathname !== '/buy' || url.searchParams.get('external-transaction-id') !== externalId || !session) throw new Error('Buy URL failed validation')
    await urlFile.writeFile(result.buyUrl + '\n')
    await urlFile.sync()
  } finally { await urlFile.close() }
  emit({ step: 'handoff', path: '/buy', externalTransactionId: externalId, urlFile: options.urlFile, instruction: 'Open the URL from the file in a browser, complete the DFX steps and make the bank transfer manually.' })
  const deadline = Date.now() + Number(options.wait) * 60_000
  let lastModule = ''
  let lastBackend = ''
  let backend
  let expired = false
  while (Date.now() < deadline) {
    let detail
    try { detail = await fiat.getTransactionDetail(externalId, { idType: 'externalTransactionId' }) } catch (error) {
      if (error?.constructor?.name !== 'NoSuchElementError') throw error
    }
    const status = detail?.status ?? 'not found'
    if (!['not found', 'in_progress', 'completed', 'failed'].includes(status)) throw new Error('Unknown module status')
    if (status !== lastModule) { emit({ step: 'module-status', status }); lastModule = status }
    if (status === 'failed') throw new Error('Module reports failed')
    if (!expired) {
      const response = await backendDetail(session, externalId)
      expired = Boolean(response.expired)
      if (response.data) backend = response.data
      const next = expired ? 'session expired' : response.missing ? 'not found' : String(response.data?.state ?? 'unknown')
      if (next !== lastBackend) { emit({ step: 'backend-status', status: next }); lastBackend = next }
    }
    if (status === 'completed') { assertDetail(detail); break }
    await delay(Math.min(60_000, Math.max(0, deadline - Date.now())))
  }
  if (lastModule !== 'completed') throw new Error('Purchase timed out')
  if (expired) throw new Error('Original session expired before backend evidence could be verified')
  if (!backend || backend.type !== 'Buy' || backend.state !== 'Completed' || backend.outputAsset !== options.asset || backend.outputBlockchain !== 'Base' || backend.externalTransactionId !== externalId || typeof backend.uid !== 'string' || !backend.uid || typeof backend.outputTxId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(backend.outputTxId)) throw new Error('Backend purchase evidence does not match')
  const receipt = await state.provider.getTransactionReceipt(backend.outputTxId)
  if (!receipt || receipt.status !== 1 || receipt.hash.toLowerCase() !== backend.outputTxId.toLowerCase() || receipt.blockNumber <= block) throw new Error('Payout receipt missing, failed or predates baseline')
  const toTopic = zeroPadValue(address, 32).toLowerCase()
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === USDC.toLowerCase() && log.topics.length === 3 && log.topics[0].toLowerCase() === TRANSFER.toLowerCase() && log.topics[2].toLowerCase() === toTopic)
  if (logs.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(logs[0].data)) throw new Error('Expected exactly one token Transfer to the account')
  const amount = BigInt(logs[0].data)
  if (amount <= 0n || !matchesRoundedAmount(amount, backend.outputAmount)) throw new Error('Transfer amount does not match backend outputAmount')
  const [prior, after] = await Promise.all([
    readAtBlock(receipt.blockNumber - 1, () => token.balanceOf(address, { blockTag: receipt.blockNumber - 1 })),
    readAtBlock(receipt.blockNumber, () => token.balanceOf(address, { blockTag: receipt.blockNumber }))
  ])
  if (after - prior !== amount) throw new Error('Payout block balance change does not match Transfer')
  const screenshot = await screenshotExplorer(options, runId, backend.outputTxId)
  assertDetail(await fiat.getTransactionDetail(externalId, { idType: 'externalTransactionId' }))
  assertDetail(await fiat.getTransactionDetail(backend.uid))
  const finished = await version()
  if (started !== finished) throw new Error('Backend commit changed during the run')
  if (git(['rev-parse', 'HEAD']) !== head) throw new Error('HEAD changed during the run')
  if (state.retries > 0) throw new Error(`Run is not evidence: ${state.retries} read retries`)
  if (git(['status', '--porcelain']) !== '') throw new Error('Run is not evidence: the working tree changed during the run')
  const record = {
    version: 2,
    art: 'hybrid',
    head,
    frontend_sha: head.replace(/^0x/i, ''),
    backend_sha: started.replace(/^0x/i, ''),
    backend_sha_ende: finished.replace(/^0x/i, ''),
    befehl: invocation(),
    chain_id: 8453,
    lokal: false,
    vertraege: { USDC },
    wallet: { name: walletName, version: walletVersion, oberflaeche: false },
    flags: `api.dfx.swiss /version commit ${finished}, production`,
    erkennung: 'selbst',
    gemockt: ['wallet UI: WDK derives the receiving account in this script; the purchase is completed by hand in the DFX web app and by bank transfer'],
    dirty: false,
    wiederholungen: 0,
    schalter: [],
    txs: [{ hash: backend.outputTxId, rolle: 'kauf', from: receipt.from, saldo: { vorher: prior.toString(), nachher: after.toString() } }],
    screenshots: [screenshot],
    backend_beleg: { endpoint: 'GET /v1/transaction/detail/single', antwort: { uid: backend.uid, type: backend.type, state: backend.state, outputTxId: backend.outputTxId, outputAmount: backend.outputAmount, outputAsset: backend.outputAsset, externalTransactionId: backend.externalTransactionId } }
  }
  const gitPath = git(['rev-parse', '--git-path', 'echter-lauf-kauf.json'])
  const target = isAbsolute(gitPath) ? gitPath : resolve(root, gitPath)
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
  emit({ step: 'verified', hash: backend.outputTxId, block: receipt.blockNumber, priorBalance: prior, afterBalance: after, amount, protocol: target })
}

try { await main() } catch (error) {
  const code = error instanceof UsageError ? 2 : error instanceof NotRunError || !state.flow ? 3 : 1
  try { emit({ step: 'error', error: redact(error?.message ?? error), exitCode: code }) } catch { process.stdout.write(JSON.stringify({ step: 'error', error: 'Output failed', exitCode: code }) + '\n') }
  process.exitCode = code
} finally {
  try { state.wdk?.dispose() } catch { process.exitCode ||= 1 }
  state.provider?.destroy()
  if (state.out) await state.out.close().catch(() => { process.exitCode ||= 1 })
}

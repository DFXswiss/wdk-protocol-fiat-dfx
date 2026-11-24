// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

// Live matrix against the DFX sandbox by default. It sends no on-chain transaction.
// POST /v1/auth creates DFX users; production requires DFX_ENV=production.
// Buy and sell assets come from the raw GET /v1/asset catalog for each network.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import WalletManagerSolana from '@tetherto/wdk-wallet-solana'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import WalletManagerSpark from '@tetherto/wdk-wallet-spark'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const ENV = process.env.DFX_ENV === 'production' ? 'production' : 'sandbox'
const API = ENV === 'production' ? 'https://api.dfx.swiss' : 'https://dev.api.dfx.swiss'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function assertModuleCopy () {
  const mismatch = () => new Error('installed module differs from the working tree; run npm ci in e2e')
  const installed = resolve(repoRoot, 'e2e/node_modules/@dfx.swiss/wdk-protocol-fiat-dfx')
  try {
    const collect = base => {
      const files = []
      const visit = relative => {
        const path = resolve(base, relative)
        let current = resolve('/')
        for (const part of path.split('/').filter(Boolean)) {
          current = resolve(current, part)
          if (lstatSync(current).isSymbolicLink()) throw mismatch()
        }
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
          for (const name of readdirSync(path)) visit(`${relative}/${name}`)
        } else if (stat.isFile()) files.push(relative)
        else throw mismatch()
      }
      for (const name of ['package.json', 'index.js', 'bare.js']) {
        if (!lstatSync(resolve(base, name)).isFile()) throw mismatch()
        visit(name)
      }
      for (const name of ['src', 'types']) {
        if (!lstatSync(resolve(base, name)).isDirectory()) throw mismatch()
        visit(name)
      }
      return files.sort()
    }
    const source = collect(repoRoot)
    const copy = collect(installed)
    if (source.length !== copy.length || source.some((file, i) => file !== copy[i])) throw mismatch()
    const digest = path => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return createHash('sha256').update(readFileSync(fd)).digest('hex') } finally { closeSync(fd) }
    }
    for (const file of source) {
      if (digest(resolve(repoRoot, file)) !== digest(resolve(installed, file))) throw mismatch()
    }
  } catch {
    throw mismatch()
  }
}
const OUT = new URL('./out/', import.meta.url)
const masked = value => String(value).split(seed).join('[REDACTED]')
  .replace(/([?&]session=)[^&\s"<>]+/g, '$1[REDACTED]')
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED-JWT]')
const results = []
const log = (...a) => console.log(...a.map(masked))
const j = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? `${x}n` : x)
const err = e => masked(`${e?.constructor?.name} ${e?.reason ?? ''} ${e?.message}`).replace(/\s+/g, ' ').slice(0, 200)

async function step (chain, name, fn) {
  const t = Date.now()
  try {
    const value = await fn()
    results.push({ chain, name, ok: true, value: typeof value === 'string' ? masked(value) : value })
    log(`  OK   ${name} (${Date.now() - t} ms) ${typeof value === 'string' ? value : j(value)}`.slice(0, 400))
    return value
  } catch (e) {
    results.push({ chain, name, ok: false, error: masked(err(e)) })
    log(`  FAIL ${name} (${Date.now() - t} ms) ${err(e)}`)
    return undefined
  }
}

async function userCheck (token, address) {
  const res = await fetch(`${API}/v2/user`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.text()
  return { status: res.status, addressInProfile: body.toLowerCase().includes(address.toLowerCase()) }
}

const PREFERRED_ASSETS = ['USDT', 'USDC', 'EURC', 'ZCHF', 'ETH', 'POL', 'SOL', 'TRX', 'BTC', 'BNB']

function git (args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function apiVersion () {
  const response = await fetch(`${API}/version`)
  return (await response.text()).trim()
}

function preferred (rows) {
  if (!rows.length) return undefined
  const code = PREFERRED_ASSETS.find(name => rows.some(row => row.name === name))
  return code === undefined ? rows[0] : rows.find(row => row.name === code)
}

function cryptoUnits (asset, listedRows) {
  const listedRow = listedRows.find(row => row.code === asset.name)
  const source = listedRow ? listedRow.decimals : asset.decimals
  if (typeof source === 'number' && Number.isInteger(source) && source >= 0 && source <= 255) {
    return 50n * 10n ** BigInt(source)
  }
  throw new Error(`decimals for ${asset.blockchain}/${asset.name} are not an integer from 0 to 255`)
}

function skip (chain, name, reason) {
  results.push({ chain, name, skipped: true, reason })
  log(`  SKIP ${name}: ${reason}`)
}

async function sessionStep (chain, kind, url, address) {
  if (!url) return
  await step(chain, `${kind}Url session valid at /v2/user`, async () => {
    const u = new URL(url)
    const session = u.searchParams.get('session')
    if (!session) throw new Error(`${kind} URL has no session parameter`)
    const user = await userCheck(session, address)
    if (user.status !== 200) throw new Error(`${kind} session returned HTTP ${user.status} at /v2/user`)
    if (!user.addressInProfile) throw new Error(`${kind} session profile does not match the wallet address`)
    const params = Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'session'))
    return { ...user, origin: u.origin, path: u.pathname, params }
  })
}

async function expectUnsupported (chain, fiat, direction, code, fiatCurrency, amountAsset, listedRows) {
  const message = `Unsupported ${direction} asset or network: ${code}`
  const method = direction === 'sell' ? 'quoteSell' : 'quoteBuy'
  await step(chain, `${method} ${code} -> ValueError ${message}`, async () => {
    try {
      if (direction === 'sell') await fiat.quoteSell({ cryptoAsset: code, fiatCurrency, cryptoAmount: cryptoUnits(amountAsset, listedRows) })
      else await fiat.quoteBuy({ cryptoAsset: code, fiatCurrency, fiatAmount: 10000n })
    } catch (e) {
      if (e?.constructor?.name === 'ValueError' && e.message === message) return err(e)
      throw e
    }
    throw new Error('NOT REJECTED')
  })
}

const CASES = [
  { chain: 'ethereum', Manager: WalletManagerEvm, cfg: { provider: 'https://ethereum-rpc.publicnode.com' }, network: 'ethereum' },
  { chain: 'polygon', Manager: WalletManagerEvm, cfg: { provider: 'https://polygon-bor-rpc.publicnode.com' }, network: 'polygon' },
  { chain: 'arbitrum', Manager: WalletManagerEvm, cfg: { provider: 'https://arbitrum-one-rpc.publicnode.com' }, network: 'arbitrum' },
  { chain: 'base', Manager: WalletManagerEvm, cfg: { provider: 'https://base-rpc.publicnode.com' }, network: 'base' },
  { chain: 'optimism', Manager: WalletManagerEvm, cfg: { provider: 'https://optimism-rpc.publicnode.com' }, network: 'optimism' },
  { chain: 'bsc', Manager: WalletManagerEvm, cfg: { provider: 'https://bsc-rpc.publicnode.com' }, network: 'binancesmartchain' },
  { chain: 'sepolia', Manager: WalletManagerEvm, cfg: { provider: 'https://ethereum-sepolia-rpc.publicnode.com' }, network: 'sepolia' },
  {
    chain: 'polygon-4337',
    Manager: WalletManagerEvmErc4337,
    cfg: { chainId: 137, provider: 'https://polygon-bor-rpc.publicnode.com', bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true },
    network: 'polygon'
  },
  {
    chain: 'base-4337',
    Manager: WalletManagerEvmErc4337,
    cfg: { chainId: 8453, provider: 'https://base-rpc.publicnode.com', bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true },
    network: 'base'
  },
  { chain: 'tron', Manager: WalletManagerTron, cfg: { provider: 'https://api.trongrid.io' }, network: 'tron' },
  { chain: 'solana', Manager: WalletManagerSolana, cfg: { provider: 'https://api.mainnet-beta.solana.com' }, network: 'solana' },
  { chain: 'bitcoin', Manager: WalletManagerBtc, cfg: { network: 'bitcoin', bip: 84 }, network: 'bitcoin' },
  { chain: 'spark', Manager: WalletManagerSpark, cfg: { network: 'MAINNET' }, network: 'spark' }
]

const only = process.argv[2]
if (process.argv.length > 3 || (only !== undefined && !CASES.some(c => c.chain === only))) {
  console.error(`Usage: node live-matrix.mjs [${CASES.map(c => c.chain).join('|')}]`)
  process.exit(2)
}
assertModuleCopy()
const require = createRequire(import.meta.url)
const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
if (dfxWalletPath !== wdkWalletPath) {
  throw new Error(`Duplicate @tetherto/wdk-wallet copies: DFX resolves ${dfxWalletPath}; WDK resolves ${wdkWalletPath}. FiatProtocol class identity differs, so DFX registration would fail. Remove e2e/node_modules and reinstall from e2e/ with install-links=true (see .npmrc).`)
}
const seed = WDK.getRandomSeedPhrase()
mkdirSync(OUT, { recursive: true })
const startedAt = new Date().toISOString()
const head = git(['rev-parse', 'HEAD'])
const dirty = git(['status', '--porcelain']) !== ''
const apiVersionStart = await apiVersion()
log(`start env=${ENV} head=${head} dirty=${dirty} apiVersion=${apiVersionStart} at ${startedAt}`)

let rawCatalog = []
const catalogOk = await step('run', 'fetch raw catalog', async () => {
  const response = await fetch(`${API}/v1/asset`)
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} from /v1/asset`)
  const body = JSON.parse(text)
  if (!Array.isArray(body)) throw new Error('/v1/asset did not return an array')
  rawCatalog = body
  return `${body.length} rows`
})

for (const c of CASES.filter(c => !only || c.chain === only)) {
  log(`\n=== ${c.chain} (network ${c.network})`)
  let fiat, account, address
  const ok = await step(c.chain, 'register + getFiatProtocol', async () => {
    const wdk = new WDK(seed)
      .registerWallet(c.chain, c.Manager, c.cfg)
      .registerProtocol(c.chain, 'dfx', DfxProtocol, { environment: ENV, network: c.network })
    account = await wdk.getAccount(c.chain, 0)
    address = await account.getAddress()
    fiat = account.getFiatProtocol('dfx')
    if (!(fiat instanceof DfxProtocol)) throw new Error('DFX protocol unavailable')
    return `${fiat instanceof DfxProtocol} address=${address}`
  })
  if (!ok) continue

  const tx = await step(c.chain, 'getTransactionDetail(unknown uid) -> NoSuchElementError after auth', async () => {
    try {
      await fiat.getTransactionDetail('MATRIX-NONEXISTENT-UID')
      throw new Error('NOT REJECTED')
    } catch (e) {
      if (e?.constructor?.name === 'NoSuchElementError') return 'NoSuchElementError (auth succeeded, 404 mapped)'
      throw e
    }
  })
  if (tx === undefined) log('  (auth did not succeed, or an unknown uid returned a transaction)')

  let listed = []
  const listedStep = await step(c.chain, 'getSupportedCryptoAssets (this network)', async () => {
    listed = (await fiat.getSupportedCryptoAssets()).filter(a => a.networkCode === c.network)
    return listed.map(a => `${a.code}/${a.decimals}`)
  })
  const fiats = await step(c.chain, 'getSupportedFiatCurrencies', async () => (await fiat.getSupportedFiatCurrencies()).map(f => f.code).join(','))
  await step(c.chain, 'getSupportedCountries (bank allowed)', async () => (await fiat.getSupportedCountries()).filter(x => x.isBuyAllowed).length)
  if (!catalogOk) continue

  const networkRows = rawCatalog.filter(row => row && typeof row.blockchain === 'string' && row.blockchain.toLowerCase() === c.network)
  const buyable = networkRows.filter(row => row.buyable === true)
  const sellable = networkRows.filter(row => row.sellable === true)
  const tradable = networkRows.filter(row => row.buyable === true || row.sellable === true)
  if (listedStep === undefined) {
    await step(c.chain, 'catalog cross-check', async () => { throw new Error('module catalog request failed') })
  } else {
    const missing = tradable.filter(asset => !listed.some(a => a.code === asset.name))
    for (const asset of missing) {
      await step(c.chain, `catalog: ${asset.blockchain}/${asset.name} tradable in the API but missing in the module`, async () => {
        throw new Error('tradable in the API but missing in the module')
      })
    }
    if (missing.length === 0) {
      await step(c.chain, 'catalog cross-check', async () => `${tradable.length} tradable API assets present in the module`)
    }
  }

  const cur = fiats?.includes('EUR') ? 'EUR' : 'CHF'
  const buyAsset = preferred(buyable)
  const sellAsset = preferred(sellable)
  log(`  -- buy ${buyAsset ? buyAsset.name : 'none'} / sell ${sellAsset ? sellAsset.name : 'none'} / ${cur}`)

  if (!buyAsset) {
    skip(c.chain, 'buy', `no buyable asset on ${c.network} in the API catalog`)
  } else {
    const code = buyAsset.name
    await step(c.chain, `quoteBuy ${cur}->${code} fiatAmount 100`, () => fiat.quoteBuy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n }))
    const buy = await step(c.chain, `buy ${cur}->${code} fiatAmount 100`, async () => {
      const url = (await fiat.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n })).buyUrl
      if (!url) throw new Error('buy returned no widget URL')
      return url
    })
    await sessionStep(c.chain, 'buy', buy, address)
    // Contract checks as an integrator would hit them.
    await step(c.chain, 'buy with foreign recipient -> recipient mismatch ValueError', async () => {
      try {
        await fiat.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n, recipient: 'foreign-address' })
        throw new Error('NOT REJECTED')
      } catch (e) {
        if (e?.constructor?.name === 'ValueError' && e.message === 'recipient must match the account address') return err(e)
        throw e
      }
    })
    await step(c.chain, 'buy with read-only account -> AccountRequiredError', async () => {
      const ro = new DfxProtocol(await account.toReadOnlyAccount(), { environment: ENV, network: c.network })
      try {
        await ro.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n })
        throw new Error('NOT REJECTED')
      } catch (e) {
        if (e?.constructor?.name === 'AccountRequiredError') return err(e)
        throw e
      }
    })
    const ext = `matrix-${c.chain}-${Date.now()}`
    await step(c.chain, 'buy with externalTransactionId -> URL param', async () => {
      const u = new URL((await fiat.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n, config: { externalTransactionId: ext } })).buyUrl)
      if (u.searchParams.get('external-transaction-id') !== ext) throw new Error('external-transaction-id missing')
      return 'external-transaction-id present'
    })
    await step(c.chain, 'getTransactionDetail(externalId) before any payment -> NoSuchElementError', async () => {
      try {
        await fiat.getTransactionDetail(ext, { idType: 'externalTransactionId' })
        throw new Error('NOT REJECTED')
      } catch (e) {
        if (e?.constructor?.name === 'NoSuchElementError') return 'NoSuchElementError (no transaction registered yet)'
        throw e
      }
    })
    if (buyAsset.sellable !== true) await expectUnsupported(c.chain, fiat, 'sell', code, cur, buyAsset, listed)
  }

  if (!sellAsset) {
    skip(c.chain, 'sell', `no sellable asset on ${c.network} in the API catalog`)
  } else {
    const code = sellAsset.name
    await step(c.chain, `quoteSell ${code}->${cur} cryptoAmount 50`, () => fiat.quoteSell({ cryptoAsset: code, fiatCurrency: cur, cryptoAmount: cryptoUnits(sellAsset, listed) }))
    const sell = await step(c.chain, `sell ${code}->${cur} cryptoAmount 50`, async () => {
      const cryptoAmount = cryptoUnits(sellAsset, listed)
      const url = (await fiat.sell({ cryptoAsset: code, fiatCurrency: cur, cryptoAmount })).sellUrl
      if (!url) throw new Error('sell returned no widget URL')
      return url
    })
    await sessionStep(c.chain, 'sell', sell, address)
    if (sellAsset.buyable !== true) await expectUnsupported(c.chain, fiat, 'buy', code, cur)
  }
}

const apiVersionEnd = await apiVersion()
const finishedAt = new Date().toISOString()
if (apiVersionStart !== apiVersionEnd) {
  const error = masked(`${apiVersionStart} -> ${apiVersionEnd}`)
  results.push({ chain: 'run', name: 'api version changed during the run', ok: false, error })
  log(`  FAIL api version changed during the run ${error}`)
}
const meta = { env: ENV, head, dirty, apiVersionStart, apiVersionEnd, startedAt, finishedAt }
writeFileSync(new URL(`matrix-results-${ENV}.json`, OUT), masked(j([{ meta }, ...results])))
log(`META ${j(meta)}`)
const fails = results.filter(r => r.ok === false)
const skips = results.filter(r => r.skipped === true)
const passed = results.filter(r => r.ok === true).length
log(`\nSUMMARY: ${passed}/${passed + fails.length} steps ok, ${skips.length} skipped`)
for (const f of fails) log(`  FAIL [${f.chain}] ${f.name}: ${f.error}`)
for (const s of skips) log(`  SKIP [${s.chain}] ${s.name}: ${s.reason}`)
process.exit(fails.length === 0 ? 0 : 1)

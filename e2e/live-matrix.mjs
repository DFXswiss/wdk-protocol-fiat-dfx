// E2E integration probe via WDK core, against DFX sandbox by default.
// POST /v1/auth creates DFX users; production requires DFX_ENV=production.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import WalletManagerSolana from '@tetherto/wdk-wallet-solana'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import WalletManagerSpark from '@tetherto/wdk-wallet-spark'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const require = createRequire(import.meta.url)
const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
if (dfxWalletPath !== wdkWalletPath) {
  throw new Error(`Duplicate @tetherto/wdk-wallet copies: DFX resolves ${dfxWalletPath}; WDK resolves ${wdkWalletPath}. FiatProtocol class identity differs, so DFX registration would fail. Remove e2e/node_modules and reinstall from e2e/ with install-links=true (see .npmrc).`)
}

const ENV = process.env.DFX_ENV === 'production' ? 'production' : 'sandbox'
const API = ENV === 'production' ? 'https://api.dfx.swiss' : 'https://dev.api.dfx.swiss'
const seed = WDK.getRandomSeedPhrase()
const OUT = new URL('./out/', import.meta.url)
mkdirSync(OUT, { recursive: true })
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
const urls = {}
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
    return `${fiat instanceof DfxProtocol} address=${address}`
  })
  if (!ok) continue

  const assets = await step(c.chain, 'getSupportedCryptoAssets (this network)', async () =>
    (await fiat.getSupportedCryptoAssets()).filter(a => a.networkCode === c.network).map(a => `${a.code}/${a.decimals}`))
  const fiats = await step(c.chain, 'getSupportedFiatCurrencies', async () => (await fiat.getSupportedFiatCurrencies()).map(f => f.code).join(','))
  await step(c.chain, 'getSupportedCountries (bank allowed)', async () => (await fiat.getSupportedCountries()).filter(x => x.isBuyAllowed).length)

  // Pick an asset on this network; prefer stablecoins.
  if (assets === undefined) {
    await step(c.chain, 'select listed asset', async () => { throw new Error('Asset catalog request failed') })
    continue
  }
  const codes = (assets ?? []).map(s => s.split('/')[0])
  const cur = fiats?.includes('EUR') ? 'EUR' : 'CHF'
  if (!codes.length && c.chain === 'bitcoin') {
    for (const [method, input] of [
      ['quoteBuy', { cryptoAsset: 'BTC', fiatCurrency: cur, fiatAmount: 10000n }],
      ['buy', { cryptoAsset: 'BTC', fiatCurrency: cur, fiatAmount: 10000n }],
      ['quoteSell', { cryptoAsset: 'BTC', fiatCurrency: cur, cryptoAmount: 100000000n }],
      ['sell', { cryptoAsset: 'BTC', fiatCurrency: cur, cryptoAmount: 100000000n }]
    ]) {
      await step(c.chain, `${method} -> missing decimals ValueError`, async () => {
        try { await fiat[method](input) } catch (e) {
          if (e?.constructor?.name === 'ValueError' && e.message === 'Missing decimals for Bitcoin/BTC') return err(e)
          throw e
        }
        throw new Error('Bitcoin without API decimals was not rejected')
      })
    }
    continue
  }
  const code = ['USDT', 'USDC', 'EURC', 'ZCHF', 'ETH', 'POL', 'SOL', 'TRX', 'BTC', 'BNB'].find(x => codes.includes(x)) ?? codes[0]
  const selectedAsset = (assets ?? []).find(s => s.startsWith(code + '/'))
  if (!selectedAsset) {
    await step(c.chain, 'select listed asset', async () => { throw new Error('No listed asset with decimals') })
    continue
  }
  const dec = Number(selectedAsset.split('/')[1])
  const cryptoAmount = 50n * 10n ** BigInt(dec) // 50 units
  log(`  -- pair ${code}/${cur}, crypto decimals ${dec}`)

  await step(c.chain, `quoteBuy ${cur}->${code} fiatAmount 100`, () => fiat.quoteBuy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n }))
  await step(c.chain, `quoteSell ${code}->${cur} cryptoAmount 50`, () => fiat.quoteSell({ cryptoAsset: code, fiatCurrency: cur, cryptoAmount }))

  const tx = await step(c.chain, 'getTransactionDetail(unknown uid) -> expects NoSuchElementError after auth', async () => {
    try { return await fiat.getTransactionDetail('E2E-NONEXISTENT-UID') } catch (e) {
      if (e?.constructor?.name === 'NoSuchElementError') return 'NoSuchElementError (auth succeeded, 404 mapped)'
      throw e
    }
  })

  const buy = await step(c.chain, `buy ${cur}->${code} fiatAmount 100`, async () => {
    const url = (await fiat.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n })).buyUrl
    if (!url) throw new Error('buy returned no widget URL')
    return url
  })
  const sell = await step(c.chain, `sell ${code}->${cur} cryptoAmount 50`, async () => {
    const url = (await fiat.sell({ cryptoAsset: code, fiatCurrency: cur, cryptoAmount })).sellUrl
    if (!url) throw new Error('sell returned no widget URL')
    return url
  })
  for (const [kind, url] of [['buy', buy], ['sell', sell]]) {
    if (!url) continue
    urls[`${c.chain}-${kind}`] = url
    await step(c.chain, `${kind}Url session valid at /v2/user`, async () => {
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
  const ext = `e2e-${c.chain}-${Date.now()}`
  await step(c.chain, 'buy with externalTransactionId -> URL param', async () => {
    const u = new URL((await fiat.buy({ cryptoAsset: code, fiatCurrency: cur, fiatAmount: 10000n, config: { externalTransactionId: ext } })).buyUrl)
    if (u.searchParams.get('external-transaction-id') !== ext) throw new Error('external-transaction-id missing')
    return 'external-transaction-id present'
  })
  await step(c.chain, 'getTransactionDetail(externalId) before any payment -> NoSuchElementError', async () => {
    try { return j(await fiat.getTransactionDetail(ext, { idType: 'externalTransactionId' })) } catch (e) {
      if (e?.constructor?.name === 'NoSuchElementError') return 'NoSuchElementError (no transaction registered yet)'
      throw e
    }
  })
  if (tx === undefined) log('  (auth did not succeed for this chain)')
}

// Private handoff to widget-check.mjs; never include these session URLs in reports.
const urlFile = new URL(`e2e-urls-${ENV}.json`, OUT)
writeFileSync(urlFile, '', { mode: 0o600 })
chmodSync(urlFile, 0o600)
writeFileSync(urlFile, JSON.stringify(urls, null, 2), { mode: 0o600 })
writeFileSync(new URL(`e2e-results-${ENV}.json`, OUT), masked(j(results)))
const fails = results.filter(r => !r.ok)
log(`\nSUMMARY: ${results.length - fails.length}/${results.length} steps ok`)
for (const f of fails) log(`  FAIL [${f.chain}] ${f.name}: ${f.error}`)
process.exit(0)

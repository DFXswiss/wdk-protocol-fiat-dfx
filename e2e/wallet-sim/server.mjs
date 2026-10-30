import { createServer } from 'node:http'
import { readFile, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
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

// Manager, configuration and network mirror ../live-matrix.mjs.
const CASES = [
  { chain: 'ethereum', Manager: WalletManagerEvm, cfg: { provider: 'https://ethereum-rpc.publicnode.com' }, network: 'ethereum' },
  { chain: 'polygon', Manager: WalletManagerEvm, cfg: { provider: 'https://polygon-bor-rpc.publicnode.com' }, network: 'polygon' },
  { chain: 'arbitrum', Manager: WalletManagerEvm, cfg: { provider: 'https://arbitrum-one-rpc.publicnode.com' }, network: 'arbitrum' },
  { chain: 'base', Manager: WalletManagerEvm, cfg: { provider: 'https://base-rpc.publicnode.com' }, network: 'base' },
  { chain: 'optimism', Manager: WalletManagerEvm, cfg: { provider: 'https://optimism-rpc.publicnode.com' }, network: 'optimism' },
  { chain: 'bsc', Manager: WalletManagerEvm, cfg: { provider: 'https://bsc-rpc.publicnode.com' }, network: 'binancesmartchain' },
  { chain: 'sepolia', Manager: WalletManagerEvm, cfg: { provider: 'https://ethereum-sepolia-rpc.publicnode.com' }, network: 'sepolia' },
  { chain: 'polygon-4337', Manager: WalletManagerEvmErc4337, cfg: { chainId: 137, provider: 'https://polygon-bor-rpc.publicnode.com', bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true }, network: 'polygon' },
  { chain: 'base-4337', Manager: WalletManagerEvmErc4337, cfg: { chainId: 8453, provider: 'https://base-rpc.publicnode.com', bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true }, network: 'base' },
  { chain: 'tron', Manager: WalletManagerTron, cfg: { provider: 'https://api.trongrid.io' }, network: 'tron' },
  { chain: 'solana', Manager: WalletManagerSolana, cfg: { provider: 'https://api.mainnet-beta.solana.com' }, network: 'solana' },
  { chain: 'bitcoin', Manager: WalletManagerBtc, cfg: { network: 'bitcoin', bip: 84 }, network: 'bitcoin' },
  { chain: 'spark', Manager: WalletManagerSpark, cfg: { network: 'MAINNET' }, network: 'spark' }
]
const packages = new Map([
  [WalletManagerEvm, 'evm'], [WalletManagerEvmErc4337, 'evm-erc-4337'],
  [WalletManagerTron, 'tron'], [WalletManagerSolana, 'solana'],
  [WalletManagerBtc, 'btc'], [WalletManagerSpark, 'spark']
])

const port = Number(process.env.PORT ?? 4748)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const environment = process.env.WALLET_SIM_ENV ?? 'sandbox'
if (!['sandbox', 'production'].includes(environment)) throw new Error('WALLET_SIM_ENV muss sandbox oder production sein.')
const checkoutOrigin = environment === 'production' ? 'https://app.dfx.swiss' : 'https://dev.app.dfx.swiss'
const seedFile = process.env.WALLET_SIM_SEED_FILE
const ordersFile = process.env.WALLET_SIM_ORDERS_FILE
const TOKENS = {
  arbitrum: [{ symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }]
}
const NATIVE = {
  ethereum: ['ETH', 18], polygon: ['POL', 18], arbitrum: ['ETH', 18],
  base: ['ETH', 18], optimism: ['ETH', 18], bsc: ['BNB', 18],
  sepolia: ['ETH', 18], 'polygon-4337': ['POL', 18], 'base-4337': ['ETH', 18], tron: ['TRX', 6], solana: ['SOL', 9]
}
async function preparedSeed () {
  let file
  try {
    file = await open(seedFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const seed = (await file.readFile('utf8')).trim()
    if (!seed) throw new Error()
    return seed
  } catch {
    throw new Error('Vorbereitete Wallet nicht lesbar: eigene reguläre, nicht leere Seed-Datei mit Rechten nur für den Eigentümer erforderlich (keine Gruppen- oder Fremdrechte, z. B. 0600; keine Symlinks).')
  } finally { await file?.close() }
}
// Validate before listening; never include file contents or underlying errors in diagnostics.
if (seedFile) await preparedSeed()
const ORDER_FIELDS = ['id', 'direction', 'asset', 'chain', 'network', 'amount', 'amountMode', 'fiatCurrency', 'time', 'environment', 'address']
let savedOrders = []
if (ordersFile) {
  let file
  try {
    file = await open(ordersFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const rows = JSON.parse(await file.readFile('utf8'))
    if (!Array.isArray(rows) || rows.some(row => !row || ORDER_FIELDS.some(key => typeof row[key] !== 'string') || !['sandbox', 'production'].includes(row.environment) || !CASES.some(c => c.chain === row.chain && c.network === row.network) || !['buy', 'sell'].includes(row.direction) || !['fiat', 'crypto'].includes(row.amountMode) || !/^\d+(?:\.\d+)?$/.test(row.amount) || !Number.isFinite(Date.parse(row.time)))) throw new Error()
    savedOrders = rows.map(row => Object.fromEntries(ORDER_FIELDS.map(key => [key, row[key]])))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('WALLET_SIM_ORDERS_FILE konnte nicht geladen werden: gültige eigene reguläre Auftragsdatei mit Rechten nur für den Eigentümer erforderlich (keine Gruppen- oder Fremdrechte, z. B. 0600; keine Symlinks).')
  } finally { await file?.close() }
}
async function saveOrder (order) {
  const rows = [Object.fromEntries(ORDER_FIELDS.map(key => [key, order[key]])), ...savedOrders]
  if (ordersFile) {
    const temporary = `${ordersFile}.${randomBytes(12).toString('hex')}.tmp`
    let file
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(JSON.stringify(rows))
      await file.sync()
      await file.close()
      file = null
      await rename(temporary, ordersFile)
    } catch {
      throw new WalletInputError('Auftrag konnte nicht lokal gespeichert werden. Bitte den Pfad für WALLET_SIM_ORDERS_FILE prüfen.')
    } finally { await file?.close(); await unlink(temporary).catch(() => {}) }
  }
  savedOrders = rows
}
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`])
const names = { ethereum: 'Ethereum', polygon: 'Polygon', arbitrum: 'Arbitrum', base: 'Base', optimism: 'Optimism', bsc: 'BNB Smart Chain', sepolia: 'Sepolia', 'polygon-4337': 'Polygon Smart Account', 'base-4337': 'Base Smart Account', tron: 'Tron', solana: 'Solana', bitcoin: 'Bitcoin', spark: 'Spark' }
let session
const calls = []
class WalletInputError extends Error {}
class ModuleFailure extends Error { constructor (detail) { super('Modulaufruf fehlgeschlagen'); this.detail = detail } }
const check = (condition, message) => { if (!condition) throw new WalletInputError(message) }
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)
function masked (text, seed) {
  let value = String(text)
  if (seed) value = value.split(seed).join('[maskiert]').split(encodeURIComponent(seed)).join('[maskiert]')
  return value.replace(/((?:session|access_token|token)(?:=|%3D))[^&\s"<>#]*/gi, '$1[maskiert]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [maskiert]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[maskiert]')
}
async function call (s, chain, method, fn) {
  const start = Date.now()
  let ok = false
  try { const result = await fn(); ok = true; return result } catch (e) {
    // Wallet setup errors may contain fragments of mnemonic input; suppress their text entirely.
    throw new ModuleFailure({ class: method === 'Wallet erstellen' ? 'WalletSetupError' : e?.constructor?.name ?? 'Error', reason: method === 'Wallet erstellen' || e?.reason == null ? null : masked(e.reason, s.seed), message: method === 'Wallet erstellen' ? 'Wallet konnte nicht erstellt werden. Bitte Wiederherstellungswörter prüfen.' : masked(e?.message ?? 'Unbekannter Fehler', s.seed) })
  } finally {
    calls.push({ method, chain, durationMs: Date.now() - start, ok })
    if (calls.length > 100) calls.shift()
  }
}
const invoke = (s, account, method, ...args) => call(s, account.chain, method, () => account.protocol[method](...args))
function decimals (row) {
  check(Number.isInteger(row?.decimals) && row.decimals >= 0 && row.decimals <= 255, 'Für diese Währung fehlen gültige Nachkommastellen.')
  return row.decimals
}
function toUnits (input, places) {
  check(typeof input === 'string' && input.length <= 300 && /^\d+(?:\.\d+)?$/.test(input), 'Bitte einen positiven Betrag eingeben.')
  const [whole, fraction = ''] = input.split('.')
  check(fraction.slice(places).replace(/0/g, '') === '', `Höchstens ${places} Nachkommastellen erlaubt.`)
  const value = BigInt(whole + fraction.slice(0, places).padEnd(places, '0'))
  check(value > 0n, 'Der Betrag muss größer als null sein.')
  return value
}
function displayUnits (value, places) {
  const raw = BigInt(value)
  const digits = (raw < 0n ? -raw : raw).toString().padStart(places + 1, '0')
  return `${raw < 0n ? '-' : ''}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`
}
const walletView = s => ({ environment, preparedWallet: Boolean(seedFile), accounts: s?.accounts.map(({ protocol, account, ...a }) => a) ?? [] })
async function balances (s) {
  async function amount (fn, places) {
    let timer
    try {
      const value = await Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error()), 10000) })])
      return displayUnits(value, places)
    } catch { return null } finally { clearTimeout(timer) }
  }
  return Promise.all(s.accounts.map(async ({ chain, account }) => {
    if (!CASES.find(c => c.chain === chain)?.cfg.provider || !NATIVE[chain]) return { chain, balances: [] }
    const [symbol, places] = NATIVE[chain]
    const entries = [{ symbol, decimals: places }, ...(TOKENS[chain] ?? [])]
    return { chain, balances: await Promise.all(entries.map(async token => ({
      symbol: token.symbol,
      amount: await amount(() => token.address ? account.getTokenBalance(token.address) : account.getBalance(), token.decimals)
    }))) }
  }))
}
async function catalog (s) {
  const account = s.accounts[0]
  const assets = await invoke(s, account, 'getSupportedCryptoAssets')
  const fiats = await invoke(s, account, 'getSupportedFiatCurrencies')
  return { assets: assets.filter(a => s.accounts.some(c => c.network.toLowerCase() === a.networkCode.toLowerCase())), fiats }
}
async function trade (s, body) {
  check(['buy', 'sell'].includes(body.direction), 'Ungültige Richtung.')
  check(['fiat', 'crypto'].includes(body.amountMode), 'Ungültiger Betragsmodus.')
  const account = s.accounts.find(a => a.chain === body.chain)
  check(account, 'Bitte ein Wallet-Konto wählen.')
  const { assets, fiats } = await catalog(s)
  const asset = assets.find(a => a.code === body.cryptoAsset && a.networkCode.toLowerCase() === account.network.toLowerCase())
  const fiat = fiats.find(f => f.code === body.fiatCurrency)
  check(asset && fiat, 'Dieses Asset oder diese Währung ist nicht verfügbar.')
  const options = { cryptoAsset: asset.code, fiatCurrency: fiat.code, config: { network: account.network }, [body.amountMode === 'fiat' ? 'fiatAmount' : 'cryptoAmount']: toUnits(body.amount, decimals(body.amountMode === 'fiat' ? fiat : asset)) }
  return { account, asset, fiat, options }
}
async function route (path, body, url) {
  if (path === 'GET /api/log') return calls
  if (path === 'GET /api/wallet') return walletView(session)
  if (path === 'POST /api/wallet/create') {
    check(!session, 'Eine Wallet ist bereits geöffnet. Für eine neue Sitzung den Server neu starten.')
    check(body.seed === undefined || typeof body.seed === 'string', 'Wiederherstellungswörter müssen Text sein.')
    check(body.smartAccount === undefined || typeof body.smartAccount === 'boolean', 'Ungültiger Kontotyp.')
    check(body.prepared === undefined || typeof body.prepared === 'boolean', 'Ungültige Wallet-Auswahl.')
    check(!body.prepared || (seedFile && body.seed === undefined), 'Keine vorbereitete Wallet verfügbar oder widersprüchliche Auswahl.')
    let seed
    try { seed = body.prepared ? await preparedSeed() : body.seed?.trim() || WDK.getRandomSeedPhrase() } catch { throw new WalletInputError('Vorbereitete Wallet nicht lesbar. Eigene Seed-Datei und Rechte nur für den Eigentümer prüfen (keine Gruppen- oder Fremdrechte, z. B. 0600).') }
    const next = { seed, accounts: [], orders: [] }
    try {
      await call(next, 'alle', 'Wallet erstellen', async () => {
        next.wdk = new WDK(seed)
        const cases = CASES.map(c => c.chain === 'ethereum' && body.smartAccount ? { ...c, Manager: WalletManagerEvmErc4337, cfg: { ...c.cfg, chainId: 1, bundlerUrl: 'https://bundler.invalid', safeModulesVersion: '0.3.0', useNativeCoins: true } } : c)
        for (const c of cases) next.wdk.registerWallet(c.chain, c.Manager, c.cfg).registerProtocol(c.chain, 'dfx', DfxProtocol, { environment, network: c.network, wallet: 'WDK Demo Wallet' })
        for (const c of cases) {
          const account = await next.wdk.getAccount(c.chain, 0)
          next.accounts.push({ chain: c.chain, name: names[c.chain], network: c.network, address: await account.getAddress(), package: `@tetherto/wdk-wallet-${packages.get(c.Manager)}`, smartAccount: c.Manager === WalletManagerEvmErc4337, protocol: account.getFiatProtocol('dfx'), account })
        }
      })
      next.orders = savedOrders.filter(order => order.environment === environment && next.accounts.some(a => a.chain === order.chain && a.address === order.address)).map(order => ({ ...order, status: 'started' }))
      session = next
      return walletView(session)
    } catch (error) { try { await next.wdk?.dispose() } catch {} throw error }
  }
  check(session, 'Bitte zuerst eine Wallet erstellen.')
  const s = session
  if (path === 'GET /api/balances') return balances(s)
  if (path === 'GET /api/offer') {
    check(['buy', 'sell'].includes(url.searchParams.get('direction')), 'Ungültige Richtung.')
    return catalog(s)
  }
  if (path === 'GET /api/orders') return s.orders
  if (path === 'POST /api/status') {
    const order = s.orders.find(o => o.id === body.id)
    check(order, 'Auftrag nicht gefunden.')
    const account = s.accounts.find(a => a.chain === order.chain)
    const detail = await invoke(s, account, 'getTransactionDetail', order.id, { idType: 'externalTransactionId' })
    order.status = detail.status
    return detail
  }
  if (path === 'POST /api/quote' || path === 'POST /api/checkout') {
    const { account, asset, fiat, options } = await trade(s, body)
    if (path === 'POST /api/quote') {
      const raw = await invoke(s, account, body.direction === 'buy' ? 'quoteBuy' : 'quoteSell', options)
      return { cryptoAmount: displayUnits(raw.cryptoAmount, decimals(asset)), fiatAmount: displayUnits(raw.fiatAmount, decimals(fiat)), fee: displayUnits(raw.fee, fiat.decimals), rate: raw.rate, cryptoAsset: asset.code, fiatCurrency: fiat.code }
    }
    const id = `wallet-${Date.now()}-${randomBytes(6).toString('hex')}`
    options.config.externalTransactionId = id
    const result = await invoke(s, account, body.direction, options)
    const checkout = new URL(result.buyUrl ?? result.sellUrl)
    check(checkout.origin === checkoutOrigin && !checkout.username && !checkout.password, 'Ungültige Anbieter-Adresse.')
    const order = { id, direction: body.direction, asset: asset.code, chain: account.chain, network: account.network, amount: body.amount, amountMode: body.amountMode, fiatCurrency: fiat.code, time: new Date().toISOString(), status: 'started', environment, address: account.address }
    await saveOrder(order)
    s.orders.unshift(order)
    return { id, url: checkout.href }
  }
  throw new WalletInputError('Unbekannte API-Route.')
}
async function readBody (req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) { size += chunk.length; check(size <= 16384, 'Anfrage zu groß.'); chunks.push(chunk) }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    check(body && typeof body === 'object' && !Array.isArray(body), 'JSON-Objekt erwartet.')
    return body
  } catch { throw new WalletInputError('Ungültiges JSON-Objekt.') }
}
function json (res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(stringify(value)) }
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }
let queue = Promise.resolve()
createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${checkoutOrigin}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
  try {
    check(origins.has(`http://${req.headers.host}`) && (!req.headers.origin || origins.has(req.headers.origin)) && req.headers['sec-fetch-site'] !== 'cross-site', 'Nur lokale Browser-Anfragen erlaubt.')
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {}
      const task = queue.then(() => route(`${req.method} ${url.pathname}`, body, url))
      queue = task.catch(() => {})
      return json(res, 200, { ok: true, data: await task })
    }
    const file = files[url.pathname]
    if (req.method !== 'GET' || !file) { res.writeHead(404); return res.end('Nicht gefunden') }
    const data = await readFile(new URL(`./public/${file[0]}`, import.meta.url))
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(data)
  } catch (e) {
    json(res, e instanceof ModuleFailure || e instanceof WalletInputError ? 200 : 500, { ok: false, error: e instanceof ModuleFailure ? e.detail : { class: e instanceof WalletInputError ? 'WalletInputError' : 'ServerError', reason: null, message: e instanceof WalletInputError ? e.message : 'Die Anfrage konnte nicht verarbeitet werden.' } })
  }
}).listen(port, '127.0.0.1', () => process.send?.('ready'))

// Production purchase handoff. Run from e2e/: node real-purchase.mjs <command>.
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const NETWORK = 'arbitrum'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const stateDir = resolve(process.env.STATE_DIR || join(homedir(), '.wdk-dfx-real'))
const seedFile = join(stateDir, 'seed.txt')
const stateFile = join(stateDir, 'state.json')
const widgetFile = join(stateDir, 'widget-url.txt')
let seed = ''
let widgetUrl = ''
let wdk

function redact (value) {
  let text = String(value)
  for (const secret of [seed, widgetUrl]) {
    if (secret) text = text.split(secret).join('[REDACTED]')
  }
  // Also suppress partial mnemonic echoes and encoded widget session values.
  if (seed) {
    for (const word of seed.split(/\s+/).filter(word => /^[a-z]+$/.test(word))) {
      text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '[REDACTED]')
    }
  }
  if (widgetUrl) {
    const session = new URL(widgetUrl).searchParams.get('session')
    if (session) {
      text = text.split(session).join('[REDACTED]')
      text = text.split(encodeURIComponent(session)).join('[REDACTED]')
    }
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[TOKEN REDACTED]')
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:session|token|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
}

function errorText (error) {
  return redact(`${error?.constructor?.name ?? 'Error'} reason=${error?.reason ?? '-'}: ${error?.message ?? 'Unbekannter Fehler'}`)
}

function logStatus (text) {
  console.log(`${new Date().toISOString()} ${text}`)
}

function exists (file) {
  try { lstatSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function privateFile (file, create, contents) {
  const flags = constants.O_NOFOLLOW | (create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_RDONLY)
  const fd = openSync(file, flags, 0o600)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) {
      throw new Error('Zustandsdatei muss eine eigene reguläre Datei ohne Hardlinks sein')
    }
    if (!create) {
      if ((stat.mode & 0o077) !== 0) throw new Error('Zustandsdatei muss privat sein: Rechte 0600 erforderlich')
      return readFileSync(fd, 'utf8')
    }
    fchmodSync(fd, 0o600)
    writeFileSync(fd, contents, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function cents (input) {
  if (!/^[0-9]+(?:\.[0-9]{2})?$/.test(input)) {
    throw new Error('AMOUNT_EUR muss eine positive ganze Zahl oder eine Zahl mit genau zwei Nachkommastellen sein (z. B. 20.50)')
  }
  const [whole, fraction = '00'] = input.split('.')
  const amount = BigInt(whole) * 100n + BigInt(fraction)
  if (amount <= 0n) throw new Error('AMOUNT_EUR muss größer als null sein')
  return amount
}

function units (amount, decimals) {
  const n = BigInt(amount)
  const digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0')
  return `${n < 0n ? '-' : ''}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
}

function walletSelfTest () {
  const require = createRequire(import.meta.url)
  const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
  const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
  if (dfxWalletPath !== wdkWalletPath) {
    throw new Error('Mehrere @tetherto/wdk-wallet-Kopien: WDK und DFX müssen dieselbe Kopie verwenden (siehe e2e/live-matrix.mjs)')
  }
}

async function prepare (fiat, address, fiatAmount, confirm) {
  if (exists(stateFile) || exists(widgetFile)) {
    throw new Error('Kauf bereits vorbereitet: vorhandene widget-url.txt verwenden und mit status nachverfolgen; Zustand wird nicht überschrieben')
  }
  const quote = await fiat.quoteBuy({ cryptoAsset: 'USDC', fiatCurrency: 'EUR', fiatAmount })
  // Persist only the documented quote fields, never arbitrary provider data.
  const savedQuote = {
    cryptoAmount: quote.cryptoAmount.toString(),
    fiatAmount: quote.fiatAmount.toString(),
    fee: quote.fee.toString(),
    rate: quote.rate
  }
  if (!/^\d+(?:\.\d+)?$/.test(savedQuote.rate)) throw new Error('Ungültiger Quote-Kurs')
  console.log(`Wallet-Adresse: ${address}`)
  console.log(`Arbiscan: https://arbiscan.io/address/${address}`)
  console.log(`Quote: ${units(quote.fiatAmount, 2)} EUR → ${units(quote.cryptoAmount, 6)} USDC`)
  console.log(`Gebühr: ${units(quote.fee, 2)} EUR; effektiver Kurs inklusive Gebühren: ${quote.rate} EUR/USDC`)
  if (!confirm) throw new Error('Nur Quote angezeigt; prepare --confirm erforderlich für Production-Anmeldung und Kaufvorbereitung')
  const externalTransactionId = `wdk-real-${Date.now()}-${randomBytes(8).toString('hex')}`
  // Reserve the ID before buy(): a failed handoff must not lose its tracking ID
  // or let a repeated prepare silently replace the single purchase being tracked.
  privateFile(stateFile, true, JSON.stringify({
    address,
    network: NETWORK,
    environment: 'production',
    cryptoAsset: 'USDC',
    fiatCurrency: 'EUR',
    fiatAmount: fiatAmount.toString(),
    quote: savedQuote,
    externalTransactionId,
    createdAt: new Date().toISOString()
  }, null, 2) + '\n')
  console.log(`externalTransactionId: ${externalTransactionId}`)
  const result = await fiat.buy({
    cryptoAsset: 'USDC', fiatCurrency: 'EUR', fiatAmount, config: { externalTransactionId }
  })
  // Validate without passing an invalid URL into errors that might echo it.
  let parsed
  try { parsed = new URL(result.buyUrl) } catch { throw new Error('DFX hat keine gültige Widget-URL geliefert') }
  if (parsed.protocol !== 'https:' || !parsed.searchParams.get('session')) {
    throw new Error('DFX hat keine HTTPS-Widget-URL mit Session geliefert')
  }
  widgetUrl = parsed.toString()
  privateFile(widgetFile, true, widgetUrl + '\n')
  console.log(`Widget-URL liegt in ${widgetFile} (enthält eine Anmelde-Session, nicht teilen)`)
  console.log('Nächste Schritte: Widget öffnen, E-Mail im DFX-Fenster eingeben und den E-Mail-Link bestätigen; dann die dort angezeigte Überweisung selbst ausführen.')
  console.log('Danach: node real-purchase.mjs status --watch (mit demselben STATE_DIR).')
}

async function status (account, fiat, address, watch) {
  const state = JSON.parse(privateFile(stateFile, false))
  if (state.network !== NETWORK || state.environment !== 'production' || state.address !== address ||
      typeof state.externalTransactionId !== 'string' || !/^wdk-real-\d+-[a-f0-9]{16}$/.test(state.externalTransactionId)) {
    throw new Error('Gespeicherter Zustand passt nicht zu Wallet, Production-Netz oder Kauf-ID')
  }
  do {
    let transactionStatus
    let lookupError
    try {
      const detail = await fiat.getTransactionDetail(state.externalTransactionId, { idType: 'externalTransactionId' })
      if (!['completed', 'failed', 'in_progress'].includes(detail.status)) throw new Error('Unbekannter DFX-Transaktionsstatus')
      transactionStatus = detail.status
      logStatus(`DFX: ${transactionStatus}`)
    } catch (error) {
      if (error?.constructor?.name === 'NoSuchElementError') {
        logStatus(`noch keine Transaktion bei DFX (${errorText(error)})`)
      } else {
        lookupError = error
        logStatus(errorText(error))
      }
    }
    let balance
    let balanceError
    try {
      balance = await account.getTokenBalance(USDC)
      logStatus(`USDC auf Arbitrum: ${units(balance, 6)}`)
    } catch (error) {
      balanceError = error
      logStatus(errorText(error))
    }
    if (transactionStatus === 'failed') { process.exitCode = 1; return }
    if (lookupError || balanceError) { process.exitCode = 2; return }
    if (!watch || (transactionStatus === 'completed' && balance > 0n)) return
    await delay(60_000)
  } while (true)
}

async function main () {
  const [command, ...flags] = process.argv.slice(2)
  const allowed = { prepare: '--confirm', status: '--watch', address: null }
  if (!Object.hasOwn(allowed, command) || flags.length > 1 || flags.some(flag => flag !== allowed[command])) {
    throw new Error('Aufruf: node real-purchase.mjs prepare [--confirm] | status [--watch] | address')
  }
  const amount = command === 'prepare' ? cents(process.env.AMOUNT_EUR ?? '20') : undefined
  walletSelfTest()
  if (command === 'prepare') mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const dir = lstatSync(stateDir)
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid()) {
    throw new Error('STATE_DIR muss ein eigenes Verzeichnis ohne Symlink sein')
  }
  chmodSync(stateDir, 0o700)
  if (command === 'prepare' && !exists(seedFile)) {
    if (exists(stateFile) || exists(widgetFile)) throw new Error('Seed fehlt für vorhandenen Kauf; keine neue Wallet erzeugt')
    seed = WDK.getRandomSeedPhrase()
    privateFile(seedFile, true, seed + '\n')
  } else {
    seed = privateFile(seedFile, false).trim()
  }
  if (!seed || !/^[a-z]+(?: [a-z]+)*$/.test(seed)) throw new Error('Ungültiges Seed-Dateiformat')
  wdk = new WDK(seed)
    .registerWallet(NETWORK, WalletManagerEvm, { provider: 'https://arbitrum-one-rpc.publicnode.com' })
    .registerProtocol(NETWORK, 'dfx', DfxProtocol, { environment: 'production', network: NETWORK })
  const account = await wdk.getAccount(NETWORK, 0)
  const address = await account.getAddress()
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Ungültige Wallet-Adresse')
  if (command === 'address') { console.log(address); return }
  const fiat = account.getFiatProtocol('dfx')
  if (command === 'prepare') await prepare(fiat, address, amount, flags.includes('--confirm'))
  else await status(account, fiat, address, flags.includes('--watch'))
}

try {
  await main()
} catch (error) {
  console.error(`${new Date().toISOString()} ${errorText(error)}`)
  process.exitCode = 2
} finally {
  try { wdk?.dispose() } catch (error) {
    console.error(`${new Date().toISOString()} ${errorText(error)}`)
    process.exitCode = 2
  }
}

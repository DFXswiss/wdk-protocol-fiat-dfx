const $ = id => document.getElementById(id)
const state = { accounts: [], pairs: [], direction: 'buy', screen: 'welcome', revision: 0, quoteKey: null, busy: false, timer: null }
state.balances = new Map()
state.balancesBusy = false
async function api (path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!result.ok) throw result.error
  return result.data
}
function show (screen) {
  clearTimeout(state.timer)
  state.revision++
  state.quoteKey = null
  state.screen = screen
  for (const id of ['welcome', 'portfolio', 'trade', 'orders']) $(id).hidden = screen !== id
  document.querySelector('.viewport').scrollTop = 0
  if (screen === 'portfolio') refreshBalances()
}
function element (tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}
// Keep amount display in strings too: no Number conversion of monetary values.
function money (input, minimum = 2) {
  const [whole, fraction = ''] = String(input).split('.')
  const trimmed = fraction.replace(/0+$/, '').padEnd(minimum, '0')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (trimmed ? `,${trimmed}` : '')
}
function userError (error) {
  const message = error?.message ?? ''
  const limit = message.match(/\(limit:\s*([^)]*)\)/)?.[1]
  const unit = $('amount-unit').textContent
  const limitText = limit ? (/^\d+(?:\.\d+)?$/.test(limit) ? `${money(limit)} ${unit}` : limit.replace(/\d+\.\d+/g, value => money(value))) : null
  if (message.includes('AmountTooLow')) return `Betrag zu niedrig${limitText ? ` – mindestens ${limitText}` : '. Bitte einen höheren Betrag wählen.'}`
  if (message.includes('AmountTooHigh')) return `Betrag zu hoch${limitText ? ` – höchstens ${limitText}` : '. Bitte einen kleineren Betrag wählen.'}`
  if (/Unsupported buy asset/.test(message)) return 'Dieses Asset ist auf diesem Netz bei DFX nur verkaufbar.'
  if (/Unsupported sell asset/.test(message)) return 'Dieses Asset ist auf diesem Netz bei DFX nur kaufbar.'
  if (/Unsupported .*fiat|CurrencyUnsupported|IbanCurrencyMismatch/.test(message)) return 'Diese Währung ist für das gewählte Angebot nicht verfügbar. Bitte eine andere wählen.'
  if (/UNAUTHORIZED/.test(String(error?.reason)) || /signature|authenticat|sign.in/i.test(message)) return 'Anmeldung bei DFX fehlgeschlagen. Bitte erneut versuchen.'
  if (/NETWORK_ERROR|REQUEST_TIMEOUT/.test(String(error?.reason))) return 'DFX ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.'
  if (/FORBIDDEN/.test(String(error?.reason))) return 'DFX ist für diese Anfrage derzeit nicht verfügbar.'
  if (message.includes('PaymentMethodNotAllowed')) return 'Diese Zahlungsart ist für das Angebot nicht verfügbar.'
  if (error?.class === 'WalletInputError') return message
  if (/Wallet konnte nicht/.test(message)) return message
  return 'Das Angebot konnte nicht geladen werden. Bitte Betrag oder Auswahl ändern oder später erneut versuchen.'
}
function errorBox (target, error, override) {
  target.classList.add('error')
  target.replaceChildren(element('p', override ?? userError(error)), element('small', `${error?.class ?? 'Verbindungsfehler'}${error?.reason ? ` · ${error.reason}` : ''}`, 'technical'))
}
async function createWallet (restore, prepared = false) {
  if (state.busy) return
  const seed = $('seed').value.trim()
  if (restore && !seed) { errorBox($('welcome-error'), { class: 'WalletInputError', message: 'Bitte Wiederherstellungswörter eingeben.' }); return }
  state.busy = true
  $('create-wallet').disabled = $('restore-submit').disabled = $('load-prepared').disabled = true
  $('welcome-error').classList.remove('error')
  $('welcome-error').textContent = 'Deine Konten werden vorbereitet …'
  $('seed').value = ''
  try {
    const wallet = await api('/api/wallet/create', { smartAccount: $('smart-account').checked, ...(prepared ? { prepared: true } : restore ? { seed } : {}) })
    state.accounts = wallet.accounts
    renderAccounts()
    show('portfolio')
  } catch (error) { errorBox($('welcome-error'), error) } finally {
    state.busy = false
    $('create-wallet').disabled = $('restore-submit').disabled = $('load-prepared').disabled = false
    refreshLog()
  }
}
function renderAccounts () {
  $('accounts').replaceChildren(...state.accounts.map((account, index) => {
    const row = element('div', '', 'account')
    const icon = element('span', account.chain === 'bitcoin' ? 'BTC' : account.name.slice(0, 3).toUpperCase(), `coin tone-${index % 5}`)
    const info = element('div', '', 'account-text')
    info.append(element('strong', `${account.name}${account.smartAccount && account.chain === 'ethereum' ? ' · Smart' : ''}`), element('small', `${account.address.slice(0, 7)}…${account.address.slice(-5)}`))
    const balances = state.balances.get(account.chain)
    const balance = element('small', balances?.length ? balances.map(entry => `${entry.amount === null ? '–' : money(entry.amount, 0)} ${entry.symbol}`).join(' · ') : '–', 'account-balance')
    info.append(balance)
    const copy = element('button', '⧉', 'copy')
    copy.id = `copy-${account.chain}`
    copy.setAttribute('aria-label', `${account.name}: Adresse kopieren`)
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(account.address); copy.textContent = '✓' } catch { copy.textContent = 'Fehler' }
      setTimeout(() => { copy.textContent = '⧉' }, 1800)
    })
    row.append(icon, info, copy)
    return row
  }))
}
async function refreshBalances () {
  if (!state.accounts.length || state.balancesBusy) return
  state.balancesBusy = true
  $('refresh-balances').disabled = true
  $('balance-status').textContent = 'Kontostände werden geladen …'
  try {
    const rows = await api('/api/balances')
    state.balances = new Map(rows.map(row => [row.chain, row.balances]))
    $('balance-status').textContent = `Abgerufen um ${new Date().toLocaleTimeString('de-DE')} · – = nicht verfügbar`
  } catch {
    state.balances.clear()
    $('balance-status').textContent = 'Kontostände nicht verfügbar · Bitte erneut aktualisieren.'
  } finally {
    renderAccounts()
    state.balancesBusy = false
    $('refresh-balances').disabled = false
  }
}
function payload () {
  const pair = state.pairs[Number($('asset-select').value)]
  if (!pair) return null
  return { direction: state.direction, chain: pair.account.chain, cryptoAsset: pair.asset.code, fiatCurrency: $('fiat-select').value, amountMode: $('amount-mode').value, amount: $('amount').value.trim().replace(',', '.') }
}
function updateUnit () {
  const pair = state.pairs[Number($('asset-select').value)]
  $('amount-unit').textContent = $('amount-mode').value === 'fiat' ? $('fiat-select').value : pair?.asset.code ?? ''
  $('smart-note').hidden = !pair?.account.smartAccount
}
async function openTrade (direction) {
  show('trade')
  state.direction = direction
  state.pairs = []
  $('trade-title').textContent = direction === 'buy' ? 'Krypto kaufen' : 'Krypto verkaufen'
  $('asset-select').replaceChildren()
  $('asset-select').dataset.catalog = 'loading'
  $('fiat-select').replaceChildren()
  $('amount').value = '100'
  $('amount-mode').value = 'fiat'
  $('continue-dfx').disabled = true
  $('offer').classList.remove('error')
  $('offer').textContent = 'Verfügbare Angebote werden geladen …'
  const revision = state.revision
  try {
    const data = await api(`/api/offer?direction=${direction}`)
    if (revision !== state.revision) return
    for (const account of state.accounts) {
      for (const asset of data.assets.filter(a => a.networkCode.toLowerCase() === account.network.toLowerCase())) state.pairs.push({ account, asset })
    }
    state.pairs.sort((a, b) => (a.asset.code === 'USDT' ? -1 : 0) - (b.asset.code === 'USDT' ? -1 : 0))
    state.pairs.forEach((pair, index) => $('asset-select').add(new Option(`${pair.asset.code} · ${pair.account.name}${pair.account.smartAccount && pair.account.chain === 'ethereum' ? ' (Smart)' : ''}`, String(index))))
    data.fiats.forEach(fiat => $('fiat-select').add(new Option(fiat.code, fiat.code)))
    if (data.fiats.some(fiat => fiat.code === 'EUR')) $('fiat-select').value = 'EUR'
    if (!state.pairs.length || !data.fiats.length) { $('asset-select').dataset.catalog = 'empty'; $('offer').textContent = 'Für deine Wallet sind derzeit keine Angebote verfügbar.'; return }
    $('asset-select').dataset.catalog = 'loaded'
    scheduleQuote()
  } catch (error) { if (revision === state.revision) { $('asset-select').dataset.catalog = 'error'; errorBox($('offer'), error) } } finally { refreshLog() }
}
function scheduleQuote () {
  if (!state.pairs.length) return
  clearTimeout(state.timer)
  state.revision++
  state.quoteKey = null
  $('continue-dfx').disabled = true
  updateUnit()
  $('offer').classList.remove('error')
  $('offer').textContent = 'Angebot wird berechnet …'
  const revision = state.revision
  state.timer = setTimeout(() => quote(revision), 450)
}
async function quote (revision) {
  const body = payload()
  if (!body) return
  try {
    const offer = await api('/api/quote', body)
    if (revision !== state.revision || state.screen !== 'trade') return
    const fiat = `${money(offer.fiatAmount)} ${offer.fiatCurrency}`
    const crypto = `${money(offer.cryptoAmount, 0)} ${offer.cryptoAsset}`
    $('offer').classList.remove('error')
    $('offer').replaceChildren(
      element('p', `Du zahlst ${state.direction === 'buy' ? fiat : crypto}`),
      element('p', `Du erhältst ca. ${state.direction === 'buy' ? crypto : fiat}`, 'receive'),
      element('p', `Gebühr ${money(offer.fee)} ${offer.fiatCurrency}`),
      element('p', `Kurs 1 ${offer.cryptoAsset} = ${money(offer.rate, 0)} ${offer.fiatCurrency}`),
      element('p', 'Anbieter: DFX', 'provider')
    )
    state.quoteKey = JSON.stringify(body)
    $('continue-dfx').disabled = false
  } catch (error) { if (revision === state.revision) errorBox($('offer'), error) } finally { refreshLog() }
}
async function checkout () {
  const body = payload()
  if (state.busy || !body || state.quoteKey !== JSON.stringify(body)) return
  state.busy = true
  $('continue-dfx').disabled = true
  $('continue-dfx').textContent = 'Bei DFX anmelden …'
  for (const id of ['asset-select', 'fiat-select', 'amount', 'amount-mode', 'trade-back']) $(id).disabled = true
  try {
    const result = await api('/api/checkout', body)
    // Never insert the session-bearing URL as text or into diagnostics.
    $('browser-domain').textContent = `🔒 ${new URL(result.url).hostname}`
    $('browser-frame').src = result.url
    $('browser-sheet').hidden = false
    document.querySelector('.viewport').inert = true
    $('browser-close').focus()
  } catch (error) { errorBox($('offer'), error) } finally {
    state.busy = false
    for (const id of ['asset-select', 'fiat-select', 'amount', 'amount-mode', 'trade-back']) $(id).disabled = false
    $('continue-dfx').disabled = state.quoteKey !== JSON.stringify(payload())
    $('continue-dfx').textContent = 'Weiter zu DFX →'
    refreshLog()
  }
}
function closeBrowser () {
  $('browser-sheet').hidden = true
  $('browser-frame').removeAttribute('src')
  document.querySelector('.viewport').inert = false
  openOrders()
  $('orders-back').focus()
}
const statuses = { started: 'Gestartet · Status prüfen', in_progress: 'In Bearbeitung', completed: 'Abgeschlossen', failed: 'Fehlgeschlagen' }
async function openOrders () {
  show('orders')
  $('order-status').hidden = true
  $('order-list').textContent = 'Aufträge werden geladen …'
  const revision = state.revision
  try {
    const orders = await api('/api/orders')
    if (revision !== state.revision) return
    if (!orders.length) { $('order-list').textContent = 'Noch keine Aufträge. Starte deinen ersten Kauf oder Verkauf.'; return }
    $('order-list').replaceChildren(...orders.map(order => {
      const item = element('button', '', 'order-item')
      item.id = `order-${order.id}`
      item.dataset.testid = 'order-item'
      item.append(element('strong', `${order.direction === 'buy' ? '↓ Kauf' : '↑ Verkauf'} · ${order.asset}`), element('small', `${money(order.amount, order.amountMode === 'fiat' ? 2 : 0)} ${order.amountMode === 'fiat' ? order.fiatCurrency : order.asset} · ${state.accounts.find(a => a.chain === order.chain)?.name ?? order.network}`), element('small', `${new Date(order.time).toLocaleString('de-DE')} · ${statuses[order.status] ?? 'Status unbekannt'}`))
      item.addEventListener('click', () => orderStatus(order, item))
      return item
    }))
  } catch (error) { if (revision === state.revision) errorBox($('order-list'), error) }
}
async function orderStatus (order, item) {
  const revision = ++state.revision
  item.disabled = true
  $('order-status').hidden = false
  $('order-status').classList.remove('error')
  $('order-status').textContent = 'Status bei DFX wird abgefragt …'
  try {
    const detail = await api('/api/status', { id: order.id })
    if (revision !== state.revision) return
    $('order-status').textContent = `${order.asset} · ${statuses[detail.status] ?? 'Status derzeit unbekannt'}`
    item.lastChild.textContent = `${new Date(order.time).toLocaleString('de-DE')} · ${statuses[detail.status] ?? 'Status unbekannt'}`
  } catch (error) {
    if (revision !== state.revision) return
    errorBox($('order-status'), error, error?.class === 'NoSuchElementError' ? 'Noch nicht bei DFX eingegangen. Sobald du im DFX-Fenster die Zahlungsdaten abrufst und bezahlst, erscheint der Auftrag hier.' : 'Der Status konnte nicht abgerufen werden. Bitte erneut versuchen.')
  } finally { item.disabled = false; refreshLog() }
}
async function refreshLog () {
  if (!$('under-hood').open) return
  try { const calls = await api('/api/log'); $('call-log').textContent = calls.map(c => `${c.ok ? 'OK' : 'FEHLER'}  ${c.chain} · ${c.method} · ${c.durationMs} ms`).join('\n') || 'Noch keine Aufrufe.' } catch { $('call-log').textContent = 'Protokoll nicht erreichbar.' }
}
$('create-wallet').addEventListener('click', () => createWallet(false))
$('restore-submit').addEventListener('click', () => createWallet(true))
$('load-prepared').addEventListener('click', () => createWallet(false, true))
$('refresh-balances').addEventListener('click', refreshBalances)
$('btn-buy').addEventListener('click', () => openTrade('buy'))
$('btn-sell').addEventListener('click', () => openTrade('sell'))
$('btn-orders').addEventListener('click', openOrders)
$('trade-back').addEventListener('click', () => show('portfolio'))
$('orders-back').addEventListener('click', () => show('portfolio'))
for (const id of ['asset-select', 'fiat-select', 'amount-mode']) $(id).addEventListener('change', scheduleQuote)
$('amount').addEventListener('input', scheduleQuote)
$('continue-dfx').addEventListener('click', checkout)
$('browser-close').addEventListener('click', closeBrowser)
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('browser-sheet').hidden) closeBrowser() })
$('under-hood').addEventListener('toggle', refreshLog)
setInterval(refreshLog, 2000)
async function init () {
  try {
    const wallet = await api('/api/wallet')
    state.environment = wallet.environment
    const production = wallet.environment === 'production'
    $('environment-badge').textContent = production ? 'PRODUCTION' : 'SANDBOX'
    $('environment-badge').classList.toggle('production', production)
    document.title = `Wallet · ${production ? 'Production' : 'Sandbox'}`
    $('sandbox-note').hidden = production
    $('production-note').hidden = !production
    $('load-prepared').hidden = !wallet.preparedWallet
    $('create-wallet').disabled = $('restore-submit').disabled = false
    if (production) setInterval(refreshBalances, 30000)
    if (wallet.accounts.length) { state.accounts = wallet.accounts; renderAccounts(); show('portfolio') }
  } catch (error) { errorBox($('welcome-error'), error, 'Der lokale Wallet-Server ist nicht erreichbar. Bitte neu laden.') }
}
init()

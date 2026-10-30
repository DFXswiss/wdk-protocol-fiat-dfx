#!/usr/bin/env node
// Local integration probe. Run only against the disposable dfx-e2e-wdk2 stack.
// Fixture data is retained for inspection; no tokens or wallet seeds are persisted.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
if (dfxWalletPath !== wdkWalletPath) {
  throw new Error(`Duplicate @tetherto/wdk-wallet copies: DFX resolves ${dfxWalletPath}; WDK resolves ${wdkWalletPath}. FiatProtocol class identity differs, so DFX registration would fail. Remove e2e/node_modules and reinstall from e2e/ with install-links=true (see .npmrc).`)
}

const API = new URL(process.env.DFX_LOCAL_API ?? 'http://localhost:3020').origin
const APP = new URL(process.env.DFX_LOCAL_APP ?? 'http://localhost:3021').origin
for (const origin of [API, APP]) {
  const url = new URL(origin)
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Disposable local stack only')
}
const DB_CONTAINER = process.env.DFX_LOCAL_DB_CONTAINER ?? 'dfx-e2e-wdk2-db-1'
const API_CONTAINER = process.env.DFX_LOCAL_API_CONTAINER ?? DB_CONTAINER.replace(/-db-1$/, '-api-1')
const DIR = fileURLToPath(new URL('./out/fullstack/', import.meta.url))
const runId = `wdk-${Date.now()}-${randomUUID().slice(0, 8)}`
const IBAN = 'CH9300762011623852957'
const secrets = new Set()
const results = {
  runId, startedAt: new Date().toISOString(), api: API, app: APP,
  sellAssignment: 'SQL fixture: NOT assigned through buyFiatService/findAndComplete. POST /payIn only creates input; registration is a disabled job.',
  limitations: ['No real bank transfer, blockchain deposit or payout', 'Fixture data retained in local DB',
    'Module detail has no direction or uid field; raw API DTO and DB prove direction and identity'],
  steps: []
}
mkdirSync(`${DIR}shots`, { recursive: true })
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]')
    .replace(/([?&]session=)[^&\s"<>]+/g, '$1[REDACTED]')
}
function persist() {
  writeFileSync(`${DIR}results.json.tmp`, redact(results) + '\n', { mode: 0o600 })
  renameSync(`${DIR}results.json.tmp`, `${DIR}results.json`)
}
async function step(name, fn, dependencies = []) {
  const started = Date.now()
  try {
    assert(dependencies.every(v => v !== undefined), 'Blocked: prerequisite failed (not executed)')
    const evidence = await fn()
    results.steps.push({ name, ok: true, ms: Date.now() - started, evidence })
    console.log(`OK ${name} ${redact(evidence).slice(0, 600)}`)
    persist()
    return evidence
  } catch (error) {
    results.steps.push({ name, ok: false, ms: Date.now() - started,
      error: redact(error.message), evidence: error.evidence })
    console.log(`FAIL ${name} ${redact(error.message).replace(/\s+/g, ' ').slice(0, 700)}`)
    persist()
    return undefined
  }
}
function check(condition, message, evidence) {
  if (!condition) throw Object.assign(new Error(message), { evidence })
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`
function num(value) {
  assert(typeof value === 'number' && Number.isFinite(value), 'SQL number must be a finite number')
  return String(value)
}
function id(value) {
  assert(Number.isSafeInteger(value) && value > 0, 'Expected positive integer ID')
  return num(value)
}
function sql(statement) {
  try {
    return execFileSync('docker', ['exec', DB_CONTAINER, 'psql',
      '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'sa', '-d', 'dfx', '-t', '-A', '-F', '\t', '-c', statement],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    throw new Error(`SQL failed: ${error.stderr?.toString() || error.message}`)
  }
}
function rows(select) {
  const output = sql(`SELECT row_to_json(evidence) FROM (${select}) evidence`)
  return output ? output.split('\n').map(line => JSON.parse(line)) : []
}
function one(select) {
  const found = rows(select)
  check(found.length === 1, `Expected exactly one DB row, got ${found.length}`, found)
  return found[0]
}
function change(statement) {
  const output = sql(`WITH changed AS (${statement} RETURNING *) SELECT row_to_json(changed) FROM changed`)
  const changed = output ? output.split('\n').map(line => JSON.parse(line)) : []
  check(changed.length === 1, 'Expected exactly one changed DB row', changed)
  return changed[0]
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(fn, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value
  do {
    value = await fn()
    if (value) return value
    await delay(500)
  } while (Date.now() < deadline)
  throw new Error(`Timed out after ${timeout}ms`)
}
async function api(path, token, method = 'GET', body) {
  const response = await fetch(`${API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await response.text()
  check(response.ok, `${method} ${path}: HTTP ${response.status} ${text}`, { status: response.status, body: redact(text) })
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}
let browser, wdk, fiat, address, token, user, adminToken
const detailTraces = []
async function localFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.equal(url.origin, 'https://dev.api.dfx.swiss', 'Unexpected module API origin')
  const response = await fetch(`${API}${url.pathname}${url.search}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (url.pathname === '/v1/auth' && response.ok) {
    const auth = await response.clone().json()
    if (auth.accessToken) secrets.add(auth.accessToken)
  }
  if (url.pathname === '/v1/auth/signMessage' && response.ok) {
    const challenge = await response.clone().json()
    assert(challenge.message.startsWith('[loc]_'), 'Expected local signing challenge')
  }
  if (url.pathname === '/v1/transaction/detail/single') {
    detailTraces.push({ query: url.search, status: response.status, body: await response.clone().json() })
  }
  return response
}
function requestRow(ext, type) {
  // Pricing may create several requests for one widget; retain all as evidence, choose latest valid.
  const requests = rows(`SELECT id, uid, type, status, "routeId", "sourceId", "targetId", amount,
    "estimatedAmount", "externalTransactionId", "isComplete", "isValid", "userId", "deactivatedAt"
    FROM transaction_request WHERE "externalTransactionId"=${quote(ext)} ORDER BY id DESC`)
  const request = requests.find(r => r.type === type && r.isValid && !r.deactivatedAt)
  check(request && request.userId === user.id && !request.isComplete, 'No valid open request owned by wallet', requests)
  const asset = one(`SELECT id,name,blockchain FROM asset WHERE id=${id(type === 'Buy' ? request.targetId : request.sourceId)}`)
  const currency = one(`SELECT id,name FROM fiat WHERE id=${id(type === 'Buy' ? request.sourceId : request.targetId)}`)
  check(asset.name === 'ETH' && asset.blockchain === 'Ethereum' && currency.name === 'CHF', 'Unexpected widget pair', { asset, currency, request })
  check(Math.abs(request.amount - (type === 'Buy' ? 100 : 0.1)) < 1e-9, 'Unexpected widget amount', request)
  return { request, requests }
}
async function widget(kind, ext) {
  const options = { cryptoAsset: 'ETH', fiatCurrency: 'CHF',
    ...(kind === 'buy' ? { fiatAmount: 10000n } : { cryptoAmount: 100000000000000000n }),
    config: { externalTransactionId: ext } }
  const trade = await fiat[kind](options)
  const url = new URL(trade[`${kind}Url`])
  assert.equal(url.origin, 'https://dev.app.dfx.swiss')
  assert.equal(url.searchParams.get('external-transaction-id'), ext)
  token = url.searchParams.get('session')
  assert(token, 'Widget session missing')
  secrets.add(token)
  url.protocol = new URL(APP).protocol
  url.host = new URL(APP).host
  return { url: url.toString(), ext, kind }
}
async function openWidget(spec) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  const captures = [], pending = new Set()
  page.on('response', response => {
    if (new URL(response.url()).origin !== API || new URL(response.url()).pathname !== `/v1/${spec.kind}/paymentInfos`
      || response.request().method() !== 'PUT') return
    const task = (async () => {
      const body = await response.text()
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = body }
      captures.push({ status: response.status(), request: response.request().postDataJSON(), body: parsed })
    })().catch(error => captures.push({ captureError: error.message }))
    pending.add(task)
    task.finally(() => pending.delete(task))
  })
  try {
    await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(expected => localStorage.getItem('dfx.authenticationToken') === expected, token)
    await page.getByRole('heading', { name: 'Payment Information', exact: true }).waitFor({ state: 'visible' })
    await poll(() => captures.findLast(c => c.status >= 200 && c.status < 300 && c.request?.externalTransactionId === spec.ext))
    const capture = captures.findLast(c => c.status >= 200 && c.status < 300 && c.request?.externalTransactionId === spec.ext)
    const text = await page.locator('body').innerText()
    if (spec.kind === 'buy') {
      assert(capture.body.iban, 'Payment response missing IBAN')
      assert(text.replace(/\s/g, '').includes(capture.body.iban.replace(/\s/g, '')), 'IBAN not rendered')
    } else {
      const req = requestRow(spec.ext, 'Sell').request
      const deposit = one(`SELECT d.address FROM deposit_route r JOIN deposit d ON d.id=r."depositId" WHERE r.id=${id(req.routeId)}`)
      assert.equal(capture.body.depositAddress?.toLowerCase(), deposit.address.toLowerCase(), 'API/DB deposit address mismatch')
      assert(text.toLowerCase().includes(deposit.address.toLowerCase()), 'Deposit address not rendered')
    }
    const shot = `shots/${runId}-${spec.kind}-${spec.ext.endsWith('mismatch') ? 'mismatch' : 'payment'}.png`
    await page.screenshot({ path: `${DIR}${shot}`, fullPage: true })
    return { shot, captures, ...requestRow(spec.ext, spec.kind === 'buy' ? 'Buy' : 'Sell') }
  } catch (error) {
    await Promise.allSettled([...pending])
    const shot = `shots/${runId}-${spec.ext}-failed.png`
    await page.screenshot({ path: `${DIR}${shot}`, fullPage: true }).catch(() => {})
    error.evidence = { captures, shot, pageText: redact(await page.locator('body').innerText().catch(() => 'unavailable')) }
    throw error
  } finally {
    await context.close()
  }
}
function buyEvidence(bankId) {
  return one(`SELECT b.id AS "buyCryptoId", b."buyId", b."bankTxId", b."inputAmount", b."inputAsset",
    b."amlCheck", b.status, b."isComplete", b."outputAssetId", t.id AS "transactionId", t.uid,
    t."externalId", t."requestId", t."userId", t.type
    FROM buy_crypto b JOIN "transaction" t ON t.id=b."transactionId" WHERE b."bankTxId"=${id(bankId)}`)
}
function seedBank(request, ext, amount) {
  // The ingest cron normally fills txAmount/txCurrency and creates the source transaction.
  const transaction = change(`INSERT INTO "transaction" ("sourceType",uid,"eventDate")
    VALUES ('BankTx',${quote(`T${randomBytes(8).toString('hex').toUpperCase()}`)},NOW())`)
  const bank = change(`INSERT INTO bank_tx ("accountServiceRef",amount,currency,"txAmount","txCurrency",
    "chargeAmount","creditDebitIndicator",iban,type,"bookingDate","valueDate","transactionId",name,"remittanceInfo")
    VALUES (${quote(ext)},${num(amount)},'CHF',${num(amount)},'CHF',0,'CRDT',${quote(IBAN)},'Unknown',
    NOW(),NOW(),${id(transaction.id)},'E2E Tester',${quote(ext)})`)
  return { bankId: bank.id, transactionId: transaction.id, amount, type: bank.type, requestId: request.id }
}
async function detail(ext, uid, expected, type) {
  const traceStart = detailTraces.length
  const byExternal = await fiat.getTransactionDetail(ext, { idType: 'externalTransactionId' })
  const byUid = await fiat.getTransactionDetail(uid, { idType: 'uid' })
  const traces = detailTraces.slice(traceStart)
  const evidence = { byExternal, byUid, traces }
  check(byExternal.status === expected && byUid.status === expected, `Expected ${expected}`, evidence)
  check(JSON.stringify(byExternal) === JSON.stringify(byUid), 'UID/external results differ', evidence)
  check(byExternal.cryptoAsset === 'ETH' && byExternal.fiatCurrency === 'CHF', 'Wrong asset/currency', evidence)
  check(traces.length === 2 && traces.every(t => t.status === 200 && t.body.uid === uid && t.body.type === type),
    'Raw API UID/direction mismatch', evidence)
  return evidence
}
async function main() {
  const imports = await step('load installed dependencies', async () => {
    const [{ default: WDK }, { default: WalletManagerEvm }, { default: DfxProtocol }, { chromium }, { ethers }] = await Promise.all([
      import('@tetherto/wdk'), import('@tetherto/wdk-wallet-evm'), import('@dfx.swiss/wdk-protocol-fiat-dfx'),
      import('playwright'), import('ethers')])
    wdk = new WDK(WDK.getRandomSeedPhrase())
      .registerWallet('ethereum', WalletManagerEvm, { provider: API })
      .registerProtocol('ethereum', 'dfx', DfxProtocol, { environment: 'sandbox', network: 'ethereum', language: 'en', fetch: localFetch })
    const account = await wdk.getAccount('ethereum', 0)
    address = await account.getAddress()
    fiat = account.getFiatProtocol('dfx')
    main.chromium = chromium
    main.ethers = ethers
    return { address }
  })
  const buyExt = `${runId}-buy`, mismatchExt = `${runId}-mismatch`, sellExt = `${runId}-sell`
  await step('seed fresh prices (as harness global.setup)', async () => {
    const referenceByPriceRuleId = {
      2: 123,
      3: 251,
      6: 123,
      7: 123,
      8: 123,
      9: 123,
      10: 123,
      11: 123,
      12: 123,
      13: 123,
      14: 123,
      16: 123,
      17: 123,
      18: 123,
      19: 123,
      20: 123,
      21: 123,
      22: 123,
      23: 123,
      24: 123,
      25: 123,
      26: 123,
      27: 123,
      28: 123,
      29: 123,
      30: 123,
      31: 123,
      32: 123,
      33: 123,
      34: 123,
      36: 123,
      37: 123,
      39: 123,
      41: 123,
      42: 123,
      43: 123,
      44: 123,
      45: 123,
      46: 123,
      47: 123,
      48: 123,
      49: 334,
      50: 123,
      51: 337,
      52: 123,
      53: 123,
      54: 123,
      55: 123,
      56: 123,
      57: 123,
      58: 123,
      61: 251,
      63: 123,
    }
    sql(`UPDATE price_rule
      SET "priceTimestamp" = now() + interval '4 hours'
      WHERE "currentPrice" IS NOT NULL`)
    for (const [priceRuleId, referenceId] of Object.entries(referenceByPriceRuleId)) {
      sql(`UPDATE price_rule SET "referenceId" = ${id(referenceId)} WHERE id = ${id(Number(priceRuleId))}`)
    }
    return { referenceRules: Object.keys(referenceByPriceRuleId).length }
  })
  let buySpec
  const registration = await step('WDK buy URL + local authentication', async () => {
    buySpec = await widget('buy', buyExt)
    user = one(`SELECT id,"userDataId",address FROM "user" WHERE lower(address)=lower(${quote(address)})`)
    return { user, url: redact(buySpec.url), externalTransactionId: buyExt }
  }, [imports])
  const kyc = await step('KYC + personal data (factory SQL)', async () => {
    await api('/v2/user/mail', token, 'PUT', { mail: `${runId}@example.com` })
    return change(`UPDATE user_data SET "kycLevel"=50,"depositLimit"=1000000,"accountType"='Personal',
      firstname='E2E',surname='Tester',street='Teststrasse',location='Zug',zip='6300',phone='+41791234567',
      "countryId"=(SELECT id FROM country WHERE symbol='CH'),
      "languageId"=(SELECT id FROM language WHERE symbol='EN') WHERE id=${id(user.userDataId)}`)
  }, [registration])
  const admin = await step('random admin + staff clearance + readiness', async () => {
    const wallet = main.ethers.Wallet.createRandom()
    async function login() {
      const { message } = await api(`/v1/auth/signMessage?address=${encodeURIComponent(wallet.address)}`)
      assert(message.startsWith('[loc]_'))
      const auth = await api('/v1/auth', null, 'POST', { address: wallet.address, signature: await wallet.signMessage(message) })
      assert(auth.accessToken)
      secrets.add(auth.accessToken)
      return auth.accessToken
    }
    await login()
    const staff = one(`SELECT id,"userDataId" FROM "user" WHERE lower(address)=lower(${quote(wallet.address)})`)
    sql(`BEGIN; UPDATE "user" SET role='Admin' WHERE id=${id(staff.id)};
      UPDATE user_data SET "verifiedName"='E2E Test Staff' WHERE id=${id(staff.userDataId)};
      INSERT INTO setting (key,value) VALUES ('staffKycClearance',${quote(JSON.stringify([staff.userDataId]))})
      ON CONFLICT (key) DO UPDATE SET value=(SELECT jsonb_agg(DISTINCT item)::text FROM
        jsonb_array_elements(setting.value::jsonb || EXCLUDED.value::jsonb) item); COMMIT;`)
    adminToken = await login()
    assert.equal(JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64url')).role, 'Admin')
    await poll(async () => {
      try { await api('/v1/userData', adminToken); return true } catch (e) {
        if (e.message.includes('HTTP 403') && e.message.includes('STAFF_KYC_REQUIRED')) return false
        throw e
      }
    }, 90000)
    return { ...staff, address: wallet.address, clearanceReady: true }
  }, [imports])
  const browserReady = await step('launch Chromium', async () => {
    browser = await main.chromium.launch({ headless: true })
    return { headless: true }
  }, [imports])
  const payment = await step('buy widget: payment information + request', () => openWidget(buySpec), [kyc, browserReady])
  const bank = await step('buy: unassigned bank transfer SQL', () => seedBank(payment.request, buyExt, payment.request.amount), [payment])
  const assigned = await step('buy: admin bankTx assignment + DB linkage', async () => {
    await api(`/v1/bankTx/${id(bank.bankId)}`, adminToken, 'PUT', { type: 'BuyCrypto', buyId: payment.request.routeId })
    const evidence = buyEvidence(bank.bankId)
    const req = one(`SELECT id,"isComplete",status FROM transaction_request WHERE id=${id(evidence.requestId)}`)
    check(evidence.externalId === buyExt && evidence.userId === user.id && req.isComplete,
      'Backend did not complete/link external request', { evidence, req })
    return { ...evidence, request: req }
  }, [bank, admin])
  await step('buy: module in_progress, external ID = UID', () => detail(buyExt, assigned.uid, 'in_progress', 'Buy'), [assigned])
  const completed = await step('buy: simulate completed_buy fields', async () => {
    const amount = payment.request.estimatedAmount
    check(amount > 0, 'Invalid quoted output amount', payment.request)
    sql(`BEGIN; UPDATE buy_crypto SET status='Complete',"isComplete"=true,"amlPostProcessed"=true,"amlCheck"='Pass',
      "amlReason"=NULL,"amountInChf"=${num(payment.request.amount)},"amountInEur"=${num(payment.request.amount)},
      "outputAmount"=${num(amount)},"outputReferenceAmount"=${num(amount)},"outputAssetId"=${id(payment.request.targetId)},
      "outputReferenceAssetId"=${id(payment.request.targetId)},"outputDate"=NOW(),"txId"=${quote(`0x${randomBytes(32).toString('hex')}`)}
      WHERE id=${id(assigned.buyCryptoId)};
      UPDATE "transaction" SET "amlCheck"='Pass',"outputDate"=NOW() WHERE id=${id(assigned.transactionId)}; COMMIT;`)
    return buyEvidence(bank.bankId)
  }, [assigned])
  await step('buy: module completed', () => detail(buyExt, assigned.uid, 'completed', 'Buy'), [completed])
  const failed = await step('buy: simulate failed without refund fields', async () => {
    sql(`BEGIN; UPDATE buy_crypto SET status='Created',"isComplete"=false,"amlCheck"='Fail',"amlReason"=NULL,
      "outputDate"=NULL,"txId"=NULL,"chargebackDate"=NULL,"chargebackAllowedDate"=NULL,"chargebackAllowedDateUser"=NULL
      WHERE id=${id(assigned.buyCryptoId)};
      UPDATE "transaction" SET "amlCheck"='Fail',"outputDate"=NULL WHERE id=${id(assigned.transactionId)}; COMMIT;`)
    return buyEvidence(bank.bankId)
  }, [assigned])
  await step('buy: module failed', () => detail(buyExt, assigned.uid, 'failed', 'Buy'), [failed])

  let mismatchSpec
  const mismatchUrl = await step('heuristic: second buy URL', async () => {
    mismatchSpec = await widget('buy', mismatchExt)
    return { url: redact(mismatchSpec.url), externalTransactionId: mismatchExt }
  }, [kyc])
  const mismatch = await step('heuristic: widget payment information + request', () => openWidget(mismatchSpec), [mismatchUrl, browserReady])
  const wrongBank = await step('heuristic: bank amount +10 percent', () => {
    const amount = mismatch.request.amount * 1.10
    assert(mismatch.request.amount < amount * 0.99)
    return seedBank(mismatch.request, mismatchExt, amount)
  }, [mismatch])
  await step('heuristic: admin assigns route, request must stay unmatched', async () => {
    await api(`/v1/bankTx/${id(wrongBank.bankId)}`, adminToken, 'PUT', { type: 'BuyCrypto', buyId: mismatch.request.routeId })
    const transaction = buyEvidence(wrongBank.bankId)
    const requests = rows(`SELECT id,"isComplete",status FROM transaction_request WHERE "externalTransactionId"=${quote(mismatchExt)}`)
    const evidence = { transaction, requests, routeAssigned: transaction.buyId === mismatch.request.routeId,
      externalRequestMatched: transaction.externalId === mismatchExt }
    check(evidence.routeAssigned && transaction.externalId == null && transaction.requestId == null && requests.every(r => !r.isComplete),
      'Unexpected heuristic match outside tolerance', evidence)
    return evidence
  }, [wrongBank, admin])
  await step('heuristic: module NoSuchElementError for second ID', async () => {
    const start = detailTraces.length
    try {
      const value = await fiat.getTransactionDetail(mismatchExt, { idType: 'externalTransactionId' })
      throw Object.assign(new Error('Expected NoSuchElementError, got a transaction'), { evidence: value })
    } catch (error) {
      if (error.constructor.name !== 'NoSuchElementError') throw error
      const traces = detailTraces.slice(start)
      check(traces.some(t => t.status === 404), 'Missing backend 404 evidence', traces)
      return { error: error.constructor.name, traces }
    }
  }, [wrongBank, admin])

  const deposits = await step('seed deposit addresses (as harness global.setup)', async () => {
    const mnemonic = process.env.E2E_EVM_DEPOSIT_SEED || execFileSync('docker',
      ['exec', API_CONTAINER, 'printenv', 'EVM_DEPOSIT_SEED'],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    assert(mnemonic, 'EVM deposit seed is missing')
    secrets.add(mnemonic)
    const blockchains = 'Ethereum;Sepolia;BinanceSmartChain;Arbitrum;Optimism;Polygon;Base;Gnosis;Haqq'
    for (let i = 0; i < 200; i++) {
      const wallet = main.ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`)
      sql(`INSERT INTO deposit (address, blockchains, "accountIndex", created, updated)
        SELECT ${quote(wallet.address)}::text, ${quote(blockchains)}::text, ${num(i)}::int, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM deposit WHERE address = ${quote(wallet.address)})`)
    }
    return { poolSize: 200, blockchains }
  }, [imports])
  const bankAccount = await step('sell: bank account via factory API', async () => {
    const result = await api('/v1/bankAccount', token, 'POST', { iban: IBAN, label: runId })
    id(result.id)
    return { id: result.id, iban: result.iban }
  }, [kyc])
  let sellSpec
  const sellUrl = await step('WDK sell URL', async () => {
    sellSpec = await widget('sell', sellExt)
    return { url: redact(sellSpec.url), externalTransactionId: sellExt }
  }, [kyc])
  const sellPayment = await step('sell widget: deposit address + request', () => openWidget(sellSpec), [sellUrl, bankAccount, browserReady, deposits])
  const sellFixture = await step('sell: SQL pending_sell (assignment NOT backend-tested)', async () => {
    const r = sellPayment.request
    const deposit = one(`SELECT d.address FROM deposit_route r JOIN deposit d ON d.id=r."depositId" WHERE r.id=${id(r.routeId)}`)
    const txUid = `T${randomBytes(8).toString('hex').toUpperCase()}`
    // One atomic fixture, matching factory structure. Explicit output fiat also supports current module mapping.
    const output = sql(`WITH tx AS (
      INSERT INTO "transaction" ("sourceType",type,uid,"externalId","amountInChf",assets,"amlCheck","userId","userDataId","eventDate")
      VALUES ('CryptoInput','BuyFiat',${quote(txUid)},${quote(sellExt)},${num(r.estimatedAmount)},'ETH','Pending',${id(user.id)},${id(user.userDataId)},NOW()) RETURNING id,uid
    ), ci AS (
      INSERT INTO crypto_input ("inTxId",amount,"isConfirmed","addressAddress","addressBlockchain",
        "destinationAddressAddress","destinationAddressBlockchain","assetId",status,purpose,"transactionId")
      SELECT ${quote(`0x${randomBytes(32).toString('hex')}`)},${num(r.amount)},true,${quote(deposit.address)},'Ethereum',
        ${quote(deposit.address)},'Ethereum',${id(r.sourceId)},'Completed','BuyFiat',tx.id FROM tx RETURNING id
    ), bf AS (
      INSERT INTO buy_fiat ("transactionId","cryptoInputId","sellId","isComplete","amlPostProcessed","amlCheck",
        "inputAmount","inputAsset","inputReferenceAmount","inputReferenceAsset","amountInChf","amountInEur","outputAssetId","outputReferenceAssetId")
      SELECT tx.id,ci.id,${id(r.routeId)},false,true,'Pending',${num(r.amount)},'ETH',${num(r.amount)},'ETH',
        ${num(r.estimatedAmount)},${num(r.estimatedAmount)},${id(r.targetId)},${id(r.targetId)} FROM tx,ci RETURNING id
    ) SELECT json_build_object('transactionId',tx.id,'uid',tx.uid,'buyFiatId',bf.id,'cryptoInputId',ci.id,
      'externalId',${quote(sellExt)},'assignmentViaBackend',false) FROM tx,ci,bf`)
    return JSON.parse(output)
  }, [sellPayment])
  await step('sell: module in_progress + direction/assets', () => detail(sellExt, sellFixture.uid, 'in_progress', 'Sell'), [sellFixture])
  const sellComplete = await step('sell: SQL completed_sell', async () => {
    sql(`BEGIN; UPDATE buy_fiat SET "isComplete"=true,"amlCheck"='Pass',"outputAmount"=${num(sellPayment.request.estimatedAmount)},
      "outputDate"=NOW() WHERE id=${id(sellFixture.buyFiatId)};
      UPDATE "transaction" SET "amlCheck"='Pass',"outputDate"=NOW() WHERE id=${id(sellFixture.transactionId)}; COMMIT;`)
    return one(`SELECT b.id,b."isComplete",b."amlCheck",b."outputAmount",b."outputDate",t.uid,t."externalId"
      FROM buy_fiat b JOIN "transaction" t ON t.id=b."transactionId" WHERE b.id=${id(sellFixture.buyFiatId)}`)
  }, [sellFixture])
  await step('sell: module completed + direction/assets', () => detail(sellExt, sellFixture.uid, 'completed', 'Sell'), [sellComplete])
}
try {
  await main()
} catch (error) {
  await step('unexpected runner failure', () => { throw error })
} finally {
  if (browser) await step('close browser', async () => { await browser.close(); return { closed: true } })
  if (wdk) await step('dispose wallet', async () => { await wdk.dispose(); return { disposed: true } })
  results.finishedAt = new Date().toISOString()
  results.ok = results.steps.every(s => s.ok)
  persist()
  process.exitCode = results.ok ? 0 : 1
}

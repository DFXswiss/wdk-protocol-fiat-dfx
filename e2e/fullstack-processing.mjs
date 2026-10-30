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
const DIR = fileURLToPath(new URL('./out/', import.meta.url))
const runId = `wdk-processing-${Date.now()}-${randomUUID().slice(0, 8)}`
const IBAN = 'CH9300762011623852957'
const secrets = new Set()
const results = {
  runId, startedAt: new Date().toISOString(), api: API, app: APP,
  sellAssignment: 'Created pay-in fixture only; BuyFiat must create/link the sale through findAndComplete.',
  expectedProcesses: ['BuyCrypto', 'BuyFiat', 'AutoAmlCheck', 'BuyCryptoRefreshFee', 'BuyFiatSetFee'],
  sequences: {}, registration: {},
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
  writeFileSync(`${DIR}fullstack-processing.json.tmp`, redact(results) + '\n', { mode: 0o600 })
  renameSync(`${DIR}fullstack-processing.json.tmp`, `${DIR}fullstack-processing.json`)
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
function seedPayIn(request, amount = request.amount) {
  const deposit = one(`SELECT d.address,d.blockchains FROM deposit_route r
    JOIN deposit d ON d.id=r."depositId" WHERE r.id=${id(request.routeId)}`)
  check(deposit.blockchains.split(';').includes('Ethereum'), 'Sell route does not accept Ethereum', deposit)
  // payin.service.ts:96-138 creates an unassigned source transaction before saving the input.
  // crypto-input.entity.ts:37-59,145-146,178-205: Created / Deposit, unconfirmed, no purpose/route yet.
  // getNewPayIns (payin.service.ts:206-217) accepts Created + Deposit; registration matches
  // addressAddress/addressBlockchain against sell.deposit (buy-fiat-registration.service.ts:95-132).
  // Unlike factories.ts:1102-1140 (completed_sell), do not seed Completed, BuyFiat or a destination.
  const output = sql(`WITH tx AS (
    INSERT INTO "transaction" ("sourceType",uid,"eventDate")
    VALUES ('CryptoInput',${quote(`T${randomBytes(8).toString('hex').toUpperCase()}`)},NOW()) RETURNING id
  ), ci AS (
    INSERT INTO crypto_input ("transactionId","inTxId",amount,"assetId",status,"txType",
      "isConfirmed","addressAddress","addressBlockchain")
    SELECT tx.id,${quote(`0x${randomBytes(32).toString('hex')}`)},${num(amount)},${id(request.sourceId)},
      'Created','Deposit',false,${quote(deposit.address)},'Ethereum' FROM tx RETURNING *
  ) SELECT row_to_json(ci) FROM ci`)
  const input = JSON.parse(output)
  check(input.status === 'Created' && input.purpose == null && input.routeId == null,
    'New input must not already be assigned', input)
  return input
}
function processingRow(kind, sourceId) {
  const table = kind === 'buy' ? 'buy_crypto' : 'buy_fiat'
  const sourceColumn = kind === 'buy' ? 'bankTxId' : 'cryptoInputId'
  return one(`SELECT b.id,b."amlCheck",b."amlReason",b."isComplete",b."outputAmount",
    to_jsonb(b)->>'status' AS status,b."totalFeeAmount",b."blockchainFee",b."outputDate",
    t.id AS "transactionId",t.uid,t."externalId",t."requestId",t."userId",t.type,
    ${kind === 'buy' ? 'b."buyId"' : 'b."sellId"'} AS "routeId",
    ${kind === 'buy' ? 'NULL::json' : `(SELECT json_build_object('status',ci.status,
      'isConfirmed',ci."isConfirmed",'outTxId',ci."outTxId") FROM crypto_input ci WHERE ci.id=b."cryptoInputId")`} AS "payIn"
    FROM ${table} b JOIN "transaction" t ON t.id=b."transactionId"
    WHERE b."${sourceColumn}"=${id(sourceId)}`)
}
function saleEvidence(inputId, ext) {
  return {
    input: one(`SELECT id,status,purpose,"isConfirmed","routeId","transactionId",amount,"assetId",
      "addressAddress","addressBlockchain","outTxId" FROM crypto_input WHERE id=${id(inputId)}`),
    sale: rows(`SELECT b.id,b."sellId",b."cryptoInputId",b."amlCheck",b."isComplete",
      t.id AS "transactionId",t.uid,t."externalId",t."requestId",t."userId"
      FROM buy_fiat b JOIN "transaction" t ON t.id=b."transactionId"
      WHERE b."cryptoInputId"=${id(inputId)}`)[0] ?? null,
    requests: rows(`SELECT id,"isComplete","isValid",status,"externalTransactionId"
      FROM transaction_request WHERE "externalTransactionId"=${quote(ext)} ORDER BY id`)
  }
}
async function waitForSale(label, input, ext) {
  const started = Date.now(), deadline = started + 180000
  const samples = results.registration[label] = []
  do {
    const evidence = saleEvidence(input.id, ext)
    samples.push({ time: new Date().toISOString(), elapsedSeconds: (Date.now() - started) / 1000, ...evidence })
    persist()
    console.log(`${label} registration ${redact(samples.at(-1))}`)
    if (evidence.sale) return evidence
    if (Date.now() >= deadline) break
    await delay(Math.min(20000, deadline - Date.now()))
  } while (true)
  check(false, 'BuyFiat did not create a sale within three minutes; see registration evidence', samples)
}
function stoppingPoint(kind, sample) {
  const b = sample.database
  if (!b) return 'No database snapshot; cause undetermined (see errors).'
  const observations = [`DFX=${sample.dfxState ?? 'unavailable'}, module=${sample.moduleStatus ?? 'unavailable'}`,
    `amlCheck=${b.amlCheck}, amlReason=${b.amlReason}, status=${b.status}, isComplete=${b.isComplete}`,
    `outputAmount=${b.outputAmount}, totalFeeAmount=${b.totalFeeAmount}, blockchainFee=${b.blockchainFee}`]
  if (b.amlReason) observations.push(`Backend reports AML reason: ${b.amlReason}`)
  if (b.totalFeeAmount == null) observations.push('Fee not populated at observation end.')
  if (kind === 'sell') observations.push(`Pay-in status=${b.payIn?.status}, confirmed=${b.payIn?.isConfirmed}, outTxId=${b.payIn?.outTxId}. PayIn is disabled by the supplied configuration.`)
  observations.push('Payout jobs are disabled by the supplied stack configuration; no real payout is expected.')
  observations.push('These fields show the stopping point, not proof of a unique root cause; job logs were not inspected.')
  return observations.join(' ')
}
async function observe(kind, ext, readDatabase) {
  const started = Date.now(), deadline = started + 360000
  const samples = results.sequences[kind] = []
  do {
    const sample = { time: new Date().toISOString(), elapsedSeconds: (Date.now() - started) / 1000 }
    const traceStart = detailTraces.length
    try {
      sample.module = await fiat.getTransactionDetail(ext, { idType: 'externalTransactionId' })
      sample.moduleStatus = sample.module.status
    } catch (error) {
      sample.moduleError = { name: error.constructor.name, message: redact(error.message) }
    }
    sample.traces = detailTraces.slice(traceStart)
    const raw = sample.traces.findLast(t => t.status === 200)?.body
    sample.dfxState = raw?.state ?? null
    sample.dfxReason = raw?.reason ?? null
    try { sample.database = readDatabase() }
    catch (error) { sample.databaseError = redact(error.message) }
    samples.push(sample)
    persist()
    console.log(`${kind} processing ${redact(sample)}`)
    if (sample.moduleStatus === 'completed' || sample.database?.isComplete === true || Date.now() >= deadline) break
    // Schedule from the start, avoiding cumulative request latency drift.
    const next = Math.min(deadline, started + (Math.floor((Date.now() - started) / 20000) + 1) * 20000)
    await delay(Math.max(0, next - Date.now()))
  } while (true)
  const conclusion = stoppingPoint(kind, samples.at(-1))
  results[`${kind}StoppingPoint`] = conclusion
  console.log(`${kind}: ${redact(conclusion)}`)
  printSequence(kind, samples)
  const evidence = { samples, conclusion }
  check(samples.every(s => !s.moduleError && !s.databaseError && s.dfxState != null),
    'Processing observation contains failed queries or missing DFX state', evidence)
  check(samples.every(s => s.moduleStatus !== 'completed' && s.database.isComplete !== true),
    'Unexpected completion with payout jobs disabled', evidence)
  check(samples.every(s => s.database.externalId === ext && s.database.userId === user.id
    && s.traces.some(t => t.status === 200 && t.body.uid === s.database.uid
      && t.body.type === (kind === 'buy' ? 'Buy' : 'Sell'))), 'Processing identity/direction mismatch', evidence)
  check(samples.some(s => s.database.amlCheck != null
    || s.database.totalFeeAmount != null || (s.database.status != null && s.database.status !== 'Created')),
  'No AML, fee or status processing beyond initial registration observed in six minutes', evidence)
  return evidence
}
function printSequence(label, samples) {
  console.log(`\n${label} state sequence`)
  console.table(samples.map(s => ({ time: s.time, seconds: Math.round(s.elapsedSeconds),
    DFX: s.dfxState, module: s.moduleStatus ?? s.moduleError?.name, amlCheck: s.database?.amlCheck,
    status: s.database?.status, isComplete: s.database?.isComplete, outputAmount: s.database?.outputAmount,
    totalFeeAmount: s.database?.totalFeeAmount, blockchainFee: s.database?.blockchainFee })))
}
async function main() {
  const imports = await step('load installed dependencies', async () => {
    const [{ default: WDK }, { default: WalletManagerEvm }, { default: DfxProtocol }, { chromium }, { ethers }] = await Promise.all([
      import('@tetherto/wdk'), import('@tetherto/wdk-wallet-evm'), import('@dfx.swiss/wdk-protocol-fiat-dfx'),
      import('playwright'), import('ethers')])
    const seed = WDK.getRandomSeedPhrase()
    secrets.add(seed)
    wdk = new WDK(seed)
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
  await step('buy: observe real processing for six minutes', () => observe('buy', buyExt, () => processingRow('buy', bank.bankId)), [assigned])

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
  const sellInput = await step('sell: seed newly detected crypto deposit', () => seedPayIn(sellPayment.request), [sellPayment])
  const sellRegistered = await step('sell: wait up to three minutes for BuyFiat registration',
    () => waitForSale('sell', sellInput, sellExt), [sellInput])
  await step('sell: backend completed and linked request', () => {
    const evidence = saleEvidence(sellInput.id, sellExt)
    const b = evidence.sale
    check(b && b.externalId === sellExt && b.userId === user.id && b.sellId === sellPayment.request.routeId
      && evidence.requests.some(r => r.id === b.requestId && r.isComplete),
    'Backend did not link and complete our sell request', evidence)
    return { ...evidence, assignmentViaBackend: true,
      path: 'registerSellPayIn -> createFromCryptoInput -> findAndComplete -> transactionService.updateInternal' }
  }, [sellRegistered])
  await step('sell: observe real processing for six minutes',
    () => observe('sell', sellExt, () => processingRow('sell', sellInput.id)), [sellRegistered])

  let mismatchSpec
  const mismatchUrl = await step('sell mismatch: second WDK sell URL', async () => {
    mismatchSpec = await widget('sell', mismatchExt)
    return { url: redact(mismatchSpec.url), externalTransactionId: mismatchExt }
  }, [kyc])
  const mismatchPayment = await step('sell mismatch: deposit address + request',
    () => openWidget(mismatchSpec), [mismatchUrl, bankAccount, browserReady, deposits])
  const mismatchInput = await step('sell mismatch: deposit amount +10 percent', () => {
    const amount = mismatchPayment.request.amount * 1.10
    assert(mismatchPayment.request.amount < amount * 0.99)
    return seedPayIn(mismatchPayment.request, amount)
  }, [mismatchPayment])
  const mismatchRegistered = await step('sell mismatch: wait for backend registration',
    () => waitForSale('sellMismatch', mismatchInput, mismatchExt), [mismatchInput])
  await step('sell mismatch: route recognized but request unmatched', () => {
    const evidence = saleEvidence(mismatchInput.id, mismatchExt)
    check(evidence.sale && evidence.sale.sellId === mismatchPayment.request.routeId
      && evidence.sale.externalId == null && evidence.sale.requestId == null
      && evidence.requests.length > 0 && evidence.requests.every(r => !r.isComplete),
    'Observed unexpected backend assignment outside amount tolerance', evidence)
    return evidence
  }, [mismatchRegistered])
  await step('sell mismatch: module NoSuchElementError', async () => {
    const start = detailTraces.length
    let value, caught
    try { value = await fiat.getTransactionDetail(mismatchExt, { idType: 'externalTransactionId' }) }
    catch (error) { caught = error }
    const evidence = { value, error: caught ? { name: caught.constructor.name, message: redact(caught.message) } : null,
      traces: detailTraces.slice(start), database: saleEvidence(mismatchInput.id, mismatchExt) }
    check(caught?.constructor.name === 'NoSuchElementError' && evidence.traces.some(t => t.status === 404),
      'Observed a result other than NoSuchElementError with backend 404', evidence)
    return evidence
  }, [mismatchInput])
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

#!/usr/bin/env node
// Local integration probe. Run only against the disposable dfx-e2e-wdk2 stack.
// Fixture data is retained for inspection; no tokens or wallet seeds are persisted.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes, randomInt } from 'node:crypto'
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
const DB_CONTAINER = process.env.DFX_LOCAL_DB_CONTAINER ?? 'dfx-e2e-wdk2-db-1'
const API_CONTAINER = process.env.DFX_LOCAL_API_CONTAINER ?? DB_CONTAINER.replace(/-db-1$/, '-api-1')
const WINDOW = Number(process.env.OBSERVE_MINUTES ?? 15) * 60 * 1000
assert(Number.isFinite(WINDOW) && WINDOW > 0, 'OBSERVE_MINUTES must be a finite positive number of minutes')
const selectedScenarios = new Set((process.env.LIFECYCLE_SCENARIOS ?? 'buyA,buyB,sell').split(',').map(value => value.trim()))
assert([...selectedScenarios].every(value => ['buyA', 'buyB', 'sell'].includes(value)),
  'LIFECYCLE_SCENARIOS must be a comma-separated selection of buyA,buyB,sell')
const needsPrimaryWallet = selectedScenarios.has('buyA') || selectedScenarios.has('sell')
const DIR = fileURLToPath(new URL('./out/', import.meta.url))
const runId = `wdk-lifecycle-${Date.now()}-${randomUUID().slice(0, 8)}`
const scenarioIbans = new Set()
function createScenarioIban() {
  let iban
  do {
    const bban = '00762' + Array.from({ length: 12 }, () => randomInt(10)).join('')
    const checksum = String(98n - BigInt(`${bban}121700`) % 97n).padStart(2, '0')
    iban = `CH${checksum}${bban}`
  } while (scenarioIbans.has(iban))
  assert.match(iban, /^CH\d{2}00762\d{12}$/)
  const rearranged = (iban.slice(4) + iban.slice(0, 4))
    .replace(/[A-Z]/g, letter => String(letter.charCodeAt(0) - 55))
  assert.equal(BigInt(rearranged) % 97n, 1n, 'Invalid scenario IBAN checksum')
  scenarioIbans.add(iban)
  return iban
}
const secrets = new Set()
const results = {
  runId, startedAt: new Date().toISOString(), api: API, app: APP,
  observeMinutes: WINDOW / (60 * 1000), selectedScenarios: [...selectedScenarios],
  sellAssignment: 'Created pay-in fixture only; BuyFiat must create/link the sale through findAndComplete.',
  expectedProcesses: ['BuyCrypto', 'BuyFiat', 'AutoAmlCheck', 'BuyCryptoRefreshFee', 'BuyFiatSetFee'],
  scenarios: {},
  limitations: ['No real bank transfer, blockchain deposit or payout', 'Fixture data retained in local DB',
    'Completed Ident is simulated with KYC level 50, verifiedName and lastNameCheckDate=now(); the external name-check provider is not tested',
    'Backend robustness finding: NameCheckService.classifyRiskData crashes on an empty provider response with TypeError: Cannot read properties of undefined (reading \'every\'), observed 2026-09-25',
    'Environment preparation seeds a numeric referral code when absent; backend user.repository.ts:67-75 (UserRepository.getNextRef) crashes on an empty numeric-ref set (null.ref), observed 2026-09-25',
    'Module detail has no direction or uid field; raw API DTO and DB prove direction and identity'],
  steps: []
}
mkdirSync(`${DIR}shots`, { recursive: true })
function redact(value) {
  const sensitiveKey = /^(?:accessToken|refreshToken|token|session|privateKey|mnemonic|seed|EVM_DEPOSIT_SEED)$/i
  let text = typeof value === 'string' ? value : JSON.stringify(value, (key, v) =>
    sensitiveKey.test(key) ? '[REDACTED]' : typeof v === 'bigint' ? v.toString() : v)
  text ??= 'null'
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]')
    .replace(/([?&]session=)[^&\s"<>]+/g, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
}

function persist() {
  writeFileSync(`${DIR}fullstack-lifecycle.json.tmp`, redact(results) + '\n', { mode: 0o600 })
  renameSync(`${DIR}fullstack-lifecycle.json.tmp`, `${DIR}fullstack-lifecycle.json`)
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
function dbTimestampMs(value) {
  if (typeof value !== 'string') return NaN
  // PostgreSQL timestamps without a zone represent UTC in this database.
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
  return Date.parse(zoneless ? `${value.replace(' ', 'T')}Z` : value)
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
let browser, wdk, fiat, address, token, user, adminToken, adminVerifiedName
const wallets = []
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
async function openWidget(spec, context, sellIban) {
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
    if (spec.kind === 'sell') {
      const selector = page.getByText('Add or select your IBAN', { exact: true })
      const payment = page.getByRole('heading', { name: 'Payment Information', exact: true })
      await selector.or(payment).first().waitFor({ state: 'visible' })
      if (await selector.isVisible()) {
        assert.match(sellIban, /^CH\d+$/)
        await selector.click()
        await page.getByText(new RegExp(sellIban.split('').join('\\s*'))).click()
      }
    }
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
    const shot = `shots/${spec.ext}-payment.png`
    await page.screenshot({ path: `${DIR}${shot}`, fullPage: true })
    return { shot, captures, ...requestRow(spec.ext, spec.kind === 'buy' ? 'Buy' : 'Sell') }
  } catch (error) {
    await Promise.allSettled([...pending])
    const shot = `shots/${runId}-${spec.ext}-failed.png`
    await page.screenshot({ path: `${DIR}${shot}`, fullPage: true }).catch(() => {})
    error.evidence = { captures, shot, pageText: redact(await page.locator('body').innerText().catch(() => 'unavailable')) }
    throw error
  }
}
function seedBank(request, ext, amount, iban) {
  // The ingest cron normally fills txAmount/txCurrency and creates the source transaction.
  const transaction = change(`INSERT INTO "transaction" ("sourceType",uid,"eventDate")
    VALUES ('BankTx',${quote(`T${randomBytes(8).toString('hex').toUpperCase()}`)},NOW())`)
  const bank = change(`INSERT INTO bank_tx ("accountServiceRef",amount,currency,"txAmount","txCurrency",
    "chargeAmount","creditDebitIndicator",iban,"senderAccount",type,"bookingDate","valueDate","transactionId",name,"remittanceInfo")
    VALUES (${quote(ext)},${num(amount)},'CHF',${num(amount)},'CHF',0,'CRDT',${quote(iban)},${quote(iban)},'Unknown',
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

// Source paths below are relative to ../stack/api/src at implementation time.
// BuyCrypto/BuyFiat jobs run EVERY_MINUTE (their *-job.service.ts:24 / :15).
const INTERVAL = 20000
const JOB_CYCLE = 60000
const failedStates = new Set(['Failed', 'Returned', 'Stopped', 'LimitExceeded', 'FeeTooHigh', 'PriceUndeterminable'])
const expectedStatus = state => state === 'Completed' ? 'completed' : failedStates.has(state) ? 'failed' : 'in_progress'

function scenario(label, kind, ext) {
  const item = { label, kind, ext, iban: createScenarioIban(), timeline: [], observations: [], events: [], halted: [] }
  results.scenarios[label] = item
  return item
}
async function runScenario(s, fn) {
  let context
  try {
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
    await fn(context)
  } catch (error) {
    await step(`${s.label}: unexpected scenario failure`, () => { throw error })
  } finally {
    if (context) await step(`${s.label}: close context`, async () => {
      await context.close()
      return { closed: true }
    })
  }
}
function database(s) {
  if (!s.sourceId) return null
  const buy = s.kind === 'buy'
  const found = rows(`SELECT b.id,b."amlCheck",b."amlReason",b.comment,b."isComplete",b."outputAmount",
    b."totalFeeAmount",b."blockchainFee",b."outputDate",b."amountInChf",b."amountInEur",
    b."inputAmount",b."inputAsset",b."inputReferenceAmountMinusFee",b."outputReferenceAmount",
    to_jsonb(b)->>'status' AS status, to_jsonb(b)->>'txId' AS "txId",
    b."chargebackDate",b."chargebackAllowedDate",b."chargebackAmount",b."chargebackAsset",
    t.id AS "transactionId",t.uid,t."externalId",t."requestId",t."userId",t.type,
    t."outputDate" AS "transactionOutputDate",
    ${buy ? `b."bankTxId",b."chargebackBankTxId",b."chargebackOutputId" AS "fiatOutputId",
      (SELECT json_build_object('id',f.id,'estimatePayoutFeeAmount',f."estimatePayoutFeeAmount",
        'actualPayoutFeeAmount',f."actualPayoutFeeAmount",'actualPayoutFeePercent',f."actualPayoutFeePercent")
        FROM buy_crypto_fee f WHERE f."buyCryptoId"=b.id) AS "payoutFee", NULL::json AS "payIn"`
      : `b."bankTxId",b."fiatOutputId", NULL::json AS "payoutFee",
      (SELECT json_build_object('id',ci.id,'status',ci.status,'purpose',ci.purpose,
        'isConfirmed',ci."isConfirmed",'outTxId',ci."outTxId") FROM crypto_input ci
        WHERE ci.id=b."cryptoInputId") AS "payIn"`},
    (SELECT json_build_object('id',f.id,'type',f.type,'amount',f.amount,'currency',f.currency,
      'iban',f.iban,'remittanceInfo',f."remittanceInfo",'bankTxId',f."bankTxId",'outputDate',f."outputDate",
      'isComplete',f."isComplete",'isTransmittedDate',f."isTransmittedDate") FROM fiat_output f
      WHERE f.id=b."${buy ? 'chargebackOutputId' : 'fiatOutputId'}") AS "fiatOutput"
    FROM ${buy ? 'buy_crypto' : 'buy_fiat'} b JOIN "transaction" t ON t.id=b."transactionId"
    WHERE b."${buy ? 'bankTxId' : 'cryptoInputId'}"=${id(s.sourceId)}`)
  check(found.length <= 1, 'Multiple lifecycle rows for one source', found)
  return found[0] ?? null
}
function halt(s, event, reason) {
  const evidence = { time: new Date().toISOString(), event, outcome: 'not_reached', reason }
  s.halted.push(evidence)
  console.log(`FAIL ${s.label}: ${event}: backend stopping point: ${reason}`)
  results.steps.push({ name: `${s.label}: ${event}`, ok: false, evidence })
  persist()
  return undefined
}
async function observe(s, event, { waitForAml = false, allowUnregistered = false, waitForRegistration = allowUnregistered,
  waitForBank = false, waitForCompleted = false } = {}) {
  const started = Date.now(), deadline = started + WINDOW
  const samples = []
  let previous, equalCount = 0, unchangedSince = started
  const observation = { event, startedAt: new Date(started).toISOString(), samples }
  s.observations.push(observation)
  do {
    const sample = { time: new Date().toISOString(), event, elapsedSeconds: (Date.now() - started) / 1000 }
    const traceStart = detailTraces.length
    try {
      sample.module = await fiat.getTransactionDetail(s.ext, { idType: 'externalTransactionId' })
      sample.moduleStatus = sample.module.status
    } catch (error) {
      sample.moduleError = { name: error.constructor.name, message: redact(error.message) }
    }
    sample.traces = detailTraces.slice(traceStart)
    const raw = sample.traces.findLast(t => t.status === 200)?.body
    sample.dfxState = raw?.state ?? null
    sample.dfxReason = raw?.reason ?? null
    try { sample.database = database(s) }
    catch (error) { sample.databaseError = redact(error.message) }
    // During real BuyFiat registration the external request has no transaction detail yet.
    // This observed 404 is an expected absence, not a failed transport/query.
    // The registration job can link the row between the HTTP read and the SQL read.
    const notRegistered = allowUnregistered && !sample.databaseError
      && !samples.some(x => x.dfxState != null && x.database)
      && sample.moduleError?.name === 'NoSuchElementError'
      && sample.traces.some(t => t.status === 404)
    sample.pendingRegistration = notRegistered
    sample.errors = []
    if (sample.databaseError) sample.errors.push(sample.databaseError)
    if (!allowUnregistered && !sample.database && !sample.databaseError) sample.errors.push('Lifecycle database row disappeared')
    if (sample.moduleError && !notRegistered) sample.errors.push(sample.moduleError.message)
    if (!sample.moduleError && typeof sample.dfxState !== 'string') sample.errors.push('Missing raw DFX state')
    if (sample.dfxState != null && sample.moduleStatus !== expectedStatus(sample.dfxState)) {
      sample.errors.push(`E7 mismatch: ${sample.dfxState} requires ${expectedStatus(sample.dfxState)}, got ${sample.moduleStatus}`)
    }
    if (sample.database && (sample.database.externalId !== s.ext || sample.database.userId !== user.id
      || (raw && raw.uid !== sample.database.uid))) sample.errors.push('Technical failure: external-ID linkage differs')
    if (s.kind === 'sell' && !sample.database) {
      try {
        sample.input = one(`SELECT id,status,purpose,"isConfirmed","routeId" FROM crypto_input WHERE id=${id(s.sourceId)}`)
      } catch (error) { sample.errors.push(redact(error.message)) }
    }
    samples.push(sample)
    s.timeline.push(sample)
    // Exclude clocks, DTO countdowns and DB updated/version bookkeeping from stability.
    const signature = JSON.stringify({ dfxState: sample.dfxState, dfxReason: sample.dfxReason,
      moduleStatus: sample.moduleStatus, database: sample.database, input: sample.input, errors: sample.errors })
    if (signature === previous) equalCount++
    else { equalCount = 1; unchangedSince = Date.now(); previous = signature }
    const amlDecided = ['Pass', 'Fail', 'Pending', 'GSheet'].includes(sample.database?.amlCheck)
    const f = sample.database?.fiatOutput
    const bankReady = sample.database?.amlCheck === 'Pass' && f?.amount > 0 && !f.isComplete && f.iban && f.currency
    const prerequisiteObserved = (!waitForAml || amlDecided) && (!waitForRegistration || Boolean(sample.database))
      && (!waitForBank || bankReady)
      && (!waitForCompleted || (sample.dfxState === 'Completed' && sample.moduleStatus === 'completed'))
    const stable = equalCount >= 3 && Date.now() - unchangedSince >= JOB_CYCLE
    persist()
    console.log(`${s.label} ${redact({ time: sample.time, event, DFX: sample.dfxState,
      module: sample.moduleStatus, amlCheck: sample.database?.amlCheck, amlReason: sample.database?.amlReason,
      status: sample.database?.status, fee: sample.database?.totalFeeAmount,
      outputAmount: sample.database?.outputAmount, errors: sample.errors })}`)
    if (stable && prerequisiteObserved) { observation.endReason = 'three_equal_samples_after_job_cycle'; break }
    if (Date.now() >= deadline) { observation.endReason = 'eight_minute_window'; break }
    const next = Math.min(deadline, started + (Math.floor((Date.now() - started) / INTERVAL) + 1) * INTERVAL)
    await delay(Math.max(0, next - Date.now()))
  } while (true)
  observation.last = samples.at(-1)
  observation.amlDecided = ['Pass', 'Fail', 'Pending', 'GSheet'].includes(observation.last.database?.amlCheck)
  observation.reached = { completed: samples.some(x => x.dfxState === 'Completed' && x.moduleStatus === 'completed'),
    returned: samples.some(x => x.dfxState === 'Returned' && x.moduleStatus === 'failed') }
  persist()
  check(samples.every(x => x.errors.length === 0), 'Observation contains a technical failure or E7 mismatch', observation)
  return observation
}
async function event(s, name, action, options) {
  const applied = await step(`${s.label}: ${name}`, async () => {
    const evidence = await action()
    s.events.push({ time: new Date().toISOString(), event: name, evidence })
    return evidence ?? { accepted: true }
  })
  if (applied === undefined) return undefined
  return step(`${s.label}: observe ${name}`, () => observe(s, name, options))
}
function printTimeline(s) {
  console.log(`\n${s.label} timeline`)
  console.table(s.timeline.map(x => ({ time: x.time, event: x.event, DFX: x.dfxState,
    module: x.moduleStatus ?? (x.pendingRegistration ? 'not_registered' : x.moduleError?.name),
    amlCheck: x.database?.amlCheck, amlReason: x.database?.amlReason, status: x.database?.status,
    fee: x.database?.totalFeeAmount, blockchainFee: x.database?.blockchainFee,
    outputAmount: x.database?.outputAmount, result: x.errors.length ? 'FAIL' : 'OK' })))
}

async function prepareCompliance(s) {
  const bankApproved = await event(s, 'sender or payout bank data approved', async () => {
    const source = s.kind === 'buy'
      ? one(`SELECT iban FROM bank_tx WHERE id=${id(s.sourceId)}`)
      : one(`SELECT iban FROM deposit_route WHERE id=${id(s.routeId)}`)
    const readCandidates = () => rows(`SELECT id,iban,type,active,approved,status,comment,"userDataId" FROM bank_data
      WHERE "userDataId"=${id(user.userDataId)} AND iban=${quote(source.iban)}
        AND type IN ('BankIn','BankOut') ORDER BY id`)
    const started = Date.now(), deadline = started + WINDOW
    const verification = {
      startedAt: new Date(started).toISOString(), samples: [],
      criteria: {
        source: 'bank-data.service.ts:78-175',
        eligibility: 'Non-User type, InternalReview, approved false or null (lines 60-70)',
        checks: 'Verified name/name match; another approved row for the IBAN; account ownership, BankIn precedence and pending/expired merge (lines 98-107, 156-170)',
        approval: 'No errors, or only missing verified name with no existing row or matching existing name (lines 109-123)',
        otherOutcomes: 'Existing active without account mismatch: forbid; pending merge or age under five minutes: InternalReview; eligible active/name conflict: ManualReview; otherwise forbid (lines 124-142)'
      }
    }
    s.bankDataVerification = verification
    const isApproved = b => b.active === true && b.approved === true && ['BankIn', 'BankOut'].includes(b.type)
      && typeof b.status === 'string'
      && !['InternalReview', 'ManualReview'].includes(b.status)
    let after, candidates
    do {
      candidates = readCandidates()
      after = candidates.find(isApproved)
      const sample = { time: new Date().toISOString(), elapsedSeconds: (Date.now() - started) / 1000, candidates }
      verification.samples.push(sample)
      persist()
      console.log(`${s.label} bank data verification ${redact(sample)}`)
      if (after || Date.now() >= deadline) break
      await delay(Math.max(0, Math.min(INTERVAL, deadline - Date.now())))
    } while (true)
    verification.path = after ? 'automatic' : 'compliance_fallback'
    verification.beforeFallback = candidates
    persist()
    if (verification.path === 'compliance_fallback') {
      check(candidates.length === 1 && candidates[0].status === 'InternalReview'
        && candidates[0].approved !== true,
        'Missing, ambiguous or already decided backend bank data; no approval applied', verification)
      const bank = candidates[0]
      await api(`/v1/bankData/${id(bank.id)}`, adminToken, 'PUT', { approved: true, status: 'Completed' })
      after = readCandidates().find(b => b.id === bank.id)
    }
    verification.after = after
    persist()
    check(after && isApproved(after), 'Bank data approval outside review was not persisted', verification)
    return { ...after, userDataId: user.userDataId, verification }
  })
  if (!bankApproved) return undefined
  const phoneChecked = await event(s, 'IP country phone check recorded', async () => {
    const phoneCallIpCountryCheckDate = new Date().toISOString()
    await api(`/v1/userData/${id(user.userDataId)}`, adminToken, 'PUT', { phoneCallIpCountryCheckDate })
    const after = one(`SELECT "phoneCallIpCountryCheckDate" FROM user_data WHERE id=${id(user.userDataId)}`)
    check(Math.abs(dbTimestampMs(after.phoneCallIpCountryCheckDate) - Date.parse(phoneCallIpCountryCheckDate)) <= 1,
      'IP country phone check was not persisted', after)
    return { userDataId: user.userDataId, ...after }
  })
  if (!phoneChecked) return undefined
  // BlockAmlReasons includes ManualCheckIpCountryPhone: waiting alone cannot recheck it.
  return event(s, 'AML reevaluation after operating steps', async () => {
    const current = database(s)
    check(Boolean(current), 'Lifecycle row missing before AML reevaluation')
    if (['Pending', 'GSheet'].includes(current.amlCheck) && !current.isComplete) {
      if (s.kind === 'buy') {
        await api(`/v1/buyCrypto/${id(current.id)}/amlCheck/reviewReset`, adminToken, 'PUT', {
          expectedAmlCheck: current.amlCheck, expectedAmlReason: current.amlReason ?? null
        })
      } else {
        await api(`/v1/buyFiat/${id(current.id)}/amlCheck`, adminToken, 'DELETE')
      }
      return { id: current.id, previousAmlCheck: current.amlCheck, resetRequested: true }
    }
    return { id: current.id, previousAmlCheck: current.amlCheck, resetRequested: false }
  }, { waitForAml: true })
}
async function compliance(s, verdict) {
  if (verdict === 'Pass' && !await prepareCompliance(s)) return undefined
  const current = database(s)
  if (verdict === 'Pass') {
    const automaticPass = current?.amlCheck === 'Pass'
    await step(`${s.label}: backend AML outcome after operating steps`, () => ({
      automaticPass, amlCheck: current?.amlCheck, amlReason: current?.amlReason, comment: current?.comment
    }))
    if (automaticPass) return { automaticPass: true, id: current.id }
    // aml-error.enum.ts:102-107; the backend checks error values in comment, not just amlReason.
    const blacklist = ['BankDataNotActive', 'BankDataManualReview', 'BankDataMissing', 'BankDataUserMismatch']
    if (current?.amlCheck !== 'Pending' || !current.amlReason || current.amlReason === 'NA'
      || blacklist.some(error => current.comment?.includes(error) || current.amlReason.includes(error))) {
      return halt(s, 'compliance Pass', 'AML reevaluation did not leave an eligible Pending decision without blacklisted bank-data errors.')
    }
  }
  if (!current || !['Pass', 'Fail', 'Pending', 'GSheet'].includes(current.amlCheck)) {
    return halt(s, `compliance ${verdict}`, `No AML decision observed within ${results.observeMinutes} minutes; no verdict overwritten.`)
  }
  return event(s, `compliance ${verdict}`, async () => {
    if (verdict === 'Fail') check(['Pending', 'GSheet'].includes(current.amlCheck),
      'Expected an unresolved AML review before rejection', current)
    // ManualAmlCheckDto requires responsible; the controller replaces it with the staff verifiedName.
    const body = { amlCheck: verdict, amlReason: verdict === 'Pass' ? 'NA' : 'ManualCheck',
      responsible: adminVerifiedName }
    await api(`/v1/${s.kind === 'buy' ? 'buyCrypto' : 'buyFiat'}/${id(current.id)}/amlCheck`, adminToken, 'PUT', body)
    return { id: current.id, body }
  })
}
function confirmBuyPayout(s) {
  const b = database(s)
  // Never invent the price/output/fee preparation that disabled jobs may not reach.
  if (b?.amlCheck !== 'Pass' || b.isComplete || !(b.outputAmount > 0)
    || !(b.outputReferenceAmount > 0) || !b.payoutFee
    || !['ReadyForPayout', 'PayingOut'].includes(b.status)) {
    return { notReached: true, reason: 'Backend has not prepared a positive crypto output and fee at the payout boundary.', database: b }
  }
  const txId = `0x${randomBytes(32).toString('hex')}`
  // buy-crypto.entity.ts:605-613,637-650; buy-crypto-fees.entity.ts:82-86.
  // A zero-cost synthetic payout is explicit bank/chain I/O, not a pricing estimate.
  // null base units is the completion method's supported uncaptured-chain-value fallback.
  // buy-crypto-out.service.ts:263-265 -> transaction.service.ts:515-516.
  const updated = sql(`WITH completed AS (
    UPDATE buy_crypto SET "txId"=${quote(txId)},"outputDate"=NOW(),"isComplete"=true,
      status='Complete',"outputAmountBaseUnits"=NULL
    WHERE id=${id(b.id)} AND "amlCheck"='Pass' AND "isComplete"=false
      AND status IN ('ReadyForPayout','PayingOut') AND "outputAmount">0 RETURNING *
  ), fee AS (
    UPDATE buy_crypto_fee f SET "actualPayoutFeeAmount"=0,"actualPayoutFeePercent"=0
    FROM completed b WHERE f."buyCryptoId"=b.id RETURNING f.id
  ), tx AS (
    UPDATE "transaction" t SET "outputDate"=b."outputDate" FROM completed b
    WHERE t.id=b."transactionId" RETURNING t.id
  ) SELECT json_build_object('id',b.id,'txId',b."txId",'isComplete',b."isComplete",
    'feeRows',(SELECT count(*) FROM fee),'transactionRows',(SELECT count(*) FROM tx)) FROM completed b`)
  check(Boolean(updated), 'Payout confirmation lost its guarded update')
  const evidence = JSON.parse(updated)
  check(evidence.feeRows === 1 && evidence.transactionRows === 1, 'Payout completion linkage missing', evidence)
  return { ...evidence, simulatedActualPayoutFee: 0, outputAmountBaseUnits: null }
}
function confirmBankExecution(s) {
  const b = database(s), f = b?.fiatOutput
  if (!f || !(f.amount > 0) || f.isComplete || !f.iban || !f.currency
    || (s.kind === 'sell' && b.amlCheck !== 'Pass')) {
    return { notReached: true, reason: 'Backend has not created an executable fiat output.', database: b }
  }
  // Simulate the outgoing bank statement and the successful transmission/confirmation.
  // fiat-output-job.service.ts:453-456 (transmitted/confirmed/approved), :624-650 (bank completion).
  // Remittance fallback is the transmission path at :480 / :509, not an invented output amount.
  // The enabled BuyCrypto/BuyFiat jobs perform their OWN downstream completion:
  // buy-crypto-preparation.service.ts:1043-1072; buy-fiat-preparation.service.ts:660-685.
  const remittance = f.remittanceInfo ?? `DFX Payout ${f.id}`
  const reference = `${s.ext}-out`
  const output = sql(`WITH bank AS (
    INSERT INTO bank_tx ("accountServiceRef",amount,currency,"txAmount","txCurrency","chargeAmount",
      "creditDebitIndicator",iban,type,"bookingDate","valueDate",name,"remittanceInfo")
    VALUES (${quote(reference)},${num(f.amount)},${quote(f.currency)},${num(f.amount)},${quote(f.currency)},0,
      'DBIT',${quote(f.iban)},${quote(s.kind === 'buy' ? 'BuyCryptoReturn' : 'BuyFiat')},NOW(),NOW(),
      'E2E Tester',${quote(remittance)}) RETURNING id,created
  ), confirmed AS (
    UPDATE fiat_output SET "bankTxId"=bank.id,"outputDate"=bank.created,"isComplete"=true,
      "isTransmittedDate"=COALESCE("isTransmittedDate",bank.created),
      "isConfirmedDate"=COALESCE("isConfirmedDate",bank.created),
      "isApprovedDate"=COALESCE("isApprovedDate",bank.created),"remittanceInfo"=${quote(remittance)}
    FROM bank WHERE fiat_output.id=${id(f.id)} AND "isComplete"=false RETURNING fiat_output.*
  ) SELECT json_build_object('fiatOutputId',id,'bankTxId',"bankTxId",'outputDate',"outputDate",
    'isComplete',"isComplete",'remittanceInfo',"remittanceInfo") FROM confirmed`)
  check(Boolean(output), 'Bank execution confirmation lost its guarded update')
  return JSON.parse(output)
}
async function simulate(s, name, fn, options) {
  let evidence
  try {
    evidence = fn(s)
  } catch (error) {
    return step(`${s.label}: ${name}`, () => { throw error })
  }
  if (evidence.notReached) return halt(s, name, evidence.reason)
  return event(s, name, () => evidence, options)
}
async function purchase(s, spec, dependencies, context) {
  const payment = await step(`${s.label}: widget payment information`, () => openWidget(spec, context), dependencies)
  if (!payment) return undefined
  const incoming = await event(s, 'incoming unassigned bank transfer', () => {
    const result = seedBank(payment.request, s.ext, payment.request.amount, s.iban)
    s.sourceId = result.bankId
    return result
  }, { allowUnregistered: true, waitForRegistration: false })
  if (!incoming) return undefined
  const bank = { bankId: s.sourceId }
  return event(s, 'bank transfer assigned by Admin', async () => {
    await api(`/v1/bankTx/${id(bank.bankId)}`, adminToken, 'PUT', { type: 'BuyCrypto', buyId: payment.request.routeId })
    return { bankId: bank.bankId, requestId: payment.request.id, assignment: 'real Admin API' }
  }, { waitForAml: true, allowUnregistered: true })
}
function collectLogs() {
  const args = ['logs', '--since', results.startedAt, API_CONTAINER]
  const options = { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  // spawnSync retains both Docker streams, including stderr on successful exit.
  const log = spawnSync('docker', args, options)
  const lines = `${log.stdout ?? ''}\n${log.stderr ?? ''}`.split('\n')
  const selected = new Set()
  lines.forEach((line, index) => {
    if (/buy-crypto|buy-fiat|aml/i.test(line)) {
      selected.add(index)
      // Include stack/error continuation lines following the matching logger prefix.
      for (let j = index + 1; j < Math.min(lines.length, index + 12); j++) {
        if (!/^\s+(?:at\s|\S*Error:)|^(?:TypeError|Error|ReferenceError):/.test(lines[j])) break
        selected.add(j)
      }
    }
  })
  results.apiLog = { container: API_CONTAINER, since: results.startedAt, capturedAt: new Date().toISOString(),
    available: log.status === 0 && !log.error, exitCode: log.status,
    error: log.error ? redact(log.error.message) : undefined,
    lines: [...selected].sort((a, b) => a - b).map(i => /accessToken|refreshToken|privateKey|mnemonic|seed|authorization/i.test(lines[i])
      ? '[REDACTED sensitive log line]' : redact(lines[i])) }
  // Optional diagnostics are not a lifecycle failure; do not expose unrelated container logs.
  if (!results.apiLog.available) results.apiLog.note = 'Docker logs unavailable or capture exceeded time/buffer limit.'
  console.log(`API log: ${results.apiLog.available ? 'captured' : 'unavailable'}, ${results.apiLog.lines.length} matching/context lines`)
}
async function main() {
  for (const origin of [API, APP]) {
    const url = new URL(origin)
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Disposable local stack only')
  }
  const imports = await step('load installed dependencies', async () => {
    const [{ default: WDK }, { default: WalletManagerEvm }, { default: DfxProtocol }, { chromium }, { ethers }] = await Promise.all([
      import('@tetherto/wdk'), import('@tetherto/wdk-wallet-evm'), import('@dfx.swiss/wdk-protocol-fiat-dfx'),
      import('playwright'), import('ethers')])
    main.createWallet = async () => {
      const seed = WDK.getRandomSeedPhrase()
      secrets.add(seed)
      wdk = new WDK(seed)
      wallets.push(wdk)
      wdk.registerWallet('ethereum', WalletManagerEvm, { provider: API })
        .registerProtocol('ethereum', 'dfx', DfxProtocol, { environment: 'sandbox', network: 'ethereum', language: 'en', fetch: localFetch })
      const account = await wdk.getAccount('ethereum', 0)
      address = await account.getAddress()
      fiat = account.getFiatProtocol('dfx')
    }
    if (needsPrimaryWallet) await main.createWallet()
    main.chromium = chromium
    main.ethers = ethers
    return { address }
  })
  const buyExt = `${runId}-buy-a`, sellExt = `${runId}-sell`
  const prices = await step('seed fresh prices (as harness global.setup)', async () => {
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
  const registration = needsPrimaryWallet ? await step('WDK URL + local authentication', async () => {
    buySpec = await widget(selectedScenarios.has('buyA') ? 'buy' : 'sell', selectedScenarios.has('buyA') ? buyExt : sellExt)
    user = one(`SELECT id,"userDataId",address FROM "user" WHERE lower(address)=lower(${quote(address)})`)
    return { user, url: redact(buySpec.url), externalTransactionId: buySpec.ext }
  }, [imports]) : undefined
  const kyc = needsPrimaryWallet ? await step('Completed Ident simulation: KYC + personal data + current name check (factory SQL)', async () => {
    await api('/v2/user/mail', token, 'PUT', { mail: `${runId}@example.com` })
    return change(`UPDATE user_data SET "kycLevel"=50,"depositLimit"=1000000,"accountType"='Personal',
      "lastNameCheckDate"=now(),
      firstname='E2E',surname='Tester',"verifiedName"='E2E Tester',street='Teststrasse',location='Zug',zip='6300',phone='+41791234567',
      "countryId"=(SELECT id FROM country WHERE symbol='CH'),
      "languageId"=(SELECT id FROM language WHERE symbol='EN') WHERE id=${id(user.userDataId)}`)
  }, [registration]) : undefined
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
    adminVerifiedName = one(`SELECT "verifiedName" FROM user_data WHERE id=${id(staff.userDataId)}`).verifiedName
    assert.equal(adminVerifiedName, 'E2E Test Staff')
    assert.equal(JSON.parse(Buffer.from(adminToken.split('.')[1], 'base64url')).role, 'Admin')
    await poll(async () => {
      try { await api('/v1/userData', adminToken); return true } catch (e) {
        if (e.message.includes('HTTP 403') && e.message.includes('STAFF_KYC_REQUIRED')) return false
        throw e
      }
    }, 90000)
    // shared/auth/role.guard.ts:36,38: Admin satisfies both Support and Compliance gates.
    return { ...staff, address: wallet.address, role: 'Admin',
      endpointRolesSatisfied: ['Compliance', 'Support'], clearanceReady: true }
  }, [imports])
  await step('seed numeric referral code (every real database has one)', async () => {
    const evidence = JSON.parse(sql(`WITH seeded AS (
      UPDATE "user" SET ref='000-100' WHERE id=${id(admin.id)}
        AND NOT EXISTS (SELECT 1 FROM "user" WHERE ref ~ '^[0-9]{3}-[0-9]{3}$')
      RETURNING id,ref
    ) SELECT json_build_object('seeded',EXISTS(SELECT 1 FROM seeded),
      'adminId',${id(admin.id)},'ref',(SELECT ref FROM seeded))`))
    return { preparation: 'environment', ...evidence }
  }, [admin])
  const browserReady = await step('launch Chromium', async () => {
    browser = await main.chromium.launch({ headless: true })
    return { headless: true }
  }, [imports])

  if (selectedScenarios.has('buyA')) {
    const buyA = scenario('buyA', 'buy', buyExt)
    await runScenario(buyA, async context => {
      const registeredA = await purchase(buyA, buySpec, [kyc, browserReady, admin, prices], context)
      if (registeredA) {
        const approved = await compliance(buyA, 'Pass')
        if (approved) await simulate(buyA, 'synthetic crypto payout confirmed', confirmBuyPayout)
      }
    })
  }

  if (selectedScenarios.has('buyB')) {
    const buyB = scenario('buyB', 'buy', `${runId}-buy-b`)
    const originalWallet = { wdk, fiat, address, token, user }
    await runScenario(buyB, async context => {
      const buyBSpec = await step('buyB: fresh WDK wallet + local authentication', async () => {
        await main.createWallet()
        if (originalWallet.address) assert.notEqual(address.toLowerCase(), originalWallet.address.toLowerCase())
        const spec = await widget('buy', buyB.ext)
        user = one(`SELECT id,"userDataId",address FROM "user" WHERE lower(address)=lower(${quote(address)})`)
        if (originalWallet.user) {
          assert.notEqual(user.id, originalWallet.user.id)
          assert.notEqual(user.userDataId, originalWallet.user.userDataId)
        }
        buyB.user = user
        return spec
      }, [imports, ...(needsPrimaryWallet ? [registration] : [])])
      const buyBKyc = await step('buyB: Completed Ident simulation', async () => {
        await api('/v2/user/mail', token, 'PUT', { mail: `${buyB.ext}@example.com` })
        const data = change(`UPDATE user_data SET "kycLevel"=50,"depositLimit"=1000000,"accountType"='Personal',
          "lastNameCheckDate"=now(),
          firstname='E2E',surname='Tester',"verifiedName"='E2E Tester',street='Teststrasse',location='Zug',zip='6300',phone='+41791234567',
          "countryId"=(SELECT id FROM country WHERE symbol='CH'),
          "languageId"=(SELECT id FROM language WHERE symbol='EN') WHERE id=${id(user.userDataId)}`)
        assert.equal(data.phoneCallIpCountryCheckDate, null, 'Fresh buyB account must not have a phone check')
        return data
      }, [buyBSpec])
      const registeredB = buyBSpec && await purchase(buyB, buyBSpec, [buyBKyc, browserReady, admin, prices], context)
      if (registeredB) {
        const rejected = await compliance(buyB, 'Fail')
        if (rejected) {
          const refund = await event(buyB, 'Admin refund request', async () => {
            const b = database(buyB)
            const bank = one(`SELECT iban,amount,currency FROM bank_tx WHERE id=${id(buyB.sourceId)}`)
            // RefundInternalDto:19-39 accepts IBAN/amount/asset/date, but NOT creditor data.
            // First record the valid refund request without approval date (service.ts:901-903).
            // validateChargebackIban checks IBAN/BIC/blacklists, not bank_data.approved;
            // the approval leg accepts explicit creditor data. No operating steps for buyB.
            const body = { refundIban: bank.iban, chargebackAmount: bank.amount, chargebackAsset: bank.currency }
            await api(`/v1/buyCrypto/${id(b.id)}/refund`, adminToken, 'POST', body)
            return { id: b.id, body }
          })
          if (refund) {
            const approval = await event(buyB, 'Admin refund approval with creditor data', async () => {
              const b = database(buyB)
              // Real administrative event, not SQL. update-buy-crypto.dto.ts exposes these fields;
              // buy-crypto.service.ts:430-465 creates the output using the supplied creditor data.
              // Initiation date mirrors chargebackFillUp's approval leg (entity.ts:699-700).
              const now = new Date().toISOString()
              const body = { chargebackAllowedDate: now, chargebackDate: now,
                chargebackCreditorName: 'E2E Tester', chargebackCreditorAddress: 'Teststrasse',
                chargebackCreditorHouseNumber: '1', chargebackCreditorZip: '6300',
                chargebackCreditorCity: 'Zug', chargebackCreditorCountry: 'CH' }
              await api(`/v1/buyCrypto/${id(b.id)}`, adminToken, 'PUT', body)
              return { id: b.id, body }
            })
            if (approval) await simulate(buyB, 'synthetic refund bank execution confirmed', confirmBankExecution)
          }
        }
      }
    })
    ;({ wdk, fiat, address, token, user } = originalWallet)
  }
  if (selectedScenarios.has('sell')) {
    const sale = scenario('sell', 'sell', sellExt)
    await runScenario(sale, async context => {
      const deposits = await step('seed deposit addresses (as harness global.setup)', async () => {
        let mnemonic = process.env.E2E_EVM_DEPOSIT_SEED
        if (!mnemonic) {
          try {
            mnemonic = execFileSync('docker', ['exec', API_CONTAINER, 'printenv', 'EVM_DEPOSIT_SEED'],
              { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
          } catch { throw new Error('Could not read local API deposit seed') }
        }
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
        const result = await api('/v1/bankAccount', token, 'POST', { iban: sale.iban, label: runId })
        id(result.id)
        return { id: result.id, iban: result.iban }
      }, [kyc])

      const sellSpec = await step('sell: WDK URL', () => widget('sell', sellExt), [kyc])
      const sellPayment = await step('sell: widget deposit information', () => openWidget(sellSpec, context, sale.iban),
        [sellSpec, bankAccount, browserReady, deposits, prices])
      if (sellPayment) {
        sale.routeId = sellPayment.request.routeId
        const registration = await event(sale, 'crypto deposit detected; real BuyFiat registration', () => {
          const input = seedPayIn(sellPayment.request)
          sale.sourceId = input.id
          return { inputId: input.id, status: input.status, isConfirmed: input.isConfirmed }
        }, { allowUnregistered: true })
        if (registration) {
          const b = database(sale)
          if (!b?.payIn?.purpose) halt(sale, 'blockchain confirmation', 'BuyFiat registration did not assign the input.')
          else {
            const confirmation = await event(sale, 'blockchain input confirmed', () => {
              // crypto-input.entity.ts:326-333, INPUT; base/evm.strategy.ts:31-33 forwardRequired=true.
              // Undefined status is not persisted by TypeORM: retain the current status, do not complete forwarding.
              const ci = change(`UPDATE crypto_input SET "isConfirmed"=true
                WHERE id=${id(sale.sourceId)} AND purpose IS NOT NULL AND "addressBlockchain"='Ethereum'`)
              return { inputId: ci.id, isConfirmed: ci.isConfirmed, status: ci.status, forwardRequired: true }
            }, { waitForAml: true })
            if (confirmation) {
              const approved = await compliance(sale, 'Pass')
              if (approved) {
                const boundary = await step('sell: observe bank execution boundary',
                  () => observe(sale, 'await bank execution boundary', { waitForBank: true }))
                if (boundary) {
                  const executed = await simulate(sale, 'synthetic sell bank execution confirmed', confirmBankExecution,
                    { waitForCompleted: true })
                  if (executed && !sale.halted.some(entry => entry.event === 'synthetic sell bank execution confirmed')) {
                    await step('sell: module completed after bank execution', () => {
                      check(executed.reached.completed, 'Module completed was not observed after bank execution', executed)
                      return { moduleStatus: 'completed', fiatOutput: executed.last.database?.fiatOutput }
                    })
                  }
                }
              }
            }
          }
        }
      }
    })
  }
}
try {
  await main()
} catch (error) {
  await step('unexpected runner failure', () => { throw error })
} finally {
  if (browser) await step('close browser', async () => { await browser.close(); return { closed: true } })
  for (const wallet of wallets) await step('dispose wallet', async () => { await wallet.dispose(); return { disposed: true } })
  try { collectLogs() } catch (error) { results.apiLog = { available: false, error: redact(error.message) } }
  for (const s of Object.values(results.scenarios)) {
    printTimeline(s)
    const last = s.timeline.at(-1)
    s.conclusion = { dfxState: last?.dfxState ?? null, moduleStatus: last?.moduleStatus ?? null,
      expectedTerminalState: s.label === 'buyB' ? 'Returned' : 'Completed',
      terminalObserved: s.timeline.some(x => s.label === 'buyB'
        ? x.dfxState === 'Returned' && x.moduleStatus === 'failed'
        : x.dfxState === 'Completed' && x.moduleStatus === 'completed'),
      stoppingPoint: last?.database ?? null }
  }
  results.finishedAt = new Date().toISOString()
  results.ok = results.steps.every(s => s.ok)
  results.note = 'OK checks E7 consistency and technical steps, not guaranteed backend progress; inspect terminalObserved and halted.'
  persist()
  process.exitCode = results.ok ? 0 : 1
}

#!/usr/bin/env node
// UI-only KYC probe for the disposable local stack. Never seeds or updates the DB.
// Selectors: app/e2e-stack/specs/{kyc,buy,auth}.spec.ts;
// nationality/Ident: app/src/screens/kyc.screen.tsx (1321f956).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const API = new URL(process.env.DFX_LOCAL_API ?? 'http://localhost:3020').origin
const APP = new URL(process.env.DFX_LOCAL_APP ?? 'http://localhost:3021').origin
const DB = process.env.DFX_LOCAL_DB_CONTAINER ?? 'dfx-e2e-wdk2-db-1'
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const runId = `kyc-${Date.now()}-${randomUUID().slice(0, 8)}`
const mail = `e2e+${runId}@dfx.swiss`
const secrets = new Set()
const pending = new Set()
const results = {
  runId, api: API, app: APP, startedAt: new Date().toISOString(), steps: [], table: [], apiResponses: [],
  limitations: ['Local stack only; external browser requests blocked and recorded.',
    'No SQL writes, KYC fixtures, provider callbacks or identity completion.',
    'Fresh wallet and UI-created local account retained for inspection.'],
  boundarySource: {
    ui: 'app/src/screens/kyc.screen.tsx:1831-1926 (Ident, SumsubWebSdk/session)',
    webhook: 'api/src/subdomains/generic/kyc/controllers/kyc.controller.ts:488-510 (signature check)',
    applicant: 'api/src/subdomains/generic/kyc/services/kyc.service.ts:1065-1078 (getApplicantData)'
  }
}
let browser, context, page, wdk, fiat, address, user, session, currentStep
let notificationBaseline = 0
const options = { cryptoAsset: 'ETH', fiatCurrency: 'CHF', fiatAmount: 10000n }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => {
    if (/token|secret|seed|mnemonic|signature|kycHash|kycCode|^hash$|^code$|^otp$/i.test(key)) return '[REDACTED]'
    if (typeof item === 'bigint') return item.toString()
    return item
  })
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED-JWT]')
    .replace(/([?&](?:session|code|otp|token|accessToken)=)[^&\s"<>]+/gi, '$1[REDACTED]')
}
function safe(value) { return JSON.parse(redact(value)) }
function persist() {
  writeFileSync(`${OUT}kyc-widget.json.tmp`, redact(results) + '\n', { mode: 0o600 })
  renameSync(`${OUT}kyc-widget.json.tmp`, `${OUT}kyc-widget.json`)
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`
function id(value) {
  assert(Number.isSafeInteger(value) && value > 0, 'Invalid DB identity')
  return String(value)
}
function rows(select) {
  assert(/^SELECT\s/i.test(select), 'Only SELECT queries permitted')
  // Enforced by PostgreSQL too, including queries used to retrieve mail codes.
  const output = execFileSync('docker', ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', DB,
    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'sa', '-d', 'dfx', '-t', '-A', '-c',
    `SELECT row_to_json(evidence) FROM (${select}) evidence`],
  { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  return output ? output.split('\n').map(line => JSON.parse(line)) : []
}
function owner() {
  const found = rows(`SELECT id,"userDataId",address FROM "user" WHERE lower(address)=lower(${quote(address)})`)
  assert.equal(found.length, 1, 'Expected one wallet owner')
  return found[0]
}
function state() {
  const data = rows(`SELECT id,"kycLevel",mail,firstname,surname FROM user_data WHERE id=${id(user.userDataId)}`)
  assert.equal(data.length, 1, 'Missing user_data')
  return { ...data[0], kycSteps: rows(`SELECT id,name,type,status,"sequenceNumber" FROM kyc_step
    WHERE "userDataId"=${id(user.userDataId)} ORDER BY id`) }
}
async function poll(fn, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  do {
    const value = await fn()
    if (value) return value
    await pause(250)
  } while (Date.now() < deadline)
  throw new Error(message)
}
async function snapshot(name) {
  const evidence = { step: name }
  if (page && !page.isClosed()) {
    evidence.path = new URL(page.url()).pathname
    const authenticatorVisible = await page.getByPlaceholder('Authenticator code').isVisible()
    evidence.ui = authenticatorVisible ? '[Authenticator setup panel withheld: contains secret/QR]'
      : redact(await page.locator('body').innerText())
    evidence.screenshot = `${runId}-${results.table.length.toString().padStart(2, '0')}.png`
    // Hide OTP fields and any authenticator secret/QR panel; never persist credentials as pixels.
    const masks = [page.locator('input[name="token"]')]
    if (authenticatorVisible) masks.push(page.locator('body'))
    await page.screenshot({ path: OUT + evidence.screenshot, fullPage: true, mask: masks })
  }
  if (user) Object.assign(evidence, state())
  results.table.push(evidence)
  return evidence
}
async function step(name, fn) {
  const entry = { name, status: 'FAIL' }
  results.steps.push(entry)
  try {
    entry.evidence = await fn()
    entry.status = 'OK'
  } catch (error) {
    entry.error = redact(error.message)
  }
  try { entry.observation = await snapshot(name) } catch (error) {
    entry.status = 'FAIL'
    entry.observationError = redact(error.message)
  }
  console.log(`${entry.status} ${name}`)
  persist()
  return entry.status === 'OK'
}
async function localFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.equal(url.origin, 'https://dev.api.dfx.swiss', 'Unexpected module origin')
  const response = await fetch(`${API}${url.pathname}${url.search}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(20000)
  })
  const body = await response.clone().json().catch(() => null)
  if (body?.accessToken) secrets.add(body.accessToken)
  if (url.pathname === '/v1/auth/signMessage' && response.ok) {
    assert(body.message.startsWith('[loc]_'), 'Expected local signing challenge')
    secrets.add(body.message)
  }
  results.apiResponses.push({ source: 'module', path: url.pathname, status: response.status, body: safe(body) })
  return response
}
async function widget() {
  const trade = await fiat.buy({ ...options, config: { externalTransactionId: `${runId}-${results.steps.length}` } })
  const url = new URL(trade.buyUrl)
  assert.equal(url.origin, 'https://dev.app.dfx.swiss')
  session = url.searchParams.get('session')
  assert(session, 'Missing module session')
  secrets.add(session)
  url.protocol = new URL(APP).protocol
  url.host = new URL(APP).host
  return url.href
}
async function open(url) {
  if (context) await context.close()
  currentStep = undefined
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    // Local KYC session URLs use Config.url(): localhost:3000. Forward the real UI request;
    // no response stubs and no direct KYC API mutations by this runner.
    if (url.origin === 'http://localhost:3000' || url.origin === 'https://dev.api.dfx.swiss') {
      await route.continue({ url: `${API}${url.pathname}${url.search}` })
    } else if ([API, APP].includes(url.origin)) {
      await route.continue()
    } else {
      results.apiResponses.push({ source: 'browser', origin: url.origin, path: url.pathname,
        blocked: true, reason: 'External network outside local probe' })
      await route.abort('blockedbyclient')
    }
  })
  page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('response', response => {
    const url = new URL(response.url())
    if (!/\/v\d+\//.test(url.pathname)) return
    const task = (async () => {
      const raw = await response.text()
      let body
      try { body = JSON.parse(raw) } catch { body = raw }
      if (body?.currentStep) {
        currentStep = body.currentStep
        if (currentStep.session?.url) secrets.add(currentStep.session.url)
      }
      if (body?.kyc?.hash) secrets.add(body.kyc.hash)
      if (body?.secret) secrets.add(body.secret)
      if (body?.uri) secrets.add(body.uri)
      results.apiResponses.push({ source: 'browser', path: url.pathname,
        method: response.request().method(), status: response.status(), body: safe(body) })
    })().catch(() => {
      results.apiResponses.push({ source: 'browser', path: url.pathname, status: response.status(), bodyUnavailable: true })
    })
    pending.add(task)
    task.finally(() => pending.delete(task))
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(expected => localStorage.getItem('dfx.authenticationToken') === expected, session)
}
const visible = locator => locator.isVisible()
const button = name => page.getByRole('button', { name, exact: true })
async function country(name) {
  const field = page.locator(`input[name="${name}"]`)
  await field.fill('Switzerland')
  await page.getByText('Switzerland', { exact: true }).click()
  await field.blur()
}
async function completed(name) {
  await poll(() => state().kycSteps.some(s => s.name === name && s.status === 'Completed'),
    `${name} was not completed; see UI and API evidence`)
}
async function detect() {
  return poll(async () => {
    if (await visible(page.getByPlaceholder('Email code'))) return 'mail-code'
    if (await visible(page.getByPlaceholder('Authenticator code'))) return 'authenticator-blocked'
    if (await visible(page.locator('input[name="email"]'))) return 'contact'
    if (await visible(page.getByText('Account Type', { exact: true }))) return 'personal'
    if (await visible(page.locator('input[name="nationality"]'))) return 'nationality'
    if (currentStep?.name === 'Ident' || state().kycSteps.some(s => s.name === 'Ident' && s.status === 'InProgress')) return 'ident'
    if (await visible(page.getByText('How did you hear about DFX?', { exact: true }))) return 'referral-blocked'
    if (await visible(button('Complete KYC'))) return 'complete-kyc'
    if (await visible(button('Enter email'))) return 'enter-email'
    if (await visible(button('Enter user data'))) return 'enter-data'
    if (await visible(button('Start'))) return 'start'
    if (await visible(button('Continue'))) return 'continue'
    return false
  }, 'No supported KYC screen appeared; see screenshot and API responses')
}
async function journey() {
  for (let count = 0; count < 18; count++) {
    let screen
    const detected = await step('observe next KYC screen', async () => { screen = await detect(); return { screen } })
    if (!detected) return
    if (screen === 'ident') {
      await step('Ident / Sumsub boundary', async () => {
        // Give the SDK time to surface a blocked provider request or its rendered error.
        await pause(2000)
        await Promise.allSettled([...pending])
        assert(results.apiResponses.some(r => r.source === 'browser' && /\/kyc/.test(r.path)), 'Missing KYC API evidence')
        const db = state()
        assert(!db.kycSteps.some(s => s.name === 'Ident' && s.status === 'Completed'), 'Ident unexpectedly completed')
        results.stop = { kind: 'ident-boundary', reason: 'Ident reached; external identification is outside the local stack.',
          currentStep: safe(currentStep ?? null), apiResponseIndex: results.apiResponses.length - 1,
          sources: results.boundarySource }
        return results.stop
      })
      return
    }
    const ok = await step(`UI: ${screen}`, async () => {
      switch (screen) {
        case 'contact':
          await page.locator('input[name="email"]').fill(mail)
          await page.locator('input[name="email"]').blur()
          await button('Next').click()
          await page.getByText('Is this email address correct?').waitFor()
          await snapshot('contact email confirmation')
          await button('Confirm').click()
          await completed('ContactData')
          assert.equal(state().mail, mail)
          break
        case 'personal':
          await page.getByText('Select...').first().click()
          await page.getByText('Personal', { exact: true }).click()
          for (const [name, value] of Object.entries({ firstname: 'E2EFirst', lastname: 'E2ELast',
            street: 'Bahnhofstrasse', 'house-number': '1', zip: '8001', city: 'Zurich', phone: '+41791234567' })) {
            await page.locator(`input[name="${name}"]`).fill(value)
            await page.locator(`input[name="${name}"]`).blur()
          }
          await country('country')
          await button('Next').click()
          await completed('PersonalData')
          assert.equal(state().firstname, 'E2EFirst')
          assert.equal(state().surname, 'E2ELast')
          break
        case 'nationality':
          await country('nationality')
          await button('Next').click()
          await completed('NationalityData')
          break
        case 'mail-code': {
          // mail.ts stores Login OTPs in texts[].params.url; /2fa instead uses
          // VerificationMail texts[].params.code, as auth.spec.ts:31-78 demonstrates.
          const row = await poll(() => rows(`SELECT id,data FROM notification WHERE "userDataId"=${id(user.userDataId)}
            AND context='VerificationMail' AND id>${notificationBaseline} ORDER BY id DESC LIMIT 1`)[0],
          'No fresh VerificationMail notification; mail verification cannot continue', 20000)
          const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
          const code = data.texts?.map(t => t.params?.code).find(c => typeof c === 'string' && /^\d{6}$/.test(c))
          assert(code, 'VerificationMail missing texts[].params.code')
          secrets.add(code)
          notificationBaseline = row.id
          await page.getByPlaceholder('Email code').fill(code)
          await button('Next').click()
          await page.getByPlaceholder('Email code').waitFor({ state: 'hidden' })
          break
        }
        case 'complete-kyc': case 'enter-email': case 'enter-data': case 'start': case 'continue': {
          const labels = { 'complete-kyc': 'Complete KYC', 'enter-email': 'Enter email', 'enter-data': 'Enter user data',
            start: 'Start', continue: 'Continue' }
          await button(labels[screen]).click()
          await button(labels[screen]).waitFor({ state: 'hidden' })
          break
        }
        default: throw new Error(`${screen}: requires information unavailable in this local UI journey; no fixture bypass`)
      }
      return { submittedViaUi: true }
    })
    if (!ok) return
  }
  await step('bounded KYC journey', () => { throw new Error('Exceeded 18 UI transitions without reaching Ident') })
}
async function main() {
  mkdirSync(OUT, { recursive: true })
  const setup = await step('single @tetherto/wdk-wallet copy and module setup', async () => {
    for (const origin of [API, APP]) assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Local origins required')
    const dfxPath = realpathSync(createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet'))
    const wdkPath = realpathSync(createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet'))
    assert.equal(dfxPath, wdkPath, 'Duplicate @tetherto/wdk-wallet; reinstall e2e dependencies with install-links=true')
    const [{ default: WDK }, { default: WalletManagerEvm }, { default: DfxProtocol }, { chromium }] = await Promise.all([
      import('@tetherto/wdk'), import('@tetherto/wdk-wallet-evm'), import('@dfx.swiss/wdk-protocol-fiat-dfx'), import('playwright')])
    const seed = WDK.getRandomSeedPhrase()
    secrets.add(seed)
    wdk = new WDK(seed).registerWallet('ethereum', WalletManagerEvm, { provider: API })
      .registerProtocol('ethereum', 'dfx', DfxProtocol, { environment: 'sandbox', network: 'ethereum', language: 'en', fetch: localFetch })
    const account = await wdk.getAccount('ethereum', 0)
    address = await account.getAddress()
    fiat = account.getFiatProtocol('dfx')
    browser = await chromium.launch({ headless: true })
    return { walletCopy: dfxPath, address }
  })
  if (!setup) return
  const opened = await step('buy(): fresh wallet login and widget', async () => {
    const url = await widget()
    user = owner()
    const initial = state()
    assert.equal(initial.kycLevel, 0, 'Expected fresh KYC level 0')
    assert(!initial.mail && initial.kycSteps.length === 0, 'Expected account without KYC fixtures')
    notificationBaseline = rows(`SELECT COALESCE(MAX(id),0) AS id FROM notification WHERE "userDataId"=${id(user.userDataId)}`)[0].id
    await open(url)
    await detect()
    return { user, initial }
  })
  if (opened) await journey()
  if (!results.stop) {
    results.stop = { kind: 'before-ident', reason: results.steps.findLast(s => s.status === 'FAIL')?.error ?? 'Ident not reached' }
    await step('reach identification boundary', () => { throw new Error(results.stop.reason) })
  }
  // Independent of journey success: prove the same account still signs in, even after an early stop.
  await step('same account: quoteBuy', async () => {
    const value = await fiat.quoteBuy(options)
    assert(value, 'Missing quote')
    return { quote: value, authenticationProof: 'quoteBuy is indicative; buy() below proves authentication' }
  })
  await step('same account: buy() and reopened widget', async () => {
    assert(user, 'Initial wallet registration failed')
    const before = state()
    const url = await widget()
    assert.deepEqual(owner(), user, 'Wallet owner changed')
    await open(url)
    await detect()
    assert.equal(state().kycLevel, before.kycLevel, 'Reopening changed KYC level')
    return { user, retainedKycLevel: before.kycLevel }
  })
  await step('reopened widget: current KYC progress', async () => {
    assert(user && page, 'Widget unavailable')
    const screen = await detect()
    if (screen === 'complete-kyc') {
      await button('Complete KYC').click()
      await button('Complete KYC').waitFor({ state: 'hidden' })
      await detect()
    }
    // Completed forms must not be offered again on the authenticated return path.
    const resumedScreen = await detect()
    const database = state()
    const formNames = { contact: 'ContactData', personal: 'PersonalData', nationality: 'NationalityData' }
    assert(!database.kycSteps.some(s => s.name === formNames[resumedScreen] && s.status === 'Completed'),
      'Widget offered an already completed KYC form after reopening')
    return { screen: resumedScreen, database }
  })
}
try {
  await main()
} catch (error) {
  mkdirSync(OUT, { recursive: true })
  await step('unexpected runner failure', () => { throw error })
} finally {
  await Promise.allSettled([...pending])
  for (const [name, close] of [['browser', () => browser?.close()], ['wallet', () => wdk?.dispose()]]) {
    try { await close() } catch (error) { results.steps.push({ name: `close ${name}`, status: 'FAIL', error: redact(error.message) }) }
  }
  results.finishedAt = new Date().toISOString()
  results.ok = results.steps.every(s => s.status === 'OK') && results.stop?.kind === 'ident-boundary'
  persist()
  console.table(results.table.map(r => ({ step: r.step, ui: r.path ?? '', kycLevel: r.kycLevel,
    steps: r.kycSteps?.map(s => `${s.name}:${s.status}`).join(', ') })))
  process.exitCode = results.ok ? 0 : 1
}

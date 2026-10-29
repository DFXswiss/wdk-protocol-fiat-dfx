// User-journey simulation through the wallet simulator: a wallet user buys/sells via DFX.
import { chromium } from 'playwright'
import { fork } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = process.env.WALLET_SIM_PORT ?? '4748'
const OUT = new URL('./out/', import.meta.url)
mkdirSync(OUT, { recursive: true })
let server
const stopOnExit = () => server?.kill('SIGKILL')
process.once('exit', stopOnExit)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))
async function startServer () {
  const env = { ...process.env, PORT, WALLET_SIM_ENV: 'sandbox' }
  delete env.WALLET_SIM_SEED_FILE
  delete env.WALLET_SIM_ORDERS_FILE
  server = fork(new URL('./wallet-sim/server.mjs', import.meta.url), [], {
    env, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Wallet server startup timed out')), 30000)
    const exited = () => finish(new Error(`Wallet server exited before readiness (check port ${PORT})`))
    const ready = message => { if (message === 'ready') finish() }
    function finish (error) {
      clearTimeout(timer)
      server.off('error', finish)
      server.off('exit', exited)
      server.off('message', ready)
      if (error) reject(error)
      else resolve()
    }
    server.once('error', finish)
    server.once('exit', exited)
    server.on('message', ready)
  })
}
async function stopServer () {
  const child = server
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      let killTimer
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        killTimer = setTimeout(() => {
          console.error(`Wallet server did not exit after SIGKILL (PID ${child.pid})`)
          process.exitCode = 1
          finish()
        }, 5000)
      }, 5000)
      function finish () {
        clearTimeout(timer)
        clearTimeout(killTimer)
        child.off('exit', finish)
        resolve()
      }
      child.once('exit', finish)
      child.kill('SIGTERM')
    })
  }
  server = undefined
}

const BASE = `http://localhost:${PORT}`
const JOURNEYS = [
  { name: 'eth-eoa-buy-usdt', direction: 'buy', asset: /USDT.*ethereum/i, fiat: 'EUR', amount: '100' },
  { name: 'eth-4337-buy-usdt', smart: true, direction: 'buy', asset: /USDT.*ethereum/i, fiat: 'EUR', amount: '100' },
  { name: 'tron-buy-usdt', direction: 'buy', asset: /USDT.*tron/i, fiat: 'CHF', amount: '100' },
  { name: 'solana-sell-usdt', direction: 'sell', asset: /USDT.*solana/i, fiat: 'EUR', amount: '50' },
  { name: 'bitcoin-buy-btc', unlisted: true, direction: 'buy', asset: /BTC.*bitcoin/i, fiat: 'EUR', amount: '100' },
  { name: 'spark-sell-btc', direction: 'sell', asset: /BTC.*spark/i, fiat: 'EUR', amount: '0.001', crypto: true },
  { name: 'eth-too-low', direction: 'buy', asset: /USDT.*ethereum/i, fiat: 'EUR', amount: '1' }
]
const tid = id => `[data-testid="${id}"], #${id}`
const masked = s => String(s ?? '').replace(/((?:session|access_token|token)(?:=|%3D))[^&\s"<>#]*/gi, '$1[REDACTED]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED-JWT]')
const clean = s => masked(s).replace(/\s+/g, ' ').trim().slice(0, 300)
const STATE_TIMEOUT = 60000
async function waitForState (context, description, predicate) {
  try {
    const result = await context.waitForFunction(predicate, null, { timeout: STATE_TIMEOUT })
    await result.dispose()
  } catch (error) {
    const lastText = await context.evaluate(() => document.body?.innerText ?? '')
      .catch(e => `page read failed: ${e.message}`)
    throw new Error(`${description}: ${error.message}; last text: ${JSON.stringify(clean(lastText))}`)
  }
}

const results = []
const browser = await chromium.launch()
try {
  for (const j of JOURNEYS.filter(j => !process.argv[2] || j.name === process.argv[2])) {
    try {
      await startServer()
      const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
      const timeout = setTimeout(() => { page.close().catch(() => {}) }, 10 * STATE_TIMEOUT)
      try {
        const errors = []
        page.on('pageerror', e => errors.push(String(e)))
        const shot = async step => page.screenshot({ path: fileURLToPath(new URL(`sim-${j.name}-${step}.png`, OUT)) })
        const out = { journey: j.name }
        try {
          await page.goto(BASE, { waitUntil: 'networkidle' })
          if (j.smart) await page.locator(tid('smart-account')).check().catch(() => page.locator(tid('smart-account')).click())
          await page.locator(tid('create-wallet')).click()
          await waitForState(page, 'Wallet accounts did not become visible', () =>
            document.querySelector('#portfolio')?.hidden === false && document.querySelector('#accounts .account'))
          out.home = clean(await page.locator('body').innerText())
          await shot('1-home')

          await page.locator(tid(j.direction === 'buy' ? 'btn-buy' : 'btn-sell')).click()
          await waitForState(page, 'Asset options or a final offer message did not appear', () => {
            const offer = document.querySelector('#offer')?.textContent.trim()
            return document.querySelector('#asset-select option') || (offer && offer !== 'Verfügbare Angebote werden geladen …')
          })
          const select = page.locator(tid('asset-select'))
          await waitForState(page, 'Asset catalog status did not settle', () => {
            const status = document.querySelector('#asset-select')?.dataset.catalog
            return status && status !== 'loading'
          })
          const options = await select.locator('option').allTextContents()
          const pick = options.find(o => j.asset.test(o))
          out.assetOptions = options.length
          const catalog = await select.getAttribute('data-catalog')
          if (pick && j.unlisted) throw new Error(`Asset is unexpectedly offered: ${pick}`)
          if (!pick && j.unlisted) {
            if (catalog === 'error') throw new Error('Asset catalog failed to load')
            if (catalog === 'empty') throw new Error('Asset catalog offers no usable asset and fiat combination for this wallet')
            if (catalog !== 'loaded') throw new Error(`Unexpected asset catalog status: ${catalog}`)
            out.excluded = true
            await shot('2-excluded')
            out.pageErrors = errors.length
            results.push(out)
            console.log(JSON.stringify(out, null, 1))
            continue
          }
          if (!pick) throw new Error(`asset not offered: ${j.asset} in [${options.slice(0, 12).join(' | ')}]`)
          await select.selectOption({ label: pick })
          await page.locator(tid('fiat-select')).selectOption(j.fiat).catch(() => {})
          if (j.crypto) await page.locator(tid('amount-mode')).selectOption('crypto').catch(() => page.locator(tid('amount-mode')).click())
          await page.locator(tid('amount')).fill(j.amount)
          await waitForState(page, 'Quote result or error did not appear', () => {
            const offer = document.querySelector('#offer')
            return offer?.textContent.trim() && (offer.classList.contains('error') || document.querySelector('#continue-dfx')?.disabled === false)
          })
          out.offer = clean(await page.locator(tid('offer')).innerText())
          await shot('2-offer')

          const cont = page.locator(tid('continue-dfx'))
          if (await cont.isDisabled().catch(() => true)) { out.continue = 'disabled'; throw new Error('Continue to DFX is disabled') }
          await cont.click()
          await waitForState(page, 'DFX checkout frame did not open', () =>
            document.querySelector('#browser-sheet')?.hidden === false && document.querySelector('#browser-frame')?.getAttribute('src'))
          const frame = page.frameLocator(tid('browser-frame'))
          const dfxFrame = await (await page.locator(tid('browser-frame')).elementHandle()).contentFrame()
          if (!dfxFrame) throw new Error('DFX checkout frame is unavailable')
          const heading = j.direction === 'buy' ? 'Buy' : 'Sell'
          try {
            await dfxFrame.getByText(heading, { exact: true }).first()
              .waitFor({ state: 'visible', timeout: STATE_TIMEOUT })
          } catch (error) {
            const lastText = await dfxFrame.evaluate(() => document.body?.innerText ?? '')
              .catch(e => `frame read failed: ${e.message}`)
            throw new Error(`DFX widget ${heading} not ready within 60 s; last text: ${JSON.stringify(clean(lastText))}; ${error.message}`)
          }
          out.dfx = clean(await frame.locator('body').innerText().catch(e => 'frame read failed: ' + e.message))
          await shot('3-dfx')

          await page.locator(tid('browser-close')).click()
          await waitForState(page, 'Return to orders did not complete', () =>
            document.querySelector('#browser-sheet')?.hidden === true && document.querySelector('#orders')?.hidden === false)
          await waitForState(page, 'Order list did not finish loading', () => {
            const list = document.querySelector('#order-list')?.textContent.trim()
            return list && list !== 'Aufträge werden geladen …'
          })
          if (!await page.locator(tid('order-item')).count()) {
            throw new Error(`No order available: ${clean(await page.locator('#order-list').innerText())}`)
          }
          await page.locator(tid('order-item')).first().click()
          await waitForState(page, 'Order status or error did not appear', () => {
            const status = document.querySelector('#order-status')
            const text = status?.textContent.trim()
            return status?.hidden === false && text && text !== 'Status bei DFX wird abgefragt …'
          })
          const statusError = await page.locator('#order-status').evaluate(status => {
            const text = status.textContent.trim()
            return status.classList.contains('error') && !text.startsWith('Noch nicht bei DFX eingegangen') ? text : null
          })
          if (statusError !== null) throw new Error(`Order status failed: ${clean(statusError)}`)
          out.status = clean(await page.locator(tid('order-status')).first().innerText().catch(() => ''))
          await shot('4-orders')
        } catch (e) {
          out.stop = masked(e.message).slice(0, 200)
          await shot('x-stop').catch(() => {})
        }
        out.pageErrors = errors.length
        results.push(out)
        console.log(JSON.stringify(out, null, 1))
      } finally {
        clearTimeout(timeout)
        await page.close()
      }
    } finally {
      await stopServer()
    }
  }
  if (!results.length || results.some(out => Object.hasOwn(out, 'stop') || out.pageErrors > 0)) process.exitCode = 1
} finally {
  await stopServer()
  await browser.close()
}

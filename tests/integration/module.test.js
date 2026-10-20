// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals'
import { NoSuchElementError, ProviderError, ValueError } from '@tetherto/wdk-wallet/protocols'
import DfxProtocol from '../../index.js'
import { expectRequests, failure, httpRequest, response } from '../helpers.js'
import {
  accountFixture, challengeMessage, DummyFirstSignature, DummySmartAccount, DUMMY_SMART_ADDRESS,
  DUMMY_TOKEN, EXTERNAL_TRANSACTION_ID, LOCAL_CONFIG, PAIR, resetServer,
  serverControl, UID
} from './helpers.js'

describe('@dfx.swiss/wdk-protocol-fiat-dfx', () => {
  const accounts = []
  let expectedCatalog

  beforeAll(async () => {
    expectedCatalog = JSON.parse(await readFile(new URL('./fixtures/expected-catalog.json', import.meta.url), 'utf8'))
  })

  beforeEach(async () => { await resetServer() })

  async function freshAccount (index = 0) {
    const account = await accountFixture(index)
    accounts.push(account)
    return account
  }

  afterEach(() => {
    for (const account of accounts.splice(0)) account.dispose()
  })

  describe('catalogs', () => {
    test('lists the complete recorded crypto catalog in API order', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.getSupportedCryptoAssets()).toEqual(expectedCatalog.assets)
    })

    test('lists the complete recorded fiat catalog in API order', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.getSupportedFiatCurrencies()).toEqual(expectedCatalog.currencies)
    })

    test('lists the complete recorded country catalog in API order', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.getSupportedCountries()).toEqual(expectedCatalog.countries)
    })
  })

  describe('quotes', () => {
    test('quotes a buy for 100 CHF', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.quoteBuy({ ...PAIR, fiatAmount: 10000n })).toEqual({
        cryptoAmount: 118700000n,
        fiatAmount: 10000n,
        fee: 149n,
        rate: '0.842459983150800337'
      })
    })

    test('quotes a sale for 100 USDT', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.quoteSell({ ...PAIR, cryptoAmount: 100000000n })).toEqual({
        cryptoAmount: 100000000n,
        fiatAmount: 8134n,
        fee: 166n,
        rate: '0.8134'
      })
    })

    test('quotes a buy for 100 USDT', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.quoteBuy({ ...PAIR, cryptoAmount: 100000000n })).toEqual({
        cryptoAmount: 100000000n,
        fiatAmount: 8424n,
        fee: 126n,
        rate: '0.8424'
      })
    })

    test('quotes a sale for 100 CHF', async () => {
      const protocol = new DfxProtocol(undefined, LOCAL_CONFIG)

      expect(await protocol.quoteSell({ ...PAIR, fiatAmount: 10000n })).toEqual({
        cryptoAmount: 122940000n,
        fiatAmount: 10000n,
        fee: 204n,
        rate: '0.813404912965674313'
      })
    })
  })

  describe('authenticated methods', () => {
    test('returns a buy widget URL for an EOA', async () => {
      const protocol = new DfxProtocol(await freshAccount(), LOCAL_CONFIG)

      expect(await protocol.buy({ ...PAIR, fiatAmount: 10000n })).toEqual({
        buyUrl: `https://dev.app.dfx.swiss/buy?session=${DUMMY_TOKEN}&lang=en&asset-in=CHF&asset-out=USDT&blockchain=Ethereum&amount-in=100`
      })
    })

    test('returns a sell widget URL for an EOA', async () => {
      const protocol = new DfxProtocol(await freshAccount(), LOCAL_CONFIG)

      expect(await protocol.sell({ ...PAIR, fiatAmount: 10000n })).toEqual({
        sellUrl: `https://dev.app.dfx.swiss/sell?session=${DUMMY_TOKEN}&lang=en&asset-in=USDT&asset-out=CHF&blockchain=Ethereum&amount-out=100`
      })
    })

    test.each([
      ['buy', { ...PAIR, fiatAmount: 10000n }],
      ['sell', { ...PAIR, fiatAmount: 10000n }],
      ['getTransactionDetail', UID]
    ])('%s submits the smart-account address and a Safe signature', async (method, input) => {
      const smart = new DummySmartAccount(await freshAccount())
      const protocol = new DfxProtocol(smart, LOCAL_CONFIG)

      await failure(protocol[method](input), ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      expect(smart.messages).toEqual([challengeMessage(DUMMY_SMART_ADDRESS)])
      expect(smart.typedData).toEqual([{
        domain: { chainId: 1, verifyingContract: DUMMY_SMART_ADDRESS },
        types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
        message: { message: expect.stringMatching(/^0x[0-9a-f]{64}$/) }
      }])
      const authBodies = await serverControl('/__auth-bodies')
      expect(authBodies).toHaveLength(1)
      expect(authBodies[0].signature).toBe(await smart.account.signTypedData(smart.typedData[0]))
      expect(await serverControl('/__events')).toEqual([
        `challenge:${DUMMY_SMART_ADDRESS}`,
        `login:${DUMMY_SMART_ADDRESS}`
      ])
    })

    test.each([['buy', 'recipient'], ['sell', 'refundAddress']])('%s rejects a mismatching delivery address before signing', async (method, field) => {
      const smart = new DummySmartAccount(await freshAccount())
      const protocol = new DfxProtocol(smart, LOCAL_CONFIG)

      await failure(protocol[method]({ ...PAIR, fiatAmount: 10000n, [field]: '0x0000000000000000000000000000000000000002' }), ValueError,
        `${field} must match the account address`)
      expect(smart.messages).toEqual([])
      expect(await serverControl('/__events')).toEqual([])
    })

    test('rejects an unregistered UID with the recorded error', async () => {
      const protocol = new DfxProtocol(await freshAccount(), LOCAL_CONFIG)

      await failure(protocol.getTransactionDetail(UID), NoSuchElementError, 'Transaction not found')
    })

    test('rejects an unregistered external ID with the recorded error', async () => {
      const protocol = new DfxProtocol(await freshAccount(), LOCAL_CONFIG)

      await failure(protocol.getTransactionDetail(EXTERNAL_TRANSACTION_ID, { idType: 'externalTransactionId' }), NoSuchElementError, 'Transaction not found')
    })
  })

  describe('authentication sessions', () => {
    const ADDRESS = '0x405005c7c4422390f4b334f64cf20e0b767131d0'
    const MESSAGE = challengeMessage(ADDRESS)
    const SIGNATURE = '0xf422b86a971338356e72f01f5e21456c8013321d5f6e23d08d344f2537bdc51f7a4ef5258e2684fdd5ec49c43a3576c2683bec8ab3d5e072484d53c9c1674aa41c'
    const OPTIONS = { ...PAIR, fiatAmount: 10000n }
    const BUY_URL_2 = `https://dev.app.dfx.swiss/buy?session=${DUMMY_TOKEN}.2&lang=en&asset-in=CHF&asset-out=USDT&blockchain=Ethereum&amount-in=100`
    const SELL_URL_2 = `https://dev.app.dfx.swiss/sell?session=${DUMMY_TOKEN}.2&lang=en&asset-in=USDT&asset-out=CHF&blockchain=Ethereum&amount-out=100`
    const EXPECTED_DETAIL = { cryptoAsset: 'USDT', fiatCurrency: 'CHF', status: 'completed' }
    const CHALLENGE = httpRequest(`/v1/auth/signMessage?address=${ADDRESS}`, 'GET', undefined, undefined, 'sandbox')
    const AUTH = httpRequest('/v1/auth', 'POST', JSON.stringify({ address: ADDRESS, signature: SIGNATURE, blockchain: 'Ethereum' }), undefined, 'sandbox')
    const DETAIL = httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, DUMMY_TOKEN, 'sandbox')
    const DETAIL_2 = httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, `${DUMMY_TOKEN}.2`, 'sandbox')
    const CATALOG = [
      httpRequest('/v1/asset', 'GET', undefined, undefined, 'sandbox'),
      httpRequest('/v1/fiat', 'GET', undefined, undefined, 'sandbox')
    ]

    async function trackedProtocol (options = {}) {
      const tracked = new DummySmartAccount(await freshAccount(), ADDRESS)
      const requests = []
      const protocol = new DfxProtocol(tracked, {
        ...LOCAL_CONFIG,
        fetch: async (url, init) => {
          requests.push([url, init])
          return options.fetch ? options.fetch(url, init) : LOCAL_CONFIG.fetch(url, init)
        }
      })
      return { protocol, requests, tracked }
    }

    test('parallel first lookups share one signature and keep their token for the next lookup', async () => {
      await resetServer({ completedDetail: true })
      const { protocol, requests, tracked } = await trackedProtocol()

      const result = await Promise.all([protocol.getTransactionDetail(UID), protocol.getTransactionDetail(UID)])
      const cached = await protocol.getTransactionDetail(UID)

      expect(result).toEqual([EXPECTED_DETAIL, EXPECTED_DETAIL])
      expect(cached).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE])
      expectRequests(requests, [CHALLENGE, AUTH, DETAIL, DETAIL, ...CATALOG, ...CATALOG, DETAIL, ...CATALOG])
    })

    test('parallel 401 responses share one renewal and retain its token for the next lookup', async () => {
      await resetServer({ completedDetail: true })
      let rejectOld = false
      let rejected = 0
      let release
      const bothRejected = new Promise(resolve => { release = resolve })
      const { protocol, requests, tracked } = await trackedProtocol({
        fetch: async (url, init) => {
          if (rejectOld && new URL(url).pathname === '/v1/transaction/detail/single' && init.headers.Authorization === `Bearer ${DUMMY_TOKEN}`) {
            if (++rejected === 2) release()
            await bothRejected
            return response({ message: 'Expired detail session' }, 401)
          }
          return LOCAL_CONFIG.fetch(url, init)
        }
      })

      expect(await protocol.getTransactionDetail(UID)).toEqual(EXPECTED_DETAIL)
      rejectOld = true
      expect(await Promise.all([protocol.getTransactionDetail(UID), protocol.getTransactionDetail(UID)])).toEqual([EXPECTED_DETAIL, EXPECTED_DETAIL])
      expect(await protocol.getTransactionDetail(UID)).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expectRequests(requests, [
        CHALLENGE, AUTH, DETAIL, ...CATALOG, DETAIL, DETAIL,
        CHALLENGE, AUTH, DETAIL_2, DETAIL_2, ...CATALOG, ...CATALOG,
        DETAIL_2, ...CATALOG
      ])
    })

    test.each([
      [1, `${DUMMY_TOKEN}.2`],
      [2, `${DUMMY_TOKEN}.3`]
    ])('preserves another call\'s renewed session after a delayed HTTP 401 on attempt %s', async (attempt, expectedToken) => {
      await resetServer({ expireDetails: attempt, completedDetail: true })
      const tracked = new DummySmartAccount(await freshAccount(), ADDRESS)
      const requests = []
      let signalDelayed
      let releaseDelayed
      const delayed = new Promise(resolve => { signalDelayed = resolve })
      const released = new Promise(resolve => { releaseDelayed = resolve })
      let detailCalls = 0
      const protocol = new DfxProtocol(tracked, {
        ...LOCAL_CONFIG,
        fetch: async (url, init) => {
          requests.push([url, init])
          const hold = new URL(url).pathname === '/v1/transaction/detail/single' && ++detailCalls === attempt
          const result = await LOCAL_CONFIG.fetch(url, init)
          if (hold) {
            signalDelayed()
            await released
          }
          return result
        }
      })

      const late = protocol.getTransactionDetail(UID).catch(error => error)
      await delayed
      let renewed
      try {
        renewed = await protocol.getTransactionDetail(UID)
      } finally {
        releaseDelayed()
      }
      const error = await late
      const cached = await protocol.getTransactionDetail(UID)

      expect(renewed).toEqual(EXPECTED_DETAIL)
      if (attempt === 1) expect(error).toEqual(EXPECTED_DETAIL)
      else await failure(Promise.reject(error), ProviderError, 'Unauthorized', 'UNAUTHORIZED')
      expect(cached).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual(Array.from({ length: attempt + 1 }, () => MESSAGE))
      const freshDetail = httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, expectedToken, 'sandbox')
      const beforeRenewal = attempt === 1 ? [DETAIL, DETAIL] : [DETAIL, CHALLENGE, AUTH, DETAIL_2, DETAIL_2]
      const afterRenewal = attempt === 1 ? [freshDetail, ...CATALOG] : []
      expectRequests(requests, [
        CHALLENGE, AUTH, ...beforeRenewal,
        CHALLENGE, AUTH, freshDetail, ...CATALOG, ...afterRenewal, freshDetail, ...CATALOG
      ])
    })

    test('a failed shared login rejects every waiter with the same error and releases the next login', async () => {
      await resetServer({ auth: 'unauthorized', completedDetail: true })
      const { protocol, requests, tracked } = await trackedProtocol()

      const errors = await Promise.all([
        protocol.getTransactionDetail(UID).catch(error => error),
        protocol.getTransactionDetail(UID).catch(error => error)
      ])
      const next = await protocol.getTransactionDetail(UID)
      const cached = await protocol.getTransactionDetail(UID)

      await failure(Promise.reject(errors[0]), ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      expect(errors[1]).toBe(errors[0])
      expect(next).toEqual(EXPECTED_DETAIL)
      expect(cached).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expectRequests(requests, [CHALLENGE, AUTH, CHALLENGE, AUTH, DETAIL_2, ...CATALOG, DETAIL_2, ...CATALOG])
    })

    test('a two-generations-old caller spends its only retry on the current expired token', async () => {
      const detail3 = httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, `${DUMMY_TOKEN}.3`, 'sandbox')
      const detail4 = httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, `${DUMMY_TOKEN}.4`, 'sandbox')
      await resetServer({ completedDetail: true })
      const expectedRequests = [
        CHALLENGE, AUTH, DETAIL, ...CATALOG, DETAIL,
        DETAIL, CHALLENGE, AUTH, DETAIL_2, ...CATALOG,
        DETAIL_2, CHALLENGE, AUTH, detail3, ...CATALOG,
        detail3, CHALLENGE, AUTH, detail4, ...CATALOG
      ]
      const tracked = new DummySmartAccount(await freshAccount(), ADDRESS)
      const requests = []
      let rejectedToken
      let hold = false
      let signalHeld
      let release
      const held = new Promise(resolve => { signalHeld = resolve })
      const released = new Promise(resolve => { release = resolve })
      const protocol = new DfxProtocol(tracked, {
        ...LOCAL_CONFIG,
        fetch: async (url, init) => {
          requests.push([url, init])
          if (new URL(url).pathname === '/v1/transaction/detail/single' && init.headers.Authorization === rejectedToken) {
            if (hold) {
              hold = false
              signalHeld()
              await released
            }
            return response({ message: 'Expired detail session' }, 401)
          }
          return LOCAL_CONFIG.fetch(url, init)
        }
      })

      const initial = await protocol.getTransactionDetail(UID)
      rejectedToken = `Bearer ${DUMMY_TOKEN}`
      hold = true
      const late = protocol.getTransactionDetail(UID).catch(error => error)
      await held
      let second
      let third
      try {
        second = await protocol.getTransactionDetail(UID)
        rejectedToken = `Bearer ${DUMMY_TOKEN}.2`
        third = await protocol.getTransactionDetail(UID)
        rejectedToken = `Bearer ${DUMMY_TOKEN}.3`
      } finally {
        release()
      }
      const error = await late
      const next = await protocol.getTransactionDetail(UID)

      expect(initial).toEqual(EXPECTED_DETAIL)
      expect(second).toEqual(EXPECTED_DETAIL)
      expect(third).toEqual(EXPECTED_DETAIL)
      await failure(Promise.reject(error), ProviderError, 'Expired detail session', 'UNAUTHORIZED')
      expect(next).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE, MESSAGE, MESSAGE])
      expectRequests(requests, expectedRequests)
    })

    test('authenticates again on the next lookup after the renewed token also receives HTTP 401', async () => {
      await resetServer({ expireDetails: 2, completedDetail: true })
      const { protocol, requests, tracked } = await trackedProtocol()

      const error = await protocol.getTransactionDetail(UID).catch(error => error)
      const result = await protocol.getTransactionDetail(UID)

      await failure(Promise.reject(error), ProviderError, 'Unauthorized', 'UNAUTHORIZED')
      expect(result).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE, MESSAGE])
      expectRequests(requests, [
        CHALLENGE, AUTH, DETAIL, CHALLENGE, AUTH, DETAIL_2,
        CHALLENGE, AUTH,
        httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, `${DUMMY_TOKEN}.3`, 'sandbox'),
        ...CATALOG
      ])
    })

    test('reuses the renewed token without another login after its detail request receives HTTP 500', async () => {
      await resetServer({ expireDetails: 1 })
      const unknown = '00000000-0000-4000-8000-000000000001'
      const failedPath = `/v1/transaction/detail/single?uid=${unknown}`
      const { protocol, requests, tracked } = await trackedProtocol()

      const error = await protocol.getTransactionDetail(unknown).catch(error => error)
      const next = await protocol.getTransactionDetail(UID).catch(error => error)

      await failure(Promise.reject(error), ProviderError, `Unrecorded DFX request: GET ${failedPath} body=null`, 'INTERNAL_SERVER_ERROR')
      await failure(Promise.reject(next), NoSuchElementError, 'Transaction not found')
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expectRequests(requests, [
        CHALLENGE, AUTH, httpRequest(failedPath, 'GET', undefined, DUMMY_TOKEN, 'sandbox'),
        CHALLENGE, AUTH, httpRequest(failedPath, 'GET', undefined, `${DUMMY_TOKEN}.2`, 'sandbox'),
        httpRequest(`/v1/transaction/detail/single?uid=${UID}`, 'GET', undefined, `${DUMMY_TOKEN}.2`, 'sandbox')
      ])
    })

    test('a failed buy login leaves the existing detail session intact', async () => {
      await resetServer({ completedDetail: true })
      let logins = 0
      const authResponses = []
      const { protocol, requests, tracked } = await trackedProtocol({
        fetch: async (url, init) => {
          const auth = new URL(url).pathname === '/v1/auth'
          const result = auth && ++logins === 2
            ? response({ message: 'Widget login failed' }, 401)
            : await LOCAL_CONFIG.fetch(url, init)
          if (auth) {
            const copy = typeof result.clone === 'function' ? result.clone() : result
            authResponses.push({ status: result.status, body: JSON.parse(await copy.text()) })
          }
          return result
        }
      })

      const initial = await protocol.getTransactionDetail(UID)
      const error = await protocol.buy(OPTIONS).catch(error => error)
      const result = await protocol.getTransactionDetail(UID)

      expect(initial).toEqual(EXPECTED_DETAIL)
      await failure(Promise.reject(error), ProviderError, 'Widget login failed', 'UNAUTHORIZED')
      expect(result).toEqual(EXPECTED_DETAIL)
      expect(authResponses).toEqual([
        { status: 201, body: { accessToken: DUMMY_TOKEN } },
        { status: 401, body: { message: 'Widget login failed' } }
      ])
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expectRequests(requests, [
        CHALLENGE, AUTH, DETAIL, ...CATALOG,
        ...CATALOG, CHALLENGE, AUTH,
        DETAIL, ...CATALOG
      ])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`,
        `detail:/v1/transaction/detail/single?uid=${UID}:Bearer ${DUMMY_TOKEN}`,
        `challenge:${ADDRESS}`,
        `detail:/v1/transaction/detail/single?uid=${UID}:Bearer ${DUMMY_TOKEN}`
      ])
    })

    test.each([
      ['buy', false, { buyUrl: BUY_URL_2 }],
      ['sell', false, { sellUrl: SELL_URL_2 }],
      ['buy', true, undefined]
    ])('a fresh %s login with failure %s leaves the detail token unchanged', async (method, fail, expectedWidget) => {
      await resetServer({ completedDetail: true })
      const expectedRequests = [CHALLENGE, AUTH, DETAIL, ...CATALOG, ...CATALOG, CHALLENGE, AUTH, DETAIL, ...CATALOG]
      let logins = 0
      const { protocol, requests, tracked } = await trackedProtocol({
        fetch: (url, init) => {
          if (new URL(url).pathname === '/v1/auth' && ++logins === 2 && fail) return response({ message: 'Widget login failed' }, 401)
          return LOCAL_CONFIG.fetch(url, init)
        }
      })

      const initial = await protocol.getTransactionDetail(UID)
      const widget = await protocol[method](OPTIONS).catch(error => error)
      const cached = await protocol.getTransactionDetail(UID)

      expect(initial).toEqual(EXPECTED_DETAIL)
      if (fail) await failure(Promise.reject(widget), ProviderError, 'Widget login failed', 'UNAUTHORIZED')
      else expect(widget).toEqual(expectedWidget)
      expect(cached).toEqual(EXPECTED_DETAIL)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expectRequests(requests, expectedRequests)
    })

    test('EOA needs one signature for each fresh login', async () => {
      const { protocol, requests, tracked } = await trackedProtocol()

      await protocol.sell(OPTIONS)
      const result = await protocol.buy({ ...OPTIONS, recipient: ADDRESS })

      expect(result).toEqual({ buyUrl: BUY_URL_2 })
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`, `challenge:${ADDRESS}`, `login:${ADDRESS}`
      ])
      expectRequests(requests, [...CATALOG, CHALLENGE, AUTH, ...CATALOG, CHALLENGE, AUTH])
    })

    test.each([
      ['buy', 'recipient', { buyUrl: BUY_URL_2 }],
      ['sell', 'refundAddress', { sellUrl: SELL_URL_2 }]
    ])('%s opens a fresh session after transaction lookup', async (method, field, expectedResult) => {
      const { protocol, requests, tracked } = await trackedProtocol()

      await protocol.getTransactionDetail(UID).catch(() => {})
      const result = await protocol[method]({ ...OPTIONS, [field]: ADDRESS })

      expect(result).toEqual(expectedResult)
      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`,
        `detail:/v1/transaction/detail/single?uid=${UID}:Bearer ${DUMMY_TOKEN}`,
        `challenge:${ADDRESS}`, `login:${ADDRESS}`
      ])
      expectRequests(requests, [CHALLENGE, AUTH, DETAIL, ...CATALOG, CHALLENGE, AUTH])
    })

    test.each([
      ['buy', 'recipient'],
      ['sell', 'refundAddress']
    ])('%s rejects mismatched EOA delivery before signing or login', async (method, field) => {
      const { protocol, tracked } = await trackedProtocol()

      await protocol.getTransactionDetail(UID).catch(() => {})
      await failure(protocol[method]({ ...OPTIONS, [field]: DUMMY_SMART_ADDRESS }), ValueError, `${field} must match the account address`)

      expect(tracked.messages).toEqual([MESSAGE])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`,
        `detail:/v1/transaction/detail/single?uid=${UID}:Bearer ${DUMMY_TOKEN}`
      ])
    })

    test('transaction details establish their own session after a widget login', async () => {
      const { protocol, tracked } = await trackedProtocol()

      await protocol.buy(OPTIONS)
      await protocol.getTransactionDetail(UID).catch(() => {})

      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`, `challenge:${ADDRESS}`, `login:${ADDRESS}`,
        `detail:/v1/transaction/detail/single?uid=${UID}:Bearer ${DUMMY_TOKEN}.2`
      ])
    })

    test('an unrecoverable EOA signature proceeds to normal backend login', async () => {
      const tracked = new DummyFirstSignature(await freshAccount(), 'invalid-signature')
      tracked.address = ADDRESS
      const protocol = new DfxProtocol(tracked, LOCAL_CONFIG)

      await failure(protocol.sell(OPTIONS), ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      await protocol.buy(OPTIONS)

      expect(tracked.messages).toEqual([MESSAGE, MESSAGE])
      expect(await serverControl('/__events')).toEqual([
        `challenge:${ADDRESS}`, `login:${ADDRESS}`, `challenge:${ADDRESS}`, `login:${ADDRESS}`
      ])
    })
  })
})

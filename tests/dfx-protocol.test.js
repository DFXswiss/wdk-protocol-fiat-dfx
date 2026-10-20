// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { ProviderErrorReason } from '@tetherto/wdk-wallet'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js'
import { AbiCoder, hashMessage, TypedDataEncoder, verifyMessage, verifyTypedData, Wallet } from 'ethers'
import { SafeAccountV0_3_0 as SafeAccount030 } from 'abstractionkit'
import {
  AccountRequiredError, BuyError, SellError, BuyErrorReason, SellErrorReason, FiatProtocol, MaximumFeeExceededError, NoSuchElementError, IFiatProtocol as WalletFiatProtocol,
  ProviderError, ProviderRequiredError, ValueError, NotImplementedError, ReadOnlyAccountRequiredError
} from '@tetherto/wdk-wallet/protocols'
import DfxProtocol, { DfxProtocol as NamedDfxProtocol, IFiatProtocol } from '../index.js'
import * as publicApi from '../index.js'
import { challengeMessage, expectRequests, failure, failureSync, httpRequest, response } from './helpers.js'

const fetchMock = jest.fn()
const getAddressMock = jest.fn()
const signMock = jest.fn()
const signTypedDataMock = jest.fn()
const transportMock = jest.fn()
const bodyTextMock = jest.fn()
const timerMock = jest.fn()
const authMock = jest.fn()
globalThis.fetch = transportMock

class DummyReadOnlyAccount {
  async getAddress (...args) {
    return getAddressMock(...args)
  }
}

class DummyAccount extends DummyReadOnlyAccount {
  async sign (...args) {
    return signMock(...args)
  }
}

class DummyTypedAccount extends DummyAccount {
  async signTypedData (...args) {
    return signTypedDataMock(...args)
  }
}

class DummyResponse {
  ok = true
  status = 200
  text = bodyTextMock
}

describe('@dfx.swiss/wdk-protocol-fiat-dfx', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    getAddressMock.mockReset()
    signMock.mockReset()
    signTypedDataMock.mockReset()
    transportMock.mockReset()
    bodyTextMock.mockReset()
    timerMock.mockReset()
    authMock.mockReset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  const DUMMY_ASSETS = [
    { id: 1, name: 'ETH', uniqueName: 'Ethereum/ETH', blockchain: 'Ethereum', description: 'Ether', decimals: 18, buyable: true, sellable: true },
    { id: 2, name: 'USDT', uniqueName: 'Ethereum/USDT', blockchain: 'Ethereum', description: 'Tether', decimals: 6, buyable: true, sellable: true },
    { id: 3, name: 'USDT', uniqueName: 'Tron/USDT', blockchain: 'Tron', description: 'Tether', decimals: 6, buyable: true, sellable: true },
    { id: 4, name: 'BTC', uniqueName: 'Bitcoin/BTC', blockchain: 'Bitcoin', description: 'Bitcoin', buyable: true, sellable: true },
    { id: 5, name: 'BUY', uniqueName: 'Ethereum/BUY', blockchain: 'Ethereum', description: 'Buy only', decimals: 2, buyable: true, sellable: false },
    { id: 6, name: 'SELL', uniqueName: 'Ethereum/SELL', blockchain: 'Ethereum', description: 'Sell only', decimals: 2, buyable: false, sellable: true },
    { id: 7, name: 'OFF', uniqueName: 'Ethereum/OFF', blockchain: 'Ethereum', decimals: 2, buyable: false, sellable: false }
  ]
  const DUMMY_FIAT = [
    { id: 11, name: 'EUR', buyable: true, sellable: true },
    { id: 12, name: 'CHF', buyable: true, sellable: true },
    { id: 13, name: 'JPY', buyable: true, sellable: false },
    { id: 14, name: 'BHD', buyable: false, sellable: true },
    { id: 15, name: 'ZZZ', buyable: true, sellable: true },
    { id: 16, name: 'USD', buyable: false, sellable: false }
  ]
  const DUMMY_COUNTRIES = [
    { symbol: 'CH', name: 'Switzerland', bankAllowed: true, cardAllowed: false, locationAllowed: false },
    { symbol: 'US', name: 'United States', bankAllowed: false, cardAllowed: true, locationAllowed: true }
  ]
  const DUMMY_BUY = '{"isValid":true,"amount":100,"estimatedAmount":0.123456789012345678,"rate":810.000000000000001,"fees":{"total":1.23}}'
  const DUMMY_SELL = '{"isValid":true,"amount":0.123456789012345678,"estimatedAmount":100,"rate":0.00125,"fees":{"total":0.9},"feesTarget":{"total":1.23}}'
  const DUMMY_DETAIL = { uid: '123', type: 'Buy', state: 'Completed', inputAssetId: 11, inputAsset: 'EUR', outputAssetId: 1, outputAsset: 'Ethereum/ETH', outputBlockchain: 'Ethereum' }
  const OPTIONS = { cryptoAsset: 'ETH', fiatCurrency: 'EUR', fiatAmount: 10000n }
  const DUMMY_ADDRESS = '0x0000000000000000000000000000000000000001'
  const EXPECTED_QUOTE = { cryptoAmount: 123456789012345678n, fiatAmount: 10000n, fee: 123n, rate: '810.000007290000072' }
  const CATALOG_REQUESTS = [httpRequest('/v1/asset'), httpRequest('/v1/fiat')]
  const CHALLENGE_REQUEST = httpRequest('/v1/auth/signMessage?address=0x0000000000000000000000000000000000000001')
  const AUTH_REQUEST = httpRequest('/v1/auth', 'POST', '{"address":"0x0000000000000000000000000000000000000001","signature":"dummy-signature"}')
  const ETH_AUTH_REQUEST = httpRequest('/v1/auth', 'POST', '{"address":"0x0000000000000000000000000000000000000001","signature":"dummy-signature","blockchain":"Ethereum"}')
  const DETAIL_REQUEST = httpRequest('/v1/transaction/detail/single?uid=123', 'GET', undefined, 'dummy-session')
  const ETH_WIDGET_REQUESTS = [...CATALOG_REQUESTS, CHALLENGE_REQUEST, ETH_AUTH_REQUEST]
  const BUY_QUOTE_REQUEST = httpRequest('/v1/buy/quote', 'PUT', '{"currency":{"name":"EUR"},"asset":{"id":1},"specialCode":"","paymentMethod":"Bank","amount":100}')
  const SELL_QUOTE_REQUEST = httpRequest('/v1/sell/quote', 'PUT', '{"currency":{"name":"EUR"},"asset":{"id":1},"specialCode":"","targetAmount":100}')

  function expectInteractions (requests, signatures = [], addresses = []) {
    expectRequests(fetchMock.mock.calls, requests)
    expect(signMock.mock.calls).toEqual(signatures)
    expect(getAddressMock.mock.calls).toEqual(addresses)
  }

  function widget (method, { token = 'dummy-session', asset = 'ETH', blockchain = 'Ethereum', amount = '100', crypto = false } = {}) {
    const assets = method === 'buy' ? `asset-in=EUR&asset-out=${asset}` : `asset-in=${asset}&asset-out=EUR`
    const field = (method === 'buy') !== crypto ? 'amount-in' : 'amount-out'
    return { [`${method}Url`]: `https://app.dfx.swiss/${method}?session=${token}&lang=en&${assets}&blockchain=${blockchain}&${field}=${amount}` }
  }

  // Explicit route lookup makes unexpected calls fail instead of borrowing another endpoint's fixture.
  function setup (config = {}, overrides = {}, account = new DummyAccount()) {
    getAddressMock.mockReset().mockResolvedValue(DUMMY_ADDRESS)
    signMock.mockReset().mockResolvedValue('dummy-signature')
    const routes = {
      'GET /v1/asset': response(DUMMY_ASSETS),
      'GET /v1/fiat': response(DUMMY_FIAT),
      'GET /v1/country': response(DUMMY_COUNTRIES),
      [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: challengeMessage(DUMMY_ADDRESS, config.environment), blockchains: ['Ethereum'] }),
      'POST /v1/auth': response({ accessToken: 'dummy-session' }, 201),
      'PUT /v1/buy/quote': response(DUMMY_BUY),
      'PUT /v1/sell/quote': response(DUMMY_SELL),
      'GET /v1/transaction/detail/single?uid=123': response(DUMMY_DETAIL),
      ...overrides
    }
    const base = config.environment === 'sandbox' ? 'https://dev.api.dfx.swiss' : 'https://api.dfx.swiss'
    const fetch = fetchMock.mockReset().mockImplementation(async (url, init) => {
      const route = Object.keys(routes).find(route => url === base + route.slice(route.indexOf(' ') + 1) && init.method === route.slice(0, route.indexOf(' ')))
      const value = routes[route]
      if (value === undefined) throw new ProviderError('Unexpected test route', { reason: 'INTERNAL_SERVER_ERROR' })
      const result = typeof value === 'function' ? await value(init) : value
      return result
    })
    return { protocol: new DfxProtocol(account, { fetch, ...config }), routes }
  }

  const OWNER_ADDRESS = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  const DUMMY_ACCOUNT_MESSAGE = challengeMessage(DUMMY_ADDRESS)
  const ERC_6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'
  // Independent of src/constants.js so a wrong salt or module address cannot wrap.
  const WDK_SAFE_OVERRIDES = {
    c2Nonce: BigInt('0x69b348339eea4ed93f9d11931c3b894c8f9d8c7663a053024b11cb7eb4e5a1f6'),
    entrypointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    safe4337ModuleAddress: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
    safeModuleSetupAddress: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47'
  }

  function ownerSignature (message, vOffset = 27) {
    // Public test key 1. The expected EOA is fixed independently of recovery.
    const OWNER_KEY = Uint8Array.from([...new Array(31).fill(0), 1])
    const payload = Buffer.from(message, 'utf8')
    const digest = keccak256(Buffer.concat([
      Buffer.from(`\x19Ethereum Signed Message:\n${payload.length}`, 'utf8'), payload
    ]))
    const signature = secp256k1.sign(digest, OWNER_KEY, { prehash: false, format: 'recovered' })
    return '0x' + Buffer.from(signature.subarray(1)).toString('hex') + (signature[0] + vOffset).toString(16).padStart(2, '0')
  }

  function ownerSetup (network = 'Ethereum', address = DUMMY_ADDRESS, vOffset = 27) {
    const message = challengeMessage(address)
    const result = setup({ network }, {
      'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: network }]),
      [`GET /v1/auth/signMessage?address=${address}`]: response({ message })
    })
    getAddressMock.mockResolvedValue(address)
    signMock.mockImplementation(async message => ownerSignature(message, vOffset))
    return result
  }

  async function buyMatchingSafe (network, invoke = protocol => protocol.buy(OPTIONS), { catalog = true } = {}) {
    const predicted = SafeAccount030.createAccountAddress([OWNER_ADDRESS], WDK_SAFE_OVERRIDES)
    const account = '0x' + predicted.slice(2).toUpperCase()
    const message = challengeMessage(account)
    const wallet = new Wallet('0x' + '00'.repeat(31) + '01')
    let safeSignature
    signTypedDataMock.mockImplementation(async typed => {
      safeSignature = await wallet.signTypedData(typed.domain, typed.types, typed.message)
      return safeSignature
    })
    const routes = {
      [`GET /v1/auth/signMessage?address=${account}`]: response({ message })
    }
    if (catalog) routes['GET /v1/asset'] = response([{ ...DUMMY_ASSETS[0], blockchain: network }])
    const { protocol } = setup({ network }, routes, new DummyTypedAccount())
    getAddressMock.mockResolvedValue(account)
    signMock.mockImplementation(async signed => ownerSignature(signed))
    const result = await invoke(protocol)
    const typed = signTypedDataMock.mock.calls[0][0]
    const auth = fetchMock.mock.calls.find(call => call[1]?.method === 'POST' && String(call[0]).endsWith('/v1/auth'))
    return { predicted, account, message, safeSignature, result, typed, body: JSON.parse(auth[1].body) }
  }

  function wrappedInner (signature) {
    const encoded = '0x' + signature.slice(2, -ERC_6492_MAGIC.length)
    return AbiCoder.defaultAbiCoder().decode(['address', 'bytes', 'bytes'], encoded)[2]
  }

  const NATIVE_ASSETS = [['Bitcoin', 'BTC', 'bitcoin'], ['Lightning', 'BTC', 'lightning'], ['Arkade', 'BTC', 'arkade'], ['Firo', 'FIRO', 'firo']]
  const EXTERNAL_IDS = [
    ['a', 'a'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._%3A-'],
    ['x'.repeat(256), 'x'.repeat(256)]
  ]
  const INVALID_EXTERNAL_IDS = ['', '  ', 'x'.repeat(257), ' leading', 'trailing ', 'a b', '<id>', 'id>', 'a/b', 'a?b', 'a&b', 'a=b', 'a+b', 'a#b', 'a%b', 'ümlaut', 'a\nb', 'a\n', 'a\r', 'a\t', 'a\u0000', 'a\u200b']
  const EXTERNAL_ID_MESSAGE = 'externalTransactionId must contain 1–256 characters from A-Z, a-z, 0-9, dot (.), underscore (_), colon (:) and hyphen (-)'

  function tradeCases (METHOD) {
    const EXPECTATIONS = {
      buy: { signatures: [[challengeMessage(DUMMY_ADDRESS)]], addresses: [[]], result: widget('buy'), requests: ETH_WIDGET_REQUESTS },
      sell: { signatures: [[challengeMessage(DUMMY_ADDRESS)]], addresses: [[]], result: widget('sell'), requests: ETH_WIDGET_REQUESTS },
      quoteBuy: { signatures: [], addresses: [], result: EXPECTED_QUOTE, requests: [...CATALOG_REQUESTS, BUY_QUOTE_REQUEST] },
      quoteSell: { signatures: [], addresses: [], result: EXPECTED_QUOTE, requests: [...CATALOG_REQUESTS, SELL_QUOTE_REQUEST] }
    }
    const { signatures, addresses, result: EXPECTED_RESULT, requests: EXPECTED_REQUESTS } = EXPECTATIONS[METHOD]
    test.each(NATIVE_ASSETS.flatMap(([NETWORK, CRYPTO_ASSET]) => [null, undefined].map(DUMMY_DECIMALS =>
      [NETWORK, CRYPTO_ASSET, METHOD, DUMMY_DECIMALS]
    )))('%s/%s %s rejects API decimals %p', async (NETWORK, CRYPTO_ASSET, CASE_METHOD, DUMMY_DECIMALS) => {
      const { protocol } = setup({ network: NETWORK }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], blockchain: NETWORK, name: CRYPTO_ASSET, decimals: DUMMY_DECIMALS }])
      })

      await failure(protocol[CASE_METHOD]({ cryptoAsset: CRYPTO_ASSET, fiatCurrency: 'EUR', cryptoAmount: 125000000n }), ValueError, `Missing decimals for ${NETWORK}/${CRYPTO_ASSET}`)
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD].flatMap(CASE_METHOD =>
      ['', '  '].map(NETWORK => [CASE_METHOD, NETWORK])
    ))('%s rejects invalid per-operation networks %#', async (CASE_METHOD, NETWORK) => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, config: { network: NETWORK } }), ValueError, 'network must be a non-empty string')
      expectInteractions([])
    })

    test.each([METHOD].flatMap(CASE_METHOD =>
      [['ETH', 1], ['eth', 8]].map(([CRYPTO_ASSET, EXPECTED_ID]) => [CASE_METHOD, CRYPTO_ASSET, EXPECTED_ID])
    ))('%s prefers the unique exact asset spelling %s on one network', async (CASE_METHOD, CRYPTO_ASSET, EXPECTED_ID) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        'GET /v1/asset': response([
          { ...DUMMY_ASSETS[0], id: 8, name: 'eth' }, DUMMY_ASSETS[0]
        ])
      })
      const RESULTS = { buy: widget('buy', { asset: CRYPTO_ASSET }), sell: widget('sell', { asset: CRYPTO_ASSET }), quoteBuy: EXPECTED_QUOTE, quoteSell: EXPECTED_QUOTE }
      const REQUESTS = {
        buy: ETH_WIDGET_REQUESTS,
        sell: ETH_WIDGET_REQUESTS,
        quoteBuy: [...CATALOG_REQUESTS, httpRequest('/v1/buy/quote', 'PUT', `{"currency":{"name":"EUR"},"asset":{"id":${EXPECTED_ID}},"specialCode":"","paymentMethod":"Bank","amount":100}`)],
        quoteSell: [...CATALOG_REQUESTS, httpRequest('/v1/sell/quote', 'PUT', `{"currency":{"name":"EUR"},"asset":{"id":${EXPECTED_ID}},"specialCode":"","targetAmount":100}`)]
      }

      const result = await protocol[CASE_METHOD]({ ...OPTIONS, cryptoAsset: CRYPTO_ASSET, config: {} })

      expect(result).toEqual(RESULTS[CASE_METHOD])
      expectInteractions(REQUESTS[CASE_METHOD], signatures, addresses)
    })

    test.each([METHOD].flatMap(CASE_METHOD => [
      ['Eth', ['ETH', 'eth']],
      ['ETH', ['ETH', 'ETH']]
    ].map(values => [CASE_METHOD, ...values])))('%s rejects unresolved asset spelling on one network %#', async (CASE_METHOD, CRYPTO_ASSET, DUMMY_NAMES) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        'GET /v1/asset': response(DUMMY_NAMES.map((DUMMY_NAME, index) => ({ ...DUMMY_ASSETS[0], id: index + 1, name: DUMMY_NAME, blockchain: index === 0 ? 'Ethereum' : 'ETHEREUM' })))
      })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, cryptoAsset: CRYPTO_ASSET }), ValueError,
        `Ambiguous asset spelling ${CRYPTO_ASSET} on network ethereum`)
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD].flatMap(CASE_METHOD =>
      ['EUR', 'eur'].map(FIAT_CURRENCY => [CASE_METHOD, FIAT_CURRENCY])
    ))('%s matches input %s to the uppercase fiat catalog entry and excludes lowercase rows', async (CASE_METHOD, FIAT_CURRENCY) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        'GET /v1/fiat': response([{ ...DUMMY_FIAT[0], id: 18, name: 'eur' }, DUMMY_FIAT[0]])
      })
      const result = await protocol[CASE_METHOD]({ ...OPTIONS, fiatCurrency: FIAT_CURRENCY })
      expect(result).toEqual(EXPECTED_RESULT)
      expectInteractions(EXPECTED_REQUESTS, signatures, addresses)
    })

    test.each([METHOD].flatMap(CASE_METHOD => [
      ['Eur', ['EUR', 'EUR']], ['EUR', ['EUR', 'EUR']]
    ].map(values => [CASE_METHOD, ...values])))('%s rejects unresolved fiat collisions %#', async (CASE_METHOD, FIAT_CURRENCY, DUMMY_NAMES) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        'GET /v1/fiat': response(DUMMY_NAMES.map((DUMMY_NAME, index) => ({ ...DUMMY_FIAT[0], id: index + 11, name: DUMMY_NAME })))
      })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, fiatCurrency: FIAT_CURRENCY }), ValueError, `Ambiguous fiat currency: ${FIAT_CURRENCY}`)
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD].flatMap(CASE_METHOD =>
      ['eur', 'EUR'].map(FIAT_CURRENCY => [CASE_METHOD, FIAT_CURRENCY])
    ))('%s rejects input %s when only a lowercase fiat catalog row exists', async (CASE_METHOD, FIAT_CURRENCY) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        'GET /v1/fiat': response([{ ...DUMMY_FIAT[0], name: 'eur' }])
      })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, fiatCurrency: FIAT_CURRENCY }), ValueError,
        `Unsupported ${CASE_METHOD.toLowerCase().includes('buy') ? 'buy' : 'sell'} fiat currency: ${FIAT_CURRENCY}`)
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD].flatMap(CASE_METHOD =>
      [{}, { fiatAmount: 1n, cryptoAmount: 1n }].map(AMOUNTS => [CASE_METHOD, AMOUNTS])
    ))('%s rejects invalid amount selection %#', async (CASE_METHOD, AMOUNTS) => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', ...AMOUNTS }), ValueError, 'Exactly one of fiatAmount and cryptoAmount must be supplied')
      expectInteractions([])
    })

    test.each([METHOD])('%s rejects input precision loss', async CASE_METHOD => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', cryptoAmount: 123456789012345678n }), ValueError, 'amount exceeds the precision the DFX API accepts')
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD])('%s rejects assets with missing decimals', async CASE_METHOD => {
      const { protocol } = setup({ network: 'bitcoin' }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], name: 'UNKNOWN' }])
      })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, cryptoAsset: 'UNKNOWN' }), ValueError, 'Missing decimals for Bitcoin/UNKNOWN')
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([
      ['buy', 'SELL', 'EUR', 'Unsupported buy asset or network: SELL'],
      ['quoteBuy', 'SELL', 'EUR', 'Unsupported buy asset or network: SELL'],
      ['sell', 'BUY', 'EUR', 'Unsupported sell asset or network: BUY'],
      ['quoteSell', 'BUY', 'EUR', 'Unsupported sell asset or network: BUY'],
      ['buy', 'ETH', 'BHD', 'Unsupported buy fiat currency: BHD'],
      ['quoteBuy', 'ETH', 'BHD', 'Unsupported buy fiat currency: BHD'],
      ['sell', 'ETH', 'JPY', 'Unsupported sell fiat currency: JPY'],
      ['quoteSell', 'ETH', 'JPY', 'Unsupported sell fiat currency: JPY'],
      ['quoteBuy', 'ETH', 'ZZZ', 'Unsupported buy fiat currency: ZZZ'],
      ['quoteBuy', 'ETH', 'XXX', 'Unsupported buy fiat currency: XXX'],
      ['quoteBuy', 'UNKNOWN', 'EUR', 'Unsupported buy asset or network: UNKNOWN']
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s enforces direction and supported metadata', async (CASE_METHOD, CRYPTO_ASSET, FIAT_CURRENCY, EXPECTED_MESSAGE) => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, cryptoAsset: CRYPTO_ASSET, fiatCurrency: FIAT_CURRENCY }), ValueError, EXPECTED_MESSAGE)
      expectInteractions(CATALOG_REQUESTS)
    })
  }

  function widgetCases (METHOD) {
    test.each(['Ethereum', 'Sepolia', 'BinanceSmartChain', 'Optimism', 'Arbitrum', 'Polygon', 'Base', 'Haqq', 'Gnosis', 'Plasma', 'Citrea', 'CitreaTestnet'])(
      '%s submits the account address when the signature recovers elsewhere', async NETWORK => {
        const { protocol } = ownerSetup(NETWORK.toUpperCase())

        const result = await protocol[METHOD](OPTIONS)

        expect(result).toEqual(widget(METHOD, { blockchain: NETWORK.toUpperCase() }))
        expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST,
          httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: ownerSignature(DUMMY_ACCOUNT_MESSAGE), blockchain: NETWORK }))],
        [[DUMMY_ACCOUNT_MESSAGE]], [[]])
      }
    )

    test.each(['Tron', 'Solana', 'Bitcoin'].flatMap(NETWORK => [METHOD].map(CASE_METHOD => [NETWORK, CASE_METHOD])))(
      '%s %s rejects mismatched delivery before authentication', async (NETWORK, CASE_METHOD) => {
        const { protocol } = ownerSetup(NETWORK)
        const FIELD = CASE_METHOD === 'buy' ? 'recipient' : 'refundAddress'
        await failure(protocol[CASE_METHOD]({ ...OPTIONS, [FIELD]: 'dummy-different-address' }), ValueError, `${FIELD} must match the account address`)
        expectInteractions(CATALOG_REQUESTS, [], [[]])
      }
    )

    test.each([METHOD])('%s preserves DFX spelling with mixed-case input', async CASE_METHOD => {
      const { protocol } = setup({ network: 'eThErEuM' })
      const EXPECTED_ASSETS = CASE_METHOD === 'buy' ? 'asset-in=EUR&asset-out=USDT' : 'asset-in=USDT&asset-out=EUR'
      const AMOUNT = CASE_METHOD === 'buy' ? 'amount-in' : 'amount-out'
      const result = await protocol[CASE_METHOD]({ cryptoAsset: 'USDt', fiatCurrency: 'eUr', fiatAmount: 10000n, config: { network: 'ETHEREUM' } })
      expect(result).toEqual({ [`${CASE_METHOD}Url`]: `https://app.dfx.swiss/${CASE_METHOD}?session=dummy-session&lang=en&${EXPECTED_ASSETS}&blockchain=Ethereum&${AMOUNT}=100` })
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([METHOD].flatMap(CASE_METHOD => [
      ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', '0xAbcdefABCDEFabcdefABCDEFabcdefABCDEFabcd'],
      ['TronAddressAbC', 'TronAddressAbC']
    ].map(values => [CASE_METHOD, ...values])))('%s accepts matching address case %#', async (CASE_METHOD, DUMMY_ACCOUNT_ADDRESS, ADDRESS_OVERRIDE) => {
      const message = challengeMessage(DUMMY_ACCOUNT_ADDRESS)
      const { protocol } = setup({ network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ACCOUNT_ADDRESS}`]: response({ message })
      })
      getAddressMock.mockResolvedValue(DUMMY_ACCOUNT_ADDRESS)
      const FIELD = CASE_METHOD === 'buy' ? 'recipient' : 'refundAddress'
      const result = await protocol[CASE_METHOD]({ ...OPTIONS, [FIELD]: ADDRESS_OVERRIDE })

      expect(result).toEqual(widget(CASE_METHOD))
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ACCOUNT_ADDRESS}`),
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ACCOUNT_ADDRESS, signature: 'dummy-signature', blockchain: 'Ethereum' }))],
      [[message]], [[]])
    })

    test.each([
      ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', '0xabcdefabcdefabcdefabcdefabcdefabcdefabce'],
      ['TronAddressAbC', 'tronaddressabc'],
      ['0xAbCd', '0xabcd'],
      ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 'not-hex']
    ])('rejects mismatching address case %#', async (DUMMY_ACCOUNT_ADDRESS, ADDRESS_OVERRIDE) => {
      const { protocol } = setup({ network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ACCOUNT_ADDRESS}`]: response({ message: challengeMessage(DUMMY_ACCOUNT_ADDRESS) })
      })
      getAddressMock.mockResolvedValue(DUMMY_ACCOUNT_ADDRESS)
      const FIELD = METHOD === 'buy' ? 'recipient' : 'refundAddress'

      await failure(protocol[METHOD]({ ...OPTIONS, [FIELD]: ADDRESS_OVERRIDE }), ValueError, `${FIELD} must match the account address`)

      expectInteractions(CATALOG_REQUESTS, [], [[]])
    })

    test.each([
      ['buy', { fiatAmount: 10000n }, 'amount-in=100', 'EUR', 'ETH'],
      ['buy', { cryptoAmount: 50000000000000000n }, 'amount-out=0.05', 'EUR', 'ETH'],
      ['sell', { cryptoAmount: 50000000000000000n }, 'amount-in=0.05', 'ETH', 'EUR'],
      ['sell', { fiatAmount: 10000 }, 'amount-out=100', 'ETH', 'EUR']
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s builds the correct URL amount side for case %#', async (CASE_METHOD, AMOUNT, AMOUNT_PARAMETER, ASSET_IN, ASSET_OUT) => {
      const { protocol } = setup({ environment: 'sandbox', network: 'ethereum', wallet: 'dummy-partner', publicKey: 'dummy-public-key', language: 'de' })
      const result = await protocol[CASE_METHOD]({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', ...AMOUNT })

      expect(result).toEqual({
        [`${CASE_METHOD}Url`]: `https://dev.app.dfx.swiss/${CASE_METHOD}?session=dummy-session&lang=de&asset-in=${ASSET_IN}&asset-out=${ASSET_OUT}&blockchain=Ethereum&${AMOUNT_PARAMETER}`
      })
      expectInteractions([
        httpRequest('/v1/asset', 'GET', undefined, undefined, 'sandbox'),
        httpRequest('/v1/fiat', 'GET', undefined, undefined, 'sandbox'),
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ADDRESS}`, 'GET', undefined, undefined, 'sandbox'),
        httpRequest('/v1/auth', 'POST', '{"address":"0x0000000000000000000000000000000000000001","signature":"dummy-signature","wallet":"dummy-partner","blockchain":"Ethereum","key":"dummy-public-key"}', undefined, 'sandbox')
      ], [[challengeMessage(DUMMY_ADDRESS, 'sandbox')]], [[]])
    })

    test.each([METHOD])('%s accepts its default address explicitly', async CASE_METHOD => {
      const { protocol } = setup({ network: 'ethereum' })
      const INPUT_OPTIONS = { ...OPTIONS, [CASE_METHOD === 'buy' ? 'recipient' : 'refundAddress']: DUMMY_ADDRESS, config: { network: 'ethereum' } }
      const EXPECTED_ASSETS = CASE_METHOD === 'buy' ? 'asset-in=EUR&asset-out=ETH' : 'asset-in=ETH&asset-out=EUR'
      const AMOUNT = CASE_METHOD === 'buy' ? 'amount-in' : 'amount-out'

      const result = await protocol[CASE_METHOD](INPUT_OPTIONS)

      expect(result).toEqual({ [`${CASE_METHOD}Url`]: `https://app.dfx.swiss/${CASE_METHOD}?session=dummy-session&lang=en&${EXPECTED_ASSETS}&blockchain=Ethereum&${AMOUNT}=100` })
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([METHOD])('%s requires a full account', async CASE_METHOD => {
      const { protocol } = setup({}, {}, new DummyReadOnlyAccount())
      await failure(protocol[CASE_METHOD](OPTIONS), AccountRequiredError, 'A signing account is required for buy and sell')
      expectInteractions([])
    })

    test.each([METHOD])('%s requires a constructor network', async CASE_METHOD => {
      const { protocol } = setup()
      await failure(protocol[CASE_METHOD](OPTIONS), ValueError, 'network must be configured in the constructor to bind the account to a chain')
      expectInteractions([])
    })

    test.each([METHOD])('%s rejects a network different from the constructor', async CASE_METHOD => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, config: { network: 'tron' } }), ValueError, 'network must match the account network configured in the constructor')
      expectInteractions([])
    })

    test.each(EXTERNAL_IDS.map(([ID, EXPECTED_ID]) => [METHOD, ID, EXPECTED_ID]))('%s appends an encoded external ID %#', async (CASE_METHOD, ID, EXPECTED_ID) => {
      const { protocol } = setup({ network: 'ethereum' })
      const EXPECTED_RESULT = widget(CASE_METHOD)
      const result = await protocol[CASE_METHOD]({ ...OPTIONS, config: { externalTransactionId: ID } })
      expect(result).toEqual({ [`${CASE_METHOD}Url`]: EXPECTED_RESULT[`${CASE_METHOD}Url`] + '&external-transaction-id=' + EXPECTED_ID })
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([METHOD].flatMap(CASE_METHOD => INVALID_EXTERNAL_IDS.map(ID => [CASE_METHOD, ID])))('%s rejects invalid external ID before HTTP %#', async (CASE_METHOD, ID) => {
      const { protocol } = setup({ network: 'ethereum' })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, config: { externalTransactionId: ID } }), ValueError, EXTERNAL_ID_MESSAGE)
      expectInteractions([])
    })

    test.each([METHOD])('%s omits the optional external ID', async CASE_METHOD => {
      const { protocol } = setup({ network: 'ethereum' })
      const result = await protocol[CASE_METHOD]({ ...OPTIONS, config: {} })
      expect(result).toEqual(widget(CASE_METHOD))
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })
  }

  function quoteCases (METHOD) {
    test.each([METHOD].flatMap(CASE_METHOD => [
      ['Eth', ['ETH', 'eth'], ['Ethereum', 'Ethereum'], 'Ambiguous asset spelling Eth on network ethereum'],
      ['ETH', ['ETH', 'eth'], ['Ethereum', 'Tron'], 'Ambiguous asset ETH; configure network: ethereum, tron'],
      ['ETH', ['ETH', 'eth', 'ETH'], ['Ethereum', 'ETHEREUM', 'Tron'], 'Ambiguous asset ETH; configure network: ethereum, tron']
    ].map(values => [CASE_METHOD, ...values])))('%s rejects unresolved asset collisions without a network %#', async (CASE_METHOD, CRYPTO_ASSET, DUMMY_NAMES, DUMMY_CHAINS, EXPECTED_MESSAGE) => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response(DUMMY_NAMES.map((DUMMY_NAME, index) => ({ ...DUMMY_ASSETS[0], id: index + 1, name: DUMMY_NAME, blockchain: DUMMY_CHAINS[index] })))
      })
      await failure(protocol[CASE_METHOD]({ ...OPTIONS, cryptoAsset: CRYPTO_ASSET }), ValueError, EXPECTED_MESSAGE)
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([METHOD === 'quoteBuy' ? 'buy' : 'sell'])('%s quote computes the effective CHF/USDT rate from amounts', async DIRECTION => {
      const DUMMY_BODY = DIRECTION === 'buy'
        ? '{"isValid":true,"amount":100,"estimatedAmount":114.32,"rate":0.87,"fees":{"total":1}}'
        : '{"isValid":true,"amount":3,"estimatedAmount":7,"rate":0.42857,"feesTarget":{"total":1}}'
      const { protocol } = setup({ network: 'ETHEREUM' }, { [`PUT /v1/${DIRECTION}/quote`]: response(DUMMY_BODY) })
      const CASE_METHOD = DIRECTION === 'buy' ? 'quoteBuy' : 'quoteSell'
      const EXPECTED_RESULT = DIRECTION === 'buy'
        ? { cryptoAmount: 114320000n, fiatAmount: 10000n, fee: 100n, rate: '0.874737578726382085' }
        : { cryptoAmount: 3000000n, fiatAmount: 700n, fee: 100n, rate: '2.33333333333333333' }
      const PAYMENT_FIELD = DIRECTION === 'buy' ? ',"paymentMethod":"Bank"' : ''
      const FIELD = DIRECTION === 'buy' ? 'amount' : 'targetAmount'
      const result = await protocol[CASE_METHOD]({ cryptoAsset: 'USDt', fiatCurrency: 'chf', fiatAmount: 10000n, config: { network: 'TrOn' } })

      expect(result).toEqual(EXPECTED_RESULT)
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest(`/v1/${DIRECTION}/quote`, 'PUT', `{"currency":{"name":"CHF"},"asset":{"id":3},"specialCode":""${PAYMENT_FIELD},"${FIELD}":100}`)])
    })

    test.each([
      ['quoteBuy', 'buy', { fiatAmount: 10000n }, 'amount', '100', { cryptoAmount: 123456789012345678n, fiatAmount: 10000n, fee: 123n, rate: '810.000007290000072' }],
      ['quoteBuy', 'buy', { cryptoAmount: 50000000000000000n }, 'targetAmount', '0.05', { cryptoAmount: 123456789012345678n, fiatAmount: 10000n, fee: 123n, rate: '810.000007290000072' }],
      ['quoteSell', 'sell', { cryptoAmount: 50000000000000000n }, 'amount', '0.05', { cryptoAmount: 123456789012345678n, fiatAmount: 10000n, fee: 123n, rate: '810.000007290000072' }],
      ['quoteSell', 'sell', { fiatAmount: 10000 }, 'targetAmount', '100', { cryptoAmount: 123456789012345678n, fiatAmount: 10000n, fee: 123n, rate: '810.000007290000072' }]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s maps amount case %# with exact request and response units', async (CASE_METHOD, DIRECTION, AMOUNT, FIELD, AMOUNT_LITERAL, EXPECTED_RESULT) => {
      const { protocol } = setup({ wallet: 'dummy-partner' })
      const PAYMENT_FIELD = DIRECTION === 'buy' ? ',"paymentMethod":"Bank"' : ''
      const result = await protocol[CASE_METHOD]({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', ...AMOUNT })

      expect(result).toEqual(EXPECTED_RESULT)
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest(`/v1/${DIRECTION}/quote`, 'PUT', `{"currency":{"name":"EUR"},"asset":{"id":1},"wallet":"dummy-partner","specialCode":""${PAYMENT_FIELD},"${FIELD}":${AMOUNT_LITERAL}}`)])
    })

    test.each([
      ['quoteBuy', 'buy', { fiatAmount: 1 }, 'limit', '10'],
      ['quoteBuy', 'buy', { cryptoAmount: 1n }, 'limitTarget', '0.01'],
      ['quoteSell', 'sell', { cryptoAmount: 1n }, 'limit', '0.01'],
      ['quoteSell', 'sell', { fiatAmount: 1 }, 'limitTarget', '10']
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s rejects an invalid quote before reading its sentinel rate', async (CASE_METHOD, DIRECTION, AMOUNT, LIMIT_FIELD, DUMMY_LIMIT) => {
      const DUMMY_BODY = `{"isValid":false,"rate":1.7976931348623157e+308,"errors":[{"error":"AmountTooLow","limit":${LIMIT_FIELD === 'limit' ? DUMMY_LIMIT : '99'},"limitTarget":${LIMIT_FIELD === 'limitTarget' ? DUMMY_LIMIT : '99'}}]}`
      const { protocol } = setup({}, { [`PUT /v1/${DIRECTION}/quote`]: response(DUMMY_BODY) })
      const PAYMENT_FIELD = DIRECTION === 'buy' ? ',"paymentMethod":"Bank"' : ''
      const FIELD = LIMIT_FIELD === 'limit' ? 'amount' : 'targetAmount'
      const AMOUNT_LITERAL = AMOUNT.fiatAmount === undefined ? '0.000000000000000001' : '0.01'
      await failure(protocol[CASE_METHOD]({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', ...AMOUNT }), ValueError, `DFX quote rejected: AmountTooLow (limit: ${DUMMY_LIMIT})`)
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest(`/v1/${DIRECTION}/quote`, 'PUT', `{"currency":{"name":"EUR"},"asset":{"id":1},"specialCode":""${PAYMENT_FIELD},"${FIELD}":${AMOUNT_LITERAL}}`)])
    })

    test.each([METHOD === 'quoteBuy' ? 'buy' : 'sell'].flatMap(DIRECTION => ['amount', 'estimatedAmount'].flatMap(FIELD =>
      [0, -1].map(DUMMY_VALUE => [DIRECTION, FIELD, DUMMY_VALUE])
    )))('rejects nonpositive %s response %s = %s', async (DIRECTION, FIELD, DUMMY_VALUE) => {
      const { protocol } = setup({}, { [`PUT /v1/${DIRECTION}/quote`]: response({ isValid: true, amount: 1, estimatedAmount: 100, [FIELD]: DUMMY_VALUE }) })
      await failure(protocol[DIRECTION === 'buy' ? 'quoteBuy' : 'quoteSell'](OPTIONS), ProviderError, 'DFX quote amounts must be positive', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, DIRECTION === 'buy' ? BUY_QUOTE_REQUEST : SELL_QUOTE_REQUEST])
    })

    test.each([METHOD])('%s rejects absent fee totals', async CASE_METHOD => {
      const DIRECTION = CASE_METHOD === 'quoteBuy' ? 'buy' : 'sell'
      const { protocol } = setup({}, { [`PUT /v1/${DIRECTION}/quote`]: response({ isValid: true, amount: 1, estimatedAmount: 1, rate: 1 }) })
      await failure(protocol[CASE_METHOD](OPTIONS), ProviderError, 'Invalid decimal in DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, CASE_METHOD === 'quoteBuy' ? BUY_QUOTE_REQUEST : SELL_QUOTE_REQUEST])
    })

    test.each([METHOD].flatMap(CASE_METHOD => [400, 422].map(DUMMY_STATUS => [CASE_METHOD, DUMMY_STATUS])))('%s maps HTTP %s to invalid input', async (CASE_METHOD, DUMMY_STATUS) => {
      const ROUTE = CASE_METHOD === 'quoteBuy' ? 'PUT /v1/buy/quote' : 'PUT /v1/sell/quote'
      const { protocol } = setup({}, { [ROUTE]: response({ message: 'Invalid amount' }, DUMMY_STATUS) })
      await failure(protocol[CASE_METHOD](OPTIONS), ValueError, 'Invalid amount')
      expectInteractions([...CATALOG_REQUESTS, CASE_METHOD === 'quoteBuy' ? BUY_QUOTE_REQUEST : SELL_QUOTE_REQUEST])
    })
  }

  function accountCases (METHOD) {
    test.each([
      ['buy', { ...OPTIONS, recipient: DUMMY_ADDRESS }, widget('buy'), [...CATALOG_REQUESTS], []],
      ['sell', { ...OPTIONS, refundAddress: DUMMY_ADDRESS }, widget('sell'), [...CATALOG_REQUESTS], []],
      ['getTransactionDetail', '123', { cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' }, [], [DETAIL_REQUEST, ...CATALOG_REQUESTS]]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD).flatMap(values =>
      ['0xsig', 'not-a-signature', '0x' + '00'.repeat(65), '0x' + '11'.repeat(64) + '02'].map(DUMMY_SIGNATURE => [...values, DUMMY_SIGNATURE])
    ))(
      '%s forwards unrecoverable EVM signature %# with the account address and one challenge', async (CASE_METHOD, INPUT, EXPECTED_RESULT, BEFORE_AUTH, AFTER_AUTH, DUMMY_SIGNATURE) => {
        const { protocol } = ownerSetup()
        signMock.mockResolvedValue(DUMMY_SIGNATURE)
        const AUTH_REQUESTS = [CHALLENGE_REQUEST,
          httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: DUMMY_SIGNATURE, blockchain: 'Ethereum' }))]
        const result = await protocol[CASE_METHOD](INPUT)

        expect(result).toEqual(EXPECTED_RESULT)
        expectInteractions([...BEFORE_AUTH, ...AUTH_REQUESTS, ...AFTER_AUTH], [[DUMMY_ACCOUNT_MESSAGE]], [[]])
      }
    )

    test.each([METHOD].flatMap(CASE_METHOD => ['sign', 'getAddress'].map(ACCOUNT_OPERATION => [CASE_METHOD, ACCOUNT_OPERATION])))('%s wraps non-allowlisted errors from %s with their cause', async (CASE_METHOD, ACCOUNT_OPERATION) => {
      const DUMMY_CAUSE = new NotImplementedError('dummy-operation')
      const { protocol } = setup({ network: 'ethereum' })
      const accountMock = ACCOUNT_OPERATION === 'sign' ? signMock : getAddressMock
      accountMock.mockRejectedValue(DUMMY_CAUSE)
      const error = await failure(protocol[CASE_METHOD](CASE_METHOD === 'getTransactionDetail' ? '123' : OPTIONS), ProviderError, 'DFX account authentication failed', 'UNAUTHORIZED')
      expect(error.cause).toBe(DUMMY_CAUSE)
      expectInteractions([
        ...(CASE_METHOD === 'getTransactionDetail' ? [] : CATALOG_REQUESTS),
        ...(ACCOUNT_OPERATION === 'sign' ? [CHALLENGE_REQUEST] : [])
      ], ACCOUNT_OPERATION === 'sign' ? [[challengeMessage(DUMMY_ADDRESS)]] : [], [[]])
    })

    test.each([
      ['buy', new AccountRequiredError('dummy-allowed')],
      ['buy', new ValueError('dummy-allowed')],
      ['buy', new ProviderRequiredError('dummy-allowed')],
      ['buy', new ProviderError('dummy-allowed', { reason: 'NETWORK_ERROR' })],
      ['buy', new BuyError('dummy-allowed', { reason: 'INSUFFICIENT_FUNDS' })],
      ['buy', new MaximumFeeExceededError('dummy-allowed')],
      ['sell', new SellError('dummy-allowed', { reason: 'INSUFFICIENT_FUNDS' })],
      ['sell', new AccountRequiredError('dummy-allowed')],
      ['sell', new MaximumFeeExceededError('dummy-allowed')],
      ['sell', new ProviderRequiredError('dummy-allowed')],
      ['sell', new ProviderError('dummy-allowed', { reason: 'NETWORK_ERROR' })],
      ['sell', new ValueError('dummy-allowed')],
      ['getTransactionDetail', new ProviderRequiredError('dummy-allowed')],
      ['getTransactionDetail', new ProviderError('dummy-allowed', { reason: 'NETWORK_ERROR' })]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD).flatMap(([CASE_METHOD, DUMMY_CAUSE]) => ['getAddress', 'sign'].map(ACCOUNT_OPERATION => [CASE_METHOD, DUMMY_CAUSE, ACCOUNT_OPERATION])))('%s preserves exact allowlisted error case %#', async (CASE_METHOD, DUMMY_CAUSE, ACCOUNT_OPERATION) => {
      const { protocol } = setup({ network: 'ethereum' })
      const accountMock = ACCOUNT_OPERATION === 'sign' ? signMock : getAddressMock
      accountMock.mockRejectedValue(DUMMY_CAUSE)
      const error = await protocol[CASE_METHOD](CASE_METHOD === 'getTransactionDetail' ? '123' : OPTIONS).catch(error => error)
      expect(error).toBe(DUMMY_CAUSE)
      expectInteractions([
        ...(CASE_METHOD === 'getTransactionDetail' ? [] : CATALOG_REQUESTS),
        ...(ACCOUNT_OPERATION === 'sign' ? [CHALLENGE_REQUEST] : [])
      ], ACCOUNT_OPERATION === 'sign' ? [[challengeMessage(DUMMY_ADDRESS)]] : [], [[]])
    })

    test.each([
      ['buy', new SellError('dummy-disallowed', { reason: 'INSUFFICIENT_FUNDS' })],
      ['sell', new BuyError('dummy-disallowed', { reason: 'INSUFFICIENT_FUNDS' })],
      ['buy', new ReadOnlyAccountRequiredError('dummy-disallowed')],
      ['sell', new ReadOnlyAccountRequiredError('dummy-disallowed')],
      ['getTransactionDetail', new ReadOnlyAccountRequiredError('dummy-disallowed')],
      ['getTransactionDetail', new ValueError('dummy-disallowed')],
      ['getTransactionDetail', new NoSuchElementError('dummy-disallowed')],
      ['getTransactionDetail', null]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s wraps WDK errors absent from its contract', async (CASE_METHOD, DUMMY_CAUSE) => {
      const { protocol } = setup({ network: 'ethereum' })
      signMock.mockRejectedValue(DUMMY_CAUSE)
      const error = await failure(protocol[CASE_METHOD](CASE_METHOD === 'getTransactionDetail' ? '123' : OPTIONS), ProviderError, 'DFX account authentication failed', 'UNAUTHORIZED')
      expect(error.cause).toBe(DUMMY_CAUSE)
      expectInteractions([...(CASE_METHOD === 'getTransactionDetail' ? [] : CATALOG_REQUESTS), CHALLENGE_REQUEST],
        [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })
  }

  function catalogCases (METHOD) {
    test.each([
      ['getSupportedCryptoAssets', 'GET /v1/asset'],
      ['getSupportedFiatCurrencies', 'GET /v1/fiat'],
      ['getSupportedCountries', 'GET /v1/country']
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD).flatMap(([CASE_METHOD, ROUTE]) => [400, 422].map(DUMMY_STATUS => [CASE_METHOD, ROUTE, DUMMY_STATUS])))('%s treats list validation response %# as a provider failure', async (CASE_METHOD, ROUTE, DUMMY_STATUS) => {
      const { protocol } = setup({}, { [ROUTE]: response({ message: 'dummy-validation-error' }, DUMMY_STATUS) })
      await failure(protocol[CASE_METHOD](), ProviderError, 'dummy-validation-error', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest(ROUTE.slice(4))])
    })

    test.each([
      ['getSupportedCryptoAssets', 'GET /v1/asset', {}],
      ['getSupportedFiatCurrencies', 'GET /v1/fiat', null],
      ['getSupportedCryptoAssets', 'GET /v1/asset', [{ ...DUMMY_ASSETS[0], name: '' }]],
      ['getSupportedCryptoAssets', 'GET /v1/asset', [{ ...DUMMY_ASSETS[0], buyable: undefined }]],
      ['getSupportedCryptoAssets', 'GET /v1/asset', [{ ...DUMMY_ASSETS[0], sellable: undefined }]],
      ['getSupportedCryptoAssets', 'GET /v1/asset', [{ ...DUMMY_ASSETS[0], blockchain: null }]],
      ['getSupportedCountries', 'GET /v1/country', {}],
      ['getSupportedCountries', 'GET /v1/country', [{ ...DUMMY_COUNTRIES[0], bankAllowed: 'true' }]],
      ['getSupportedCountries', 'GET /v1/country', [null]],
      ['getSupportedCountries', 'GET /v1/country', [{ ...DUMMY_COUNTRIES[0], symbol: false }]],
      ['getSupportedCountries', 'GET /v1/country', [{ ...DUMMY_COUNTRIES[0], symbol: '' }]]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s rejects malformed metadata case %#', async (CASE_METHOD, ROUTE, DUMMY_BODY) => {
      const { protocol } = setup({}, { [ROUTE]: response(DUMMY_BODY) })
      await failure(protocol[CASE_METHOD](), ProviderError, 'Unexpected DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest(ROUTE.slice(4))])
    })
  }

  function tradableCatalogCases (METHOD) {
    test.each([METHOD === 'getSupportedCryptoAssets' ? 'asset' : 'fiat'].flatMap(CATALOG => [null, true, [], {}, { buyable: false, sellable: false, id: -1 }, { buyable: 'true' }].map(DUMMY_ROW => [CATALOG, DUMMY_ROW])))('ignores non-tradable %s row %# before validation', async (CATALOG, DUMMY_ROW) => {
      const { protocol } = setup({}, { [`GET /v1/${CATALOG}`]: response([DUMMY_ROW]) })
      const result = await protocol[CATALOG === 'asset' ? 'getSupportedCryptoAssets' : 'getSupportedFiatCurrencies']()

      expect(result).toEqual([])
      expectInteractions([httpRequest(`/v1/${CATALOG}`)])
    })
  }

  function arrayMessageCases (METHOD) {
    test.each([
      ['buy', 'POST /v1/auth', 400, ['address must be a string', 'signature must be a string'], 'address must be a string; signature must be a string', ProviderError, 'INTERNAL_SERVER_ERROR', [OPTIONS]],
      ['buy', 'POST /v1/auth', 400, ['Invalid signature'], 'Invalid signature', ProviderError, 'INTERNAL_SERVER_ERROR', [OPTIONS]],
      ['buy', 'POST /v1/auth', 401, ['Unauthorized', 'Session expired'], 'Unauthorized; Session expired', ProviderError, 'UNAUTHORIZED', [OPTIONS]],
      ['getSupportedCountries', 'GET /v1/country', 503, ['Unavailable', 'Try later'], 'Unavailable; Try later', ProviderError, 'INTERNAL_SERVER_ERROR', []],
      ['getSupportedCryptoAssets', 'GET /v1/asset', 400, ['Invalid filter', 'Try later'], 'Invalid filter; Try later', ProviderError, 'INTERNAL_SERVER_ERROR', []],
      ['getSupportedFiatCurrencies', 'GET /v1/fiat', 422, ['Invalid filter', 'Try later'], 'Invalid filter; Try later', ProviderError, 'INTERNAL_SERVER_ERROR', []],
      ['quoteBuy', 'PUT /v1/buy/quote', 400, ['amount must be positive', 'asset must be valid'], 'amount must be positive; asset must be valid', ValueError, undefined, [OPTIONS]],
      ['quoteSell', 'PUT /v1/sell/quote', 422, ['amount must be positive', 'asset must be valid'], 'amount must be positive; asset must be valid', ValueError, undefined, [OPTIONS]],
      ['getTransactionDetail', 'GET /v1/transaction/detail/single?uid=123', 404, ['Transaction not found', 'Try later'], 'Transaction not found; Try later', NoSuchElementError, undefined, ['123']],
      ['getTransactionDetail', `GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`, 400, ['Invalid signature', 'Challenge unavailable'], 'Invalid signature; Challenge unavailable', ProviderError, 'INTERNAL_SERVER_ERROR', ['123']]
    ].filter(([CASE_METHOD]) => CASE_METHOD === METHOD))('%s preserves string-array errors from %s (%s)', async (CASE_METHOD, ROUTE, DUMMY_STATUS, DUMMY_MESSAGES, EXPECTED_MESSAGE, ErrorClass, EXPECTED_REASON, ARGS) => {
      const { protocol } = setup({ network: 'ethereum' }, { [ROUTE]: response({ message: DUMMY_MESSAGES }, DUMMY_STATUS) })
      const EXPECTED_REQUESTS = {
        buy: ETH_WIDGET_REQUESTS,
        quoteBuy: [...CATALOG_REQUESTS, BUY_QUOTE_REQUEST],
        quoteSell: [...CATALOG_REQUESTS, SELL_QUOTE_REQUEST],
        getSupportedCountries: [httpRequest('/v1/country')],
        getSupportedCryptoAssets: [httpRequest('/v1/asset')],
        getSupportedFiatCurrencies: [httpRequest('/v1/fiat')],
        getTransactionDetail: ROUTE === 'GET /v1/transaction/detail/single?uid=123'
          ? [CHALLENGE_REQUEST, ETH_AUTH_REQUEST, DETAIL_REQUEST]
          : [CHALLENGE_REQUEST]
      }
      await failure(protocol[CASE_METHOD](...ARGS), ErrorClass, EXPECTED_MESSAGE, EXPECTED_REASON)
      expectInteractions(EXPECTED_REQUESTS[CASE_METHOD],
        CASE_METHOD === 'buy' || ROUTE === 'GET /v1/transaction/detail/single?uid=123' ? [[challengeMessage(DUMMY_ADDRESS)]] : [],
        CASE_METHOD === 'buy' || CASE_METHOD === 'getTransactionDetail' ? [[]] : [])
    })
  }

  describe('exports', () => {
    test('exports the class by name and default and the WDK interface', () => {
      expect(NamedDfxProtocol).toBe(DfxProtocol)
      expect(IFiatProtocol).toBe(WalletFiatProtocol)
      for (const [EXPORT_NAME, EXPECTED_VALUE] of Object.entries({ FiatProtocol, BuyErrorReason, SellErrorReason, AccountRequiredError, ValueError, ProviderError, ProviderRequiredError, BuyError, SellError, MaximumFeeExceededError, NoSuchElementError, ProviderErrorReason })) {
        expect(publicApi[EXPORT_NAME]).toBe(EXPECTED_VALUE)
      }
    })
  })

  describe('constructor', () => {
    test.each([0, 0n, -1, -1n, NaN, Infinity, -Infinity])('rejects invalid timeout %#', TIMEOUT => {
      failureSync(() => new DfxProtocol(undefined, { timeout: TIMEOUT }), ValueError, 'timeout must be a finite number greater than zero')
      expectInteractions([])
    })

    test.each([2147483648, 2147483648n, 2n ** 64n, Number.MAX_VALUE])('rejects timer overflow %s', TIMEOUT => {
      failureSync(() => new DfxProtocol(undefined, { timeout: TIMEOUT }), ValueError, 'timeout must not exceed 2147483647 milliseconds')
      expectInteractions([])
    })

    test.each(['network', 'wallet', 'publicKey', 'language'].flatMap(FIELD =>
      ['', '  '].map(VALUE => [FIELD, VALUE])
    ))('rejects invalid constructor string %s case %#', (FIELD, VALUE) => {
      failureSync(() => new DfxProtocol(undefined, { [FIELD]: VALUE }), ValueError, `${FIELD} must be a non-empty string`)
      expectInteractions([])
    })
  })

  describe('buy', () => {
    tradeCases('buy')
    widgetCases('buy')
    accountCases('buy')
    arrayMessageCases('buy')

    test('posts an independent ethers signature unchanged when the account cannot sign typed data', async () => {
      const wallet = new Wallet('0x' + '00'.repeat(31) + '02')
      const signature = await wallet.signMessage(DUMMY_ACCOUNT_MESSAGE)
      const { protocol } = setup({ network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      })
      signMock.mockResolvedValue(signature)

      const result = await protocol.buy(OPTIONS)

      expect(verifyMessage(DUMMY_ACCOUNT_MESSAGE, signature)).toBe(wallet.address)
      expect(result).toEqual(widget('buy'))
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature, blockchain: 'Ethereum' }))],
      [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    test('keeps a signature over a foreign digest on the account address', async () => {
      // ECDSA fixture: nonce k=1 gives r=G.x and recovery bit 0. For key d=2,
      // signing z'=z-r gives s=z'+2r=z+r. Recovery against challenge digest z
      // therefore yields key 1, although the signature was made for another
      // digest with key 2. Both keys are public test scalars.
      const PAYLOAD = Buffer.from(DUMMY_ACCOUNT_MESSAGE, 'utf8')
      const DIGEST = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${PAYLOAD.length}`), PAYLOAD]))
      const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
      const R = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
      const FOREIGN_DIGEST = (BigInt('0x' + Buffer.from(DIGEST).toString('hex')) - R + ORDER) % ORDER
      const S = (FOREIGN_DIGEST + 2n * R) % ORDER
      const DUMMY_SIGNATURE = '0x' + R.toString(16).padStart(64, '0') + S.toString(16).padStart(64, '0') + '1b'
      const { protocol } = setup({ network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      })
      signMock.mockResolvedValue(DUMMY_SIGNATURE)

      const result = await protocol.buy(OPTIONS)

      expect(result).toEqual(widget('buy'))
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: DUMMY_SIGNATURE, blockchain: 'Ethereum' }))],
      [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    function word (value) {
      return Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex')
    }

    function safeDigest (chainId, verifyingContract, message) {
      const payload = Buffer.from(message, 'utf8')
      const personal = keccak256(Buffer.concat([
        Buffer.from(`\x19Ethereum Signed Message:\n${payload.length}`, 'utf8'), payload
      ]))
      const structHash = keccak256(Buffer.concat([
        keccak256(Buffer.from('SafeMessage(bytes message)')),
        keccak256(personal)
      ]))
      const domain = keccak256(Buffer.concat([
        keccak256(Buffer.from('EIP712Domain(uint256 chainId,address verifyingContract)')),
        word(chainId),
        word(BigInt(verifyingContract))
      ]))
      return '0x' + Buffer.from(keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, structHash]))).toString('hex')
    }

    test.each([
      ['Ethereum', 1],
      ['Polygon', 137],
      ['Citrea', 4114],
      ['CitreaTestnet', 5115]
    ])('%s posts a Safe signature for chain %s as the account address', async (NETWORK, CHAIN_ID) => {
      const wallet = new Wallet('0x' + '00'.repeat(31) + '01')
      signTypedDataMock.mockImplementation(async typed => wallet.signTypedData(typed.domain, typed.types, typed.message))
      const { protocol } = setup({ network: NETWORK }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: NETWORK }]),
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      }, new DummyTypedAccount())
      signMock.mockImplementation(async message => ownerSignature(message))

      const result = await protocol.buy(OPTIONS)

      const typed = signTypedDataMock.mock.calls[0][0]
      const auth = fetchMock.mock.calls.find(call => call[1]?.method === 'POST' && String(call[0]).endsWith('/v1/auth'))
      const body = JSON.parse(auth[1].body)
      expect(result).toEqual(widget('buy', { blockchain: NETWORK }))
      expect(body.address).toBe(DUMMY_ADDRESS)
      expect(body.blockchain).toBe(NETWORK)
      expect(body.signature).not.toBe(ownerSignature(DUMMY_ACCOUNT_MESSAGE))
      expect(typed).toEqual({
        domain: { chainId: CHAIN_ID, verifyingContract: DUMMY_ADDRESS },
        types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
        message: { message: hashMessage(DUMMY_ACCOUNT_MESSAGE) }
      })
      expect(verifyTypedData(typed.domain, typed.types, typed.message, body.signature).toLowerCase()).toBe(OWNER_ADDRESS)
      expect(body.signature.endsWith(ERC_6492_MAGIC)).toBe(false)
      expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.message)).toBe(safeDigest(CHAIN_ID, DUMMY_ADDRESS, DUMMY_ACCOUNT_MESSAGE))
      expect(Buffer.from(keccak256(Buffer.from('SafeMessage(bytes message)'))).toString('hex')).toBe('60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca')
      expect(signMock.mock.calls).toEqual([[DUMMY_ACCOUNT_MESSAGE]])
      expect(signTypedDataMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls.filter(call => String(call[0]).includes('signMessage')).map(call => String(call[0]))).toEqual([
        `https://api.dfx.swiss/v1/auth/signMessage?address=${DUMMY_ADDRESS}`
      ])
    })

    test.each([
      ['Ethereum', 1],
      ['Sepolia', 11155111],
      ['BinanceSmartChain', 56],
      ['Optimism', 10],
      ['Arbitrum', 42161],
      ['Polygon', 137],
      ['Base', 8453],
      ['Gnosis', 100],
      ['Plasma', 9745]
    ])('wraps a matching WDK Safe prediction as ERC-6492 on %s', async (NETWORK, CHAIN_ID) => {
      const { predicted, account, message, safeSignature, result, typed, body } = await buyMatchingSafe(NETWORK)
      const [factoryAddress, factoryData] = SafeAccount030.createFactoryAddressAndData([OWNER_ADDRESS], WDK_SAFE_OVERRIDES)
      const encoded = '0x' + body.signature.slice(2, -ERC_6492_MAGIC.length)
      const [decodedFactory, decodedData, inner] = AbiCoder.defaultAbiCoder().decode(['address', 'bytes', 'bytes'], encoded)
      const hex = value => value.toLowerCase().replace(/^0x/, '')
      expect(account).not.toBe(predicted)
      expect(result).toEqual(widget('buy', { blockchain: NETWORK }))
      expect(body.address).toBe(account)
      expect(body.blockchain).toBe(NETWORK)
      expect(body.signature.endsWith(ERC_6492_MAGIC)).toBe(true)
      expect(typed.domain.chainId).toBe(CHAIN_ID)
      expect(typed.domain.verifyingContract).toBe(account)
      expect(hex(decodedFactory)).toBe(hex(factoryAddress))
      expect(hex(decodedData)).toBe(hex(factoryData))
      expect(hex(inner)).toBe(hex(safeSignature))
      expect(verifyTypedData(typed.domain, typed.types, typed.message, inner).toLowerCase()).toBe(OWNER_ADDRESS)
      expect(signMock.mock.calls).toEqual([[message]])
      expect(getAddressMock.mock.calls).toEqual([[]])
    })

    test.each([
      ['Citrea', 4114],
      ['CitreaTestnet', 5115]
    ])('sends the unwrapped Safe signature on %s when the prediction matches', async (NETWORK, CHAIN_ID) => {
      const { predicted, account, message, safeSignature, result, typed, body } = await buyMatchingSafe(NETWORK)
      expect(account).not.toBe(predicted)
      expect(account.toLowerCase()).toBe(predicted.toLowerCase())
      expect(result).toEqual(widget('buy', { blockchain: NETWORK }))
      expect(body.address).toBe(account)
      expect(body.blockchain).toBe(NETWORK)
      expect(body.signature).toBe(safeSignature)
      expect(body.signature.endsWith(ERC_6492_MAGIC)).toBe(false)
      expect(typed.domain.chainId).toBe(CHAIN_ID)
      expect(typed.domain.verifyingContract).toBe(account)
      expect(verifyTypedData(typed.domain, typed.types, typed.message, body.signature).toLowerCase()).toBe(OWNER_ADDRESS)
      expect(signMock.mock.calls).toEqual([[message]])
      expect(getAddressMock.mock.calls).toEqual([[]])
    })

    test('keeps the Safe signature when Safe prediction throws', async () => {
      const spy = jest.spyOn(SafeAccount030, 'createAccountAddress').mockImplementation(() => {
        throw new Error('invalid owner')
      })
      const SAFE_SIGNATURE = '0x' + 'ab'.repeat(65)
      signTypedDataMock.mockResolvedValue(SAFE_SIGNATURE)
      const { protocol } = setup({ network: 'Ethereum' }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: 'Ethereum' }]),
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      }, new DummyTypedAccount())
      signMock.mockImplementation(async signed => ownerSignature(signed))

      const result = await protocol.buy(OPTIONS)

      const auth = fetchMock.mock.calls.find(call => call[1]?.method === 'POST' && String(call[0]).endsWith('/v1/auth'))
      const body = JSON.parse(auth[1].body)
      expect(result).toEqual(widget('buy', { blockchain: 'Ethereum' }))
      expect(body.address).toBe(DUMMY_ADDRESS)
      expect(body.signature).toBe(SAFE_SIGNATURE)
      expect(spy).toHaveBeenCalled()
      expect(signMock.mock.calls).toEqual([[DUMMY_ACCOUNT_MESSAGE]])
    })

    test.each(['Haqq'])('%s keeps the wallet signature when DFX publishes no chain id', async NETWORK => {
      signTypedDataMock.mockResolvedValue('0x' + 'ab'.repeat(65))
      const { protocol } = setup({ network: NETWORK }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: NETWORK }]),
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      }, new DummyTypedAccount())
      signMock.mockImplementation(async message => ownerSignature(message))

      const result = await protocol.buy(OPTIONS)

      expect(result).toEqual(widget('buy', { blockchain: NETWORK }))
      expect(signTypedDataMock).not.toHaveBeenCalled()
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: ownerSignature(DUMMY_ACCOUNT_MESSAGE), blockchain: NETWORK }))],
      [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    test('does not submit the owner signature when Safe signing fails', async () => {
      const CAUSE = new Error('typed data refused')
      signTypedDataMock.mockRejectedValue(CAUSE)
      const { protocol } = setup({ network: 'polygon' }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: 'Polygon' }]),
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: DUMMY_ACCOUNT_MESSAGE })
      }, new DummyTypedAccount())
      signMock.mockImplementation(async message => ownerSignature(message))

      const error = await failure(protocol.buy(OPTIONS), ProviderError, 'DFX account authentication failed', 'UNAUTHORIZED')

      expect(error.cause).toBe(CAUSE)
      expect(signTypedDataMock).toHaveBeenCalledTimes(1)
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST], [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    test.each([OWNER_ADDRESS, '0x' + OWNER_ADDRESS.slice(2).toUpperCase()])('EOA %s needs one challenge and one signature', async DUMMY_ACCOUNT_ADDRESS => {
      const { protocol } = ownerSetup('Ethereum', DUMMY_ACCOUNT_ADDRESS)
      const message = challengeMessage(DUMMY_ACCOUNT_ADDRESS)

      const EXPECTED_REQUESTS = [...CATALOG_REQUESTS,
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ACCOUNT_ADDRESS}`),
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ACCOUNT_ADDRESS, signature: ownerSignature(message), blockchain: 'Ethereum' }))
      ]
      const result = await protocol.buy({ ...OPTIONS, recipient: OWNER_ADDRESS })

      expect(result).toEqual(widget('buy'))
      expectInteractions(EXPECTED_REQUESTS, [[message]], [[]])
    })

    test.each(['Tron', 'Bitcoin', 'Solana', 'FutureEvm'])('%s leaves a recoverable EVM signature on the account address', async NETWORK => {
      const { protocol } = ownerSetup(NETWORK)
      const result = await protocol.buy({ ...OPTIONS, recipient: DUMMY_ADDRESS })

      expect(result).toEqual(widget('buy', { blockchain: NETWORK }))
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: ownerSignature(DUMMY_ACCOUNT_MESSAGE), blockchain: NETWORK === 'FutureEvm' ? undefined : NETWORK }))],
      [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    test('encodes a future blockchain value in widget URLs', async () => {
      const { protocol } = setup({ network: 'new-chain2/?&' }, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: 'New-Chain2/?&' }])
      })
      const result = await protocol.buy(OPTIONS)

      expect(result).toEqual({
        buyUrl: 'https://app.dfx.swiss/buy?session=dummy-session&lang=en&asset-in=EUR&asset-out=ETH&blockchain=New-Chain2%2F%3F%26&amount-in=100'
      })
      expectInteractions([...CATALOG_REQUESTS, CHALLENGE_REQUEST, AUTH_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('rejects a resolved asset outside the bound account network', async () => {
      const { protocol } = setup({ network: 'tron' })
      await failure(protocol.buy(OPTIONS), ValueError, 'Unsupported buy asset or network: ETH')
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each([
      [400, 'Invalid signature', 'UNAUTHORIZED'],
      [401, 'Invalid signature format', 'UNAUTHORIZED'],
      [400, 'Invalid signature format', 'INTERNAL_SERVER_ERROR'],
      [400, 'Invalid signature ', 'INTERNAL_SERVER_ERROR'],
      [400, 'invalid signature', 'INTERNAL_SERVER_ERROR'],
      [400, 'Public key is required', 'INTERNAL_SERVER_ERROR'],
      [422, 'Invalid signature', 'INTERNAL_SERVER_ERROR']
    ])('auth HTTP %s preserves rejection %s with reason %s', async (DUMMY_STATUS, EXPECTED_MESSAGE, EXPECTED_REASON) => {
      const { protocol } = setup({ network: 'ethereum' }, { 'POST /v1/auth': response({ message: EXPECTED_MESSAGE }, DUMMY_STATUS) })
      await failure(protocol.buy(OPTIONS), ProviderError, EXPECTED_MESSAGE, EXPECTED_REASON)
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('preserves the geo-filter message from authentication', async () => {
      const { protocol } = setup({ network: 'ethereum' }, { 'POST /v1/auth': response({ message: 'The country of IP address is not allowed' }, 403) })
      await failure(protocol.buy(OPTIONS), ProviderError, 'The country of IP address is not allowed', 'FORBIDDEN')
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('encodes widget session and language values without adding query parameters', async () => {
      const { protocol } = setup({ network: 'ethereum', language: 'de&extra=1' }, {
        'POST /v1/auth': response({ accessToken: 'dummy+/=&token' })
      })
      const result = await protocol.buy(OPTIONS)

      expect(result).toEqual({
        buyUrl: 'https://app.dfx.swiss/buy?session=dummy%2B%2F%3D%26token&lang=de%26extra%3D1&asset-in=EUR&asset-out=ETH&blockchain=Ethereum&amount-in=100'
      })
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })
  })

  describe('sell', () => {
    tradeCases('sell')
    widgetCases('sell')
    accountCases('sell')

    test('wraps a matching WDK Safe prediction as ERC-6492 on Polygon', async () => {
      const { account, result, typed, body } = await buyMatchingSafe('Polygon', protocol => protocol.sell(OPTIONS))
      const inner = wrappedInner(body.signature)
      expect(result).toEqual(widget('sell', { blockchain: 'Polygon' }))
      expect(body.address).toBe(account)
      expect(body.blockchain).toBe('Polygon')
      expect(body.signature.endsWith(ERC_6492_MAGIC)).toBe(true)
      expect(typed.domain.chainId).toBe(137)
      expect(verifyTypedData(typed.domain, typed.types, typed.message, inner).toLowerCase()).toBe(OWNER_ADDRESS)
    })
  })

  describe('quoteBuy', () => {
    tradeCases('quoteBuy')
    quoteCases('quoteBuy')
    arrayMessageCases('quoteBuy')

    test.each([undefined, 0, -1, 'not-a-rate'])('does not use the provider rate field %#', async DUMMY_RATE => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({ isValid: true, amount: 3, estimatedAmount: 2, rate: DUMMY_RATE, fees: { total: 0 } }) })
      const result = await protocol.quoteBuy(OPTIONS)

      expect(result).toEqual({ cryptoAmount: 2000000000000000000n, fiatAmount: 300n, fee: 0n, rate: '1.5' })
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test('rounds an exact halfway quotient up at the eighteenth significant digit', async () => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response('{"isValid":true,"amount":123456789012345678.50,"estimatedAmount":1,"fees":{"total":0}}') })
      const result = await protocol.quoteBuy(OPTIONS)

      expect(result).toEqual({ cryptoAmount: 1000000000000000000n, fiatAmount: 12345678901234567850n, fee: 0n, rate: '123456789012345679' })
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test('per-quote network overrides the constructor without changing the account binding', async () => {
      const { protocol } = setup({ network: 'ethereum' }, { 'PUT /v1/buy/quote': response({ isValid: true, amount: 100, estimatedAmount: 100, rate: 1, fees: { total: 1 } }) })
      const result = await protocol.quoteBuy({ ...OPTIONS, cryptoAsset: 'USDT', config: { network: 'tron' } })

      expect(result).toEqual({ cryptoAmount: 100000000n, fiatAmount: 10000n, fee: 100n, rate: '1' })
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest('/v1/buy/quote', 'PUT', '{"currency":{"name":"EUR"},"asset":{"id":3},"specialCode":"","paymentMethod":"Bank","amount":100}')])
    })

    test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0n, -1n])('rejects invalid amount %s', async AMOUNT => {
      const { protocol } = setup()
      await failure(protocol.quoteBuy({ ...OPTIONS, fiatAmount: AMOUNT }), ValueError, 'amount must be a positive safe integer or positive bigint')
      expectInteractions([])
    })

    test('rejects an amount exceeding finite API number precision', async () => {
      const { protocol } = setup()
      await failure(protocol.quoteBuy({ ...OPTIONS, fiatAmount: 10n ** 400n }), ValueError, 'amount exceeds the precision the DFX API accepts')
      expectInteractions(CATALOG_REQUESTS)
    })

    test.each(['AmountTooHigh', 'PaymentMethodNotAllowed', 'IbanCurrencyMismatch', 'AssetUnsupported', 'CurrencyUnsupported'])('maps input quote error %s', async DUMMY_CODE => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({ isValid: false, error: DUMMY_CODE }) })
      await failure(protocol.quoteBuy(OPTIONS), ValueError, `DFX quote rejected: ${DUMMY_CODE}`)
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each(['KycRequired', 'BankTransactionMissing', 'PrimaryEmailNotConfirmed', 'LimitExceeded', 'NewAccountState'])('maps account state %s to the provider fallback', async DUMMY_CODE => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({ isValid: false, errors: [{ error: DUMMY_CODE }] }) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, `DFX quote rejected: ${DUMMY_CODE}`, 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([{ isValid: false }, { isValid: false, errors: [] }])('rejects invalid quotes without error codes', async DUMMY_BODY => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response(DUMMY_BODY) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, 'Invalid DFX quote without an error code', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test('rejects a quote without explicit validity', async () => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({}) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, 'Missing quote validity', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([null, [], true].map(DUMMY_BODY => [DUMMY_BODY]))('rejects a non-object quote response %#', async DUMMY_BODY => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response(DUMMY_BODY) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, 'Unexpected DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([
      ['estimatedAmount', '0.0000000000000000001'], ['amount', '1.001'], ['fees', { total: '-1' }]
    ])('rejects fractional or negative smallest units in %s', async (FIELD, DUMMY_VALUE) => {
      const DUMMY_BODY = { isValid: true, amount: '100', estimatedAmount: '0.05', rate: '2000', fees: { total: '1' }, [FIELD]: DUMMY_VALUE }
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response(DUMMY_BODY) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, 'DFX amount is not a non-negative integer in smallest units', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([undefined, 'NaN', '01', true])('rejects malformed quote decimals %s', async DUMMY_AMOUNT => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({ isValid: true, amount: DUMMY_AMOUNT, estimatedAmount: 1 }) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, 'Invalid decimal in DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test('preserves a parsed numeric HTTP 422 message as a provider failure', async () => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response({ message: 1 }, 422) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, '1', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([
      ['JPY', 13, 100n, '100'],
      ['BHD', 14, 1234n, '1.234'],
      ['CLF', 17, 12345n, '1.2345']
    ])('uses ISO minor units for %s in quote requests and responses', async (FIAT_CURRENCY, DUMMY_ID, AMOUNT, AMOUNT_LITERAL) => {
      const { protocol } = setup({}, {
        'GET /v1/fiat': response([{ id: DUMMY_ID, name: FIAT_CURRENCY, buyable: true, sellable: true }]),
        'PUT /v1/buy/quote': response(`{"isValid":true,"amount":${AMOUNT_LITERAL},"estimatedAmount":1,"rate":${AMOUNT_LITERAL},"fees":{"total":0}}`)
      })
      const result = await protocol.quoteBuy({ cryptoAsset: 'ETH', fiatCurrency: FIAT_CURRENCY, fiatAmount: AMOUNT })

      expect(result).toEqual({
        cryptoAmount: 1000000000000000000n, fiatAmount: AMOUNT, fee: 0n, rate: AMOUNT_LITERAL
      })
      expectInteractions([...CATALOG_REQUESTS,
        httpRequest('/v1/buy/quote', 'PUT', `{"currency":{"name":"${FIAT_CURRENCY}"},"asset":{"id":1},"specialCode":"","paymentMethod":"Bank","amount":${AMOUNT_LITERAL}}`)])
    })

    test.each([
      [{ error: 'AmountTooLow', message: 'Quote input rejected' }, 'Quote input rejected'],
      [{ errors: [{ error: 'AmountTooHigh' }], message: 'Quote input rejected' }, 'Quote input rejected'],
      [{ error: 'Bad Request', message: 'amount must be positive' }, 'amount must be positive'],
      [{ error: 'Unprocessable Entity', message: ['targetAmount must be positive'] }, 'targetAmount must be positive']
    ])('attributes HTTP validation failures to input using codes or explicit fields', async (DUMMY_BODY, EXPECTED_MESSAGE) => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response(DUMMY_BODY, 400) })
      await failure(protocol.quoteBuy(OPTIONS), ValueError, EXPECTED_MESSAGE)
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })

    test.each([
      [{ error: 'KycRequired', message: 'KYC must be completed' }, 'KYC must be completed'],
      [{ error: 'BankTransactionMissing', message: 'Bank setup incomplete' }, 'Bank setup incomplete'],
      [{ message: 'Unclassified failure' }, 'Unclassified failure'],
      [{ message: [{ a: 1 }] }, 'DFX HTTP 422'],
      [{}, 'DFX HTTP 422'],
      [null, 'DFX HTTP 422']
    ])('does not attribute an unknown HTTP 422 failure to caller input', async (DUMMY_BODY, EXPECTED_MESSAGE) => {
      const { protocol } = setup({}, { 'PUT /v1/buy/quote': response(DUMMY_BODY, 422) })
      await failure(protocol.quoteBuy(OPTIONS), ProviderError, EXPECTED_MESSAGE, 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, BUY_QUOTE_REQUEST])
    })
  })

  describe('quoteSell', () => {
    tradeCases('quoteSell')
    quoteCases('quoteSell')
    arrayMessageCases('quoteSell')

    test.each([
      ['3', '0.333333333333333333', 3n * 10n ** 40n], ['6', '0.166666666666666667', 6n * 10n ** 40n],
      ['1e-20', '100000000000000000000', 10n ** 20n],
      ['1e20', '0.00000000000000000001', 10n ** 60n], ['1.25e-30', '800000000000000000000000000000', 12500000000n],
      ['0.000000000000000003', '333333333333333333', 3n * 10n ** 22n], ['1', '1', 10n ** 40n], ['0.5', '2', 5n * 10n ** 39n],
      ['0.9999999999999999999', '1', 9999999999999999999n * 10n ** 21n]
    ])('divides response amounts with denominator %s to 18 significant places', async (DUMMY_AMOUNT, EXPECTED_RESULT, EXPECTED_CRYPTO_AMOUNT) => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], decimals: 40 }]),
        'PUT /v1/sell/quote': response(`{"isValid":true,"amount":${DUMMY_AMOUNT},"estimatedAmount":1,"rate":7,"feesTarget":{"total":0}}`)
      })
      const result = await protocol.quoteSell(OPTIONS)

      expect(result).toEqual({ cryptoAmount: EXPECTED_CRYPTO_AMOUNT, fiatAmount: 100n, fee: 0n, rate: EXPECTED_RESULT })
      expectInteractions([...CATALOG_REQUESTS, SELL_QUOTE_REQUEST])
    })
  })

  describe('getSupportedCryptoAssets', () => {
    catalogCases('getSupportedCryptoAssets')
    tradableCatalogCases('getSupportedCryptoAssets')
    arrayMessageCases('getSupportedCryptoAssets')

    test.each(NATIVE_ASSETS.flatMap(([DUMMY_BLOCKCHAIN, DUMMY_NAME, EXPECTED_NETWORK]) => [[0, 0], [6, 6]].map(([DUMMY_DECIMALS, EXPECTED_DECIMALS]) =>
      [DUMMY_BLOCKCHAIN, DUMMY_NAME, DUMMY_DECIMALS, EXPECTED_NETWORK, EXPECTED_DECIMALS]
    )))('lists %s/%s with API decimals %s', async (DUMMY_BLOCKCHAIN, DUMMY_NAME, DUMMY_DECIMALS, EXPECTED_NETWORK, EXPECTED_DECIMALS) => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], blockchain: DUMMY_BLOCKCHAIN, name: DUMMY_NAME, decimals: DUMMY_DECIMALS }])
      })
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([
        { code: DUMMY_NAME, networkCode: EXPECTED_NETWORK, decimals: EXPECTED_DECIMALS, name: 'Bitcoin' }
      ])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test.each([
      ...NATIVE_ASSETS.flatMap(([DUMMY_BLOCKCHAIN, DUMMY_NAME]) => [null, undefined].map(DUMMY_DECIMALS => [DUMMY_BLOCKCHAIN, DUMMY_NAME, DUMMY_DECIMALS])),
      ['Bitcoin', 'UNKNOWN', undefined], ['Unknown', 'BTC', undefined], ['Unknown', 'FIRO', undefined]
    ])('excludes %s/%s with API decimals %p', async (DUMMY_BLOCKCHAIN, DUMMY_NAME, DUMMY_DECIMALS) => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], blockchain: DUMMY_BLOCKCHAIN, name: DUMMY_NAME, decimals: DUMMY_DECIMALS }])
      })
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test('accepts native API decimals at the maximum of 255', async () => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], decimals: 255 }])
      })

      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([
        { code: 'BTC', networkCode: 'bitcoin', decimals: 255, name: 'Bitcoin' }
      ])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test.each([-1, 1.5, 256, 'invalid'])('does not hide invalid native API decimals %s', async DUMMY_DECIMALS => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[3], decimals: DUMMY_DECIMALS }])
      })
      await failure(protocol.getSupportedCryptoAssets(), ProviderError, DUMMY_DECIMALS === 'invalid' ? 'Invalid decimal in DFX response' : 'Invalid asset decimals', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/asset')])
    })

    test.each([null, ''])('returns undefined for asset description %j', async DUMMY_DESCRIPTION => {
      const { protocol } = setup({}, { 'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], description: DUMMY_DESCRIPTION }]) })
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([
        { code: 'ETH', networkCode: 'ethereum', decimals: 18, name: undefined }
      ])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test.each([['NewChain2', 'newchain2'], ['New-Chain2/?&', 'new-chain2/?&']])('lists a future blockchain value %s', async (DUMMY_BLOCKCHAIN, EXPECTED_NETWORK) => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: DUMMY_BLOCKCHAIN }])
      })
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([
        { code: 'ETH', networkCode: EXPECTED_NETWORK, decimals: 18, name: 'Ether' }
      ])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test.each(['', 'New Chain', 'Chain\t2', 'Chain\n2', 'Chain\u00002', 'Chain\u007f2', 'Chain\u00852', 'Chain\u200b2', 'Chain\u202e2'])('rejects empty blockchain names or whitespace, control and format characters %#', async DUMMY_BLOCKCHAIN => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], blockchain: DUMMY_BLOCKCHAIN }])
      })
      await failure(protocol.getSupportedCryptoAssets(), ProviderError, 'Unexpected DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/asset')])
    })

    test('lists assets available in either direction only with API decimals', async () => {
      const { protocol } = setup()
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([
        { code: 'ETH', networkCode: 'ethereum', decimals: 18, name: 'Ether' },
        { code: 'USDT', networkCode: 'ethereum', decimals: 6, name: 'Tether' },
        { code: 'USDT', networkCode: 'tron', decimals: 6, name: 'Tether' },
        { code: 'BUY', networkCode: 'ethereum', decimals: 2, name: 'Buy only' },
        { code: 'SELL', networkCode: 'ethereum', decimals: 2, name: 'Sell only' }
      ])
      expectInteractions([httpRequest('/v1/asset')])
    })

    test('excludes null decimals but keeps zero decimals and optional asset names', async () => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([
          { ...DUMMY_ASSETS[0], decimals: null }, { ...DUMMY_ASSETS[4], decimals: 0, description: undefined }
        ])
      })
      const result = await protocol.getSupportedCryptoAssets()

      expect(result).toEqual([{ code: 'BUY', networkCode: 'ethereum', decimals: 0, name: undefined }])
      expectInteractions([httpRequest('/v1/asset')])
    })
  })

  describe('getSupportedFiatCurrencies', () => {
    catalogCases('getSupportedFiatCurrencies')
    tradableCatalogCases('getSupportedFiatCurrencies')
    arrayMessageCases('getSupportedFiatCurrencies')

    test('excludes fiat catalog names without an exact uppercase ISO table entry', async () => {
      const { protocol } = setup({}, {
        'GET /v1/fiat': response([
          { ...DUMMY_FIAT[0], id: 18, name: 'eur' },
          { ...DUMMY_FIAT[0], id: 19, name: 'Eur' },
          DUMMY_FIAT[0]
        ])
      })
      const result = await protocol.getSupportedFiatCurrencies()

      expect(result).toEqual([{ code: 'EUR', decimals: 2 }])
      expectInteractions([httpRequest('/v1/fiat')])
    })

    test('lists fiat in either direction with ISO minor units and excludes unknown currencies', async () => {
      const { protocol } = setup()
      const result = await protocol.getSupportedFiatCurrencies()

      expect(result).toEqual([
        { code: 'EUR', decimals: 2 }, { code: 'CHF', decimals: 2 }, { code: 'JPY', decimals: 0 }, { code: 'BHD', decimals: 3 }
      ])
      expectInteractions([httpRequest('/v1/fiat')])
    })

    test.each([0, -1, 1.5, '9007199254740992'])('rejects invalid provider identifiers %s', async DUMMY_ID => {
      const { protocol } = setup({}, { 'GET /v1/fiat': response([{ ...DUMMY_FIAT[0], id: DUMMY_ID }]) })
      await failure(protocol.getSupportedFiatCurrencies(), ProviderError, 'Invalid DFX identifier', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/fiat')])
    })
  })

  describe('getSupportedCountries', () => {
    catalogCases('getSupportedCountries')
    arrayMessageCases('getSupportedCountries')

    test('clears the request deadline after a response', async () => {
      jest.useFakeTimers()
      const { protocol } = setup({}, {
        'GET /v1/country': response([DUMMY_COUNTRIES[0]])
      })

      const result = await protocol.getSupportedCountries()

      expect(result).toEqual([{ code: 'CH', name: 'Switzerland', isBuyAllowed: true, isSellAllowed: true }])
      expect(jest.getTimerCount()).toBe(0)
      expectInteractions([httpRequest('/v1/country')])
    })

    test.each([2147483647, 2147483647n])('accepts the maximum timer delay %s without clamping it', async TIMEOUT => {
      jest.useFakeTimers()
      const SET_TIMEOUT = globalThis.setTimeout
      timerMock.mockImplementation((...args) => SET_TIMEOUT(...args))
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(timerMock)
      const { protocol } = setup({ timeout: TIMEOUT }, {
        'GET /v1/country': init => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      })
      const pending = protocol.getSupportedCountries()
      // Handle rejection during timer advancement while preserving it for failure().
      pending.catch(() => {})
      const signal = fetchMock.mock.calls[0][1].signal
      await jest.advanceTimersByTimeAsync(2147483646)
      const abortedBeforeDeadline = signal.aborted
      await jest.advanceTimersByTimeAsync(1)
      await failure(pending, ProviderError, 'DFX request timed out', 'REQUEST_TIMEOUT')

      expect(abortedBeforeDeadline).toBe(false)
      expect(signal.aborted).toBe(true)
      expect(timerMock.mock.calls[0][1]).toBe(2147483647)
      expect(timerMock).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
      expectRequests(fetchMock.mock.calls, [httpRequest('/v1/country')], true)
      expect(getAddressMock.mock.calls).toEqual([])
      expect(signMock.mock.calls).toEqual([])
    })

    test.each(['injected', 'ambient'])('binds %s fetch to the global object', async MODE => {
      const implementation = function () {
        if (this !== globalThis && this !== undefined) throw new ValueError('Illegal fetch receiver')
        return Promise.resolve(response([]))
      }
      const fetch = transportMock.mockImplementation(implementation)
      const protocol = new DfxProtocol(undefined, MODE === 'ambient' ? {} : { fetch })
      const result = await protocol.getSupportedCountries()

      expect(result).toEqual([])
      expect(fetch.mock.contexts).toEqual([globalThis])
      expectRequests(fetch.mock.calls, [httpRequest('/v1/country')])
    })

    test.each([
      [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [408, 'REQUEST_TIMEOUT'],
      [429, 'INTERNAL_SERVER_ERROR'], [500, 'INTERNAL_SERVER_ERROR'],
      [503, 'INTERNAL_SERVER_ERROR'], [404, 'INTERNAL_SERVER_ERROR'], [418, 'INTERNAL_SERVER_ERROR']
    ])('maps HTTP %s with its message', async (DUMMY_STATUS, EXPECTED_REASON) => {
      const { protocol } = setup({}, { 'GET /v1/country': response({ message: 'dummy-provider-message' }, DUMMY_STATUS) })
      await failure(protocol.getSupportedCountries(), ProviderError, 'dummy-provider-message', EXPECTED_REASON)
      expectInteractions([httpRequest('/v1/country')])
    })

    test.each([[{ a: 1 }], [['Invalid input']], [], { detail: 'Invalid input' }, null, '', ['Invalid input', '']].map(DUMMY_MESSAGE => [DUMMY_MESSAGE]))('uses HTTP 400 fallback for an empty or non-string message after parsing %#', async DUMMY_MESSAGE => {
      const { protocol } = setup({}, { 'GET /v1/country': response({ message: DUMMY_MESSAGE }, 400) })
      await failure(protocol.getSupportedCountries(), ProviderError, 'DFX HTTP 400', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/country')])
    })

    test('joins a string and a parsed numeric message with a semicolon', async () => {
      const { protocol } = setup({}, { 'GET /v1/country': response({ message: ['Invalid input', 1] }, 400) })
      await failure(protocol.getSupportedCountries(), ProviderError, 'Invalid input; 1', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/country')])
    })

    test.each(['<html>Unavailable</html>', '{}', 'null'])('uses an HTTP fallback message for body %s', async DUMMY_BODY => {
      const { protocol } = setup({}, { 'GET /v1/country': response(DUMMY_BODY, 503) })
      await failure(protocol.getSupportedCountries(), ProviderError, 'DFX HTTP 503', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/country')])
    })

    test('preserves a network error as the cause', async () => {
      const DUMMY_CAUSE = new TypeError('dummy-network-failure')
      const fetch = transportMock.mockRejectedValue(DUMMY_CAUSE)
      const protocol = new DfxProtocol(undefined, { fetch })
      const error = await failure(protocol.getSupportedCountries(), ProviderError, 'DFX network request failed', 'NETWORK_ERROR')
      expect(error.cause).toBe(DUMMY_CAUSE)
      expectRequests(fetch.mock.calls, [httpRequest('/v1/country')])
    })

    test('maps response body transport failures to NETWORK_ERROR', async () => {
      const DUMMY_CAUSE = new TypeError('dummy-body-failure')
      bodyTextMock.mockRejectedValue(DUMMY_CAUSE)
      const DUMMY_BODY = new DummyResponse()
      const { protocol } = setup({}, { 'GET /v1/country': DUMMY_BODY })
      const error = await failure(protocol.getSupportedCountries(), ProviderError, 'DFX network request failed', 'NETWORK_ERROR')
      expect(error.cause).toBe(DUMMY_CAUSE)
      expect(DUMMY_BODY.text).toHaveBeenCalledWith()
      expectInteractions([httpRequest('/v1/country')])
    })

    test.each([[undefined, 30000], [10, 10], [10n, 10]])('aborts requests with the configured deadline %s', async (TIMEOUT, EXPECTED_DELAY) => {
      jest.useFakeTimers()
      const SET_TIMEOUT = globalThis.setTimeout
      timerMock.mockImplementation((...args) => SET_TIMEOUT(...args))
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(timerMock)
      const fetch = transportMock.mockImplementation((url, init) => new Promise((resolve, reject) => {
        const signal = init.signal
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      const protocol = new DfxProtocol(undefined, { fetch, timeout: TIMEOUT })
      const pending = protocol.getSupportedCountries()
      // Handle rejection during timer advancement while preserving it for failure().
      pending.catch(() => {})
      const signal = fetch.mock.calls[0][1].signal
      await jest.advanceTimersByTimeAsync(EXPECTED_DELAY - 1)
      const abortedBeforeDeadline = signal.aborted
      await jest.advanceTimersByTimeAsync(1)
      await failure(pending, ProviderError, 'DFX request timed out', 'REQUEST_TIMEOUT')

      expect(abortedBeforeDeadline).toBe(false)
      expect(signal.aborted).toBe(true)
      expect(timerMock.mock.calls[0][1]).toBe(EXPECTED_DELAY)
      expect(timerMock).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
      expectRequests(fetch.mock.calls, [httpRequest('/v1/country')], true)
    })

    test.each(['{', '{"value":01}', '{"value":1e}', '{"value":NaN}', '{12:3}'])('rejects malformed JSON %s', async DUMMY_BODY => {
      const { protocol } = setup({}, { 'GET /v1/country': response(DUMMY_BODY) })
      await failure(protocol.getSupportedCountries(), ProviderError, 'Invalid JSON in DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions([httpRequest('/v1/country')])
    })

    test('preserves quoted digits, escaped quotes and backslashes in JSON strings', async () => {
      const DUMMY_COUNTRIES = [{ symbol: 'CH', name: 'Area 12 "North" \\ 3', bankAllowed: true }]
      const { protocol } = setup({}, { 'GET /v1/country': response(DUMMY_COUNTRIES) })
      const result = await protocol.getSupportedCountries()

      expect(result).toEqual([{ code: 'CH', name: 'Area 12 "North" \\ 3', isBuyAllowed: true, isSellAllowed: true }])
      expectInteractions([httpRequest('/v1/country')])
    })
  })

  describe('getTransactionDetail', () => {
    const DUMMY_MESSAGE = challengeMessage(DUMMY_ADDRESS)
    const DUMMY_SOLANA = '00'.repeat(62) + '0d24'
    const DUMMY_DER = '304402210080' + '00'.repeat(31) + '021f01' + '00'.repeat(30)
    const DUMMY_COMPACT = '80' + '00'.repeat(31) + '0001' + '00'.repeat(30)

    // A denied login terminates this public operation immediately after the
    // observable auth request, without requiring unrelated catalog fixtures.
    test.each([
      ['solana', 'Solana', DUMMY_SOLANA, '1'.repeat(62) + '211'],
      ['solana', 'Solana', DUMMY_SOLANA.toUpperCase(), '1'.repeat(62) + '211'],
      ['solana', 'Solana', '00'.repeat(64), '1'.repeat(64)],
      ['solana', 'Solana', '00'.repeat(63) + '39', '1'.repeat(63) + 'z'],
      ['solana', 'Solana', '00'.repeat(63) + '3a', '1'.repeat(63) + '21'],
      ['spark', 'Spark', DUMMY_DER, DUMMY_COMPACT],
      ['spark', 'Spark', DUMMY_DER.toUpperCase(), DUMMY_COMPACT],
      ['spark', 'Spark', '3044021f01' + '00'.repeat(30) + '02210080' + '00'.repeat(31), '0001' + '00'.repeat(30) + '80' + '00'.repeat(31)],
      ['spark', 'Spark', '30440220' + '7f'.repeat(32) + '0220' + '01'.repeat(32), '7f'.repeat(32) + '01'.repeat(32)],
      ['spark', 'Spark', '3006020101020102', '00'.repeat(31) + '01' + '00'.repeat(31) + '02'],
      ['spark', 'Spark', '3006020100020100', '00'.repeat(64)],
      ...[
        '', 'xyz', '300', '0x3006020101020102',
        '3106020101020102', '3007020101020102',
        '3006030101020102', '3006020101030102',
        '3006020001020102', '3006022201020102',
        '3006020701020102', '3006020180020102',
        '300702020001020102', '300702020000020102',
        '3006020101020180', '300702010102020001',
        '300702010102010200', '30020201',
        '30260221' + '01'.repeat(33) + '020101',
        '30260201010221' + '01'.repeat(33),
        '3080' + '00'.repeat(128), DUMMY_COMPACT
      ].map(signature => ['spark', 'Spark', signature, signature]),
      ...[
        ['solana', 'Solana', 'ab'.repeat(63)], ['solana', 'Solana', 'ab'.repeat(65)],
        ['solana', 'Solana', 'gg'.repeat(64)], ['solana', 'Solana', '1'.repeat(64)],
        ['solana', 'Solana', '0x' + DUMMY_SOLANA], ['spark', 'Spark', DUMMY_SOLANA],
        ['ethereum', 'Ethereum', DUMMY_SOLANA], ['tron', 'Tron', DUMMY_DER],
        [undefined, undefined, DUMMY_SOLANA]
      ].map(([network, blockchain, signature]) => [network, blockchain, signature, signature]),
      // Constructor network names are case-insensitive at the public boundary.
      ['SOLANA', 'Solana', DUMMY_SOLANA, '1'.repeat(62) + '211'],
      ['SoLaNa', 'Solana', DUMMY_SOLANA, '1'.repeat(62) + '211'],
      ['SPARK', 'Spark', DUMMY_DER, DUMMY_COMPACT]
    ])('submits the exact %s authentication signature for format %#', async (NETWORK, BLOCKCHAIN, DUMMY_SIGNATURE, EXPECTED_SIGNATURE) => {
      getAddressMock.mockResolvedValue(DUMMY_ADDRESS)
      signMock.mockResolvedValue(DUMMY_SIGNATURE)
      fetchMock.mockResolvedValueOnce(response({ message: DUMMY_MESSAGE }))
        .mockResolvedValueOnce(response({ message: 'Invalid signature' }, 401))
      const protocol = new DfxProtocol(new DummyAccount(), { network: NETWORK, fetch: fetchMock })

      const result = protocol.getTransactionDetail('123')

      await failure(result, ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      expect(getAddressMock.mock.calls).toEqual([[]])
      expect(signMock.mock.calls).toEqual([[DUMMY_MESSAGE]])
      expectRequests(fetchMock.mock.calls, [
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ADDRESS}`),
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: EXPECTED_SIGNATURE, blockchain: BLOCKCHAIN }))
      ])
    })

    test.each([
      '', 'invalid', '0x' + '11'.repeat(64), '0x' + 'gg'.repeat(65),
      ...[26, 29, 35, 255].map(v => '0x' + '11'.repeat(64) + v.toString(16).padStart(2, '0')),
      '0x' + '00'.repeat(64) + '1b', '0x' + 'ff'.repeat(64) + '1c'
    ])('forwards malformed EVM recovery input %# for backend rejection', async DUMMY_SIGNATURE => {
      getAddressMock.mockResolvedValue(DUMMY_ADDRESS)
      signMock.mockResolvedValue(DUMMY_SIGNATURE)
      fetchMock.mockResolvedValueOnce(response({ message: DUMMY_MESSAGE }))
        .mockResolvedValueOnce(response({ message: 'Invalid signature' }, 401))
      const protocol = new DfxProtocol(new DummyAccount(), { network: 'ethereum', fetch: fetchMock })

      const result = protocol.getTransactionDetail('123')

      await failure(result, ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      expect(getAddressMock.mock.calls).toEqual([[]])
      expect(signMock.mock.calls).toEqual([[DUMMY_MESSAGE]])
      expectRequests(fetchMock.mock.calls, [
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ADDRESS}`),
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: DUMMY_SIGNATURE, blockchain: 'Ethereum' }))
      ])
    })

    test.each([0, 27].flatMap(offset => [false, true].flatMap(highS => ['', '0x', '0X'].map(prefix =>
      [offset, highS, prefix]
    ))))('submits the account address for an EIP-191 owner signature with v offset %s, high-s %s and prefix %s', async (OFFSET, HIGH_S, PREFIX) => {
      const OWNER_ADDRESS = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'
      const KEY = Uint8Array.from([...new Array(31).fill(0), 1])
      const PAYLOAD = Buffer.from(DUMMY_MESSAGE, 'utf8')
      const DIGEST = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${PAYLOAD.length}`), PAYLOAD]))
      let signature = secp256k1.Signature.fromBytes(secp256k1.sign(DIGEST, KEY, { prehash: false, format: 'recovered' }), 'recovered')
      if (HIGH_S) {
        const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
        signature = new secp256k1.Signature(signature.r, ORDER - signature.s, signature.recovery ^ 1)
      }
      const DUMMY_SIGNATURE = PREFIX + signature.toHex('compact').toUpperCase() + (signature.recovery + OFFSET).toString(16).padStart(2, '0')
      getAddressMock.mockResolvedValue(DUMMY_ADDRESS)
      signMock.mockResolvedValue(DUMMY_SIGNATURE)
      fetchMock.mockResolvedValueOnce(response({ message: DUMMY_MESSAGE }))
        .mockResolvedValueOnce(response({ message: 'Invalid signature' }, 400))
      const protocol = new DfxProtocol(new DummyAccount(), { network: 'ethereum', fetch: fetchMock })

      const result = protocol.getTransactionDetail('123')

      await failure(result, ProviderError, 'Invalid signature', 'UNAUTHORIZED')
      expect(getAddressMock.mock.calls).toEqual([[]])
      expect(signMock.mock.calls).toEqual([[DUMMY_MESSAGE]])
      expectRequests(fetchMock.mock.calls, [
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ADDRESS}`),
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: DUMMY_SIGNATURE, blockchain: 'Ethereum' }))
      ])
    })

    const DETAIL_REQUESTS = [CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST, ...CATALOG_REQUESTS]
    accountCases('getTransactionDetail')
    arrayMessageCases('getTransactionDetail')

    test('shares one login and signature between concurrent first detail requests', async () => {
      authMock.mockResolvedValueOnce(response({ accessToken: 'dummy-first-session' }, 201))
      const EXPECTED_DETAIL = { cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' }
      const EXPECTED_REQUESTS = [
        CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?uid=123', 'GET', undefined, 'dummy-first-session'),
        httpRequest('/v1/transaction/detail/single?uid=123', 'GET', undefined, 'dummy-first-session'),
        ...CATALOG_REQUESTS, ...CATALOG_REQUESTS
      ]
      const { protocol } = setup({}, {
        'POST /v1/auth': authMock
      })

      const result = await Promise.all([protocol.getTransactionDetail('123'), protocol.getTransactionDetail('123')])

      expect(result).toEqual([EXPECTED_DETAIL, EXPECTED_DETAIL])
      expectInteractions(EXPECTED_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('shared detail authentication wraps a buy-only account error for every waiter', async () => {
      const CAUSE = new BuyError('Signing refused', { reason: 'INSUFFICIENT_FUNDS' })
      const EXPECTED_REQUESTS = [CHALLENGE_REQUEST]
      const { protocol } = setup()
      signMock.mockRejectedValue(CAUSE)

      const errors = await Promise.all([
        protocol.getTransactionDetail('123').catch(error => error),
        protocol.getTransactionDetail('123').catch(error => error)
      ])

      await failure(Promise.reject(errors[0]), ProviderError, 'DFX account authentication failed', 'UNAUTHORIZED')
      expect(errors[0].cause).toBe(CAUSE)
      expect(errors[1]).toBe(errors[0])
      expectInteractions(EXPECTED_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('wraps a matching WDK Safe prediction as ERC-6492 on Polygon', async () => {
      const { account, result, typed, body } = await buyMatchingSafe(
        'Polygon',
        protocol => protocol.getTransactionDetail('123'),
        { catalog: false }
      )
      const inner = wrappedInner(body.signature)
      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expect(body.address).toBe(account)
      expect(body.blockchain).toBe('Polygon')
      expect(body.signature.endsWith(ERC_6492_MAGIC)).toBe(true)
      expect(typed.domain.chainId).toBe(137)
      expect(verifyTypedData(typed.domain, typed.types, typed.message, inner).toLowerCase()).toBe(OWNER_ADDRESS)
    })

    test('transaction details sign in as the account when the signature recovers elsewhere', async () => {
      const { protocol } = ownerSetup()

      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([
        CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', JSON.stringify({ address: DUMMY_ADDRESS, signature: ownerSignature(DUMMY_ACCOUNT_MESSAGE), blockchain: 'Ethereum' })),
        DETAIL_REQUEST,
        ...CATALOG_REQUESTS
      ], [[DUMMY_ACCOUNT_MESSAGE]], [[]])
    })

    test.each(['asset', 'fiat'])('resolves a historical inactive %s row among malformed unrelated rows', async CATALOG => {
      const DUMMY_ROWS = CATALOG === 'asset' ? DUMMY_ASSETS : DUMMY_FIAT
      const { protocol } = setup({}, {
        [`GET /v1/${CATALOG}`]: response([null, {}, { buyable: true, id: 'unrelated' }, { ...DUMMY_ROWS[0], buyable: false, sellable: false }])
      })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([true, false])('validates the historical matched row with ID lookup = %s', async USE_ID => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([{ ...DUMMY_ASSETS[0], buyable: undefined }]),
        'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, outputAssetId: USE_ID ? 1 : undefined })
      })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Unexpected DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('resolves a historical fallback past null and unrelated catalog rows', async () => {
      const { protocol } = setup({}, {
        'GET /v1/asset': response([null, {}, { ...DUMMY_ASSETS[0], buyable: false, sellable: false }]),
        'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, outputAssetId: undefined })
      })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('maps a rejected transaction UID to ValueError', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ message: 'Invalid UID' }, 422) })
      await failure(protocol.getTransactionDetail('123'), ValueError, 'Invalid UID')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each(['', '   '])('rejects an empty transaction UID', async TRANSACTION_UID => {
      const { protocol } = setup()
      await failure(protocol.getTransactionDetail(TRANSACTION_UID), ValueError, 'txId must be a non-empty UID')
      expectInteractions([])
    })

    test('requires authentication for details without misclassifying the UID', async () => {
      const protocol = new DfxProtocol()
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'A signing account is required for transaction details', 'UNAUTHORIZED')
      expectRequests(transportMock.mock.calls, [])
    })

    test('requires a signing account for details with a read-only account', async () => {
      const { protocol } = setup({}, {}, new DummyReadOnlyAccount())

      await failure(protocol.getTransactionDetail('123'), ProviderError, 'A signing account is required for transaction details', 'UNAUTHORIZED')

      expectInteractions([])
    })

    test.each([
      ['Completed', 'completed'], ['Failed', 'failed'], ['Returned', 'failed'], ['Stopped', 'failed'],
      ['LimitExceeded', 'failed'], ['FeeTooHigh', 'failed'], ['PriceUndeterminable', 'failed'],
      ['Created', 'in_progress'], ['Processing', 'in_progress'], ['LiquidityPending', 'in_progress'],
      ['CheckPending', 'in_progress'], ['KycRequired', 'in_progress'], ['PayoutInProgress', 'in_progress'],
      ['WaitingForPayment', 'in_progress'], ['Unassigned', 'in_progress'], ['ReturnPending', 'in_progress'], ['NewState', 'in_progress']
    ])('maps transaction state %s to %s', async (DUMMY_STATE, EXPECTED_STATUS) => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, state: DUMMY_STATE }) })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: EXPECTED_STATUS })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('maps sell transaction IDs to the correct catalogs', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ uid: '123', type: 'Sell', state: 'Completed', inputAssetId: 1, outputAssetId: 12 }) })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'CHF', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('encodes the transaction UID without converting it to an internal numeric ID', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123%2F%3F%26': response(DUMMY_DETAIL) })
      const result = await protocol.getTransactionDetail('123/?&')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?uid=123%2F%3F%26', 'GET', undefined, 'dummy-session'), ...CATALOG_REQUESTS],
      [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each(['Swap', 'Referral'])('rejects non-fiat transaction type %s', async DUMMY_TYPE => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, type: DUMMY_TYPE }) })
      await failure(protocol.getTransactionDetail('123'), NoSuchElementError, 'Transaction is not a DFX fiat transaction')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('rejects an unknown transaction type', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, type: 'Unknown' }) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Unknown DFX transaction type', 'INTERNAL_SERVER_ERROR')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('maps transaction HTTP 404 to NoSuchElementError', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ message: 'Transaction not found' }, 404) })
      await failure(protocol.getTransactionDetail('123'), NoSuchElementError, 'Transaction not found')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([
      { inputAssetId: undefined, outputAssetId: undefined },
      { inputAssetId: 999, outputAssetId: 999 },
      { inputAssetId: null, outputAssetId: null, outputAsset: 'ETH' }
    ])('uses unambiguous string fallback when catalog IDs cannot resolve', async DUMMY_OVERRIDE => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, ...DUMMY_OVERRIDE }) })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([
      { outputAsset: 'USDT' }, { inputAsset: 'CHF' }, { outputBlockchain: 'Tron' }
    ])('rejects contradictory ID and string metadata', async DUMMY_OVERRIDE => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, ...DUMMY_OVERRIDE }) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Conflicting transaction asset metadata', 'INTERNAL_SERVER_ERROR')
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([
      { outputAssetId: undefined, outputAsset: undefined },
      { outputAssetId: undefined, outputAsset: 'USDT', outputBlockchain: undefined },
      { inputAssetId: undefined, inputAsset: 'ZZY' }
    ])('rejects unresolved or ambiguous transaction metadata', async DUMMY_OVERRIDE => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({ ...DUMMY_DETAIL, ...DUMMY_OVERRIDE }) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Unable to resolve transaction asset', 'INTERNAL_SERVER_ERROR')
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('renews the session once after HTTP 401 and retries with the fresh token', async () => {
      let calls = 0
      let auth = 0
      const { protocol } = setup({}, {
        'POST /v1/auth': () => response({ accessToken: `dummy-${++auth}` }),
        'GET /v1/transaction/detail/single?uid=123': () => ++calls === 1 ? response({}, 401) : response(DUMMY_DETAIL)
      })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?uid=123', 'GET', undefined, 'dummy-1'),
        CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?uid=123', 'GET', undefined, 'dummy-2'), ...CATALOG_REQUESTS],
      [[challengeMessage(DUMMY_ADDRESS)], [challengeMessage(DUMMY_ADDRESS)]], [[], []])
    })

    test('stops after a second HTTP 401', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({}, 401) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'DFX HTTP 401', 'UNAUTHORIZED')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST, CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST],
        [[challengeMessage(DUMMY_ADDRESS)], [challengeMessage(DUMMY_ADDRESS)]], [[], []])
    })

    test.each([
      [404, NoSuchElementError, undefined],
      [503, ProviderError, 'INTERNAL_SERVER_ERROR']
    ])('propagates HTTP %s from the renewed transaction request without another retry', async (STATUS, ERROR_CLASS, REASON) => {
      let calls = 0
      const { protocol } = setup({}, {
        'GET /v1/transaction/detail/single?uid=123': () => response({}, ++calls === 1 ? 401 : STATUS)
      })

      await failure(protocol.getTransactionDetail('123'), ERROR_CLASS, `DFX HTTP ${STATUS}`, REASON)

      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST, CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST],
        [[challengeMessage(DUMMY_ADDRESS)], [challengeMessage(DUMMY_ADDRESS)]], [[], []])
    })

    test('does not retry other provider errors on transaction details', async () => {
      const { protocol } = setup({}, { 'GET /v1/transaction/detail/single?uid=123': response({}, 503) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'DFX HTTP 503', 'INTERNAL_SERVER_ERROR')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([
      ['cardano', 'Cardano'], ['arweave', 'Arweave'], ['internetcomputer', 'InternetComputer'], ['binancesmartchain', 'BinanceSmartChain'], ['unknown', undefined]
    ])('auth maps network %s to its complete DFX enum value', async (NETWORK, EXPECTED_BLOCKCHAIN) => {
      const { protocol } = setup({ network: NETWORK, publicKey: 'dummy-public-key' })
      const EXPECTED_CHAIN = EXPECTED_BLOCKCHAIN === undefined ? '' : `,"blockchain":"${EXPECTED_BLOCKCHAIN}"`
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([CHALLENGE_REQUEST,
        httpRequest('/v1/auth', 'POST', `{"address":"${DUMMY_ADDRESS}","signature":"dummy-signature"${EXPECTED_CHAIN},"key":"dummy-public-key"}`),
        DETAIL_REQUEST, ...CATALOG_REQUESTS], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each(['getAddress', 'sign'])('wraps a ProviderError subclass from %s on transaction details', async ACCOUNT_OPERATION => {
      class AccountProviderError extends ProviderError {}
      const DUMMY_CAUSE = new AccountProviderError('dummy-subclass', { reason: 'NETWORK_ERROR' })
      const { protocol } = setup()
      const accountMock = ACCOUNT_OPERATION === 'sign' ? signMock : getAddressMock
      accountMock.mockRejectedValue(DUMMY_CAUSE)
      const error = await failure(protocol.getTransactionDetail('123'), ProviderError, 'DFX account authentication failed', 'UNAUTHORIZED')
      expect(error.cause).toBe(DUMMY_CAUSE)
      expectInteractions(ACCOUNT_OPERATION === 'sign' ? [CHALLENGE_REQUEST] : [],
        ACCOUNT_OPERATION === 'sign' ? [[challengeMessage(DUMMY_ADDRESS)]] : [], [[]])
    })

    test('encodes address query parameters and signs only the returned message', async () => {
      const DUMMY_ACCOUNT_ADDRESS = 'dummy-address/with?query=1&extra=2'
      const message = challengeMessage(DUMMY_ACCOUNT_ADDRESS)
      const { protocol } = setup({}, { 'GET /v1/auth/signMessage?address=dummy-address%2Fwith%3Fquery%3D1%26extra%3D2': response({ message }) })
      getAddressMock.mockResolvedValue(DUMMY_ACCOUNT_ADDRESS)
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([
        httpRequest('/v1/auth/signMessage?address=dummy-address%2Fwith%3Fquery%3D1%26extra%3D2'),
        httpRequest('/v1/auth', 'POST', '{"address":"dummy-address/with?query=1&extra=2","signature":"dummy-signature"}'),
        DETAIL_REQUEST, ...CATALOG_REQUESTS], [[message]], [[]])
    })

    test.each([
      ['POST /v1/auth', {}], ['POST /v1/auth', { accessToken: '' }],
      [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`, { message: '' }],
      ['GET /v1/transaction/detail/single?uid=123', null]
    ])('rejects malformed authenticated responses', async (ROUTE, DUMMY_BODY) => {
      const { protocol } = setup({}, { [ROUTE]: response(DUMMY_BODY) })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Unexpected DFX response', 'INTERNAL_SERVER_ERROR')
      expectInteractions(ROUTE === 'POST /v1/auth'
        ? [CHALLENGE_REQUEST, AUTH_REQUEST]
        : ROUTE === 'GET /v1/transaction/detail/single?uid=123' ? [CHALLENGE_REQUEST, AUTH_REQUEST, DETAIL_REQUEST] : [CHALLENGE_REQUEST],
      ROUTE.startsWith('GET /v1/auth/') ? [] : [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('resolves historical transactions even when an asset has no decimals', async () => {
      const { protocol } = setup({}, {
        'GET /v1/transaction/detail/single?uid=123': response({
          uid: '123', type: 'Buy', state: 'Completed', inputAssetId: 11, outputAssetId: 4
        })
      })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'BTC', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('uses the transaction blockchain to disambiguate ticker fallback', async () => {
      const { protocol } = setup({}, {
        'GET /v1/transaction/detail/single?uid=123': response({
          uid: '123', type: 'Buy', state: 'Completed', inputAssetId: 11, outputAsset: 'USDT', outputBlockchain: 'Tron'
        })
      })
      const result = await protocol.getTransactionDetail('123')

      expect(result).toEqual({ cryptoAsset: 'USDT', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each(INVALID_EXTERNAL_IDS.map(ID => [ID]))('rejects invalid external detail ID before HTTP %#', async ID => {
      const { protocol } = setup()
      await failure(protocol.getTransactionDetail(ID, { idType: 'externalTransactionId' }), ValueError, EXTERNAL_ID_MESSAGE)
      expectInteractions([])
    })

    test.each(EXTERNAL_IDS)('looks up allowed external ID %# unchanged', async (ID, EXPECTED_ID) => {
      const PATH = `/v1/transaction/detail/single?external-id=${EXPECTED_ID}`
      const { protocol } = setup({}, { [`GET ${PATH}`]: response(DUMMY_DETAIL) })
      const result = await protocol.getTransactionDetail(ID, { idType: 'externalTransactionId' })

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest(PATH, 'GET', undefined, 'dummy-session'), ...CATALOG_REQUESTS], [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test.each([undefined, {}, { idType: undefined }, { idType: 'uid' }])('detail defaults to UID %#', async INPUT_OPTIONS => {
      const { protocol } = setup()
      const result = await protocol.getTransactionDetail('123', INPUT_OPTIONS)

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions(DETAIL_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('queries an encoded external ID and keeps it on session renewal', async () => {
      let calls = 0
      const PATH = '/v1/transaction/detail/single?external-id=wallet%3Aorder-1.2_3'
      const { protocol } = setup({}, {
        [`GET ${PATH}`]: () => ++calls === 1 ? response({}, 401) : response(DUMMY_DETAIL)
      })
      const result = await protocol.getTransactionDetail('wallet:order-1.2_3', { idType: 'externalTransactionId' })

      expect(result).toEqual({ cryptoAsset: 'ETH', fiatCurrency: 'EUR', status: 'completed' })
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest(PATH, 'GET', undefined, 'dummy-session'), CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest(PATH, 'GET', undefined, 'dummy-session'), ...CATALOG_REQUESTS],
      [[challengeMessage(DUMMY_ADDRESS)], [challengeMessage(DUMMY_ADDRESS)]], [[], []])
    })

    test('external ID without a registered order remains NoSuchElementError', async () => {
      const { protocol } = setup({}, {
        'GET /v1/transaction/detail/single?external-id=pending': response({ message: 'Transaction not found' }, 404)
      })
      await failure(protocol.getTransactionDetail('pending', { idType: 'externalTransactionId' }), NoSuchElementError, 'Transaction not found')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?external-id=pending', 'GET', undefined, 'dummy-session')],
      [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('external ID resolving to a Swap remains NoSuchElementError', async () => {
      const { protocol } = setup({}, {
        'GET /v1/transaction/detail/single?external-id=swap': response({ ...DUMMY_DETAIL, type: 'Swap' })
      })
      await failure(protocol.getTransactionDetail('swap', { idType: 'externalTransactionId' }), NoSuchElementError, 'Transaction is not a DFX fiat transaction')
      expectInteractions([CHALLENGE_REQUEST, AUTH_REQUEST,
        httpRequest('/v1/transaction/detail/single?external-id=swap', 'GET', undefined, 'dummy-session')],
      [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('challenge HTTP 400 is not treated as a rejected POST login', async () => {
      const { protocol } = setup({}, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: 'Invalid signature' }, 400)
      })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Invalid signature', 'INTERNAL_SERVER_ERROR')
      expectInteractions([CHALLENGE_REQUEST], [], [[]])
    })
  })

  describe('sign-in challenge', () => {
    function challengeRequests (environment = 'production') {
      return [
        httpRequest('/v1/asset', 'GET', undefined, undefined, environment),
        httpRequest('/v1/fiat', 'GET', undefined, undefined, environment),
        httpRequest(`/v1/auth/signMessage?address=${DUMMY_ADDRESS}`, 'GET', undefined, undefined, environment)
      ]
    }

    test('signs the production challenge exactly', async () => {
      const { protocol } = setup({ network: 'ethereum' })
      const result = await protocol.buy(OPTIONS)
      expect(result).toEqual(widget('buy'))
      expectInteractions(ETH_WIDGET_REQUESTS, [[challengeMessage(DUMMY_ADDRESS)]], [[]])
    })

    test('signs the sandbox challenge with the dev prefix', async () => {
      const { protocol } = setup({ environment: 'sandbox', network: 'ethereum' })
      const result = await protocol.buy(OPTIONS)
      expect(result.buyUrl.startsWith('https://dev.app.dfx.swiss/buy?')).toBe(true)
      expect(signMock.mock.calls[0][0].startsWith('[dev]_')).toBe(true)
      expectInteractions([
        ...challengeRequests('sandbox'),
        httpRequest('/v1/auth', 'POST', '{"address":"0x0000000000000000000000000000000000000001","signature":"dummy-signature","blockchain":"Ethereum"}', undefined, 'sandbox')
      ], [[challengeMessage(DUMMY_ADDRESS, 'sandbox')]], [[]])
    })

    test.each([
      ['a dev prefix in production', { environment: 'production' }, '[dev]_' + challengeMessage(DUMMY_ADDRESS)],
      ['sandbox text without the dev prefix', { environment: 'sandbox' }, challengeMessage(DUMMY_ADDRESS)],
      ['a foreign address', { environment: 'production' }, challengeMessage('0x0000000000000000000000000000000000000002')],
      ['appended text', { environment: 'production' }, challengeMessage(DUMMY_ADDRESS) + ' ']
    ])('rejects %s before signing', async (_label, config, message) => {
      const { protocol } = setup({ ...config, network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message })
      })
      await failure(protocol.buy(OPTIONS), ProviderError, 'Unexpected DFX sign-in challenge', 'INTERNAL_SERVER_ERROR')
      expectInteractions(challengeRequests(config.environment), [], [[]])
    })

    test('rejects a challenge whose address differs only by case', async () => {
      const account = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
      const { protocol } = setup({ network: 'ethereum' }, {
        [`GET /v1/auth/signMessage?address=${account}`]: response({
          message: challengeMessage('0x' + account.slice(2).toUpperCase())
        })
      })
      getAddressMock.mockResolvedValue(account)
      await failure(protocol.buy(OPTIONS), ProviderError, 'Unexpected DFX sign-in challenge', 'INTERNAL_SERVER_ERROR')
      expectInteractions([...CATALOG_REQUESTS, httpRequest(`/v1/auth/signMessage?address=${account}`)], [], [[]])
    })

    test('rejects a non-EVM challenge before signing', async () => {
      const { protocol } = setup({ network: 'bitcoin' }, {
        [`GET /v1/auth/signMessage?address=${DUMMY_ADDRESS}`]: response({ message: 'not-the-challenge' })
      })
      await failure(protocol.getTransactionDetail('123'), ProviderError, 'Unexpected DFX sign-in challenge', 'INTERNAL_SERVER_ERROR')
      expectInteractions([CHALLENGE_REQUEST], [], [[]])
    })
  })
})

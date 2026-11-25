// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from 'node:fs/promises'
import { NoSuchElementError } from '@tetherto/wdk-wallet/protocols'
import DfxProtocol from '../../index.js'
import { accountFixture, ADDRESS_PLACEHOLDER, CONFIG, EXTERNAL_TRANSACTION_ID, PAIR, UID } from './helpers.js'

// Run manually, never from Jest. Only allowlisted responses reach disk.
const responses = {}
let recording
let accountAddress
const protocol = new DfxProtocol(undefined, { ...CONFIG, timeout: 30000, fetch: recordingFetch })

async function recordingFetch (url, init) {
  const target = new URL(url)
  if (target.origin !== 'https://dev.api.dfx.swiss') throw new Error('Recording is restricted to the sandbox')
  // Freeze each catalog at its first response for all four quote requests.
  const catalog = responses[target.pathname.slice(4)]
  if (init.method === 'GET' && ['/v1/asset', '/v1/fiat', '/v1/country'].includes(target.pathname) && catalog) {
    return new Response(catalog.raw, { status: catalog.status, headers: { 'Content-Type': 'application/json' } })
  }
  const response = await globalThis.fetch(url, { ...init, redirect: 'error' })
  const raw = await response.clone().text()
  const method = init.method ?? 'GET'
  const entry = { request: { method, path: target.pathname + target.search, body: init.body ?? null }, status: response.status, raw }
  if (target.pathname === '/v1/auth/signMessage') {
    if (!response.ok) throw new Error(`Challenge recording failed: HTTP ${response.status}`)
    const message = JSON.parse(raw).message
    if (typeof message !== 'string' || !message.toLowerCase().includes(accountAddress.toLowerCase())) {
      throw new Error('Challenge does not contain the account address; inspect its schema before recording')
    }
    responses.challenge = {
      status: response.status,
      raw: raw.replace(new RegExp(accountAddress, 'gi'), ADDRESS_PLACEHOLDER)
    }
  } else if (['/v1/asset', '/v1/fiat', '/v1/country'].includes(target.pathname)) {
    if (!response.ok) throw new Error(`Catalog recording failed: ${target.pathname}, HTTP ${response.status}`)
    responses[target.pathname.slice(4)] = entry
  } else if (method === 'PUT' && ['/v1/buy/quote', '/v1/sell/quote'].includes(target.pathname)) {
    if (!response.ok) throw new Error(`Quote recording failed: ${recording}, HTTP ${response.status}`)
    responses[recording] = entry
  } else if (target.pathname === '/v1/transaction/detail/single') {
    if (response.status !== 404) throw new Error(`Expected unknown transaction HTTP 404, received ${response.status}`)
    responses[recording] = entry
  } else if (!(method === 'POST' && target.pathname === '/v1/auth')) {
    throw new Error(`Unexpected recording request: ${method} ${target.pathname}`)
  }
  // Authentication responses, headers and bodies are deliberately never saved.
  return response
}

await protocol.getSupportedCryptoAssets()
await protocol.getSupportedFiatCurrencies()
await protocol.getSupportedCountries()
for (const method of ['quoteBuy', 'quoteSell']) {
  for (const [field, amount] of [['fiatAmount', 10000n], ['cryptoAmount', 100000000n]]) {
    recording = `${method}_${field}`
    await protocol[method]({ ...PAIR, [field]: amount })
  }
}
const account = await accountFixture()
try {
  accountAddress = await account.getAddress()
  const authenticated = new DfxProtocol(account, { ...CONFIG, timeout: 30000, fetch: recordingFetch })
  for (const [key, id, options] of [
    ['detail_uid', UID, undefined],
    ['detail_external', EXTERNAL_TRANSACTION_ID, { idType: 'externalTransactionId' }]
  ]) {
    recording = key
    try {
      await authenticated.getTransactionDetail(id, options)
      throw new Error(`Expected missing transaction: ${key}`)
    } catch (error) {
      if (error.constructor !== NoSuchElementError) throw error
    }
  }
  const output = JSON.stringify({ recordedAt: new Date().toISOString(), responses }, null, 2) + '\n'
  if (output.toLowerCase().includes(accountAddress.toLowerCase()) || output.includes('accessToken')) {
    throw new Error('Refusing to save account data in fixtures')
  }
  await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true })
  await writeFile(new URL('./fixtures/sandbox.json', import.meta.url), output)
} finally {
  account.dispose()
}

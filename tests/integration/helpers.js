// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import WalletManagerEvm from '@tetherto/wdk-wallet-evm'

export const CONFIG = { environment: 'sandbox', network: 'ethereum', timeout: 5000 }
export const PAIR = { cryptoAsset: 'USDT', fiatCurrency: 'CHF' }
export const UID = '00000000-0000-4000-8000-000000000000'
export const EXTERNAL_TRANSACTION_ID = 'wdk-integration-unregistered-00000000-0000-4000-8000-000000000000'
export const ADDRESS_PLACEHOLDER = '{{ADDRESS}}'
export const DUMMY_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJkdW1teS1sb2NhbC11c2VyIn0.ZHVtbXktc2lnbmF0dXJl'

export async function accountFixture (index = 0) {
  // Signing is local; an accidental RPC request must never reach a public node.
  const wallet = new WalletManagerEvm('cook voyage document eight skate token alien guide drink uncle term abuse', { provider: 'http://127.0.0.1:1' })
  return wallet.getAccount(index)
}

export async function serverControl (path, options) {
  const response = await globalThis.fetch(`${process.env.DFX_INTEGRATION_ORIGIN}${path}`, options)
  if (!response.ok) throw new Error(`Replay control failed: ${response.status}`)
  return response.json()
}

export function resetServer (faults = {}, { preserveRegistrations = false } = {}) {
  return serverControl(`/__reset?preserveRegistrations=${preserveRegistrations}`, { method: 'POST', body: JSON.stringify(faults) })
}

export const DUMMY_SMART_ADDRESS = '0x0000000000000000000000000000000000000001'

export function challengeMessage (address) {
  return `[dev]_By_signing_this_message,_you_confirm_that_you_are_the_sole_owner_of_the_provided_Blockchain_address._Your_ID:_${address}`
}

export class DummySmartAccount {
  constructor (account, address = DUMMY_SMART_ADDRESS) {
    this.account = account
    this.address = address
    this.messages = []
    this.typedData = []
  }

  async getAddress () { return this.address }

  sign (message) {
    this.messages.push(message)
    return this.account.sign(message)
  }

  signTypedData (typedData) {
    this.typedData.push(typedData)
    return this.account.signTypedData(typedData)
  }
}

export class DummyFirstSignature extends DummySmartAccount {
  constructor (account, signature) {
    super(account)
    this.signature = signature
  }

  sign (message) {
    if (this.messages.length === 0) {
      this.messages.push(message)
      return Promise.resolve(this.signature)
    }
    return super.sign(message)
  }
}

export function localFetch (url, init) {
  const target = new URL(url)
  if (target.origin !== 'https://dev.api.dfx.swiss') throw new Error(`Unexpected API origin: ${target.origin}`)
  const origin = process.env.DFX_INTEGRATION_ORIGIN
  if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Missing local DFX server; use test:integration')
  return globalThis.fetch(`${origin}${target.pathname}${target.search}`, { ...init, redirect: 'error' })
}

export const LOCAL_CONFIG = { ...CONFIG, fetch: localFetch }

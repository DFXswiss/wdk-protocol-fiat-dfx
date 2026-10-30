// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import DfxProtocol from '../index.js'

// Run from the source checkout: node --env-file=.env.example examples/buy.js
// Replace this placeholder with an existing signing WDK account to open the widget.
// Keep keys in the wallet; never embed them here. Undefined runs only a public quote.
const account = undefined
const dfx = new DfxProtocol(account, {
  environment: process.env.DFX_ENVIRONMENT || 'sandbox',
  wallet: process.env.DFX_WALLET || undefined,
  network: process.env.DFX_NETWORK || 'ethereum'
})

const options = { cryptoAsset: 'ETH', fiatCurrency: 'EUR', fiatAmount: 10000n }
export const quote = await dfx.quoteBuy(options)
export const result = account ? await dfx.buy(options) : undefined

// Consume quote and result.buyUrl in the application UI. Never log session URLs.

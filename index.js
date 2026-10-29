// Copyright 2026 DFX AG
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyOptions} BuyOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyCommonOptions} BuyCommonOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyExactCryptoAmountOptions} BuyExactCryptoAmountOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyWithFiatAmountOptions} BuyWithFiatAmountOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyResult} BuyResult */

/** @typedef {import('@tetherto/wdk-wallet/protocols').SellOptions} SellOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellCommonOptions} SellCommonOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellExactCryptoAmountOptions} SellExactCryptoAmountOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellForFiatAmountOptions} SellForFiatAmountOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellResult} SellResult */

/** @typedef {import('@tetherto/wdk-wallet/protocols').FiatQuote} FiatQuote */
/** @typedef {import('@tetherto/wdk-wallet/protocols').FiatTransactionStatus} FiatTransactionStatus */
/** @typedef {import('@tetherto/wdk-wallet/protocols').FiatTransactionDetail} FiatTransactionDetail */

/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedCryptoAsset} SupportedCryptoAsset */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedFiatCurrency} SupportedFiatCurrency */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedCountry} SupportedCountry */

export { default, default as DfxProtocol } from './src/dfx-protocol.js'
export { IFiatProtocol, FiatProtocol, BuyErrorReason, SellErrorReason } from '@tetherto/wdk-wallet/protocols'
export {
  AccountRequiredError, ValueError, ProviderError, ProviderRequiredError,
  BuyError, SellError, MaximumFeeExceededError, NoSuchElementError
} from '@tetherto/wdk-wallet/protocols'
export { ProviderErrorReason } from '@tetherto/wdk-wallet'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').IWalletAccountReadOnly} IWalletAccountReadOnly */

/** @typedef {import('./src/dfx-protocol.js').DfxProtocolConfig} DfxProtocolConfig */

/** @typedef {import('./src/dfx-protocol.js').DfxTradeConfig} DfxTradeConfig */

/** @typedef {import('./src/dfx-protocol.js').DfxBuyOptions} DfxBuyOptions */

/** @typedef {import('./src/dfx-protocol.js').DfxSellOptions} DfxSellOptions */
/** @typedef {import('./src/dfx-protocol.js').DfxTradeOptions} DfxTradeOptions */
/** @typedef {import('./src/dfx-protocol.js').DfxQuoteConfig} DfxQuoteConfig */
/** @typedef {import('./src/dfx-protocol.js').DfxQuoteOptions} DfxQuoteOptions */
/** @typedef {import('./src/dfx-protocol.js').DfxBuyQuoteOptions} DfxBuyQuoteOptions */
/** @typedef {import('./src/dfx-protocol.js').DfxSellQuoteOptions} DfxSellQuoteOptions */

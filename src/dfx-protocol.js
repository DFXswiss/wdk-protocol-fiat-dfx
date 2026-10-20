// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import {
  FiatProtocol, AccountRequiredError, BuyError, SellError, MaximumFeeExceededError,
  NoSuchElementError, ProviderError, ProviderRequiredError, ValueError
} from '@tetherto/wdk-wallet/protocols'
import { ProviderErrorReason } from '@tetherto/wdk-wallet'
import DfxClient from './dfx-client.js'
import { normalizeSignature, recoverEvmAddress, safeMessageTypedData } from './signature.js'
import { erc6492SafeSignature } from './safe.js'
import { decimal, displayAmount, divideAmounts, minorUnits, positiveAmount, unexpected } from './amounts.js'
import { BLOCKCHAINS, ERC6492_NETWORKS, EVM_BLOCKCHAINS, EVM_CHAIN_IDS, FAILED_STATES, FIAT_DECIMALS, INPUT_ERRORS, MAX_ASSET_DECIMALS, MAX_TIMEOUT_MS, SIGN_IN_CHALLENGE, SIGN_IN_CHALLENGE_PREFIX } from './constants.js'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */
/** @typedef {import('@tetherto/wdk-wallet').IWalletAccountReadOnly} IWalletAccountReadOnly */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyOptions} BuyOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellOptions} SellOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').BuyResult} BuyResult */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SellResult} SellResult */
/** @typedef {import('@tetherto/wdk-wallet/protocols').FiatQuote} FiatQuote */
/** @typedef {import('@tetherto/wdk-wallet/protocols').FiatTransactionDetail} FiatTransactionDetail */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedCryptoAsset} SupportedCryptoAsset */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedFiatCurrency} SupportedFiatCurrency */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SupportedCountry} SupportedCountry */

/**
 * Configuration for DFX API and widget access.
 *
 * @typedef {Object} DfxProtocolConfig
 * @property {'production' | 'sandbox'} [environment] - API and app environment. Only sandbox selects sandbox; otherwise production is used.
 * @property {string} [wallet] - Partner identifier supplied by the integrating wallet developer. No default.
 * @property {string} [network] - Non-empty DFX blockchain name binding the account to its chain, case-insensitively. No default.
 * @property {string} [publicKey] - Public key sent as key during authentication. No default.
 * @property {string} [language] - Widget language code. Defaults to en.
 * @property {typeof fetch} [fetch] - HTTP implementation called with globalThis as receiver. Defaults to globalThis.fetch.
 * @property {number | bigint} [timeout] - Finite positive HTTP request deadline in milliseconds, at most 2147483647 (default: 30,000).
 */

/**
 * Configuration for a single DFX widget session.
 *
 * @typedef {Object} DfxTradeConfig
 * @property {string} [network] - Non-empty DFX blockchain name, compared case-insensitively. Defaults to and must match the constructor network.
 * @property {string} [externalTransactionId] - Wallet-assigned ID, unique per widget opening; 1–256 characters from A-Z, a-z, 0-9, dot, underscore, colon and hyphen.
 */

/**
 * Per-operation trade configuration.
 *
 * @typedef {Object} DfxTradeOptions
 * @property {DfxTradeConfig} [config] - Account network and wallet-assigned transaction ID for this widget opening.
 */

/**
 * Configuration for a single DFX quote.
 *
 * @typedef {Object} DfxQuoteConfig
 * @property {string} [network] - Non-empty DFX blockchain name, compared case-insensitively. Defaults to the constructor network.
 */

/**
 * Per-operation quote configuration.
 *
 * @typedef {Object} DfxQuoteOptions
 * @property {DfxQuoteConfig} [config] - Network selection for this quote, independent of the account network.
 */

/**
 * Options for a DFX purchase widget session.
 *
 * @typedef {BuyOptions & DfxTradeOptions} DfxBuyOptions
 */
/**
 * Options for a DFX sale widget session.
 *
 * @typedef {SellOptions & DfxTradeOptions} DfxSellOptions
 */
/**
 * Options for an indicative DFX purchase quote.
 *
 * @typedef {Omit<BuyOptions, 'recipient'> & DfxQuoteOptions} DfxBuyQuoteOptions
 */
/**
 * Options for an indicative DFX sale quote.
 *
 * @typedef {Omit<SellOptions, 'refundAddress'> & DfxQuoteOptions} DfxSellQuoteOptions
 */

const ACCOUNT_ERRORS = {
  buy: [AccountRequiredError, ValueError, ProviderRequiredError, ProviderError, BuyError, MaximumFeeExceededError],
  sell: [AccountRequiredError, ValueError, ProviderRequiredError, ProviderError, SellError, MaximumFeeExceededError],
  detail: [ProviderRequiredError, ProviderError]
}

function optionalString (value, name) {
  if (value !== undefined && value.trim() === '') {
    throw new ValueError(`${name} must be a non-empty string`)
  }
}

function externalTransactionId (value) {
  if (value.length < 1 || value.length > 256 || /[^A-Za-z0-9._:-]/.test(value)) {
    throw new ValueError('externalTransactionId must contain 1–256 characters from A-Z, a-z, 0-9, dot (.), underscore (_), colon (:) and hyphen (-)')
  }
}

function sameAddress (left, right) {
  const evm = /^0x[0-9a-fA-F]{40}$/
  return evm.test(left) && evm.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right
}

function signInChallenge (environment, address) {
  const prefix = environment === 'sandbox' ? SIGN_IN_CHALLENGE_PREFIX.sandbox : SIGN_IN_CHALLENGE_PREFIX.production
  return prefix + SIGN_IN_CHALLENGE + address
}

function record (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unexpected()
  return value
}

function textField (value) {
  if (typeof value !== 'string' || value.length === 0) throw unexpected()
  return value
}

function hasDecimals (asset) {
  return asset.decimals != null
}

function assetDecimals (asset) {
  const value = decimal(asset.decimals)
  if (value.lt(0) || value.gt(MAX_ASSET_DECIMALS) || !value.eq(value.round(0))) throw unexpected('Invalid asset decimals')
  return Number(value.toFixed())
}

function identifier (value) {
  const id = decimal(value)
  if (id.lte(0) || !id.eq(id.round(0)) || id.gt(Number.MAX_SAFE_INTEGER.toString())) {
    throw unexpected('Invalid DFX identifier')
  }
  return id.toFixed()
}

function fiatDecimals (currency) {
  const code = currency.name
  return Object.hasOwn(FIAT_DECIMALS, code) ? FIAT_DECIMALS[code] : undefined
}

function catalogRow (row, kind) {
  record(row)
  textField(row.name)
  if (typeof row.buyable !== 'boolean' || typeof row.sellable !== 'boolean') throw unexpected()
  if (kind === 'asset') {
    if (/[\s\p{Cc}\p{Cf}]/u.test(textField(row.blockchain))) throw unexpected()
    if (row.description != null && row.description !== '') textField(row.description)
    if (hasDecimals(row)) assetDecimals(row)
  }
  return { ...row, id: identifier(row.id) }
}

function transactionCode (rows, kind, id, name, blockchain) {
  const byId = id == null ? undefined : rows.find(row => row?.id === identifier(id))
  if (byId) {
    catalogRow(byId, kind)
    if ((name != null && byId.name !== name && byId.uniqueName !== name) ||
      (blockchain != null && byId.blockchain !== blockchain)) throw unexpected('Conflicting transaction asset metadata')
    return byId.name
  }
  const matches = rows.filter(row => row != null && name != null && (row.name === name || row.uniqueName === name) &&
    (blockchain == null || row.blockchain === blockchain))
  if (matches.length !== 1) throw unexpected('Unable to resolve transaction asset')
  return catalogRow(matches[0], kind).name
}

/**
 * Provides DFX fiat quotes, widget URLs and transaction status.
 */
export default class DfxProtocol extends FiatProtocol {
  /** @private */
  #token

  /** @private */
  #renewing

  /**
   * Creates a new interface to the protocol without binding it to a wallet account.
   *
   * @overload
   * @param {undefined} [account] - Omit to access only quotes and supported lists.
   * @param {DfxProtocolConfig} [config] - API and widget configuration (default: `{}`).
   * @throws {ValueError} If timeout is non-finite or non-positive.
   * @throws {ValueError} If timeout exceeds 2147483647 milliseconds.
   * @throws {ValueError} If network is supplied but is empty or whitespace-only.
   * @throws {ValueError} If wallet is supplied but is empty or whitespace-only.
   * @throws {ValueError} If publicKey is supplied but is empty or whitespace-only.
   * @throws {ValueError} If language is supplied but is empty or whitespace-only.
   */
  /**
   * Creates a new read-only interface to the protocol.
   *
   * @overload
   * @param {IWalletAccountReadOnly} readOnlyAccount - Read-only account; buy/sell throw AccountRequiredError and getTransactionDetail throws ProviderError.
   * @param {DfxProtocolConfig} [config] - API and widget configuration (default: `{}`).
   * @throws {ValueError} If timeout is non-finite or non-positive.
   * @throws {ValueError} If timeout exceeds 2147483647 milliseconds.
   * @throws {ValueError} If network is supplied but is empty or whitespace-only.
   * @throws {ValueError} If wallet is supplied but is empty or whitespace-only.
   * @throws {ValueError} If publicKey is supplied but is empty or whitespace-only.
   * @throws {ValueError} If language is supplied but is empty or whitespace-only.
   */
  /**
   * Creates a new interface to the protocol.
   *
   * @overload
   * @param {IWalletAccount} signingAccount - Account used to sign DFX authentication messages.
   * @param {DfxProtocolConfig} [config] - API and widget configuration (default: `{}`).
   * @throws {ValueError} If timeout is non-finite or non-positive.
   * @throws {ValueError} If timeout exceeds 2147483647 milliseconds.
   * @throws {ValueError} If network is supplied but is empty or whitespace-only.
   * @throws {ValueError} If wallet is supplied but is empty or whitespace-only.
   * @throws {ValueError} If publicKey is supplied but is empty or whitespace-only.
   * @throws {ValueError} If language is supplied but is empty or whitespace-only.
   */
  constructor (account, config = {}) {
    super(account)
    const timeout = typeof config.timeout === 'bigint' ? Number(config.timeout) : config.timeout
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new ValueError('timeout must be a finite number greater than zero')
    }
    if (timeout > MAX_TIMEOUT_MS) throw new ValueError('timeout must not exceed 2147483647 milliseconds')
    for (const field of ['network', 'wallet', 'publicKey', 'language']) optionalString(config[field], field)
    const environment = config.environment ?? 'production'
    /** @private */
    this._config = { ...config, timeout, environment, network: config.network?.toLowerCase() }
    /** @private */
    this._client = new DfxClient(this._config)
    /** @private */
    this._app = environment === 'sandbox' ? 'https://dev.app.dfx.swiss' : 'https://app.dfx.swiss'
  }

  /**
   * Generates a URL for a user to purchase a crypto asset with fiat currency.
   * Each opening uses a fresh authenticated session.
   * Tickers and networks are case-insensitive; EVM checksum addresses are equivalent.
   * A recovered signer that differs from the account is never used as the DFX account.
   * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
   * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
   * signature is submitted for that same address.
   * When that Safe signature's owner predicts the account under the WDK Safe 0.3.0 parameters and DFX verifies ERC-6492 on that network, it is wrapped as ERC-6492.
   * Account errors pass through only for the exact constructors listed below;
   * subclasses and other account failures become ProviderError with the original cause.
   *
   * @param {DfxBuyOptions} options - Purchase asset, currency and one amount in smallest units. recipient must match the account address.
   * @returns {Promise<BuyResult>} An object with the purchase widget URL (`buyUrl`).
   * @throws {AccountRequiredError} If a signing account is unavailable.
   * @throws {AccountRequiredError} If an account call reports a missing account.
   * @throws {ValueError} If an account call rejects a value.
   * @throws {ValueError} If the asset or network is unsupported for buying.
   * @throws {ValueError} If the asset spelling is ambiguous on a network.
   * @throws {ValueError} If the asset is ambiguous across networks.
   * @throws {ValueError} If asset decimals are missing.
   * @throws {ValueError} If the fiat currency is ambiguous.
   * @throws {ValueError} If the fiat currency is unsupported for buying.
   * @throws {ValueError} If exactly one amount is not supplied.
   * @throws {ValueError} If the amount is invalid.
   * @throws {ValueError} If the amount exceeds accepted precision.
   * @throws {ValueError} If the per-operation network is empty or whitespace-only.
   * @throws {ValueError} If the constructor network is missing.
   * @throws {ValueError} If the network differs from the account network.
   * @throws {ValueError} If recipient differs from the account address.
   * @throws {ValueError} If externalTransactionId is not 1–256 characters from A-Z, a-z, 0-9, dot, underscore, colon and hyphen.
   * @throws {ProviderError} If authentication fails.
   * @throws {ProviderError} If the sign-in challenge is not the expected DFX text.
   * @throws {ProviderError} If the API request fails.
   * @throws {ProviderError} If the API returns malformed data.
   * @throws {ProviderRequiredError} If the account requires a provider.
   * @throws {BuyError} If the account reports a purchase failure.
   * @throws {MaximumFeeExceededError} If the account reports an excessive fee.
   */
  async buy (options) {
    return { buyUrl: await this._widget('buy', options) }
  }

  /**
   * Gets a quote for a crypto asset purchase.
   * Indicative, without a signature or reservation.
   *
   * @param {DfxBuyQuoteOptions} options - Purchase asset, currency and one amount in smallest units; optional config.network selects the network.
   * @returns {Promise<FiatQuote>} Amounts and fees in smallest units; rate from response fiat/crypto display amounts including fees, rounded half up to 18 significant digits without exponent notation.
   * @throws {ValueError} If the asset or network is unsupported for buying.
   * @throws {ValueError} If the asset spelling is ambiguous on a network.
   * @throws {ValueError} If the asset is ambiguous across networks.
   * @throws {ValueError} If asset decimals are missing.
   * @throws {ValueError} If the fiat currency is ambiguous.
   * @throws {ValueError} If the fiat currency is unsupported for buying.
   * @throws {ValueError} If exactly one amount is not supplied.
   * @throws {ValueError} If the amount is invalid.
   * @throws {ValueError} If the amount exceeds accepted precision.
   * @throws {ValueError} If the per-operation network is empty or whitespace-only.
   * @throws {ValueError} If DFX rejects quote input.
   * @throws {ProviderError} If the API fails.
   * @throws {ProviderError} If the API returns malformed quote data.
   */
  async quoteBuy (options) {
    return this._quote('buy', options)
  }

  /**
   * Generates a URL for a user to sell a crypto asset for fiat currency.
   * Each opening uses a fresh authenticated session.
   * Tickers and networks are case-insensitive; EVM checksum addresses are equivalent.
   * A recovered signer that differs from the account is never used as the DFX account.
   * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
   * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
   * signature is submitted for that same address.
   * When that Safe signature's owner predicts the account under the WDK Safe 0.3.0 parameters and DFX verifies ERC-6492 on that network, it is wrapped as ERC-6492.
   * Account errors pass through only for the exact constructors listed below;
   * subclasses and other account failures become ProviderError with the original cause.
   *
   * @param {DfxSellOptions} options - Sale asset, currency and one amount in smallest units. refundAddress must match the account address.
   * @returns {Promise<SellResult>} An object with the sale widget URL (`sellUrl`).
   * @throws {AccountRequiredError} If a signing account is unavailable.
   * @throws {AccountRequiredError} If an account call reports a missing account.
   * @throws {ValueError} If an account call rejects a value.
   * @throws {ValueError} If the asset or network is unsupported for selling.
   * @throws {ValueError} If the asset spelling is ambiguous on a network.
   * @throws {ValueError} If the asset is ambiguous across networks.
   * @throws {ValueError} If asset decimals are missing.
   * @throws {ValueError} If the fiat currency is ambiguous.
   * @throws {ValueError} If the fiat currency is unsupported for selling.
   * @throws {ValueError} If exactly one amount is not supplied.
   * @throws {ValueError} If the amount is invalid.
   * @throws {ValueError} If the amount exceeds accepted precision.
   * @throws {ValueError} If the per-operation network is empty or whitespace-only.
   * @throws {ValueError} If the constructor network is missing.
   * @throws {ValueError} If the network differs from the account network.
   * @throws {ValueError} If refundAddress differs from the account address.
   * @throws {ValueError} If externalTransactionId is not 1–256 characters from A-Z, a-z, 0-9, dot, underscore, colon and hyphen.
   * @throws {ProviderError} If authentication fails.
   * @throws {ProviderError} If the sign-in challenge is not the expected DFX text.
   * @throws {ProviderError} If the API request fails.
   * @throws {ProviderError} If the API returns malformed data.
   * @throws {ProviderRequiredError} If the account requires a provider.
   * @throws {SellError} If the account reports a sale failure.
   * @throws {MaximumFeeExceededError} If the account reports an excessive fee.
   */
  async sell (options) {
    return { sellUrl: await this._widget('sell', options) }
  }

  /**
   * Gets a quote for a crypto asset sale.
   * Indicative, without a signature or reservation.
   *
   * @param {DfxSellQuoteOptions} options - Sale asset, currency and one amount in smallest units; optional config.network selects the network.
   * @returns {Promise<FiatQuote>} Amounts and fees in smallest units; rate from response fiat/crypto display amounts including fees, rounded half up to 18 significant digits without exponent notation.
   * @throws {ValueError} If the asset or network is unsupported for selling.
   * @throws {ValueError} If the asset spelling is ambiguous on a network.
   * @throws {ValueError} If the asset is ambiguous across networks.
   * @throws {ValueError} If asset decimals are missing.
   * @throws {ValueError} If the fiat currency is ambiguous.
   * @throws {ValueError} If the fiat currency is unsupported for selling.
   * @throws {ValueError} If exactly one amount is not supplied.
   * @throws {ValueError} If the amount is invalid.
   * @throws {ValueError} If the amount exceeds accepted precision.
   * @throws {ValueError} If the per-operation network is empty or whitespace-only.
   * @throws {ValueError} If DFX rejects quote input.
   * @throws {ProviderError} If the API fails.
   * @throws {ProviderError} If the API returns malformed quote data.
   */
  async quoteSell (options) {
    return this._quote('sell', options)
  }

  /**
   * Retrieves the details of a specific transaction from the provider.
   * Accepts a UID or external ID and renews an expired session once.
   * Parallel detail calls share one sign-in per instance, independently of widgets.
   * A recovered signer that differs from the account is never used as the DFX account.
   * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
   * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
   * signature is submitted for that same address.
   * When that Safe signature's owner predicts the account under the WDK Safe 0.3.0 parameters and DFX verifies ERC-6492 on that network, it is wrapped as ERC-6492.
   * Only exact ProviderRequiredError and ProviderError account errors pass through;
   * all other account failures become ProviderError with the original cause.
   *
   * @param {string} txId - DFX transaction UID or wallet-assigned external transaction ID.
   * @param {Object} [options] - Selects lookup by DFX transaction UID or wallet-assigned external transaction ID (default: `{}`).
   * @param {'uid' | 'externalTransactionId'} [options.idType] - Identifier type; defaults to uid.
   * @returns {Promise<FiatTransactionDetail>} Normalized transaction status and asset codes.
   * @throws {ValueError} If the UID is empty or whitespace-only.
   * @throws {ValueError} If externalTransactionId is not 1–256 characters from A-Z, a-z, 0-9, dot, underscore, colon and hyphen.
   * @throws {ValueError} If the identifier is rejected by DFX.
   * @throws {NoSuchElementError} If no transaction exists for the given id.
   * @throws {NoSuchElementError} If the transaction is a Swap.
   * @throws {NoSuchElementError} If the transaction is a Referral.
   * @throws {ProviderRequiredError} If the signing account requires a provider.
   * @throws {ProviderError} If a signing account is unavailable.
   * @throws {ProviderError} If authentication fails.
   * @throws {ProviderError} If the sign-in challenge is not the expected DFX text.
   * @throws {ProviderError} If the API request fails.
   * @throws {ProviderError} If the response cannot be resolved.
   */
  async getTransactionDetail (txId, options = {}) {
    const idType = options.idType === undefined ? 'uid' : options.idType
    if (idType === 'externalTransactionId') externalTransactionId(txId)
    else if (txId.trim() === '') throw new ValueError('txId must be a non-empty UID')
    const token = await this.#session()
    const path = `/v1/transaction/detail/single?${new URLSearchParams({ [idType === 'uid' ? 'uid' : 'external-id']: txId })}`
    let data
    try {
      data = await this._client._request(path, { token, input: true, detail: true })
    } catch (error) {
      if (!(error instanceof ProviderError) || error.reason !== ProviderErrorReason.UNAUTHORIZED || !this._hasAccount()) throw error
      if (this.#token === token) this.#token = undefined
      const renewed = await this.#session()
      try {
        data = await this._client._request(path, { token: renewed, input: true, detail: true })
      } catch (error) {
        if (error instanceof ProviderError && error.reason === ProviderErrorReason.UNAUTHORIZED && this.#token === renewed) this.#token = undefined
        throw error
      }
    }
    record(data)
    if (data.type === 'Swap' || data.type === 'Referral') throw new NoSuchElementError('Transaction is not a DFX fiat transaction')
    if (data.type !== 'Buy' && data.type !== 'Sell') throw unexpected('Unknown DFX transaction type')
    textField(data.state)
    const [assets, currencies] = await Promise.all([this._catalog('asset', false), this._catalog('fiat', false)])
    const cryptoSide = data.type === 'Buy' ? 'output' : 'input'
    const fiatSide = data.type === 'Buy' ? 'input' : 'output'
    return {
      cryptoAsset: transactionCode(assets, 'asset', data[`${cryptoSide}AssetId`], data[`${cryptoSide}Asset`], data[`${cryptoSide}Blockchain`]),
      fiatCurrency: transactionCode(currencies, 'fiat', data[`${fiatSide}AssetId`], data[`${fiatSide}Asset`]),
      status: data.state === 'Completed' ? 'completed' : FAILED_STATES.has(data.state) ? 'failed' : 'in_progress'
    }
  }

  /**
   * Retrieves a list of supported crypto assets from the provider.
   * Includes only assets available for buying or selling with known decimals.
   *
   * @returns {Promise<SupportedCryptoAsset[]>} Tickers, lowercase blockchain names and base-unit decimals.
   * @throws {ProviderError} If the API fails.
   * @throws {ProviderError} If the API returns malformed asset metadata.
   */
  async getSupportedCryptoAssets () {
    const assets = await this._catalog('asset')
    return assets.filter(hasDecimals).map(asset => ({
      code: asset.name,
      networkCode: asset.blockchain.toLowerCase(),
      decimals: assetDecimals(asset),
      name: asset.description || undefined
    }))
  }

  /**
   * Retrieves a list of supported fiat currencies from the provider.
   * Includes only currencies available in either direction with known ISO minor units.
   *
   * @returns {Promise<SupportedFiatCurrency[]>} ISO currency codes and minor-unit decimals.
   * @throws {ProviderError} If the API fails.
   * @throws {ProviderError} If the API returns malformed currency metadata.
   */
  async getSupportedFiatCurrencies () {
    const currencies = await this._catalog('fiat')
    return currencies.filter(currency => fiatDecimals(currency) !== undefined)
      .map(currency => ({ code: currency.name, decimals: fiatDecimals(currency) }))
  }

  /**
   * Retrieves a list of supported countries or regions from the provider.
   * Bank-transfer availability determines both trade direction flags.
   *
   * @returns {Promise<SupportedCountry[]>} Country codes, names and bank availability flags.
   * @throws {ProviderError} If the API fails.
   * @throws {ProviderError} If the API returns malformed country metadata.
   */
  async getSupportedCountries () {
    const countries = await this._client._request('/v1/country')
    if (!Array.isArray(countries)) throw unexpected()
    return countries.map(country => {
      record(country)
      if (typeof country.bankAllowed !== 'boolean') throw unexpected()
      return {
        code: textField(country.symbol),
        name: textField(country.name),
        isBuyAllowed: country.bankAllowed,
        isSellAllowed: country.bankAllowed
      }
    })
  }

  /** @private */
  _hasAccount () {
    return typeof this._account?.sign === 'function'
  }

  /** @private */
  async _accountCall (method, operation, ...args) {
    try {
      return await this._account[operation](...args)
    } catch (cause) {
      if (ACCOUNT_ERRORS[method].includes(cause?.constructor)) throw cause
      throw new ProviderError('DFX account authentication failed', { reason: ProviderErrorReason.UNAUTHORIZED, cause })
    }
  }

  /** @private */
  async #session () {
    if (this.#token) return this.#token
    this.#renewing ??= this._authenticate('detail').then(({ token }) => {
      this.#token = token
      return token
    }).finally(() => { this.#renewing = undefined })
    return this.#renewing
  }

  /**
   * Keeps the DFX account on the smart-account address.
   * The owner address is never submitted. A matching WDK Safe 0.3.0 prediction
   * wraps the typed-data signature as ERC-6492 only where DFX verifies it;
   * otherwise the Safe signature is sent unwrapped.
   *
   * @private
   */
  async #contractSignature (method, message, signature, accountAddress) {
    const signer = recoverEvmAddress(message, signature)
    if (signer === undefined || sameAddress(signer, accountAddress)) return signature
    const chainId = EVM_CHAIN_IDS[this._config.network]
    if (chainId === undefined || typeof this._account.signTypedData !== 'function') return signature
    const safeSignature = await this._accountCall(method, 'signTypedData', safeMessageTypedData(chainId, accountAddress, message))
    if (!ERC6492_NETWORKS.has(this._config.network)) return safeSignature
    return erc6492SafeSignature({ owner: signer, account: accountAddress, signature: safeSignature })
  }

  /** @private */
  async _authenticate (method, address) {
    if (!this._hasAccount()) throw new ProviderError('A signing account is required for transaction details', { reason: ProviderErrorReason.UNAUTHORIZED })
    const accountAddress = address ?? await this._accountCall(method, 'getAddress')
    const evm = EVM_BLOCKCHAINS.has(this._config.network)
    const challenge = record(await this._client._request(`/v1/auth/signMessage?${new URLSearchParams({ address: accountAddress })}`))
    const challengeText = textField(challenge.message)
    if (challengeText !== signInChallenge(this._config.environment, accountAddress)) throw unexpected('Unexpected DFX sign-in challenge')
    let signature = await this._accountCall(method, 'sign', challengeText)
    if (evm) signature = await this.#contractSignature(method, challengeText, signature, accountAddress)
    const body = {
      address: accountAddress,
      signature: normalizeSignature(this._config.network, signature),
      wallet: this._config.wallet,
      blockchain: BLOCKCHAINS.find(chain => chain.toLowerCase() === this._config.network),
      key: this._config.publicKey
    }
    const auth = record(await this._client._request('/v1/auth', { method: 'POST', body: JSON.stringify(body) }))
    return { token: textField(auth.accessToken), address: accountAddress }
  }

  /** @private */
  async _catalog (kind, tradable = true) {
    const rows = await this._client._request(`/v1/${kind}`)
    if (!Array.isArray(rows)) throw unexpected()
    if (!tradable) return rows
    return rows.filter(row => row?.buyable === true || row?.sellable === true).map(row => catalogRow(row, kind))
  }

  /** @private */
  async _trade (direction, options, widget = false) {
    const isFiat = options.fiatAmount !== undefined
    if (isFiat === (options.cryptoAmount !== undefined)) throw new ValueError('Exactly one of fiatAmount and cryptoAmount must be supplied')
    const amount = positiveAmount(isFiat ? options.fiatAmount : options.cryptoAmount)
    optionalString(options.config?.network, 'network')
    const network = options.config?.network?.toLowerCase() ?? this._config.network
    if (widget) {
      if (options.config?.externalTransactionId !== undefined) externalTransactionId(options.config.externalTransactionId)
      if (!this._config.network) throw new ValueError('network must be configured in the constructor to bind the account to a chain')
      if (network !== this._config.network) throw new ValueError('network must match the account network configured in the constructor')
    }
    const [assets, currencies] = await Promise.all([this._catalog('asset'), this._catalog('fiat')])
    const capability = direction === 'buy' ? 'buyable' : 'sellable'
    let matches = assets.filter(asset => asset.name.toLowerCase() === options.cryptoAsset.toLowerCase() && asset[capability] &&
      (network === undefined || asset.blockchain.toLowerCase() === network))
    if (!matches.length) throw new ValueError(`Unsupported ${direction} asset or network: ${options.cryptoAsset}`)
    const networks = [...new Set(matches.map(asset => asset.blockchain.toLowerCase()))]
    if (networks.length === 1) {
      const exact = matches.filter(asset => asset.name === options.cryptoAsset)
      if (exact.length === 1) matches = exact
      if (matches.length > 1) throw new ValueError(`Ambiguous asset spelling ${options.cryptoAsset} on network ${networks[0]}`)
    }
    if (matches.length > 1) throw new ValueError(`Ambiguous asset ${options.cryptoAsset}; configure network: ${networks.join(', ')}`)
    const asset = matches[0]
    if (!hasDecimals(asset)) throw new ValueError(`Missing decimals for ${asset.blockchain}/${asset.name}`)
    const fiatMatches = currencies.filter(currency => fiatDecimals(currency) !== undefined && currency.name.toLowerCase() === options.fiatCurrency.toLowerCase() && currency[capability])
    if (fiatMatches.length > 1) throw new ValueError(`Ambiguous fiat currency: ${options.fiatCurrency}`)
    const currency = fiatMatches[0]
    if (!currency) throw new ValueError(`Unsupported ${direction} fiat currency: ${options.fiatCurrency}`)
    const source = direction === 'buy' ? isFiat : !isFiat
    return {
      asset,
      currency,
      source,
      amount: displayAmount(amount, isFiat ? fiatDecimals(currency) : assetDecimals(asset))
    }
  }

  /** @private */
  async _quote (direction, options) {
    const { asset, currency, source, amount } = await this._trade(direction, options)
    const body = {
      currency: { name: currency.name },
      asset: { id: Number(asset.id) },
      wallet: this._config.wallet,
      specialCode: ''
    }
    if (direction === 'buy') body.paymentMethod = 'Bank'
    const field = source ? 'amount' : 'targetAmount'
    // amount is a validated decimal literal; metadata always uses JSON escaping.
    const json = `${JSON.stringify(body).slice(0, -1)},"${field}":${amount}}`
    const quote = record(await this._client._request(`/v1/${direction}/quote`, { method: 'PUT', body: json, input: true }))
    if (quote.isValid === false) {
      const error = quote.errors?.[0]
      const code = error?.error ?? quote.error
      const limit = source ? error?.limit : error?.limitTarget
      const message = code ? `DFX quote rejected: ${code}${limit == null ? '' : ` (limit: ${limit})`}` : 'Invalid DFX quote without an error code'
      if (INPUT_ERRORS.has(code)) throw new ValueError(message)
      throw unexpected(message)
    }
    if (quote.isValid !== true) throw unexpected('Missing quote validity')
    const buy = direction === 'buy'
    const rate = divideAmounts(buy ? quote.amount : quote.estimatedAmount, buy ? quote.estimatedAmount : quote.amount)
    return {
      cryptoAmount: minorUnits(buy ? quote.estimatedAmount : quote.amount, assetDecimals(asset)),
      fiatAmount: minorUnits(buy ? quote.amount : quote.estimatedAmount, fiatDecimals(currency)),
      fee: minorUnits(buy ? quote.fees?.total : quote.feesTarget?.total, fiatDecimals(currency)),
      rate
    }
  }

  /** @private */
  #validateAddress (options, field, address) {
    if (options[field] !== undefined && !sameAddress(options[field], address)) throw new ValueError(`${field} must match the account address`)
  }

  /** @private */
  async _widget (direction, options) {
    if (!this._hasAccount()) throw new AccountRequiredError('A signing account is required for buy and sell')
    const { asset, currency, source, amount } = await this._trade(direction, options, true)
    const address = await this._accountCall(direction, 'getAddress')
    const field = direction === 'buy' ? 'recipient' : 'refundAddress'
    this.#validateAddress(options, field, address)
    const { token } = await this._authenticate(direction, address)
    const url = new URL(`/${direction}`, this._app)
    url.searchParams.set('session', token)
    url.searchParams.set('lang', this._config.language ?? 'en')
    url.searchParams.set('asset-in', direction === 'buy' ? currency.name : asset.name)
    url.searchParams.set('asset-out', direction === 'buy' ? asset.name : currency.name)
    url.searchParams.set('blockchain', asset.blockchain)
    url.searchParams.set(source ? 'amount-in' : 'amount-out', amount)
    if (options.config?.externalTransactionId !== undefined) url.searchParams.set('external-transaction-id', options.config.externalTransactionId)
    return url.toString()
  }
}

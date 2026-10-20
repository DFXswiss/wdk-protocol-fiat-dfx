/** Configuration for DFX API and widget access. */
export interface DfxProtocolConfig {
    /** API and app environment. Only sandbox selects sandbox; otherwise production is used. */
    environment?: 'production' | 'sandbox';
    /** Partner identifier supplied by the integrating wallet developer. No default. */
    wallet?: string;
    /** Non-empty DFX blockchain name binding the account to its chain, case-insensitively. No default. */
    network?: string;
    /** Public key sent as key during authentication. No default. */
    publicKey?: string;
    /** Widget language code. Defaults to en. */
    language?: string;
    /** HTTP implementation called with globalThis as receiver. Defaults to globalThis.fetch. */
    fetch?: typeof fetch;
    /** Finite positive HTTP request deadline in milliseconds, at most 2147483647 (default: 30,000). */
    timeout?: number | bigint;
}

/** Configuration for a single DFX widget session. */
export interface DfxTradeConfig {
    /** Non-empty DFX blockchain name, compared case-insensitively. Defaults to and must match the constructor network. */
    network?: string;
    /** Wallet-assigned ID, unique per widget opening; 1–256 characters from A-Z, a-z, 0-9, dot, underscore, colon and hyphen. */
    externalTransactionId?: string;
}

/** Per-operation trade configuration. */
export interface DfxTradeOptions {
    /** Account network and wallet-assigned transaction ID for this widget opening. */
    config?: DfxTradeConfig;
}

/** Configuration for a single DFX quote. */
export interface DfxQuoteConfig {
    /** Non-empty DFX blockchain name, compared case-insensitively. Defaults to the constructor network. */
    network?: string;
}

/** Per-operation quote configuration. */
export interface DfxQuoteOptions {
    /** Network selection for this quote, independent of the account network. */
    config?: DfxQuoteConfig;
}

/** Options for a DFX purchase widget session. */
export type DfxBuyOptions = BuyOptions & DfxTradeOptions;
/** Options for a DFX sale widget session. */
export type DfxSellOptions = SellOptions & DfxTradeOptions;
/** Options for an indicative DFX purchase quote. */
export type DfxBuyQuoteOptions = Omit<BuyOptions, 'recipient'> & DfxQuoteOptions;
/** Options for an indicative DFX sale quote. */
export type DfxSellQuoteOptions = Omit<SellOptions, 'refundAddress'> & DfxQuoteOptions;

/** Provides DFX fiat quotes, widget URLs and transaction status. */
export default class DfxProtocol extends FiatProtocol {
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
    constructor(account?: undefined, config?: DfxProtocolConfig);
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
    constructor(readOnlyAccount: IWalletAccountReadOnly, config?: DfxProtocolConfig);
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
    constructor(signingAccount: IWalletAccount, config?: DfxProtocolConfig);
    /**
     * Generates a URL for a user to purchase a crypto asset with fiat currency.
     * Each opening uses a fresh authenticated session.
     * Tickers and networks are case-insensitive; EVM checksum addresses are equivalent.
     * A recovered signer that differs from the account is never used as the DFX account.
     * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
     * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
     * signature is submitted for that same address.
     * The module wraps a Safe signature only when the recovered owner predicts the account with the WDK Safe 0.3.0 parameters and the network is in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis and Plasma), the networks for which the DFX API is intended to verify ERC-6492; otherwise, it sends the Safe signature unwrapped, and an API without ERC-6492 support rejects an undeployed Safe and a wrapped signature from a deployed Safe.
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
    buy(options: DfxBuyOptions): Promise<BuyResult>;
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
    quoteBuy(options: DfxBuyQuoteOptions): Promise<FiatQuote>;
    /**
     * Generates a URL for a user to sell a crypto asset for fiat currency.
     * Each opening uses a fresh authenticated session.
     * Tickers and networks are case-insensitive; EVM checksum addresses are equivalent.
     * A recovered signer that differs from the account is never used as the DFX account.
     * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
     * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
     * signature is submitted for that same address.
     * The module wraps a Safe signature only when the recovered owner predicts the account with the WDK Safe 0.3.0 parameters and the network is in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis and Plasma), the networks for which the DFX API is intended to verify ERC-6492; otherwise, it sends the Safe signature unwrapped, and an API without ERC-6492 support rejects an undeployed Safe and a wrapped signature from a deployed Safe.
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
    sell(options: DfxSellOptions): Promise<SellResult>;
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
    quoteSell(options: DfxSellQuoteOptions): Promise<FiatQuote>;
    /**
     * Retrieves the details of a specific transaction from the provider.
     * Accepts a UID or external ID and renews an expired session once.
     * Parallel detail calls share one sign-in per instance, independently of widgets.
     * A recovered signer that differs from the account is never used as the DFX account.
     * When the recovered signer differs, that account can sign typed data and the constructor network has a DFX chain id,
     * sign-in uses a Safe EIP-712 signature for the account address; otherwise the wallet
     * signature is submitted for that same address.
     * The module wraps a Safe signature only when the recovered owner predicts the account with the WDK Safe 0.3.0 parameters and the network is in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis and Plasma), the networks for which the DFX API is intended to verify ERC-6492; otherwise, it sends the Safe signature unwrapped, and an API without ERC-6492 support rejects an undeployed Safe and a wrapped signature from a deployed Safe.
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
    getTransactionDetail(txId: string, options?: { idType?: 'uid' | 'externalTransactionId' }): Promise<FiatTransactionDetail>;
    /**
     * Retrieves a list of supported crypto assets from the provider.
     * Includes only assets available for buying or selling with known decimals.
     *
     * @returns {Promise<SupportedCryptoAsset[]>} Tickers, lowercase blockchain names and base-unit decimals.
     * @throws {ProviderError} If the API fails.
     * @throws {ProviderError} If the API returns malformed asset metadata.
     */
    getSupportedCryptoAssets(): Promise<SupportedCryptoAsset[]>;
    /**
     * Retrieves a list of supported fiat currencies from the provider.
     * Includes only currencies available in either direction with known ISO minor units.
     *
     * @returns {Promise<SupportedFiatCurrency[]>} ISO currency codes and minor-unit decimals.
     * @throws {ProviderError} If the API fails.
     * @throws {ProviderError} If the API returns malformed currency metadata.
     */
    getSupportedFiatCurrencies(): Promise<SupportedFiatCurrency[]>;
    /**
     * Retrieves a list of supported countries or regions from the provider.
     * Bank-transfer availability determines both trade direction flags.
     *
     * @returns {Promise<SupportedCountry[]>} Country codes, names and bank availability flags.
     * @throws {ProviderError} If the API fails.
     * @throws {ProviderError} If the API returns malformed country metadata.
     */
    getSupportedCountries(): Promise<SupportedCountry[]>;
}
export type IWalletAccount = import("@tetherto/wdk-wallet").IWalletAccount;
export type IWalletAccountReadOnly = import("@tetherto/wdk-wallet").IWalletAccountReadOnly;
export type BuyOptions = import("@tetherto/wdk-wallet/protocols").BuyOptions;
export type BuyResult = import("@tetherto/wdk-wallet/protocols").BuyResult;
export type SellOptions = import("@tetherto/wdk-wallet/protocols").SellOptions;
export type SellResult = import("@tetherto/wdk-wallet/protocols").SellResult;
export type FiatQuote = import("@tetherto/wdk-wallet/protocols").FiatQuote;
export type FiatTransactionDetail = import("@tetherto/wdk-wallet/protocols").FiatTransactionDetail;
export type SupportedCryptoAsset = import("@tetherto/wdk-wallet/protocols").SupportedCryptoAsset;
export type SupportedFiatCurrency = import("@tetherto/wdk-wallet/protocols").SupportedFiatCurrency;
export type SupportedCountry = import("@tetherto/wdk-wallet/protocols").SupportedCountry;
import { FiatProtocol } from "@tetherto/wdk-wallet/protocols";

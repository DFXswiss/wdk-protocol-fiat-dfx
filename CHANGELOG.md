# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - Unreleased

### Added

- Reject unknown `environment` values with `ValueError` instead of selecting production.
- All eight WDK fiat methods for the DFX production, sandbox and local environments.
- Support a local DFX API and widget through `environment: 'local'` and required loopback origins, with the `[loc]_` sign-in challenge prefix.
- Reject a DFX sign-in challenge unless it is exactly the environment prefix, the fixed DFX ownership sentence, and the address sent in the request. Production uses an empty prefix; sandbox uses `[dev]_`. A mismatch is rejected before the account signs and before `POST /v1/auth`.
- Re-export FiatProtocol, WDK error classes, ProviderErrorReason, BuyErrorReason, SellErrorReason, IFiatProtocol and wallet account types; provide dedicated network-only quote option types. Declarations under `types/` are maintained by hand.
- Optional wallet-assigned `externalTransactionId` for buy and sell widget URLs and for lookup via `getTransactionDetail(id, { idType: 'externalTransactionId' })`. Ids are 1–256 ASCII letters, digits, dots, underscores, colons and hyphens.
- Indicative buy and sell quotes with lossless response parsing, exact base units, and effective fiat-per-crypto rates that divide unrounded response amounts, including fees, and round half up to 18 significant digits.
- Authenticated widget URLs with account network binding and both amount modes. Widget URLs carry the session token and are not persisted by the module.
- One detail session per instance. Parallel detail calls share sign-in and renewal. A transaction-detail HTTP 401 retries once and invalidates only the rejected token. `buy` and `sell` sign in on every call and do not change the detail session. A failed widget login leaves the detail token intact.
- Live catalogs, ISO fiat minor units and typed WDK errors. `Completed` maps to `completed`. `Failed`, `Returned` and `Stopped` map to `failed`. Every other DFX state, including `LimitExceeded`, `FeeTooHigh` and `PriceUndeterminable`, maps to `in_progress`: `LimitExceeded` while the compliance check is pending, and `FeeTooHigh` and `PriceUndeterminable` after it has passed, while the order waits for a lower network fee or a valid price; none of the three is a final state.
- API decimals are required. Assets without them are omitted from supported lists and rejected by quote and trade methods. Names and networks compare case-insensitively; outgoing requests keep DFX spelling. Inactive catalog rows are filtered before validation; historical rows resolve from the unfiltered catalogs. ISO fiat minor units resolve by exact uppercase catalog names. A unique exact asset spelling wins a collision on one network; multiple matching fiat rows fail. Null and empty asset descriptions are an undefined display name. EVM address comparisons accept checksum case differences. Future blockchain names are non-empty strings without whitespace, control or format characters.
- EVM smart accounts sign in as the account address. When the recovered signer differs and the network has a DFX chain id, authentication sends a Safe EIP-712 signature. A delivery override must match the account address before signing. A matching WDK Safe 0.3.0 prediction wraps that signature as ERC-6492 only on networks in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis and Plasma). Citrea and CitreaTestnet receive the unwrapped Safe signature. A failed self-check sends the unwrapped signature.
- Recognized Solana hex signatures are normalized to Base58 and Spark DER-hex signatures to compact hex, without reading keys.
- Authentication HTTP 401, and HTTP 400 with exactly `Invalid signature`, map to `UNAUTHORIZED`. Other authentication HTTP 400 responses stay internal provider errors. Non-empty error-message arrays join with `'; '` when every element is a non-empty string.
- Trust declared argument and account return types; retain value rules and external API response validation. Account-error allowlists require exact constructors. Transaction details pass through only ProviderRequiredError and ProviderError from account operations. Injected and ambient fetch are bound to the global receiver.
- Timeouts must be finite, positive and at most 2147483647 ms, including bigint values. Empty or whitespace-only string options and per-operation networks are rejected.
- Depend on `@tetherto/wdk-wallet` `^1.0.0-beta.17`. Node.js 22 or newer is required. CI runs the lint, type, coverage and audit jobs listed in CONTRIBUTING.md.
- Local replay integration tests cover catalogs, quotes and authenticated URLs and details with deterministic WDK EVM accounts. The coverage gate includes unit and integration execution and requires 100% statements, branches, functions and lines.
- Configuration, security, compatibility and sandbox example documentation. Probes under `e2e/` can create sandbox users when they sign in.

### Known limitations

- Assets without API decimals, and ambiguous tickers without a network, are rejected.
- A smart account that is not deployed yet can sign in only through the ERC-6492 wrapper when the owner predicts the account with the WDK Safe 0.3.0 parameters. The module wraps Safe signatures only on networks in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis and Plasma), for which the DFX API is intended to verify ERC-6492; an API without ERC-6492 support rejects an undeployed Safe and a wrapped signature from a deployed Safe. Otherwise, and on Citrea and CitreaTestnet, it can sign in only after its contract is deployed. In every case one owner signature must meet the contract threshold. Haqq is forwarded without a Safe signature because DFX publishes no chain id for it.
- Amounts outside the API's conservative numeric precision boundary are rejected.
- Rate-limit and account-state error reasons are provisional pending WDK agreement.

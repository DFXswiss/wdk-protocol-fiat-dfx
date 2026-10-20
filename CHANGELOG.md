# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - Unreleased

### Added

- Reject a DFX sign-in challenge unless it is exactly the environment prefix,
  the fixed DFX ownership sentence, and the address sent in the request.
  Production uses an empty prefix; sandbox uses `[dev]_`. A mismatch is rejected
  before the account signs and before `POST /v1/auth`.
- Re-export FiatProtocol, WDK error classes, ProviderErrorReason, BuyErrorReason,
  SellErrorReason and wallet account types;
  provide dedicated network-only quote option types.
- Optional wallet-assigned `externalTransactionId` for buy/sell widget URLs and
  transaction lookup via `getTransactionDetail(id, { idType: 'externalTransactionId' })`.
- Order-tracking timing and sandbox account compatibility documentation.
- All eight WDK fiat methods for DFX production and sandbox environments.
- Indicative buy and sell quotes with lossless response parsing and exact base units.
- Authenticated widget URLs with account network binding and both amount modes.
- Instance-local session handling and one renewal on transaction-detail HTTP 401.
- Live catalogs, ISO fiat minor units, typed WDK errors and transaction status mapping.
- Manually maintained declarations, injected-fetch tests and 100% coverage thresholds.
- Configuration, security, compatibility and sandbox example documentation.
- Local replay integration tests for catalogs, quotes and authenticated URLs/details,
  using deterministic WDK EVM accounts without an external account module.
  The coverage gate includes both unit and integration execution.

### Changed

- Wrap a Safe EIP-712 sign-in signature as ERC-6492 when the recovered owner
  predicts the account with the WDK Safe 0.3.0 init parameters. An undeployed
  Safe can sign in once the DFX API verifies ERC-6492. A failed self-check,
  including `onChainIdentifier` or another abstractionkit configuration, sends
  the unwrapped Safe signature. DFX verifies ERC-6492 only on Ethereum, Sepolia,
  BinanceSmartChain, Optimism, Arbitrum, Polygon, Base and Gnosis. Citrea and
  CitreaTestnet receive the unwrapped Safe signature: a wrapper there would be
  rejected even for a deployed Safe, while ERC-1271 still accepts the unwrapped
  signature.
- Sign EVM smart accounts in as the account address. When the recovered signer
  differs, `signTypedData` is available and the constructor network has a DFX
  chain id, authentication sends a Safe EIP-712 signature instead of the owner
  recovery. Delivery overrides
  must still match the account address before signing.
- Require API-provided crypto-asset decimals; assets without them are omitted
  from supported lists and rejected by quote and trade methods.
- Widen the `@tetherto/wdk-wallet` dependency range to `^1.0.0-beta.17` so it
  includes the version pinned by `@tetherto/wdk-wallet-evm` and avoids duplicates.

- Accept bigint HTTP timeouts, clarify API documentation and strengthen deadline callback tests.

- Move stateful session scenarios to the local replay integration
  suite with real WDK EVM signatures, deterministic accounts and per-test resets.
  Compare complete catalogs with an independently supplied expectation fixture.
- Clarify DFX option and account-error documentation, mirror it in the maintained
  declarations and use explicit unit-test expectations for decimals and encoding.

- Follow C005 by trusting declared argument and account return types; retain value rules and external API response validation.
- Normalize null asset descriptions to undefined and align JSDoc with the
  manually maintained declarations and parent method descriptions.
- Clarify transaction-detail network requirements and unsupported signing formats.
- Document heuristic payment matching, wallet waiting deadlines, unique IDs per
  widget opening and newest-transaction lookup within a reused widget session.
- Record successful sandbox authentication with WDK EVM, Tron, Solana, Spark and
  Bitcoin packages, including the completed Solana/Spark retest.
- Package ownership and repository metadata now identify DFX AG.
- CI runs coverage gates; release publishing uses the Holepunch OIDC action.
- Effective fiat-per-crypto rates now divide unrounded response amounts, including
  fees, and round half up to 18 significant digits instead of using DFX's rounded rate.
- Asset/currency names and networks compare case-insensitively; outgoing requests
  retain DFX spelling. EVM address comparisons accept checksum case differences.
- Account error allowlists require exact constructors; transaction details pass
  through only ProviderRequiredError and ProviderError from account operations.
- Declare Node.js ≥ 22 and document testing on Node.js 22.22.0 (CI) and Bare, the CI coverage gate, known limitations
  and permanent sandbox user creation by `tests/integration/record.js` and authenticated `e2e/` probes.

### Fixed

- Share one detail session per instance: parallel detail calls share initial
  sign-in and renewal, and delayed HTTP 401 responses reuse the current token.
  `buy` and `sell` still sign in afresh without changing the detail session.
- Invalidate only the token rejected by a transaction-detail HTTP 401, including
  the single retry. Instances handle parallel calls without discarding a newer
  session. Each detail call retries at most once, even if multiple token
  generations have passed while its first response was pending.
- Use fixed address and signature vectors in integration expectations and check
  error class, message and reason through the shared assertion helper.
- Preserve replay registrations when switching authentication faults and return
  HTTP 401 with Invalid credentials for registered addresses, or HTTP 400 with
  Invalid signature for unregistered addresses, for the unauthorized fault.
- Fail lifecycle simulations when the backend has not reached the required payout
  boundary; validate prepared seed ownership and clarify owner-only file permissions.

- A failed widget login leaves the detail token intact.
- Treat empty asset descriptions like null, returning an undefined display name.
- Normalize recognized Solana hex signatures to Base58 and Spark DER-hex signatures
  to compact hex for authentication, without accessing keys or adding dependencies.
- Restrict external transaction IDs to 1–256 ASCII letters, digits, dots,
  underscores, colons and hyphens for both buy/sell URLs and detail lookup;
  invalid-ID errors identify the selected ID type.
- Map authentication POST HTTP 401 and HTTP 400 with exactly `Invalid signature`
  to `UNAUTHORIZED`; other authentication 400 responses remain internal provider
  errors with their backend message.
- Join non-empty error-message arrays with `'; '` across all endpoints when every
  element is a non-empty string after parsing, including JSON numbers parsed as
  strings. Empty strings or other element types make the entire array fall back
  to `DFX HTTP <status>`.
- Bind injected and ambient fetch to the global receiver.
- Reject non-finite or non-positive timeouts and empty or whitespace-only string options with ValueError.
- Reject timeouts above 2147483647 ms and empty or whitespace-only per-operation networks.
- Prefer a unique exact spelling for asset collisions on one network; reject
  unresolved asset ambiguity and multiple matching fiat catalog rows.
- Resolve ISO fiat minor units by exact uppercase catalog names; exclude rows
  without a table entry while matching user input case-insensitively.
- Filter inactive catalog rows before validation; resolve historical rows from
  unfiltered catalogs and validate only the matched entries.
- Accept future blockchain names as non-empty strings without whitespace, control or format characters.
- Cover ProviderError subclasses from account operations with transaction-detail wrapping tests.
- Re-export IFiatProtocol as a declaration value; maintain updated declarations by hand.
- Remove per-token suffix slicing from JSON number parsing.
- Replace BigInt-unsafe test titles and test-body loops; expand regression cases.
- Format fiat minor-unit entries individually for Standard lint.

### Known limitations

- Assets without API decimals, and ambiguous tickers without a network, are rejected.
- A smart account that is not deployed yet can sign in only through the
  ERC-6492 wrapper: on the networks where DFX verifies ERC-6492, and only when
  the owner predicts the account with the WDK Safe 0.3.0 parameters. Otherwise,
  and on Citrea and CitreaTestnet, it can sign in only after its contract is
  deployed. In every case one owner signature must meet the contract threshold.
  Haqq and Plasma are forwarded without a Safe signature because DFX publishes
  no chain id for them.
- Amounts outside the API's conservative numeric precision boundary are rejected.
- Rate-limit and account-state error reasons are provisional pending WDK agreement.

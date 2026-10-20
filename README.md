# @dfx.swiss/wdk-protocol-fiat-dfx

[![Powered by WDK](https://img.shields.io/badge/Powered%20by-WDK-26A17B)](https://wdk.tether.io)

DFX on- and off-ramping for WDK wallets. `DfxProtocol` provides indicative quotes,
authenticated DFX purchase and sale widget URLs, supported asset/currency/country
lists, and normalized transaction status. The user completes payment and any KYC
in the DFX widget; this module does not execute trades or hold funds.

## Compatibility

Implements `IFiatProtocol` by extending `FiatProtocol` from
`@tetherto/wdk-wallet`; tested against `1.0.0-beta.17`, with declared dependency range `^1.0.0-beta.17` (not a tested compatibility matrix). Version `1.0.0-beta.15` does not load because `ProviderError` is missing from `@tetherto/wdk-wallet/protocols`.

ES modules. Tested on Node.js 22.22.0 (CI) and Bare. The Bare entry point
loads `bare-node-runtime/global`. HTTP uses `fetch` or an injected implementation.
The module receives a WDK account from its caller and does not depend directly on
`@tetherto/wdk` or any specific chain wallet package. Use one installed copy of
`@tetherto/wdk-wallet` throughout the wallet application.

## Install and quick start

```sh
npm install @dfx.swiss/wdk-protocol-fiat-dfx
```

This account-free example can run as an ES module in Node.js. Quotes are indicative:
they do not authenticate, reserve funds or create a transaction.

```js
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const dfx = new DfxProtocol(undefined, { environment: 'sandbox' })
const assets = await dfx.getSupportedCryptoAssets()
const currencies = await dfx.getSupportedFiatCurrencies()
const countries = await dfx.getSupportedCountries()
const quote = await dfx.quoteBuy({
  cryptoAsset: 'ETH',
  fiatCurrency: 'EUR',
  fiatAmount: 10000n,
  config: { network: 'ethereum' }
})
// Display these values in the application; quote amounts are bigint base units.
export { assets, currencies, countries, quote }
```

With an existing signing WDK account bound to Ethereum:

```js
const dfx = new DfxProtocol(account, {
  environment: 'sandbox',
  network: 'ethereum',
  wallet: 'YourWalletName'
})
const { buyUrl } = await dfx.buy({
  cryptoAsset: 'ETH', fiatCurrency: 'EUR', fiatAmount: 10000n
})
const { sellUrl } = await dfx.sell({
  cryptoAsset: 'ETH', fiatCurrency: 'EUR', cryptoAmount: 50000000000000000n
})
// Open buyUrl or sellUrl in the wallet's user-facing browser.
// Supply a DFX transaction UID received from the DFX flow, not an internal ID:
const detail = await dfx.getTransactionDetail(transactionUid)
```

The source checkout also contains [examples/buy.js](examples/buy.js), which runs a
sandbox quote by default. Its account is explicitly a placeholder: substitute a
real WDK account to generate an authenticated URL. No private keys are embedded.

## Configuration

Use `new DfxProtocol(account?, config?)`. Configuration belongs to the instance;
the library never reads environment variables. `.env.example` is for
`examples/buy.js` and the optional `e2e/` probes. The local integration tests need
no user-supplied environment variables and run in `npm run test:coverage`.

| Option | Default | Meaning |
| --- | --- | --- |
| `environment` | `'production'` | Only `'sandbox'` selects sandbox; otherwise production is used |
| `wallet` | unset | Partner identifier supplied by the integrating wallet developer; forwarded to both quotes and authentication |
| `network` | unset | Account's DFX blockchain name, compared case-insensitively; required for `buy` and `sell` |
| `publicKey` | unset | Public key sent as `key` during authentication (e.g. Arweave, Cardano, Internet Computer) |
| `language` | `'en'` | Widget `lang` value |
| `fetch` | `globalThis.fetch` | Injectable HTTP implementation called with `globalThis` as receiver; defaults to the runtime's global implementation |
| `timeout` | `30000` | Positive `number` or `bigint`, at most `2147483647`; request deadline in milliseconds, implemented with `AbortController` |

Argument types follow the declarations and are assumed correct at runtime.
When supplied, `network`, `wallet`, `publicKey` and `language` must not be empty
or whitespace-only; these values and out-of-range timeouts throw `ValueError`
in the constructor. All four trading methods also reject an empty or
whitespace-only `options.config.network` with `ValueError`.
For `buy` and `sell`, `options.config.externalTransactionId` optionally supplies a
string matching `^[A-Za-z0-9._:-]{1,256}$`. The same validation applies to external
ID lookups; invalid values throw `ValueError`.
It is appended as `external-transaction-id` after the existing widget parameters.

Production uses `https://api.dfx.swiss` and `https://app.dfx.swiss`.
Sandbox uses `https://dev.api.dfx.swiss` and `https://dev.app.dfx.swiss`.
The supplied fetch implementation must support abort signals, including response
body reads.

`options.config.network` selects the network for a trade. Quotes use it in
preference to the constructor network. For widget URLs it must equal the
constructor network case-insensitively; the caller is responsible for binding the actual account to
that network. Authentication forwards its matching PascalCase DFX blockchain
enum value; an unknown network has no `blockchain` auth field. The module never
reads account key material. `getAddress()`, `sign(message)` and, for a differing
EVM signer on a known chain id, `signTypedData` are the account operations used.

## Methods and units

| Method | Result | Account |
| --- | --- | --- |
| `getSupportedCryptoAssets()` | `{ code, networkCode, decimals, name? }[]` | None |
| `getSupportedFiatCurrencies()` | `{ code, decimals }[]` | None |
| `getSupportedCountries()` | `{ code, name, isBuyAllowed, isSellAllowed }[]` | None |
| `quoteBuy(options)` | `FiatQuote` | None |
| `quoteSell(options)` | `FiatQuote` | None |
| `buy(options)` | `{ buyUrl }` | Signing account |
| `sell(options)` | `{ sellUrl }` | Signing account |
| `getTransactionDetail(txId, options?)` | `{ cryptoAsset, fiatCurrency, status }` | Authenticated session; signing account to obtain or renew it |

Both trade directions take `cryptoAsset`, `fiatCurrency`, and **exactly one** of
`cryptoAmount` and `fiatAmount`. Inputs accept positive `bigint` or positive safe
integer `number` values in the smallest unit. Fractions, zero, negative numbers,
unsafe integers, NaN and infinity are rejected. For EUR/CHF, `10000n` is 100.00;
for an 18-decimal asset, `50000000000000000n` is 0.05.

| Direction | Specified amount | Quote request | Widget query |
| --- | --- | --- | --- |
| Buy | Fiat | `amount` | `amount-in` |
| Buy | Crypto | `targetAmount` | `amount-out` |
| Sell | Crypto | `amount` | `amount-in` |
| Sell | Fiat | `targetAmount` | `amount-out` |

Responses are read as text and JSON numeric literals are preserved as strings
before decimal arithmetic. `cryptoAmount`, `fiatAmount`, and `fee` in a quote are
`bigint` in smallest units. Fractional smallest units in provider responses are
rejected, never rounded. Requests use exact decimal literals; an amount whose
normalized decimal representation changes through `Number` is rejected.
This restriction also applies to widget amounts.

`fee` is **fiat**, from `fees.total` on buys and `feesTarget.total` on sells, scaled
to the smallest fiat unit. It includes the provider's reported aggregate fee;
`feeAmount` and `exchangeRate` are not used. `rate` is the effective **fiat per
crypto** rate including fees, calculated from the unrounded decimal strings of
the response amounts in display units: buy `amount / estimatedAmount`, sell
`estimatedAmount / amount`. It is rounded once, half up to 18 significant digits,
and returned as a string without an exponent. For example, buying 114.32 USDT for
100 CHF gives `"0.874737578726382085"`. DFX's already rounded `rate` field is ignored.
Nonpositive response amounts cause `ProviderError(INTERNAL_SERVER_ERROR)`.
`isValid` is checked before inspecting amounts or calculating the rate.

`buy` and `sell` do not request a quote or check provider amount limits. They
validate inputs, resolve the pair for the direction, authenticate freshly and
build the widget URL. A prior quote can surface limits before opening the widget;
only confirmation in the widget is binding. `recipient` and `refundAddress`
default to the account address. Explicit overrides must match that address. The
check happens before authentication, without a signature or authentication
request for a mismatching override.
If both addresses match `0x` followed by exactly
40 hexadecimal digits, comparison ignores letter case to accept EVM checksum
spelling. All other addresses must match exactly.

## Networks, currencies and countries

The authoritative supported list comes live from the DFX API; it is not a static
chain allowlist. Crypto `code` is the asset's ticker (`name`), not `uniqueName`.
Input tickers and fiat currency names are compared case-insensitively (`USDt`
matches `USDT`). Quote bodies and widget URLs preserve the resolved DFX spelling.
`networkCode = blockchain.toLowerCase()`. The widget uses the original
blockchain value. This covers DFX networks with complete asset
metadata, not only EVM chains.

Assets without API `decimals` are excluded from supported lists and cannot be
quoted or traded. In the recorded sandbox catalog this includes Bitcoin/BTC,
Lightning/BTC and Arkade/BTC; Firo/FIRO has API `decimals: 8`. The production
API returned `decimals: null` for all four in the production catalog recorded on 2026-10-02 (`b5cafa1`). Production was not fetched again on this branch. An API value is authoritative,
including zero.

A ticker can occur on multiple networks. Without a network, ambiguous tickers
throw `ValueError` listing the candidate networks. Lists include assets and
currencies that are buyable **or** sellable. Each trading method additionally
requires availability in its own direction. Fiat minor units come from the
module's ISO 4217 table, keyed by exact uppercase catalog names; currencies without
an exact table entry are excluded from lists and trade selection.
Rows with neither `buyable === true` nor `sellable === true` are discarded before
validation. Tradable rows remain strictly validated; malformed metadata is a
provider error rather than a silently omitted trading asset.
For case-insensitive asset collisions on the same network,
a unique exact spelling wins; otherwise the trade fails with `ValueError`.
Multiple matching fiat catalog rows fail with `ValueError`, including duplicate
rows with the same uppercase ISO name.

Country availability uses `bankAllowed` for **both** directions. Treating this
nondirectional flag as buy and sell availability is an assumption; `cardAllowed`
and the IP-related `locationAllowed` are not substituted. The module has no country
selection argument; provider geography restrictions can still reject a request.

## Transaction states and timing

`txId` defaults to DFX `uid`, even if it looks numeric. Pass
`{ idType: 'externalTransactionId' }` to query `external-id` instead.
The optional second argument has an `idType` of `'uid'` or
`'externalTransactionId'`, defaulting to `'uid'`. Empty or whitespace-only UIDs
and external IDs outside the documented character and length limits throw `ValueError`.
Asset and fiat IDs
resolve against their respective unfiltered catalogs, including inactive entries;
only matched rows are strictly validated. Unambiguous catalog names are a
fallback; contradictory or unresolved metadata fails explicitly. Swap and Referral
transactions are outside this fiat interface.

| DFX state | WDK status |
| --- | --- |
| `Completed` | `completed` |
| `Failed`, `Returned`, `Stopped`, `LimitExceeded`, `FeeTooHigh`, `PriceUndeterminable` | `failed` |
| `Created`, `Processing`, `LiquidityPending`, `CheckPending`, `KycRequired`, `PayoutInProgress`, `WaitingForPayment`, `Unassigned`, `ReturnPending` | `in_progress` |
| Any unknown state | `in_progress` |

DFX's flow uses a bank transfer and payment reference. A transaction can remain
`in_progress` while awaiting the incoming payment; completion time is not guaranteed.

A shared detail-session token is kept only in private instance memory. Parallel
detail calls share one sign-in, including renewal after HTTP 401. A delayed 401
reuses a newer token when one is already available. Each call retries only once; a second
401 is returned as `ProviderError` with `UNAUTHORIZED`, and the rejected token is
discarded if it is still current. Even a call two token generations behind spends
its single retry on the current token, which may itself have expired.
`buy` and `sell` always sign in afresh and leave the detail session untouched,
including when their sign-in fails. Supported lists and quotes need no signature; details do.

### Tracking a transaction

The wallet assigns and persists an ID unique to each widget opening, using only
1–256 ASCII letters, digits, dots, underscores, colons or hyphens
(`^[A-Za-z0-9._:-]{1,256}$`). Pass it to `buy` or `sell` and reuse it for queries:

```javascript
const id = 'wallet-order-2026-09-24-001' // Create a unique ID for each widget opening.
const { buyUrl } = await dfx.buy({
  cryptoAsset: 'ETH',
  fiatCurrency: 'EUR',
  fiatAmount: 10000n,
  config: { externalTransactionId: id }
})
// Open buyUrl in the wallet's browser flow. Later:
const detail = await dfx.getTransactionDetail(id, { idType: 'externalTransactionId' })
```

The same `config.externalTransactionId` applies to `sell`. DFX heuristically
matches an incoming payment to a request: the amount must be within ±1%, the
route, source and destination must match, and the request must be at most seven
days old. If several requests match, DFX prioritizes `WaitingForPayment` over
`Created` (requests confirmed in the widget first), then an exact amount over a
match within ±1%, and only then the newest request. A different amount or late
payment can mean that the ID never receives a transaction. The wallet should
stop waiting after its own deadline.

Queries throw `NoSuchElementError` until a transaction is associated with the ID.
Multiple orders in the same widget session can carry the same ID; lookup then
returns the newest transaction (`id DESC`). A newer Swap with the same ID can
therefore hide an older purchase or sale: lookup throws `NoSuchElementError`
even though that purchase or sale exists. Use a unique ID for each widget opening;
do not reuse it for another opening. Receiving a widget URL does not establish an order.

## Errors

`FiatProtocol`, error classes and their reason enums are re-exported from this module with
the same identity as the WDK classes used internally:

```js
import {
  AccountRequiredError, ValueError, ProviderError, ProviderRequiredError,
  BuyError, SellError, MaximumFeeExceededError, NoSuchElementError,
  ProviderErrorReason, BuyErrorReason, SellErrorReason
} from '@dfx.swiss/wdk-protocol-fiat-dfx'
```

| Class | Use |
| --- | --- |
| `ValueError` | Invalid configuration, pair, network, amount, address override, UID or external ID; input-related quote errors |
| `AccountRequiredError` | `buy`/`sell` without a signing account |
| `NoSuchElementError` | Transaction detail 404, or a Swap/Referral transaction |
| `ProviderError` | HTTP, transport, timeout, authentication and malformed response failures |
| `ProviderRequiredError` | Not generated by this module: direct API access has no provider callback; may pass through from an account where the method contract permits it |
| `MaximumFeeExceededError` | Not generated: no max-fee option; may pass through from an account on `buy`/`sell` |
| `ReadOnlyAccountRequiredError` | Not generated: quotes are public; account-thrown instances are wrapped, including on widget calls |
| `BuyError` | Not generated: its only reason is `INSUFFICIENT_FUNDS`, which URL generation cannot determine; may pass through from an account on `buy` |
| `SellError` | Not generated for the same reason; may pass through from an account on `sell` |

Only account errors whose `constructor` exactly equals a listed class pass through:

| Method | Exact account error constructors passed through |
| --- | --- |
| `buy` | `AccountRequiredError`, `ValueError`, `ProviderRequiredError`, `ProviderError`, `BuyError`, `MaximumFeeExceededError` |
| `sell` | `AccountRequiredError`, `ValueError`, `ProviderRequiredError`, `ProviderError`, `SellError`, `MaximumFeeExceededError` |
| `getTransactionDetail` | `ProviderRequiredError`, `ProviderError` |

Subclasses are not implicitly allowed. In particular, account-thrown `ValueError`
and `NoSuchElementError` on transaction details are wrapped, so they cannot be
misread as an invalid UID or missing order.
Other failures thrown by `getAddress()`, `sign()` or `signTypedData()` become
`ProviderError(UNAUTHORIZED)` with the original error as `cause`.

| HTTP / failure | Mapping |
| --- | --- |
| Detail endpoint 404 | `NoSuchElementError` |
| Quote or detail 400 / 422 attributable to caller input | `ValueError` |
| `POST /v1/auth` 401, or 400 with message exactly `Invalid signature` | `ProviderError(UNAUTHORIZED)`; backend message preserved |
| Other `POST /v1/auth` 400 | `ProviderError(INTERNAL_SERVER_ERROR)`; backend message preserved |
| Supported-list or unattributable 400 / 422; authentication 422 | `ProviderError(INTERNAL_SERVER_ERROR)` |
| 401 | `ProviderError(UNAUTHORIZED)` |
| 403, including authentication geo-filter | `ProviderError(FORBIDDEN)`; provider message preserved |
| 408 or abort deadline | `ProviderError(REQUEST_TIMEOUT)` |
| 429 | `ProviderError(INTERNAL_SERVER_ERROR)` — provisional rate-limit mapping |
| 5xx, other 404, all other unsuccessful statuses | `ProviderError(INTERNAL_SERVER_ERROR)` |
| Connection or body transport failure | `ProviderError(NETWORK_ERROR)` |
| Invalid JSON or unexpected response structure | `ProviderError(INTERNAL_SERVER_ERROR)` |

HTTP 400/422 is attributed to input only for recognized input codes or explicit
validation messages naming the quote fields or transaction UID. Unknown HTTP
validation failures remain provider errors.
For all endpoints, non-empty error-response `message` arrays are joined with
`'; '` only when every element is a non-empty string after parsing. JSON numbers
are parsed as strings and included. An empty string or any other element type
causes the entire array to fall back to `DFX HTTP <status>`.

For `isValid: false`, the first structured error takes precedence over deprecated
`error`. `AmountTooLow`, `AmountTooHigh`, `PaymentMethodNotAllowed`,
`IbanCurrencyMismatch`, `AssetUnsupported`, and `CurrencyUnsupported` map to
`ValueError`, with the corresponding source/target limit when provided.
KYC, bank setup, account limits, unconfirmed email and other account-state errors
use `INTERNAL_SERVER_ERROR` provisionally. Missing or unknown error codes use the
same fallback.

## Known limitations

- Sandbox checks on 2026-09-24 used the WDK wallet packages for EVM
  (`@tetherto/wdk-wallet-evm`, seven chains), Tron (`@tetherto/wdk-wallet-tron`),
  Solana (`@tetherto/wdk-wallet-solana`), Spark (`@tetherto/wdk-wallet-spark`) and
  Bitcoin (`@tetherto/wdk-wallet-btc`, tested with BIP-84). Authentication succeeded for all of them,
  including the Solana/Spark retest. Each reached authenticated transaction lookup
  (404 / `NoSuchElementError`); all except Bitcoin also obtained a valid widget
  session (`/v2/user` 200). Solana's 64-byte hex signature is converted to Base58,
  and Spark's DER-hex signature to compact hex, using only the constructor network
  and recognized formats; other signatures pass through unchanged.
- ERC-4337 accounts (`@tetherto/wdk-wallet-evm-erc-4337`) sign in as the address
  returned by `getAddress()`. That address is the DFX account, the recipient and
  the refund address. The module never submits the recovered owner. On Ethereum,
  Sepolia, BinanceSmartChain, Optimism, Arbitrum, Polygon, Base, Gnosis, Citrea
  and CitreaTestnet, a personal signature that recovers to a different address is
  replaced with a Safe EIP-712 `SafeMessage` when the account implements
  `signTypedData`. When the recovered owner predicts that same account with the
  WDK Safe 0.3.0 parameters (no `onChainIdentifier`), the module wraps the Safe
  signature as ERC-6492. The module wraps Safe signatures only on networks in
  `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum,
  Polygon, Base and Gnosis), for which the DFX API is intended to verify
  ERC-6492; an API without ERC-6492 support rejects an undeployed Safe and a
  wrapped signature from a deployed Safe. A Safe that is not deployed yet can
  sign in once the DFX API verifies ERC-6492; a deployed Safe is still checked
  with ERC-1271.
  If the prediction does not match — a wallet `onChainIdentifier`, or another
  abstractionkit version — the module sends the Safe signature unwrapped. A
  deployed Safe can still pass ERC-1271. A Safe with no code is rejected.
  Haqq and Plasma have no chain id in that configuration, so the wallet
  signature is forwarded and DFX decides. Accounts without `signTypedData` keep
  the wallet signature on the account address. Without a constructor `network`,
  no Safe signature is built. EOA accounts still need one signature.
  Unrecoverable signatures are forwarded unchanged with the account address.
- Bitcoin authentication is sandbox-verified. Bitcoin/BTC, Lightning/BTC and
  Arkade/BTC remain excluded from the recorded sandbox catalog until the API
  supplies `decimals`; sandbox Firo/FIRO supplies `8`. In the production catalog recorded on 2026-10-02 (`b5cafa1`), production
  returned `decimals: null` for all four. Production was not fetched again on this branch.
- Ambiguous tickers without a network are rejected.
- HTTP 429 and account-state failures provisionally map to `INTERNAL_SERVER_ERROR`.
- A `recipient` or `refundAddress` differing from the account address is rejected.
- Request and widget amounts are limited to decimal values that `Number` carries
  without loss.
- `networkCode` is `blockchain.toLowerCase()`; no chain aliases are translated.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. No logging or
telemetry is implemented. Private keys and seeds are never read. `sign` is called
only when the DFX challenge equals the expected text for the selected environment
and the exact address sent in `?address=`, including the sandbox `[dev]_` prefix.
When the recovered signer differs, `signTypedData` is available and the
constructor network has a known chain id, the account also signs Safe EIP-712
typed data whose `SafeMessage` bytes are the EIP-191 hash of that message.
A matching WDK Safe prediction wraps that signature as ERC-6492 only on networks
in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum,
Polygon, Base and Gnosis), for which the DFX API is intended to verify ERC-6492;
an API without ERC-6492 support rejects an undeployed Safe and a wrapped
signature from a deployed Safe. Citrea and CitreaTestnet receive the unwrapped
Safe signature.

Widget URLs contain a bearer session token: deliver them only to the user-facing
browser and do not log or share them. Tokens are not persisted by the module.
The integrating wallet controls signing consent, account/network binding and the
lifetime of its instance. Supply only a **public** key in `publicKey` when needed.

## Development and verification

```sh
npm install && npm run lint && npm run test:coverage
```

Tests route injected fetch calls by HTTP method and URL. Coverage thresholds are
100% statements, branches, functions and lines across `src/`, enforced as a
CI gate. The coverage threshold applies to the combined unit and integration
suites because scenarios that build state across successive public calls belong
in the integration suite (R3); parallel calls to the same method in one Act belong
in unit tests. Type declarations are maintained manually;
do not regenerate them with `build:types`.

Local integration tests in `tests/integration/*.test.js` are excluded from
the default unit-test run (`npm test`) and included in `npm run test:coverage`.
For the integration project only, Jest starts a local HTTP server on a free
loopback port and stops it in global teardown. Injected fetch redirects sandbox
API URLs to that server; no external network or user environment variables are
needed. Tests cover three catalogs, four quotes, authenticated widget URLs,
unknown transaction IDs, smart-account sign-in, early delivery-address
rejection and session reuse and renewal.

```sh
npm run test:integration
```

The server replays raw sandbox responses from
`tests/integration/fixtures/sandbox.json`; its `recordedAt` field is the UTC
recording date. **Recorded on 2026-09-28.** The fixture preserves decimal JSON tokens
without parsing and reserializing response numbers. USDT on Ethereum and CHF are
tested with `10000n` fiat minor units or `100000000n` crypto minor units.
Authenticated tests derive accounts at indexes 0 and 1 from the public BIP-39 test
phrase in Tether's testing conventions and sign locally. The server verifies
EIP-191 signatures against the last issued challenge. Challenges, local session
tokens and request history reset before every test; successive logins produce
distinct local tokens. Explicit fault probes reject authentication, omit an access
token or expire a session. These probes are not recorded successful API responses.
Complete catalog results are compared with the independently supplied
`tests/integration/fixtures/expected-catalog.json`, including API order.

To refresh the recording, explicitly run the following network-enabled command
outside Jest:

```sh
node tests/integration/record.js
```

Only the recording script contacts the live sandbox and creates a fresh sandbox
user through `POST /v1/auth`, recording its address and IP at DFX. It stores no
authentication token and replaces the challenge address with a placeholder.
After recording, update the literal expectations in `tests/integration/module.test.js`
and the complete catalogs in `tests/integration/fixtures/expected-catalog.json`
using independently calculated values. Update this paragraph with the actual
recording date and include the fixtures with the tests. Missing fixtures fail
setup. Expectations must never be derived from fixture responses during a test run.

Live sandbox and production coverage remains in `e2e/live-matrix.mjs` (catalogs,
quotes, authentication, widget and details). The 100% coverage gate is measured
from the combined unit and local integration suites.

The release workflow uses `holepunchto/actions/publish` after lint and coverage
checks.

## Support and license

Use [GitHub Issues](https://github.com/DFXswiss/wdk-protocol-fiat-dfx/issues) for
integration questions and non-sensitive bug reports. Report security issues
privately using [GitHub Security Advisories](https://github.com/DFXswiss/wdk-protocol-fiat-dfx/security/advisories/new).

Apache-2.0; see [LICENSE](LICENSE). Maintained by DFX AG.

# Testing

This document records how `@dfx.swiss/wdk-protocol-fiat-dfx` was verified, what each test layer proves, and what it
does not prove. Every result below was produced by running the named command, except the steps a person carried out
by hand in the two real purchases (the DFX widget steps and the bank transfer in sections 9 and 14) and the funding
of the account in section 15, which those sections name as such. The three sends on Base in section 15 were made by a
one-off script that is not in this repository; section 15 says so. A row that says the script was not
re-run states what that script expects, not a measured result. Nothing is inferred from reading code
unless it says so.

The revisions named below are commits of the development repository
[joshuakrueger-dfx/wdk-modul-dfx](https://github.com/joshuakrueger-dfx/wdk-modul-dfx); this repository received the
module as one squashed commit. "This branch" is that repository's pull request #2 (`fix/issue-258`), whose last
commit is `090e82c`. Results dated 2026-10-30 (section 15) belong to this repository's branch
`feat/dfx-fiat-module`, which adds `e2e/bundler-send.mjs`.

- **Which code each result belongs to.** Results belong to the explicitly named revisions:
  - **This branch:** the lint, unit, integration and coverage rows, recorded in section 1, and the ERC-4337 fork probe
    of section 8, all re-run on 2026-10-20 on Node v26.7.0; on 2026-10-23 the fork probe (11/11 again), the sandbox
    live matrix and two wallet journeys on Node v26.12.1; on 2026-10-29 the sandbox and production live matrix with the
    Base ERC-4337 case (Node v26.12.1), the coverage row on Node v22.23.4 (section 1) and the real purchase of section 14.
  - **2026-09-30, after the fifth review pass:** the 59 mutations of the mutation-probe row of the summary. They were
    not repeated on this branch; the seven ERC-6492 and challenge mutations in that row belong to this branch (2026-10-20). That revision
    includes these library changes made after `27dd624`: one shared
    transaction-detail session per instance, established by a single sign-in that concurrent `getTransactionDetail`
    calls share (first sign-in and renewal after HTTP 401); `buy`/`sell` sign in fresh and never touch that session; a
    401 clears the session only if it is still the rejected token, and a renewed token rejected with 401 is dropped; a
    cached signing owner is dropped when sign-in fails; an empty asset description is treated like a missing one; the
    check of `recipient`/`refundAddress` before sign-in only runs when the sign-in address is the account address
    itself (non-EVM or EOA); the HTTP timeout also accepts a `bigint` (fifth pass of the review skills, section 10).
    Integration expectations use address and signature literals computed independently with
    ethers for the public test phrase; no wallet call computes an expected value.
  - **Current sign-in:** the account address is the DFX account. `recipient` and
    `refundAddress` are checked before every sign-in. When the account implements
    `signTypedData`, the recovered signer differs and the constructor network has a known chain id, authentication
    sends a Safe EIP-712 signature and does not submit the owner. On the networks in `ERC6492_NETWORKS`
    (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum, Polygon, Base, Gnosis, Plasma), for which the DFX API is intended to
    verify ERC-6492, that Safe signature is wrapped as ERC-6492 when the recovered owner predicts the account with the
    WDK Safe 0.3.0 parameters. Nothing is signed unless
    the sign-in challenge equals the expected DFX text for the environment and the address sent. Assets without API
    decimals stay unlisted. The owner-cache drop and the delivery check limited to
    non-EVM or EOA above describe the 2026-09-30 revision only.
  - **Library code `20ec94d` (2026-09-29):** the e2e probes of section 12 and the summary rows that name this revision,
    re-run after all review changes. They consumed a packed copy of the module whose `src/` and `index.js` were compared
    byte for byte with the repository before the run. Section 11 keeps the earlier run against `ec9b788`.
    Both live-matrix counts in the summary come from this branch (2026-10-29). A summary row
    that says the script on this branch was not re-run is not this run.
  - **This repository, 2026-10-30:** the sends through a bundler of section 15, on Base and on a fork.
  - **Real purchase:** paid on 2026-09-28 with library code `0be1b6d` (section 9). The payment itself was not repeated;
    on 2026-09-29 the same production order, wallet and DFX account were re-checked with `20ec94d` without a payment
    (section 12). A second real purchase, into an undeployed ERC-4337 account on Base, was paid on 2026-10-29 with this
    branch (section 14).
- **First runs:** 2026-09-24 (sections 1–5) and 2026-09-25 (sections 6–8) against `0be1b6d`; the numbers in this document
  are those of the 2026-09-28 re-run unless a section says otherwise.
- **Runtime:** Historical runs used Node.js `v22.22.0`. On this branch, lint, unit, integration, coverage and the 2026-10-20 fork probe used Node v26.7.0; the 2026-10-23
  runs (sandbox live matrix, two wallet journeys, fork probe) used Node v26.12.1. On 2026-10-29, `npm ci`, lint, `build:types`,
  coverage and `npm audit --audit-level=critical` were re-run on Node v22.23.4 (section 1); the sandbox and production
  live matrix, the wallet simulator and `e2e/safe-rescue.mjs` of section 14 ran on Node v26.12.1. The runs of section 15
  (2026-10-30) used Node v22.23.4. macOS arm64. The Bare entry point ran on the Bare runtime v1.35.0 (npm package `bare@1.34.1`), see the summary row.
- **WDK packages used by `tests/integration`:** root-lockfile versions `@tetherto/wdk-wallet` 1.0.0-beta.17
  (a single copy, also used by `@tetherto/wdk-wallet-evm`; 1.0.0-beta.19 before 2026-10-02)
  and `@tetherto/wdk-wallet-evm` 1.0.0-beta.19.
- **WDK packages used by the recorded `e2e/` runs:** `@tetherto/wdk` 1.0.0-beta.18,
  `@tetherto/wdk-wallet` 1.0.0-beta.20, `@tetherto/wdk-wallet-evm` 1.0.0-beta.19,
  `@tetherto/wdk-wallet-evm-erc-4337` 1.0.0-beta.20,
  `@tetherto/wdk-wallet-tron` 1.0.0-beta.14, `@tetherto/wdk-wallet-solana` 1.0.0-beta.16,
  `@tetherto/wdk-wallet-btc` 1.0.0-beta.16, `@tetherto/wdk-wallet-spark` 1.0.0-beta.27.
- **DFX environments:** sandbox `dev.api.dfx.swiss` / `dev.app.dfx.swiss`, production `api.dfx.swiss` / `app.dfx.swiss`,
  and a local full stack (real DFX API and real Postgres, external providers mocked) built from the DFX API at
  `63cb9d569` and `DFXswiss/app` `1321f956`.

## Summary

| Layer | Command | Result |
| --- | --- | --- |
| Integration, local | `npm run test:integration` | 35/35 tests in 1 suite against a local DFX server replaying recorded sandbox responses; no network |
| Unit tests | `npm run lint && npm test` | lint output empty; 711/711 tests in 2 suites |
| Coverage (unit + integration) | `npm run test:coverage` | 746/746 tests in 3 suites on Node v26.7.0 and again on Node v22.23.4 (2026-10-29); 100 % statements, branches, functions, lines |
| Mutation probes | ad-hoc script (see [Mutation probes](#mutation-probes)) | 59/59 mutations detected on 2026-09-30, each by 1–233 tests; not repeated on this branch. 7/7 mutations of the ERC-6492 wrapper and the challenge check detected on 2026-10-20 |
| Signature normalisation vs. reference libraries | `cd e2e && node signature-diff.mjs` | 0 mismatches in 20 000 Solana and 5 000 Spark signatures on `20ec94d`. The script on this branch was not re-run |
| Live matrix, sandbox | `cd e2e && DFX_ENV=sandbox node live-matrix.mjs` | 178/186 steps on this branch (2026-10-29, with the Base ERC-4337 case); all 8 failures come from the two assets the sandbox does not list as buyable (section 2). Polygon and Base ERC-4337 pass every step |
| Live matrix, production | `cd e2e && DFX_ENV=production node live-matrix.mjs` | 182/187 steps on this branch (2026-10-29); every chain except Bitcoin signs in, including the undeployed Polygon and Base ERC-4337 account; the 5 failures are all Sepolia, a testnet asset in the production catalog (section 2) |
| Widget as the user sees it | `cd e2e && node widget-check.mjs` | On `20ec94d`, the widget opens signed in, amount/asset/network prefilled, in sandbox and production. The script on this branch was not re-run |
| Wallet user journeys | `cd e2e && node wallet-journeys.mjs` | `eth-4337-buy-usdt` and `eth-eoa-buy-usdt` passed on this branch (2026-10-23); the other five journeys were not re-run. The script expects Bitcoin to stay unlisted and every other journey, the undeployed ERC-4337 Safe included, to reach the DFX page title (`Buy`/`Sell`), return and show an order status. The Solana journey fails when its random address starts with `1` or `3`, about 6 % (DFX backend issue, section 12) |
| After the widget (local full stack) | `cd e2e && node fullstack.mjs` | 29/29 steps on `20ec94d` (second run; the first stopped at a transient local `fetch failed`, section 12). The script on this branch was not re-run |
| Chains without a WDK wallet | `cd e2e && node native-quotes.mjs` | Not re-run on this branch. The script expects sandbox to list only Firo, production to list none of Bitcoin, Lightning, Arkade and Firo, and unlisted assets to be rejected with Missing decimals |
| Backend processing, first look | `cd e2e && node fullstack-processing.mjs` | On `20ec94d`, the sell deposit is matched by the real `BuyFiat` job; a +10 % counter-test is not matched. The script on this branch was not re-run |
| Transaction lifecycle, real backend jobs | `cd e2e && node fullstack-lifecycle.mjs` | On `20ec94d`: 56 steps OK, 2 red: buy and sell reach an automatic AML `Pass`, rejection and refund reach `Returned`, the module status matches all seven DFX states observed; the crypto payout and the fiat bank execution are not prepared by the local stack (no liquidity rules). The script on this branch was not re-run |
| KYC in the widget | `cd e2e && node kyc-widget.mjs` | On `20ec94d`: e-mail code → level 10 → personal data → level 20 → nationality → stops at the Sumsub identification call. The script on this branch was not re-run |
| Bare entry point | `cd e2e && npx --yes bare@1.34.1 bare-smoke.mjs` | 4/4 checks on this branch (2026-10-20, Bare runtime v1.35.0): `bare.js` loads `DfxProtocol`, and a sandbox sign-in on Polygon through stubbed `fetch` posts the predicted Safe address with exactly the ERC-6492 signature in `e2e/fixtures/bare-smoke-expected.json`, then the stubbed detail request answers 404. With one hex digit of that fixture changed the probe reports 3/4. No network, no DFX API |
| Deployed ERC-4337 account | `cd e2e && ANVIL_FORK_URL=https://polygon.drpc.org node safe-deployed.mjs` | 11/11 steps on this branch (2026-10-20): before deployment the posted signature is ERC-6492-wrapped and viem 2.38.5 verifies it on the fork while the Safe has no code; after deployment the inner signature passes ERC-1271 and the wrapped one passes viem; sandbox result `accepted` in all three sign-ins on 2026-10-23, `rejected` on 2026-10-20 (section 8) |
| Real purchase into an undeployed ERC-4337 account | wallet simulator in production; `cd e2e && node safe-rescue.mjs --native …` | On this branch (2026-10-29): 15 EUR of ETH bought for the Base smart account, which signed in to production DFX while it had no code; DFX paid 0.00565071 ETH to it and the module reports `completed`; the owner then deployed it without a bundler and moved the full balance out (section 14) |
| Sending from an ERC-4337 account through a bundler | on Base a one-off script (not committed); on a fork `cd e2e && node bundler-send.mjs …` | On 2026-10-30, on Base itself through the public Candide bundler: three UserOperations from an account that had no code; the first deployed it, and each settled with receipt status 1 and a `UserOperationEvent` with `success = true`. On an `anvil` fork of Base with a local Alto bundler, the committed script: four sends (ETH that deploys, ETH, USDC `transfer`, `--all`) exit 0, five runs that sent no UserOperation (four stopped by the script, one refused by the bundler at gas estimation), and 7/7 mutations or removed checks detected (section 15) |
| Reviews | independent code review; Tether's `wdk-review-jsdocs`, `wdk-review-dts`, `wdk-review-tests` | see [section 10](#10-reviews-2026-09-28): all findings fixed or named; fifth pass of all skills on `498d4e6` (2026-09-30) |

See [`e2e/README.md`](e2e/README.md) for prerequisites and side effects before running anything under `e2e/`.

## 1. Unit tests

On this branch (2026-10-20), `npm run lint` printed nothing and `npm test` passed 711 tests in 2 suites (Node v26.7.0).
`npm run test:integration` passed 35 tests in 1 suite on that same Node version.
`npm run test:coverage` on that same Node version passed 746 tests in 3 suites and reached 100 % coverage in all four categories.
On 2026-10-29, the jobs listed in this repository's `CONTRIBUTING.md` were re-run on Node v22.23.4: `npm ci`,
`npm run lint`
(output empty), `npm run build:types` (exit 0), `npm run test:coverage` (746/746 in 3 suites, 100 % in all four categories) and
`npm audit --audit-level=critical` (exit 0, 6 low-severity findings). In the development repository
`npm run build:types` rewrote the hand-written declarations under `types/`, so the committed `types/` were restored
after that run; in this repository `tsc` writes to the ignored `.types-build/` instead. The
session scenarios that build state across successive public calls live in the integration suite
(skill rule R3). Parallel calls to the same method within one Act belong in unit tests. All
unit tests use an injected `fetch` routed by method and URL and cover
both trade directions, both amount modes, lossless 18-decimal arithmetic, every HTTP-status mapping, every DFX
transaction state, the account-error allowlist per method, signature normalisation (Solana, Spark), sign-in as the
account address, a Safe EIP-712 signature when the recovered signer differs, its ERC-6492 wrapper on Polygon for `buy`, `sell` and
`getTransactionDetail` (decoded with ethers and checked against an independent abstractionkit prediction), the unwrapped
Safe signature on Citrea and CitreaTestnet, the exact
sign-in challenge check before any signature, and assets whose API decimals are null.
There is no cached signing owner.

### Mutation probes

A passing suite only matters if it fails on wrong code. Each mutation below was applied to the source (asserting the
pattern matched exactly once), the unit and integration suites were run in band, and the source was restored. All 59 were detected on 2026-09-30 and were not repeated on this branch. The fifth review pass added seven: `bigint` timeout not normalized, normalized timeout not passed on, and the three named limits off by one (timer maximum, asset decimals, rate precision), the request timer cleared right after it is set, and the request timer left running after a response. The asset-decimals limit first survived (only 256 was tested, not 255); a test for 255 closed it. The cleared timer first survived as well: the rebuilt timer tests ran the timer callback by hand; they now reach the deadline through the fake clock and check that the request is still open one millisecond before it and aborted at it. A timer left running after a response also survived at first; a test now checks that no timer remains after a successful request. After the shared-session change, mutations of removed code were dropped, and two were dropped as equivalent: reading the shared token slot instead of the local token (no `await` lies between them any more), and a separate check of the rejected token (the clearing directly before it already covers it; the parameter was removed). For one of them (an error class no longer re-exported) the integration suites fail to load, so only the dedicated export test is real evidence there. (Commit `75877e6` stated 43; the correct count at that commit was 42. One mutation, `options.config` not validated, no longer applies since the type guard was removed under C005.)

On 2026-10-20, seven mutations of the ERC-6492 wrapper and the sign-in challenge check were applied the same way
(pattern matched exactly once, source restored), but only `tests/dfx-protocol.test.js` was run, not the integration
suite. All seven were detected, with the number of failing tests in brackets: salt nonce changed (1), Safe 4337 module
address changed (1), self-check skipped (2), second ABI offset shifted by one word (1), challenge check removed (6),
sandbox prefix empty (6), wrapper on every network (1). With the positive ERC-6492 test covering all nine networks,
narrowing `ERC6492_NETWORKS` to Polygon failed 9 tests: the wrap case on each of the eight other networks, and
"keeps the Safe signature when Safe prediction throws", whose network then no longer reaches the prediction; removing
only Plasma failed 1 test. In the integration suite, posting the owner signature
instead of the Safe signature failed 3 of 35 tests.

Examples: sell rate not inverted; sell fee taken from the source side; a failed DFX state mapped to `in_progress`;
`PayoutInProgress` mapped to `completed`; network binding not enforced; `isValid: false` not checked first; EVM
address compared case-sensitively; always `amount-in`; account-error allowlist via `instanceof`; `fetch` called with the
wrong receiver; `blockchain` omitted at sign-in; lossy JSON numbers; external-ID character set opened; Solana signature
not Base58-encoded; leading zero bytes dropped in Base58; Spark DER kept; DER scalars not left-padded; ERC-4337 owner
not used for sign-in; signer cache disabled; wrong EIP-191 prefix; native decimals fallback removed or given priority
over API decimals; signer cached before a successful sign-in; early address check disabled; an uncached EVM account
treated as known; EIP-191 length counted in UTF-16 units instead of bytes; `null` asset description passed through;
an error class no longer re-exported.

EIP-191 recovery is pinned through the ERC-6492 tests: the owner signature there comes from an independent ethers
`Wallet`, and the module wraps only when the owner it recovers predicts the account. Swapping prefix and payload in
`recoverEvmAddress` (2026-10-20, `tests/dfx-protocol.test.js` only) failed the three wrap tests for `buy`, `sell` and
`getTransactionDetail`. The test with an account that cannot sign typed data forwards the signature unchanged and checks
only ethers against ethers. Until 2026-10-20 a reference with a UTF-8 multi-byte message pinned the recovery. Since the
challenge check rejects every text other than the ASCII DFX challenge before anything is signed, no multi-byte message
reaches the recovery through the public API any more; the mutation "EIP-191 length counted in UTF-16 units instead of
bytes" listed above is therefore no longer reachable that way and was not part of the 2026-10-20 probes.

The probe script is a local tool and is not part of this repository.

## 2. Live matrix (sandbox and production)

`e2e/live-matrix.mjs` builds a real WDK instance from a fresh random seed for each run, registers each wallet package
and this module with `registerProtocol`, and calls the module through `account.getFiatProtocol('dfx')`, exactly as an
integrating wallet does. On the `20ec94d` run, per chain it checked: registration; the three catalogues; `quoteBuy` and `quoteSell`;
sign-in (via `getTransactionDetail` on an unknown ID, expecting `NoSuchElementError` after a successful sign-in);
`buy()` and `sell()` URLs; that the session in each URL is valid (`GET /v2/user` returns 200); rejection of a foreign
`recipient`; rejection of a read-only account; `externalTransactionId` in the URL; and `getTransactionDetail` by
external ID before any payment.

Chains in that run: Ethereum, Polygon, Arbitrum, Base, Optimism, BNB Smart Chain and Sepolia (`wdk-wallet-evm`); Polygon as an
ERC-4337 smart account; Tron; Solana; Bitcoin (BIP-84); Spark.

**Sandbox on this branch: 178/186 (2026-10-29, Node v26.12.1).** This run includes the Base ERC-4337 account
(`base-4337`), which passes all 15 of its steps. The two contract steps now fail on any unexpected result: the
foreign-recipient step accepts only the module's `ValueError` `recipient must match the account address`, and the
read-only step only `AccountRequiredError`; before, both returned any outcome as a pass. With the expected message, or
the expected class, replaced, `base-4337` drops to 14/15. The 8 failures are the 6 expected ones below plus the
foreign-recipient step on Sepolia and Spark: the module checks that the asset is buyable before it checks the
recipient, so on those two chains the recipient check is not reached. A run of the same commit before the two steps
were tightened counted 180/186.

**Sandbox on this branch: 165/171 (2026-10-23), before `base-4337` was added.** The undeployed Polygon ERC-4337 account now runs the same steps
as the other chains and passes all of them: it signs in, and the `buy()` and `sell()` sessions return 200 at `/v2/user`
with the Safe address in the `/v2/user` response body (a substring check, not a comparison of the address field). With the expected address replaced by another one, those two session steps fail
(13/15 for that chain). The 6 failures are the expected ones below. Production was not run on 2026-10-23; the
production run of this branch is the 2026-10-29 one below.

**Sandbox: 172/178 (`20ec94d`).** The 6 failures are purchases of Sepolia USDT and Spark BTC, which the sandbox lists as
`sellable` but not `buyable`. The module rejects them with `ValueError`, which is the intended behaviour.

**Production on this branch: 182/187 (2026-10-29, Node v26.12.1).** Every chain except Bitcoin signs in to production
DFX with the exact challenge check and gets valid widget sessions at `/v2/user`, including the undeployed ERC-4337 account
on Polygon and on Base. Bitcoin has no listed asset (API `decimals: null`), so the module rejects its quotes and trades
before any sign-in; no production sign-in of a Bitcoin address was made. The 5 failures are all Sepolia: production
lists Sepolia/USDT as sellable but not buyable, so `quoteBuy`, `buy`, the foreign-recipient step and the
`externalTransactionId` step stop at `Unsupported buy asset or network: USDT`, and its sell quote fails upstream with
`Base fee is missing`. The Sepolia sell session is valid.

**Production: 175/179 (`20ec94d`).** In that run, every mainnet chain signs in and produces valid widget sessions. The 4 failures are all
Sepolia. Production lists the testnet asset Sepolia/USDT as sellable, and its sell quote fails upstream with
`Base fee is missing`. This is DFX catalogue data, not module behaviour.

**ERC-4337 accounts (`20ec94d`).** They signed in with the owner address recovered from the signature, as DFX's own WDK wallet did.
The widget session belonged to the owner EOA, so DFX delivered to that address and not to the smart account. The test
confirmed that a smart-account address passed as `recipient` was rejected with a message naming the owner address.

**Production side effect.** Signing in creates a DFX user per address. The run on `20ec94d` created these throwaway
test users, none with KYC or funds:

| Account | Address |
| --- | --- |
| EVM (also the owner of the ERC-4337 account) | `0xA37b911F48F44afaA3fD4e10D7CD59b786a51e8d` |
| Tron | `TARxmnAxy9nfiCEJDwbASo9oiuuArBFegW` |
| Solana | `Eomxq9KQVUc2ERQRZ412qHEQUpjwemg1P5CBx24zdnKG` |
| Bitcoin | `bc1q7aqevm93a9urcaqqzgq7s2d5zeneknye7vu5zd` |
| Spark | `spark1pgssxuy4rn42lfmj57g4hp5sdxx4qfp8ddy4fp2044swrh8jnd6nlt6f03yxna` |

That run used the same script before it moved into `e2e/`. The run of 2026-10-29 from this branch, started on
purpose, created these further throwaway users, none with KYC or funds (Bitcoin did not sign in):

| Account | Address |
| --- | --- |
| EVM (also the owner of the ERC-4337 account) | `0x96b47527B49a08CeA368ed17F300B46a406F55b9` |
| ERC-4337 account (Polygon and Base) | `0xc79777B64B7aE1361D25aBf5f1e18C14A32B29E8` |
| Tron | `TYokU9QHCBqpaDkxZaarcXS3PxqmvtgBsB` |
| Solana | `4s4aFwxCfmvLLKYAHozxYXZkunpUxttpV4TScgnJvNMd` |
| Spark | `spark1pgssxxcgwl0q72sy2x6vzfjfjcjk0s5tk8m246zssrcw5pemdkxalznx8xw8t5` |

## 3. What the user sees

`e2e/widget-check.mjs` opens the generated URLs headless. In sandbox and production the DFX app opens signed in, with no
login screen. It shows the wallet address, and the amount, asset and network are taken from the URL. DFX then
continues with its own steps: KYC (sandbox) or e-mail (production) for buying, IBAN for selling.

`e2e/wallet-journeys.mjs` drives the simulated wallet app in `e2e/wallet-sim/` (phone layout, DFX opened in an in-app
browser frame). Each journey creates a wallet, taps Buy or Sell, reads the live offer, continues to DFX and checks the
order list. The table is from the first run (2026-09-24, `0be1b6d`) and shows what each journey sees once it
reaches DFX. The Solana journey creates a random wallet: if its address starts with
`1` or `3` (about 6 %), DFX rejects sign-in (backend issue, section 12). Current run results are in sections 11 and 12.

| Journey | Offer shown to the user | DFX window |
| --- | --- | --- |
| Ethereum, buy USDT | 100.00 EUR → ~112.02 USDT, fee 1.49 EUR | signed in, KYC step |
| Ethereum smart account, buy USDT | same | signed in with the owner address |
| Tron, buy USDT | 100.00 CHF → ~113.64 USDT, fee 6.00 CHF | signed in, KYC step |
| Solana, sell USDT | ~58.011 USDT → 50.00 EUR | signed in, IBAN step |
| Bitcoin, buy BTC | 100.00 EUR → ~0.0013324 BTC | signed in, KYC step |
| Spark, sell BTC | 0.001 BTC → ~72.46 EUR | signed in, IBAN step |
| Ethereum, 1 EUR | accepted (sandbox has no minimum) | signed in |

## 4. After the widget: KYC, payment, settlement, status

The public sandbox cannot take a fresh account through a bank purchase (`RecommendationRequired`/`KycRequired`), and
production has no test money. `e2e/fullstack.mjs` therefore runs against the local DFX full stack (`DFXswiss/app`
`e2e-stack/`, real API and Postgres). The module talks to it unchanged: its injectable `fetch` rewrites the sandbox host
to the local API.

All 29 steps passed:

1. The WDK wallet signs in through the module, and `buy()` returns a URL with `external-transaction-id`.
2. KYC level 50 and complete personal data are set in the database, as the harness factories do. This simulates a
   verified user; the KYC process itself is not exercised.
3. In the browser, the widget reaches **Payment Information**. The backend stores a `transaction_request` carrying the
   external ID.
4. An incoming bank transfer is inserted as an unassigned `bank_tx` and assigned to the buy route through the **real
   admin endpoint**. That runs the backend's own path: `createFromBankTx` → `getAndCompleteTxRequest` →
   `findAndComplete`. The backend itself links the request and writes our ID to `transaction.externalId`.
5. The module's `getTransactionDetail(id, { idType: 'externalTransactionId' })` returns `in_progress` (DFX state
   `Created`). The same transaction by DFX `uid` returns the same result.
6. With `buy_crypto` set to completed, the module returns `completed`; with a failed AML check it returns `failed`.
7. **Matching heuristic, counter-test:** a second widget session followed by a transfer 10 % above the quoted amount.
   The backend does not match it, `transaction.externalId` stays empty, and the module returns `NoSuchElementError` for
   the second ID.
8. **Sell:** the widget reaches the deposit address, and the backend stores the request with the external ID. The module
   returns `in_progress` and then `completed` with `cryptoAsset` ETH and `fiatCurrency` CHF.

## 5. Chains without a WDK wallet package

No WDK wallet package exists for Lightning, Arkade or Firo, so no WDK user can currently arrive from those chains.
On `20ec94d`, `e2e/native-quotes.mjs` listed them at 8 decimals via the native fallback and quoted them in sandbox and
production. A Firo sell of 0.01 FIRO was rejected as `AmountTooLow` with DFX's minimum. The script in this branch was
not run live. It expects sandbox to list only Firo, production to list none of Bitcoin, Lightning, Arkade and Firo,
and both quote methods to reject each unlisted asset with `ValueError` `Missing decimals for <blockchain>/<asset>`.

## 6. Real backend processing (2026-09-25)

For these runs the local API was restarted with selected background jobs **enabled** (list in
[`e2e/README.md`](e2e/README.md)). Everything that talks to the outside world (blockchain scanning and payout, bank
transmission, pricing and liquidity) stayed off. Only external events are simulated:
- an incoming bank transfer (a `bank_tx` row with `senderAccount`, as the bank import writes it);
- a blockchain confirmation of a crypto deposit;
- a completed identification (KYC level 50, `verifiedName`, current `lastNameCheckDate`);
- the bank's execution of a refund.

Everything else is done by the backend or through the real admin endpoints that DFX operations use.

**Sell matching through the backend** (`fullstack-processing.mjs`). A crypto deposit is written as the blockchain scan
would write it. The `BuyFiat` job then registers it about 60 s later, creates the sale, and sets our
`externalTransactionId` on the transaction through `findAndComplete`. The module returns `in_progress`. A second
deposit 10 % above the quoted amount is assigned to the route but not to the request, and the module returns
`NoSuchElementError` for that ID.

**Lifecycle** (`fullstack-lifecycle.mjs`, `OBSERVE_MINUTES=15`). DFX state as returned by the API against the module's
status, at each observed change:

| Scenario | Event | DFX state | Module |
| --- | --- | --- | --- |
| Buy A | bank transfer assigned by admin | `Created` → `Processing` → `CheckPending` | `in_progress` |
| Buy A | bank data verified by the backend job, phone check recorded, `reviewReset` | `Created` → `LiquidityPending` (AML `Pass`, automatic) | `in_progress` |
| Buy B (separate user) | bank transfer assigned by admin | `CheckPending` | `in_progress` |
| Buy B | compliance rejects via `PUT /v1/buyCrypto/:id/amlCheck` | `Failed` | `failed` |
| Buy B | refund approved with creditor data | `ReturnPending` | `in_progress` |
| Buy B | refund executed by the bank (simulated) | `Returned` | `failed` |
| Sell | deposit registered by the backend, blockchain confirmation | `Created` → `Processing` (AML `Pass`, automatic) | `in_progress` |

Both buy and sell reach an automatic AML `Pass`. After that the backend waits for liquidity (buy, `LiquidityPending`) or
for a fiat output (sell, `Processing`). Both need the pricing and liquidity jobs, which talk to real exchanges and stay
off, so `completed` through the real pipeline is not reached. The `completed` mapping is covered by section 4, where
the completion fields are set directly.

Wallet-visible note: during a refund the status goes `failed` → `in_progress` → `failed`, because `ReturnPending` counts
as in progress (build spec, decision E7).

The runs surfaced these DFX rules. They had to be satisfied the way operations satisfies them, and none of them is a
module issue:
- **An IBAN may be active on only one account**, so each scenario uses its own valid IBAN.
- **An IP country differing from the residence country** requires a recorded phone check (`ManualCheckIpCountryPhone`).
- **Sender bank data** is created by the backend from `bank_tx.senderAccount` (type `BankIn`), then verified by the
  `BankDataVerification` job. `PUT /v1/bankData/:id` without `status` puts non-`User` bank data back into
  `InternalReview`, which the AML job skips silently.
- **An AML verdict, once written, is locked.** Compliance decisions go through `PUT /v1/buyCrypto/:id/amlCheck`.

Two backend robustness findings (DFX backend, not this module):
- `UserRepository.getNextRef` (`user.repository.ts:67-75`) throws `Cannot read properties of null (reading 'ref')` when no
  user has a numeric referral code yet. On a fresh database this breaks both the AML check and `PUT /v1/userData/:id` for
  users at KYC level 50. The test seeds one code, as every real database has.
- `NameCheckService.classifyRiskData` throws `Cannot read properties of undefined (reading 'every')` on an empty
  name-check provider response.

## 7. KYC in the widget

`kyc-widget.mjs` signs in a fresh wallet through the module, opens the buy widget, taps *Complete KYC*, and completes
the DFX screens in the UI: e-mail with the confirmation code from the harness mail fixture (level 10), then personal
data (level 20), then nationality. With the KYC jobs enabled, the next step is identification. There the backend calls
Sumsub (`KycService.initiateStep` → `SumsubService.initiateIdent` → `createApplicant`), which is unreachable locally,
and answers `PUT /v2/kyc` with 503. The same account then still quotes and opens the widget through the module at
level 20.

Wallet-visible note: on that 503 the widget loops on its *Continue* spinner instead of showing an error. This is DFX
app behaviour.

## 8. Deployed ERC-4337 account

11/11 steps on 2026-10-20 (Node v26.7.0, `@tetherto/wdk-wallet-evm-erc-4337` 1.0.0-beta.20, viem 2.38.5, fork of
Polygon via `https://polygon.drpc.org`). `safe-deployed.mjs` forks Polygon with `anvil`. Before deployment, `buy()`
submits the Safe address with an ERC-6492-wrapped signature: the factory and factory data equal the package's own
counterfactual deployment, the inner Safe signature recovers to the owner, and viem's `verifyMessage` on the fork
accepts the wrapped signature while `eth_getCode` stays empty. The probe then deploys the WDK smart account without a
bundler, using that factory data; `eth_getCode` is non-empty after. The account's personal signature over a fixed
message is byte-for-byte identical before and after deployment, and it recovers to the owner. After deployment,
`buy()` and `sell()` again submit the wrapped signature, byte for byte the one posted before deployment: the inner
signature returns the ERC-1271 magic value from `isValidSignature` on the forked Safe, and viem accepts the wrapped one.
The sandbox API cannot see the fork. On 2026-10-20 it rejected all three sign-ins as an authentication failure
(`sandbox: rejected`, `ProviderError` with reason `UNAUTHORIZED`). On 2026-10-23, after the DFX API began verifying
ERC-6492, the same code got `accepted` with a session for all three: before deployment, and for `buy()` and `sell()`
after deployment on the fork, while on Polygon itself the Safe still has no code.

## 9. Real purchase with real money (production, 2026-09-28)

A real buy was made from the wallet simulator running against **production**
(`WALLET_SIM_ENV=production`, see [`e2e/README.md`](e2e/README.md)). The simulator loaded a wallet prepared by
`e2e/real-purchase.mjs`: a fresh seed, stored `0600` on the test machine and never printed.

The user flow in the wallet: *Kaufen* → ETH on Arbitrum, 20.00 EUR → *Weiter zu DFX*. The DFX widget opened in the
wallet's in-app browser, already signed in. The e-mail link then linked the new address to an existing verified DFX
account, and the SEPA transfer was made by hand. The order was placed for **ETH**; USDC had been planned.

Recorded from the wallet's side by polling the module (`getTransactionDetail` by `externalTransactionId`) and the
on-chain balance every 60 s:

| Time (UTC) | Order status via the module | Arbitrum balance |
| --- | --- | --- |
| 08:08:00 | order created (`wallet-1790582879930-f2fca7e950a9`) | 0 ETH |
| 08:09:15 | `NoSuchElementError` (no DFX transaction yet) | 0 ETH |
| 08:42:31 | `in_progress` | 0 ETH |
| 08:43:32 | `completed` | **0.00717295 ETH** |

- **Wallet:** `0x463e558CC8842078CD1FeC6dF1Ff7F54058BE6C7`. Its derivation path `m/44'/60'/0'/0/0` gives the same
  address in MetaMask (checked by deriving it with `ethers`).
- **Payout:** [`0x081eb861f4f9d2d34f29b2f1bf3595c415ce3603f9be734cb576c7bd9dca5902`](https://arbiscan.io/tx/0x081eb861f4f9d2d34f29b2f1bf3595c415ce3603f9be734cb576c7bd9dca5902),
  08:42:37 UTC, 0.00717295 ETH from `0xFAEefD557ffD2714f16e1A44A165FCd5d6a6b6a0`, status ok (Blockscout).
- **Second order:** an earlier order from the same wallet (08:05:56) received no payment and correctly stays without
  a transaction (`NoSuchElementError`).
- **Screenshots:** the wallet's order list and portfolio after completion are in
  [`e2e/evidence/`](e2e/evidence/).

This is the first run in which every step between wallet and payout was real: sign-in, widget, account linking,
bank transfer, DFX processing, on-chain payout and status reporting through the module.

## 10. Reviews (2026-09-28)

**Independent code review** of the native-decimals fallback and the ERC-4337 owner sign-in. Two defects were
confirmed and fixed:

- The recovered owner was cached before the sign-in succeeded. A signature that recovers to an unrelated address
  (for example an ERC-1271 format) left the instance unable to sign in. The owner is now cached only after DFX returns
  an access token.
- On Tron, Solana, Bitcoin and cached EVM accounts, a mismatching `recipient`/`refundAddress` was rejected only after
  a signature and a sign-in request, which creates a DFX user. It is now rejected before either.

Documented instead of changed: purchases for ERC-4337 accounts go to the owner EOA, which usually has no gas and is
not shown in wallet apps (as in DFX's own wallet); `getTransactionDetail` for ERC-4337 accounts needs the constructor
`network`; ERC-1271 signature formats are not supported. At that revision, two parallel first sign-ins on one instance
requested two signatures each. Since the shared-session change, parallel `getTransactionDetail` calls share one sign-in (tested); parallel `buy`/`sell` calls still sign in separately by design.

**Tether's review skills** (`tetherto/wdk-agent-skills` at `219077f`):

- `wdk-review-jsdocs`: 33 findings under 9 of 35 rules (R8, R9, R17, R23, R25, R26, R28, R31, R32). All fixed:
  parent descriptions kept, one `@throws` per condition, named typedefs instead of inline objects, `quoteBuy`/`quoteSell`
  typed without `recipient`/`refundAddress` as in the parent, `null` description returned as `undefined`.
- `wdk-review-dts`: 2 findings (TD1/TD9 text drift between JSDoc and `.d.ts`; TD4 error classes not re-exported). Both
  fixed; the error classes, `ProviderErrorReason` and the account types are now exported from this module. The
  declarations were type-checked with `tsc --strict` together with a consumer file, including a check that
  `recipient` is rejected in quote options.
- `wdk-review-tests`, first pass: 7 of 11 rules reported (R1–R6, R11) plus conventions. Applied together with the code
  of conduct's C005 (no runtime type guards on typed parameters): 15 type-only checks and the 131 test cases for
  type-excluded inputs were removed; value rules, documented `@throws` conditions and all validation of DFX responses
  remain. The suite was rebuilt: tests only through the public API (signature cases now via the exact `POST /v1/auth`
  body), dummy account classes, every request and signing call asserted as fixed values inside each test, complete
  return objects, exact error class, message and reason, one act per test.
- `wdk-review-tests`, second pass on the rebuilt suite: 3 of 11 rules still reported (R1, R3, R11) plus hook
  assertions (T001), naming and the integration environment. All fixed.
- Integration tests (`npm run test:integration`, `tests/integration/`): at introduction 12/12 (35/35 on this branch, see section
  1 and the summary) against a local DFX server started
  from Jest's global setup. It replays sandbox responses recorded on 2026-09-28 (`tests/integration/record.js`,
  fixtures without tokens, seeds or test addresses) and verifies EIP-191 signatures at `POST /v1/auth` like DFX.
  Expected values are fixed literals computed independently from the recorded responses. Checks: 12/12 with all
  outbound network access denied by a macOS sandbox profile (a control fetch in the same profile is blocked);
  turning off the fake's signature check makes the wrong-key test fail; module mutations M02 and M12 fail 2 and 5 of
  the 12. No environment variable is needed; WDK EVM accounts at indexes 0 and 1 are derived from a fixed public BIP-39 test phrase. Before this change the
  three authenticated tests were skipped unless an account module was supplied, so they never ran in the gate.
- Live coverage moved entirely to `e2e/live-matrix.mjs`; rerun on 2026-09-28 with `ec9b788` against the
  sandbox: 172/178, the same six expected failures as in section 2.
- Test files are excluded from `npm run lint` by the Tether scaffold (`standard.ignore`). They were linted
  separately with the `standard` rules and ignore disabled; output empty.
- Third pass of all three skills on `ec9b788`:
  - `wdk-review-jsdocs`: 7 of 39 rules reported (missing typedef descriptions, tautologies, one text for three
    constructor overloads, implementation prose, missing `@throws` for passed-through account errors).
  - `wdk-review-dts`: 2 of 9 (declaration order changed without need; `FiatProtocol`, `BuyErrorReason` and
    `SellErrorReason` not re-exported).
  - `wdk-review-tests`: 4 of 11 (expected values rebuilding module logic, tests calling several methods, duplicates, a
    random seed in integration tests).

  All fixed in `c9b2c90`. The session and signer-cache scenarios moved to `tests/integration/module.test.js`
  (real WDK signatures, fixed public test phrase from the skill, server state reset per test). The full catalogs are
  compared against `tests/integration/fixtures/expected-catalog.json`, computed independently in Python from the
  recorded responses.
- Fourth pass of all three skills on `8c3f53e`: `wdk-review-dts` 0 violations (6 of 9 rules met, 3 not applicable),
  `wdk-review-jsdocs` 0 violations (30 of 39 met, 9 not applicable), `wdk-review-tests` 7 small violations (subsumed
  assertions, arrange after act, constant scope, `DUMMY_` naming, one `describe` name, one integration file and one
  file per method). All fixed in the following commit; the session scenarios now live in
  `tests/integration/module.test.js`.
- Fifth pass of all three skills and the code of conduct on `498d4e6` (2026-09-30, one reviewer per skill; the test skill in two parts):
  - `wdk-review-jsdocs`: 22 reported, 21 fixed: `/** @private */` on three private fields; six type descriptions that listed their fields; defaults stated for `config` and `options`; overload-specific parameter names (`readOnlyAccount`, `signingAccount`); `buy`/`sell` return an object with the URL, not the URL; the signature helper description; R33 — `timeout` accepts `number | bigint`. Not changed: `_request` keeps `@internal` (R6 allows `@internal` as the minimal block; it is called from `DfxProtocol`).
  - `wdk-review-dts`: 1 reported (TD6: internal modules neither `_`-prefixed nor under `src/internal/`). Not changed: the rule requires that internal types stay out of `types/`, via `tsconfig.json` exclusions or `@internal`; the five internal modules are excluded and `types/src` contains only `dfx-protocol.d.ts`. `tsc --strict` over `types/` with a consumer probe exits 0.
  - `wdk-review-tests`: integration suite 0 violations; unit suite 1 (R3, a test duplicating a case of the preceding table) — removed.
  - Code of conduct: 6 reported, all fixed: named constants for the timer maximum, the asset-decimals limit and the rate precision (C001); a timer test split into act then assert (T001); two timer tests now run the callback and check the abort and the exact delay (T003). P001/P002 (one PR per method, agreed spec first) as decided: one PR in a separate repository.
  - `.d.ts` updated by hand with every JSDoc change (TD1).

## 11. E2E re-run against `ec9b788` (2026-09-28)

Every probe under `e2e/` that needs no new money was run again against library code `ec9b788` (module copy compared
byte for byte with `src/` before the run):

| Probe | Result |
| --- | --- |
| `signature-diff.mjs` | 0 mismatches (20 000 Solana, 5 000 Spark) |
| `native-quotes.mjs`, sandbox and production | Lightning, Arkade and Firo listed and quoted; one expected `AmountTooLow` for the 0.01 FIRO sell |
| `live-matrix.mjs`, sandbox | 172/178, the same six expected failures as in section 2 |
| `live-matrix.mjs`, production | 175/179, the same four failures (Sepolia USDT, DFX data) as in section 2 |
| `widget-check.mjs`, sandbox and production | widget opens signed in with amount, asset and network prefilled |
| `wallet-journeys.mjs` | 6/7: the Solana sell journey stopped because DFX sign-in failed (correction 2026-09-29: this row said 7/7 from the exit code alone; the cause is the DFX Solana address issue in section 12) |
| `fullstack.mjs` | first run: the local backend answered "No valid price found for CHF → ETH" for the first buy (local price feed, not the module; sign-in and widget URL were green, and a later buy in the same run got payment details); second run: 29/29 |
| `fullstack-processing.mjs` | sell matching by the real `BuyFiat` job and the +10 % counter-test as in section 6; the two "observe processing for six minutes" steps stay red, because this first probe does not perform the operating steps (bank data approval, IP phone check) that the AML decision needs. Whether they were also red on 2026-09-25 cannot be shown, because that log was not kept. The lifecycle probe covers the AML decision |
| `fullstack-lifecycle.mjs` (`OBSERVE_MINUTES=15`) | 60 steps OK, 0 failed — corrected 2026-09-29: two of them were milestones that were not reached (crypto payout for buy A, fiat bank execution for the sale) and were recorded as OK by a probe bug fixed afterwards; buy A reaches automatic AML `Pass`, the rejected buy B goes through `Failed` to `Returned`, the sale reaches AML `Pass`; the module status matched all seven DFX states observed (`Created`, `CheckPending`, `LiquidityPending`, `Processing` → `in_progress`; `Failed`, `Returned` → `failed`; `ReturnPending` → `in_progress`) |
| `kyc-widget.mjs` | module steps green (sign-in, level 10, level 20, nationality, then quote and widget for the same account); the API log shows the documented boundary: `PUT /v2/kyc` answers 503 after the Sumsub call fails, and the widget loops on *Continue*. The probe's own boundary check stays red because no identification step is created |
| `safe-deployed.mjs` | 13/13 |
| Real purchase (section 9) | not repeated; belongs to `0be1b6d` |

After the pull-request review (2026-09-29) the probe scripts gained safeguards: the two full-stack probes refuse
non-local targets, wallet journeys force the sandbox, `real-purchase.mjs prepare` needs `--confirm`, refuses a seed
or state file readable by others and no longer passes the session URL to a browser command line, `anvil` is taken
from `PATH`, and the lifecycle probe derives the API container from the database container. Checked: every changed
script passes `node --check`; `safe-deployed.mjs` again 13/13; `fullstack.mjs` against `https://api.dfx.swiss` stops
with "Disposable local stack only"; `real-purchase.mjs prepare` without `--confirm` shows the public quote and stops before any sign-in. The
local-stack probes were not re-run after these changes, because ports 3020/3021 were then used by another local
stack.

The second review round added: every lifecycle milestone that is not reached (direct stops and simulated payouts or
bank executions) now fails the run with a non-zero exit; `widget-check.mjs` and the wallet simulator refuse URL, order
and seed files that are symbolic links, not owned by the user or open to group or others. Checked: `node --check` for
every changed script; `widget-check.mjs` refuses a URL file with mode 0644 and a symbolic link and accepts an owned
0600 file. The lifecycle change was not exercised by a run at that time, for the same port reason; section 12 exercises it.

## 12. E2E re-run against `20ec94d` (2026-09-29)

Every probe under `e2e/` that needs no new money was run again against library code `20ec94d` (module copy compared byte
for byte with `src/` before the run). The local stack ran as its own project on ports 3040/3041 (`DFX_LOCAL_API`,
`DFX_LOCAL_APP`, `DFX_LOCAL_DB_CONTAINER`), because another local stack used 3020/3021; backend `63cb9d569`, the same
13 background jobs enabled as in section 6.

| Probe | Result |
| --- | --- |
| `signature-diff.mjs` | 0 mismatches (20 000 Solana, 5 000 Spark) |
| `native-quotes.mjs`, sandbox and production | listed and quoted; one expected `AmountTooLow` for the 0.01 FIRO sell |
| `live-matrix.mjs`, sandbox | 172/178, the same six expected failures as in section 2 |
| `live-matrix.mjs`, production | 175/179, the same four failures as in section 2 |
| `widget-check.mjs`, sandbox and production | 4/4 each: widget opens signed in with amount, asset and network prefilled |
| `wallet-journeys.mjs` | the first two runs reached 0/7 and 2/7 respectively: the runner waited fixed seconds and clicked before the wallet existed under load (about 1 100 processes); now it waits for observable states. Third run 6/7: the Solana sell journey stopped at DFX sign-in (see below). After the review of this section the runner exits nonzero when a journey stops or has page errors, and it waits for an element whose whole text is `Buy`/`Sell` (the DFX page title; the widget has no heading role) instead of the word anywhere in the page. Fourth run 7/7, exit 0, 0 page errors (that run's Solana address started with `D`); with the expected titles swapped (a buy journey waiting for `Sell`) the journey stops after 60 s and the runner exits 1. The wait confirms the title only: in the Spark journey the rest of the page was still loading when the text was read. The order check then accepts only a status from DFX or the expected "not yet received at DFX" message for an unpaid order; any other status error stops the journey. Fifth run with that check: 7/7, exit 0, all seven orders "not yet received"; with the check inverted the journey stops and the runner exits 1. In the sandbox a 1 EUR purchase is accepted (production rejects it with `AmountTooLow`, limit 10.57 EUR), so `eth-too-low` is an ordinary flow there |
| `fullstack.mjs` | first run stopped at "sell: bank account via factory API" with `fetch failed` after 3 ms (request never reached the proxy; the same request in isolation returned 201; cause not determined, possibly the 256 open-file limit after 200 `docker exec` calls); second run 29/29 |
| `fullstack-processing.mjs` | 24 steps OK; sell matching as in section 6; the two six-minute observation steps red as in section 11 |
| `fullstack-lifecycle.mjs` (`OBSERVE_MINUTES=15`) | 56 steps OK, 2 red: the crypto payout for buy A and the fiat bank execution for the sale are not prepared by the local stack ("no positive crypto output and fee", "no executable fiat output"; the local stack has no liquidity rules). AML `Pass` for buy A and the sale, `Failed` → `Returned` for buy B; module status matched all seven DFX states observed. `completed` is shown only by the real purchase |
| `kyc-widget.mjs` | module steps green; boundary as in section 7 (14 × `PUT /v2/kyc` 503 in the API log) |
| `safe-deployed.mjs` | the default public Polygon RPC answered HTTP 529 ("upstream overloaded") to the fork request three times; with `ANVIL_FORK_URL=https://polygon.drpc.org` 13/13 |

**Real purchase re-check without payment.** With `20ec94d`, the wallet of section 9 (address checked) and its existing
production DFX account: `getTransactionDetail` for the paid order by external ID returns `completed` (ETH, EUR) with one
signature; a second lookup on the same instance needs no signature; two parallel lookups on a fresh instance share one
sign-in (one signature); `quoteBuy` 20 EUR → ETH on Arbitrum returns a quote; `buy` returns an `app.dfx.swiss/buy` URL
with the same parameters as in section 9 (without an external ID, which the check did not set) and one signature, and
the detail session stays usable afterwards without a new signature. The payment and payout path of DFX were not
repeated.

**DFX backend issue found: Solana addresses starting with `3`.** DFX rejects sign-ins of Solana accounts whose address
starts with `3` with 400 "Invalid signature". Sandbox, fresh throwaway accounts: 5 of 5 addresses starting with `3`
rejected, 5 of 5 others accepted; the rejected signatures verify locally (ed25519) and are sent unchanged. Cause in
the DFX API (development branch): `bitcoinAddressFormat = '([13]|bc1)[a-zA-HJ-NP-Z0-9]{25,62}|…'` also matches
43–44-character Base58 addresses beginning with `1` or `3`; `CryptoService` detects Bitcoin before Solana and
`verifySignature` uses the detected chain (the `blockchain` field is only used for EVM). About 6 % of random Solana
addresses start with `1` or `3` (5.8 % with `3` and 0.4 % with `1` in a simulation of 200 000 random keys).
Production uses the same code; it was not tested there. The module cannot work around it.

## Not covered

- **Solana sign-in for addresses starting with `3` (or `1`).** Fails at DFX (section 12); not fixable in the module.

- **Identification itself (Sumsub) and the external name check.** Both are external providers. The UI flow stops at
  the identification call, and the lifecycle test simulates a completed identification. In the real purchase
  (section 9) the account was already verified.
- **Real sell.** Only a real buy was made (section 9). Selling with real crypto was not tested.
- **USDC with real money.** Both real purchases were ETH (sections 9 and 14). USDC is covered by quotes and widget
  tests only; `e2e/safe-rescue.mjs` and `e2e/bundler-send.mjs` moved USDC out of a Safe only on a fork.
- **Paymasters.** WDK's UserOperation path was exercised with the account paying its own gas in ETH (section 15).
  Sponsored and token paymasters were not exercised.
- **Deposit detection on a real chain.** The sale in the local tests starts from a deposit row as the blockchain scan
  would write it; the scan itself is not exercised.
- **Drift between the recorded sandbox and the live API.** The integration fixtures are a snapshot of
  2026-09-28. Changes in DFX responses after that date show up in `e2e/live-matrix.mjs`, not in `npm run
  test:integration`; re-record with `node tests/integration/record.js`.

## 13. Behaviour superseded on 2026-10-02

The ERC-4337 owner authentication and native-decimals fallback described in
sections 1–12, plus the owner-cache drop and the delivery check limited to non-EVM
or EOA in the 2026-09-30 preamble, are historical results for the revisions named there. In the
current code, sign-in uses the account address. When the recovered signer differs, the account can sign typed
data and the constructor network has a DFX chain id, the module sends a Safe
EIP-712 signature for that address. It does not sign in as the recovered owner.
Bitcoin/BTC, Lightning/BTC and Arkade/BTC are excluded from the recorded sandbox
catalog and rejected by trade methods while their API rows carry `decimals: null`;
sandbox Firo/FIRO remains listed with API `decimals: 8`. In the production catalog recorded on 2026-10-02 (`b5cafa1`), production
returned null for all four, and a fetch of `/v1/asset` on 2026-10-29 still returned null for all four. An API value,
including zero, remains authoritative.

## 14. Real purchase into an undeployed ERC-4337 account (production, 2026-10-29)

A real buy was made from the wallet simulator running against **production** (`WALLET_SIM_ENV=production`) with the
prepared wallet of section 9 and the `base-4337` account (WDK Safe on Base, chain id 8453) on this branch. The
account had no code when it signed in, ordered and received the payout.

- **Owner:** `0x463e558CC8842078CD1FeC6dF1Ff7F54058BE6C7` (the address of section 9).
- **Smart account:** `0xfC4081f16078d3b9f44148Dc4003d6a4F25ED68f`, `eth_getCode` empty until the deployment below.

The user flow in the wallet: *Kaufen* → ETH · Base Smart Account, 15 EUR → *Weiter zu DFX*. The DFX steps in the
widget, including the bank transfer, were completed by hand; how the new address was verified at DFX was not
recorded.

The module calls were recorded by polling the simulator's call log (`/api/log`: method, chain, duration, result)
and its order list every 3 s, writing a line whenever either changed:
[`e2e/evidence/2026-10-29-production-module-calls.jsonl`](e2e/evidence/2026-10-29-production-module-calls.jsonl). The
`Wallet erstellen` call at 08:35:46, the first call after the restart, was a check of the simulator through its API,
not the user's click. Times are UTC.

| Time (UTC) | Source | Event | Smart-account balance |
| --- | --- | --- | --- |
| 09:41:37 | module call log | `buy` on `base-4337` succeeded (1312 ms): sign-in as the undeployed account, order `wallet-1793266896096-6c54e1f70ddf` | 0 ETH |
| 09:43:41 | Base block 53238837 | payout [`0x62b9791994216f2aea099dd4f2bf3cb5a064c3864e76dcd948d786d90602bde8`](https://basescan.org/tx/0x62b9791994216f2aea099dd4f2bf3cb5a064c3864e76dcd948d786d90602bde8), 0.00565071 ETH from `0xFAEefD557ffD2714f16e1A44A165FCd5d6a6b6a0` (the payout address of section 9) | **0.00565071 ETH** |
| 09:59:48 | module call log | `getTransactionDetail` on `base-4337` succeeded; the order list shows `completed` | 0.00565071 ETH |

The same log also holds an order from the EOA account on Base (09:34:15, 15 EUR of ETH) that was not paid and stays
`started`, and two `quoteBuy` calls that returned an error; the call log keeps no error reason.

**Moving the funds out.** The simulator does not send, and no bundler was configured. `e2e/safe-rescue.mjs` (see
[`e2e/README.md`](e2e/README.md)) lets the owner deploy the account through the Safe proxy factory with the factory
data WDK predicts, then call `execTransaction` with a pre-validated owner signature. Before that, the same call
sequence ran on `anvil` forks of Base while the account was still undeployed: once with 20 USDC set into the account
by storage write (2026-10-26) and once with its real 0.00565071 ETH (2026-10-29); both exited 0 with the account at 0
and the destination credited in full. After the real deployment, the USDC path passed again on a fork of the deployed
account (exit 0). On Base itself, with the script as of `9591a53` (before the seed-file, empty-account,
confirmation and gas re-check changes that followed), the owner held 0.00005 ETH for gas. The current script was
run afterwards on a fork of Base at block 53239900, between payout and deployment, with the owner's balance set to
the 0.00005 ETH it held later (at that block it held 0.000000155 ETH, and the script stopped before any transaction):
without `--confirm` it refused; with it, it deployed the account and moved the full 0.00565071 ETH out, exit 0.
The transactions on Base:

| Time (UTC) | Base block | Transaction | Result |
| --- | --- | --- | --- |
| 10:20:43 | 53239948 | [`0x30d9665e9f8d30016b5ef359751737a7ab77e350db474c5f68db0f3f57e535a2`](https://basescan.org/tx/0x30d9665e9f8d30016b5ef359751737a7ab77e350db474c5f68db0f3f57e535a2), owner → factory `0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67` | status 1; the account has code (171 bytes) |
| 10:20:49 | 53239951 | [`0x4b254a8c7ea187160281b1fe9cc1156865a6b15ffab36a0de2ed8e9d4047a278`](https://basescan.org/tx/0x4b254a8c7ea187160281b1fe9cc1156865a6b15ffab36a0de2ed8e9d4047a278), owner → account `execTransaction` | status 1; 0.00565071 ETH to `0x3e0004935eAD42cefB1ecf461847bdB1591f337f`, account balance 0 |

Both transactions together cost the owner 0.000002231746606711 ETH, of which 0.000000001492606711 ETH was the
L1 data fee reported in the receipts; the owner's balance fell by exactly that amount. Balances were re-read from
the chain after the script finished.

**Sandbox, 2026-10-26.** The same simulator against the sandbox, with a new wallet, recorded the catalog and quotes up
to `quoteBuy` on `base-4337`; no order was placed:
[`e2e/evidence/2026-10-26-sandbox-module-calls.jsonl`](e2e/evidence/2026-10-26-sandbox-module-calls.jsonl). The
`base-4337` case of `e2e/live-matrix.mjs` passed 15/15 steps in the sandbox on 2026-10-23 and 2026-10-26 when run alone,
and again within the full sandbox run of 2026-10-29 (section 2).

This is the first run in which an undeployed ERC-4337 account went through every step with real money: sign-in to
production DFX via ERC-6492, widget, bank transfer, on-chain payout, status through the module, and recovery of the
funds with the owner key alone.

## 15. Sending from an ERC-4337 account through a bundler (Base, 2026-10-30)

Section 14 moved the funds out with ordinary owner transactions. This section exercises WDK's own path: the account
builds a UserOperation, the owner key signs it, and a bundler submits it to the EntryPoint
(`0x0000000071727De22E5E9d8BAf0edAc6f37da032`). The account pays its own gas in ETH (`useNativeCoins`); no paymaster
is involved.

**Base itself.** Account 1 of the prepared wallet of sections 9 and 14, `0xdB2E331855F618580c73C66E054dF9C99dA2FD21`,
had no code. 0.0005 ETH was sent to it by hand. Three UserOperations then went through the public bundler
`https://api.candide.dev/public/v3/8453` to `0x3e0004935eAD42cefB1ecf461847bdB1591f337f`. A one-off script, not
committed, sent them with the same WDK calls that `e2e/bundler-send.mjs` makes (`quoteSendTransaction`,
`sendTransaction`, `getUserOperationReceipt`) and wrote one JSON line per step:
[`e2e/evidence/2026-10-30-bundler-sends.jsonl`](e2e/evidence/2026-10-30-bundler-sends.jsonl). Each bundling
transaction was then read from a Base RPC, not from the bundler: status 1 and one `UserOperationEvent` with
`success = true`. Times are UTC, when the step was logged after its receipt.

| Time (UTC) | Base block | Transaction | Sent | Gas (`actualGasCost`) |
| --- | --- | --- | --- | --- |
| 10:09:58 | 53282825 | [`0xe69dd32c5865995af2a5be9661af9a3a07c153a5633a8778323e5599e06734f8`](https://basescan.org/tx/0xe69dd32c5865995af2a5be9661af9a3a07c153a5633a8778323e5599e06734f8) | 0.0001 ETH; the account had no code before and has code after | 0.0000026534636 ETH |
| 10:10:10 | 53282831 | [`0x0f877e6e0b731e63fa3db480ebd7cd83bd68f86562c5651398f0b92de81f7882`](https://basescan.org/tx/0x0f877e6e0b731e63fa3db480ebd7cd83bd68f86562c5651398f0b92de81f7882) | 0.0001 ETH | 0.0000007898366 ETH |
| 10:10:28 | 53282840 | [`0x19454c9d48b129b8053875d7db75efa96161b62d13ff8ceea7c854b29aabde11`](https://basescan.org/tx/0x19454c9d48b129b8053875d7db75efa96161b62d13ff8ceea7c854b29aabde11) | 0.00029372004904 ETH, the balance less a reserve for gas | 0.0000007901838 ETH |

The destination received 0.00049372004904 ETH in total. Of the remaining 0.00000627995096 ETH, 0.000004233484 ETH was
gas, 0.00000154088836 ETH stayed in the account and 0.0000005055786 ETH stayed as its deposit in the EntryPoint. Each
send's account spending was its amount plus the part of the gas prefund its EntryPoint deposit did not cover; the
unspent prefund stays as that deposit.

**The committed script on a fork.** `e2e/bundler-send.mjs` ran with a random seed on an `anvil` fork of Base
(block 53284892; restarted at 53285479 after the public RPC refused state of the older block) with Pimlico Alto 0.0.21
as the local bundler (`--safe-mode false`). Fork gas used `anvil`'s 1 gwei priority fee, so its amounts are far above
Base's.

- Exit 0: a dry run; an ETH send of 0.001 that deployed the account; an ETH send of 0.002; a USDC `transfer` of 1.25
  (account 5 → 3.75 USDC, destination credited exactly); `--all`, which sent 0.0056763440854 ETH and left
  0.0002545312376 ETH in the account and 0.000071362987 ETH in the EntryPoint.
- Exit 1 before any UserOperation: `--send` without `--confirm`; `--bundler` pointing to the plain RPC
  (`eth_supportedEntryPoints` not found); an amount above the account's ETH; account ETH of 0.001 below an amount of
  0.002 while its EntryPoint deposit was 0.05 ETH. ETH sent to the USDC contract, which rejects ETH, was refused by the
  bundler at gas estimation; nothing was sent.
- Six mutations of the checks after sending were each detected with exit 1: the destination expected to hold one unit
  more; the event's and the bundler's `success` checks inverted; the exactly-one-event check changed; the upper bound
  of the ETH spent set to the amount; the account's token balance expected one unit lower. With the check "account
  ETH below the amount" removed, the case with the 0.05 ETH deposit sent a UserOperation that settled with
  `success = false` and was charged gas; the script reported `UserOperationEvent success is false`, exit 1.

On Base itself, a dry run of the committed script for account 1 passed the bundler checks and quoted
0.00000155875104 ETH for a send of 0.000001 ETH; `--all` stopped because the remainder was below 1.5 times the quoted
fee.

**Not shown here:** paymasters (sponsored or token); USDC through a bundler with real money; the committed script
moving real funds (the real sends above used the one-off script with the same WDK calls); bundlers other than
Candide on Base and Alto on a fork.

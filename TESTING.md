# Testing

The canonical description of the layers is `docs/test-architecture.md` in `DFXswiss/backend`.
This file describes the layers this repository owns. Current state and target are separate.
Nothing here describes a capability as existing when it does not.

## The layers this repository owns

| Layer | Lives in | What it proves | What it cannot prove | Runs in CI |
| --- | --- | --- | --- | --- |
| Unit | `tests/`, excluding `tests/integration/` | Public methods against injected HTTP responses, including status mapping and input validation | The live DFX API, a chain, or a wallet user interface | Yes, `npm run test:coverage`, which runs this layer and the recorded-response integration layer (`jest.coverage.config.js`) |
| Recorded-response integration | `tests/integration/` | Catalogs, quotes and authenticated URLs and details against a local server that replays a sandbox recording | The live DFX API as it answers today | Yes, `npm run test:coverage`, which runs this layer and the unit layer (`jest.coverage.config.js`) |
| Live API checks | `e2e/live-matrix.mjs`, `e2e/signature-diff.mjs`, `e2e/native-quotes.mjs`, `e2e/bare-smoke.mjs` | Live matrix and native quotes call the live sandbox or production API. Signature diff compares normalization locally. Bare smoke loads the Bare entry | An on-chain deposit. The matrix and native quotes send none. Bare smoke does not call the DFX API | No |
| Hybrid real runs | `e2e/real-sell.mjs`, `e2e/real-buy.mjs`, `e2e/bundler-send.mjs`, `e2e/safe-rescue.mjs` | For a passing sell, a deposit sent by the script, one sandbox row for that hash, and at `PayoutInProgress` or `Completed` a finite `outputAmount` greater than 0 with `outputAsset` EUR. A passing buy compares the payout transfer with the balance change, and the USDC transfer rounded to 5 significant digits half up equals `outputAmount`. Bundler send and safe rescue move a Base balance when `--send` is set | That a wallet user interface confirmed the transaction, or that a bank paid the fiat | No |
| Real sale in a wallet user interface | `e2e/wallet-ui/` | The patched starter wallet, in the iOS simulator, confirms 1 USDT or 0.0001 ETH on Sepolia or leaves the review screen. The sandbox finds that hash itself | A smart account, a purchase, the bank payout, a physical device, or an unpatched wallet | No |

Two rules, from the canonical document, govern where a test belongs:

1. A failure mode is tested at the lowest layer that can express it.
2. Test code lives in the repository whose code it proves.

The processing behind the DFX API — bank receipt, AML, liquidity, payout and booking — cannot be tested from this repository. The canonical document places that processing in the integration layer of `DFXswiss/backend`.

## Current state — measured

Measured on `99ec31e`, 2026-11-17, Node v22.23.5.

| Command | Result |
| --- | --- |
| `npm test` | 765/765 tests in 2 suites |
| `npm run test:integration` | 35/35 tests in 1 suite |
| `npm run test:coverage` | 800/800 tests in 3 suites; 100% statements, branches, functions and lines |
| `npm run lint` | No findings. At that commit the script was `standard` only |

Older unit and coverage counts in previous revisions of this file had no recorded commit. They are not repeated here.

Live probes below have a date. A row without a recorded commit says `commit not recorded`.

| Probe | Result | Date | Commit |
| --- | --- | --- | --- |
| `e2e/live-matrix.mjs`, sandbox | 178/186 steps | 2026-10-29, and the same count on 2026-11-05 | commit not recorded |
| `e2e/live-matrix.mjs`, production | 182/187 steps | 2026-10-29 | commit not recorded |
| `e2e/live-matrix.mjs`, production | 177/178 steps | 2026-11-05 | commit not recorded |
| `e2e/signature-diff.mjs` | 0 mismatches in 20,000 Solana and 5,000 Spark signatures, including a re-run | 2026-11-05 | commit not recorded |
| `e2e/native-quotes.mjs` | Historical, before the native decimals fallback: sandbox listed only Firo among Bitcoin, Lightning, Arkade and Firo; production listed none; unlisted assets were rejected with `Missing decimals`. The production run after the fallback is the 2026-11-24 `DFX_ENV=production node native-quotes.mjs` row | re-run 2026-11-05 | commit not recorded |
| `e2e/bare-smoke.mjs` | 4/4. Bare runtime v1.35.0, with `bare@1.34.1` | 2026-10-20 | commit not recorded |
| `e2e/bare-smoke.mjs` | 4/4. Bare runtime v1.36.0, with `bare@1.34.1` | 2026-11-05 | commit not recorded |
| `GET https://api.dfx.swiss/v1/asset` | `Bitcoin/BTC` decimals null, buyable true, sellable true; `Lightning/BTC` null, true, true; `Arkade/BTC` null, false, false; `BitcoinTestnet4/BTC` null, false, false; `Firo/FIRO` null, false, false | 2026-11-24 | `f9cacbc` |
| `DFX_ENV=production node native-quotes.mjs` | exit 0. bitcoin listed, quoteBuy and quoteSell quoted; lightning listed, both quoted; arkade not listed, both rejected with `Unsupported buy/sell asset or network: BTC`; firo not listed, both rejected with `Unsupported buy/sell asset or network: FIRO` | 2026-11-24 | `f9cacbc` |
| `DFX_ENV=production node live-matrix.mjs` | exit 1, `172/176 steps ok, 7 skipped`. Sign-in succeeded on 12 of 13 cases. The 4 FAILs are all in the solana case: `ProviderError UNAUTHORIZED Invalid signature` on the sign-in step and the three steps that sign in again. Skips: sepolia, tron and spark buy and sell (no buyable and no sellable asset on that network in the API catalog); solana sell (no sellable asset on solana in the API catalog) | 2026-11-24 | `f9cacbc` |

The three 2026-11-24 production rows were measured on macpro, Node v22.22.0, module commit `f9cacbca2fdf685defc797ed7268c0163779e954`, clean tree. Production API `/version` commit `7d14468756fe7ae6c346679424c7c3ed01783454` was the same at start and end.

`e2e/out/matrix-results-sandbox.json` in this tree has no commit and is not the 178/186 record. `e2e/evidence/` holds the real-run rows in the table further down. Those rows name a date. Of the wallet-ui rows, the 2026-11-12 sales and the 2026-11-16 runs name module heads, and the 2026-11-16 red row names the head of its ETH sale; the mutation rows and the 2026-11-12 red row do not.

## E2E requirement

The requirement taken from the review on `DFXswiss/app` #1595: a real wallet with a user interface sends a real transaction on a real chain, the DFX API recognizes that deposit, nothing in between is stubbed, and no API response is rewritten. One test each for an ERC-20 transfer, a native transfer, a rejected network switch and a rejected transfer. Proof that the API recognized the deposit. One test for the core feature. A documented run at the final head. CI is not required.

| Requirement | Status at this head | Evidence |
| --- | --- | --- |
| Real wallet user interface, real chain transaction, API recognizes the deposit, nothing stubbed, no rewritten API response | Partial. The wallet-ui sale sends on Sepolia and the sandbox finds the hash. The #1595 review names "a testnet or a local fork" and "for example the MetaMask extension driven by Synpress"; Maestro, the simulator and the sandbox host are declared. The open point is the wallet itself: the starter is patched and sends Ethereum through the plain EVM wallet instead of its gasless package | `e2e/wallet-ui/`, `docs/test-reality/sale-in-a-wallet-user-interface.json` |
| ERC-20 transfer, 1 USDT | Covered | 2026-11-16, module head `6150990`, sandbox id 10090, `PayoutInProgress`. Also 2026-11-12 at `97f9e71` and `2feecb3`. See the evidence table |
| Native transfer, 0.0001 ETH | Covered | 2026-11-16, module head `6150990`, sandbox id 10089, `PayoutInProgress` |
| Rejected network switch | Not applicable | The sell page is a `WebView` with no injected provider (`e2e/wallet-ui/starter.patch`, `src/app/sell/index.tsx`). This repository has no `wallet_switchEthereumChain` call. The transfer is sent from the wallet's own send screen |
| Rejected transfer | Covered | 2026-11-16, `--reject`, at `9375cd1` and again at `6150990`. No confirm tap, nonce and balances unchanged, no new sale |
| API recognition | Covered for the sandbox. The runner does not submit the hash. The sandbox list is read and matched on `inputTxId` | `e2e/wallet-ui/run-sale.mjs` |
| Core feature | Sale covered. A purchase in a wallet user interface, and a sale from a smart account in a wallet user interface, are not covered | Known gaps |
| Documented run at the final head | Not in this file. The pull request carries it. The rows below are earlier heads, not `99ec31e` | Evidence table |
| CI | Not required, and this run is not in CI | No workflow under `.github/` names `wallet-ui`, `live-matrix` or `real-sell` |

## Reality declaration

Declarations live in [`docs/test-reality/`](docs/test-reality/), one JSON record per area. Each entry states the component, the status, the mechanism with file citations, what stands there in production, and one sentence for what a green run does not prove.

`npm run docs:reality:check` checks those records. `npm run lint` runs it after `standard`. The checker is `scripts/test-reality/check.js` and `scripts/test-reality/lib.js`, copied unchanged from `DFXswiss/backend` `scripts/test-reality/` at `36dfb41`. This package is `"type": "module"`, so `scripts/test-reality/package.json` sets `"type": "commonjs"` and the two copied files stay byte-identical to that commit.

A run whose fakes are not declared is an incomplete result.

## Known gaps

- **Purchase in a wallet user interface.** On 2026-11-17 the sandbox reported all four Sepolia assets with `buyable: false`, measured with `GET /v1/asset?blockchains=Sepolia`, 2026-11-17, no module commit involved (`commit not recorded`). This repository does not call `PUT /v1/buy/:id/simulatePayment`. A simulated bank receipt through that route would be a declared fake.
- **Sale from a smart account in a wallet user interface.** The patched starter registers Ethereum as a plain EVM account, not an ERC-4337 account. A hybrid sandbox sale from a fresh Safe, id 10035, reached `Processing` and the follow timed out (`e2e/evidence/2026-11-09-sandbox-real-sell-pimlico.jsonl`, run `red6-18f0acf-safe-sell-stays-processing`, commit `78264680`, 2026-11-09).
- **Bank payout.** This repository does not pay out from a bank. `e2e/real-sell.mjs` and the wallet-ui runner return when the sandbox state is `PayoutInProgress` or `Completed` and do not read a bank debit. Recorded wallet-ui sales stopped at `PayoutInProgress`.
- **The wallet-ui run does not run in CI.** A weekly run outside CI that repeats it is not in this repository.
- **Solana sign-in when the address matches the Bitcoin format.** This is a DFX API defect, not a module defect. Measured the same day, 2026-11-24. The DFX API detects the chain of a sign-in address by regular expressions in a fixed order and tests the Bitcoin format `([13]|bc1)[a-zA-HJ-NP-Z0-9]{25,62}` before the Solana format, so a Solana address that begins with `1` or `3` is verified as a Bitcoin address and rejected. 174 of 3000 random WDK Solana addresses (5.80 %) match that Bitcoin format. A targeted production sign-in with a Solana address beginning with `3` returned `Invalid signature`; one beginning with `9` signed in. The module's signature for both is valid (offline ed25519 verification, 200 of 200), and the earlier 2026-11-24 production run at the uncommitted tree signed in on all 13 cases with another random seed. `DFX_ENV=production node live-matrix.mjs` at `f9cacbc` exited 1, `172/176 steps ok, 7 skipped`. Sign-in succeeded on 12 of 13 cases. The 4 FAILs are all in the solana case: `ProviderError UNAUTHORIZED Invalid signature` on the sign-in step and the three steps that sign in again. The live matrix uses a random seed per run, so its solana case fails in about 6 % of runs until the DFX API checks the Solana format before the Bitcoin format.

## Target

_Target — not built._

1. A purchase confirmed in a wallet user interface.
2. A sale from a smart account confirmed in a wallet user interface.

## How to run

```sh
npm run lint && npm test
npm run test:integration
npm run test:coverage
(cd e2e && node signature-diff.mjs)
(cd e2e && node native-quotes.mjs)
(cd e2e && DFX_ENV=sandbox node live-matrix.mjs)
(cd e2e && npx --yes bare@1.34.1 bare-smoke.mjs)
```

`npm run lint` is `standard` and then `npm run docs:reality:check`. The counts in [Current state](#current-state--measured) are the ones measured on `99ec31e`. The live-probe sentences there name the date and, where no commit was recorded, say so.

Sell and buy commands, flags and exit codes are in [e2e/README.md](e2e/README.md). A sell or buy record (`dfx-real-run/v1`) is written only after a passing run with a clean tree, to the file given by `--record`.

## Real-run evidence

| Date | Script | Network | Result | Evidence |
| --- | --- | --- | --- | --- |
| 2026-10-30 | one-off script, not in this tree; same WDK calls as `bundler-send.mjs` | Base | three UserOperations from an account that had no code; the first deployed it; each receipt status 1 and `UserOperationEvent` `success` true | [e2e/evidence/2026-10-30-bundler-sends.jsonl](e2e/evidence/2026-10-30-bundler-sends.jsonl) |
| 2026-10-30 | `bundler-send.mjs` | Base | 1 USDC and remaining ETH (`--all`), each exit 0 | [e2e/evidence/2026-10-30-bundler-send-script.jsonl](e2e/evidence/2026-10-30-bundler-send-script.jsonl) |
| 2026-11-02 | `real-sell.mjs` | Sepolia sandbox | exit 0; 1 USDT and 0.0001 ETH; each receipt status 1; sandbox recognized each hash; module `in_progress` | [e2e/evidence/2026-11-02-sandbox-real-sell.jsonl](e2e/evidence/2026-11-02-sandbox-real-sell.jsonl) |
| 2026-11-02 | `real-sell.mjs` | Sepolia sandbox | exit 1 at the receipt check after 1 USDT (no `gasUsed` or `effectiveGasPrice` in the receipt) | [e2e/evidence/2026-11-02-sandbox-real-sell-red.jsonl](e2e/evidence/2026-11-02-sandbox-real-sell-red.jsonl) |
| 2026-11-02 | `real-sell.mjs` | Sepolia sandbox | 6/6 mutations of its checks detected | [e2e/evidence/2026-11-02-sandbox-real-sell-mutations.jsonl](e2e/evidence/2026-11-02-sandbox-real-sell-mutations.jsonl) |
| 2026-11-04 | `real-sell.mjs` | Sepolia sandbox | exit 0 for the EOA and for a fresh undeployed Safe; all four deposits (USDT and ETH for each account) recognized | [e2e/evidence/2026-11-04-sandbox-real-sell.jsonl](e2e/evidence/2026-11-04-sandbox-real-sell.jsonl) |
| 2026-11-04 | `real-sell.mjs` | Sepolia sandbox | exit 1: `block not found` on a read at the receipt block | [e2e/evidence/2026-11-04-sandbox-real-sell-red.jsonl](e2e/evidence/2026-11-04-sandbox-real-sell-red.jsonl) |
| 2026-11-04 | `real-sell.mjs` | Sepolia sandbox | 12/12 mutations detected | [e2e/evidence/2026-11-04-sandbox-real-sell-mutations.jsonl](e2e/evidence/2026-11-04-sandbox-real-sell-mutations.jsonl) |
| 2026-11-05 | `real-sell.mjs` | Sepolia sandbox | exit 1: the Safe balance check read a public node that did not yet have the funding block and saw 0 ETH; the file ends at `funding-receipt` because the error was then written only to stderr | [e2e/evidence/2026-11-05-sandbox-real-sell-red.jsonl](e2e/evidence/2026-11-05-sandbox-real-sell-red.jsonl) |
| 2026-11-05 | `real-sell.mjs` | Sepolia sandbox | exit 1: `header not found` at the receipt block | [e2e/evidence/2026-11-05-sandbox-real-sell-red-2.jsonl](e2e/evidence/2026-11-05-sandbox-real-sell-red-2.jsonl) |
| 2026-11-05 | `real-sell.mjs` | Sepolia sandbox | twelve mutations; all twelve exited 1 at the changed check, and the three that stop before the sale deposit sent nothing to DFX | [e2e/evidence/2026-11-05-sandbox-real-sell-mutations.jsonl](e2e/evidence/2026-11-05-sandbox-real-sell-mutations.jsonl) |
| 2026-11-06 | `real-sell.mjs` | Sepolia sandbox | two IBAN-path mutations without `--send`; each exit 1; nothing sent | [e2e/evidence/2026-11-06-sandbox-real-sell-iban.jsonl](e2e/evidence/2026-11-06-sandbox-real-sell-iban.jsonl) |
| 2026-11-07 | `real-sell.mjs` and `real-buy.mjs` | Sepolia sandbox for the three `real-sell.mjs` mutations; the `real-buy.mjs` mutation used the Sepolia test seed | three mutations of `real-sell.mjs` run against the Sepolia sandbox (one sent 1 USDT and exited 1 at the booking page, one exited 3 before anything was sent, and one exited 3 because the tree was dirty, where exit 2 was expected); one clean-tree mutation of `real-buy.mjs` that exited 3 after the quote and created no purchase URL; two IBAN-mask mutations that exited 1 without sending | [e2e/evidence/2026-11-07-sandbox-real-sell-v2.jsonl](e2e/evidence/2026-11-07-sandbox-real-sell-v2.jsonl) |
| 2026-11-09 | `real-sell.mjs` | Sepolia sandbox | six runs ended red; two of them were on 2026-11-07 | [e2e/evidence/2026-11-09-sandbox-real-sell-pimlico.jsonl](e2e/evidence/2026-11-09-sandbox-real-sell-pimlico.jsonl) |
| 2026-11-12 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | exit 0 twice (module heads `97f9e71` and `2feecb3`); each sale of 1 USDT confirmed by one tap in the starter wallet, receipt status 1, found by the sandbox itself and booked to `PayoutInProgress` | [e2e/evidence/2026-11-12-wallet-ui-sale.jsonl](e2e/evidence/2026-11-12-wallet-ui-sale.jsonl) |
| 2026-11-12 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | 15/15 mutations detected: each run exited 1 at the changed check | [e2e/evidence/2026-11-12-wallet-ui-sale-mutations.jsonl](e2e/evidence/2026-11-12-wallet-ui-sale-mutations.jsonl) |
| 2026-11-12 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | two runs ended red: a scroll timeout before anything was sent, and HTTP 502 from the sandbox during the wait for the booking | [e2e/evidence/2026-11-12-wallet-ui-sale-red.jsonl](e2e/evidence/2026-11-12-wallet-ui-sale-red.jsonl) |
| 2026-11-16 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | exit 0 four times: a rejected USDT transfer at `9375cd1`; at `6150990` a sale of 0.0001 ETH (id 10089), a rejected USDT transfer and a sale of 1 USDT (id 10090). Each sale was confirmed by one tap and booked to `PayoutInProgress`; each rejected transfer left the review screen with no confirm tap, the nonce and balances unchanged and no new sale | [e2e/evidence/2026-11-16-wallet-ui-runs.jsonl](e2e/evidence/2026-11-16-wallet-ui-runs.jsonl) |
| 2026-11-16 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | 19/19 mutations of the ETH-sale and `--reject` checks detected: each run exited 1 at the changed check | [e2e/evidence/2026-11-16-wallet-ui-mutations.jsonl](e2e/evidence/2026-11-16-wallet-ui-mutations.jsonl) |
| 2026-11-16 | `wallet-ui/run-sale.mjs` | Sepolia sandbox | two runs ended red: the ETH sale at `9375cd1` (its check required a receipt without logs; the native transfer carries one EIP-7708 log), and a mutant run in which the sell page did not show the bank step before anything was sent | [e2e/evidence/2026-11-16-wallet-ui-red.jsonl](e2e/evidence/2026-11-16-wallet-ui-red.jsonl) |

## Keeping this document honest

- Every number carries the commit it was measured on, the command that produces it, and the date. A number without a commit says `commit not recorded`.
- When a layer changes what it proves, this document changes in the same pull request.
- When a fake is added, removed or altered, its declaration changes in the same pull request.

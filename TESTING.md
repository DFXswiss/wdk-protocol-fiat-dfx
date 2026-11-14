# Testing

Recorded results below are taken from runs of this module. Counts are the ones those runs reported.

## Layers

The coverage test checks handbook images and the token allowlist against their redaction records. CI also runs OCR and QR scanning against the per-image word allowlist with `npm run handbook:redaction:check`.

**Unit tests.** Command: `npm test` (lint: `npm run lint`).

Proves the public methods against injected HTTP responses, including status mapping and input validation.

Does NOT prove the live DFX API, a chain, or a wallet user interface.

Recorded: lint output empty; 711/711 tests in 2 suites. On 2026-11-06 with environment `local`: 756/756 tests in 2 suites.

**Recorded-response integration tests.** Command: `npm run test:integration`. Included in `npm run test:coverage`.

Proves catalogs, quotes and authenticated URLs and details against a local server that replays recorded sandbox responses, with no network.

Does NOT prove the live DFX API. The recording is dated in `tests/integration/fixtures/sandbox.json` (`recordedAt`, 2026-09-28).

Recorded: 35/35 tests in 1 suite. Coverage of unit plus integration: 746/746 tests in 3 suites, 100% statements, branches, functions and lines, on Node v26.7.0 and again on Node v22.23.4 (2026-10-29). On 2026-11-06 with environment `local` (Node v22.23.4): 791/791 tests in 3 suites, 100%.

**Live matrix.** Command: `cd e2e && DFX_ENV=sandbox node live-matrix.mjs` (or `DFX_ENV=production`). Optional last argument selects one chain. Writes `e2e/out/matrix-results-<environment>.json`. Exit 0 only when every step passed.

Proves the public methods against the live sandbox or production API for the chains in the script.

Does NOT prove an on-chain deposit or payout: the script sends no on-chain transaction. Sign-in calls `POST /v1/auth` and can create a DFX user, so the run is not only a read.

Recorded sandbox: 178/186 steps (2026-10-29, and the same count on 2026-11-05). The 8 failures are two assets the sandbox does not list as buyable. Polygon and Base ERC-4337 passed every step on 2026-10-29 and on 2026-11-05. Recorded production: 182/187 steps (2026-10-29); the 5 failures are Sepolia, a testnet asset in the production catalog. On 2026-11-05 production was 177/178, catalogue data only.

**Real runs without a wallet user interface (hybrid).** `e2e/real-sell.mjs` on Sepolia against the sandbox, and `e2e/real-buy.mjs` on Base against production. `e2e/bundler-send.mjs` and `e2e/safe-rescue.mjs` send from an ERC-4337 account on Base when `--send` is set.

Proves, for a passing sell, that a deposit from this script was recognized by the sandbox and that balances moved by the amount sent. A passing buy compares the payout transfer with the balance change in the receipt block.

Does NOT prove that a wallet user interface confirmed the transaction. WDK has no confirmation dialog, so a rejected wallet prompt is not covered. No purchase with `real-buy.mjs` is recorded.

**Real sale confirmed in a wallet user interface.** Command: `cd e2e && node wallet-ui/run-sale.mjs …` (see [e2e/wallet-ui/README.md](e2e/wallet-ui/README.md) for the build and flags).

Proves the WDK starter wallet, patched as listed in `e2e/wallet-ui/README.md` and running in the iOS simulator, opens the DFX sell page through this module, sends 1 USDT on Sepolia to the deposit address after one tap on its confirm button, and the sandbox finds that hash by itself and books the sale to `PayoutInProgress` or `Completed`; the receipt, Transfer log, three balance comparisons, the sandbox record and the module's `getTransactionDetail` are checked.

Does NOT prove a rejected confirmation, a smart account, a purchase, the bank payout, a physical device, an unpatched or released wallet, or stability of the sandbox (a booking can stay in `Processing`; the run is then red).

Recorded: 2026-11-12, exit 0 at `97f9e71` and at `2feecb3`; 15/15 mutations of its checks detected. See the table in e2e/wallet-ui/README.md.

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

`signature-diff.mjs` reported 0 mismatches in 20,000 Solana and 5,000 Spark signatures, including a re-run on 2026-11-05. `native-quotes.mjs` expects the sandbox to list only Firo among Bitcoin, Lightning, Arkade and Firo, production to list none of them, and unlisted assets to be rejected with `Missing decimals` (re-run on 2026-11-05 matched that). `bare-smoke.mjs` reported 4/4 on 2026-10-20 (Bare runtime v1.35.0) and again 4/4 on 2026-11-05 (Bare runtime v1.36.0); `bare@1.34.1` both times: `bare.js` loads `DfxProtocol`, a stubbed sandbox sign-in posts the predicted Safe address and the ERC-6492 signature in `e2e/fixtures/bare-smoke-expected.json`, and the stubbed detail request answers 404. No network.

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

## Not covered

The scripts directly under `e2e/` have no wallet user interface and are hybrid. `e2e/wallet-ui/` is the run in which a wallet user interface confirms the transaction. Its limits (simulator, patched starter wallet, automation taps, one EOA sale of 1 USDT) are listed in `e2e/wallet-ui/README.md`.

The live matrix sends no on-chain transaction. Recorded responses are not the live API. No purchase with `real-buy.mjs` is recorded. A rejected wallet prompt is not covered. These runs do not show a production sale or the bank payout of a sandbox sale.

# Wallet interface sale

A Sepolia sale of 1 USDT or 0.0001 ETH for EUR, or the same transfer left on the review screen. The patched WDK starter wallet, installed on the iOS simulator, confirms the send or goes back. A confirmed run requires the sandbox to recognize that hash by itself and book the sale through `PayoutInProgress` or `Completed`. At that state `outputAmount` must be a finite number greater than 0 and `outputAsset` must be EUR. Before that state `outputAmount` may be absent.

This does not cover a smart account, a purchase, or the bank payout. The wallet runs in a simulator, not on a device, and Maestro taps the controls. It does not cover an unpatched or released wallet. A confirmed run saves `sell-widget-open`, `send-review`, and `send-success`. A rejected run saves `sell-widget-open`, `send-review`, and `send-rejected`. The payment-information step is not captured, because that page prints the payout IBAN next to the deposit address. After a confirmed sale is booked, the runner saves the block explorer page and the booking page. A rejected run has no transaction, so it saves neither. The booking can stay in `Processing` on the sandbox; a confirmed run is then red and is recorded as red.

The starter is not upstream. `build.sh` checks out commit `031e210` and applies `starter.patch`. `ethereum` is switched from the gasless wallet package to the plain EVM wallet (`@tetherto/wdk-wallet-evm`) so a Sepolia account can sign the transfer. Arbitrum and Polygon stay gasless. The confirmation logic is unchanged: `sendAsset` and `onConfirm` still send the amount from the route, and `disabled` at `src/app/send/review.tsx:220` in the starter is unchanged. An Ethereum token fee is display-only and is not added to the token total. A native ETH fee is in ETH and is included in the total.

`starter.patch` changes these files:

- `package.json` adds `@tetherto/wdk-wallet-evm` 1.0.0-beta.17 and `@dfx.swiss/wdk-protocol-fiat-dfx` via `file:../../..`.
- `wdk.config.js` points `ethereum` at `@tetherto/wdk-wallet-evm`, registers protocol `dfx`, and limits that protocol's fiat methods on `ethereum` and `polygon` to `quoteSell`, `sell`, and `buy`.
- `src/wdk/networks.ts` builds Ethereum as a plain account (provider only), sets Sepolia USDT to `0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0` with 6 decimals, adds native ETH (`id` `eth-ethereum`, 18 decimals, no contract address) before that USDT row for the DFX ETH sale, and leaves Polygon gasless with asset id `usdt-polygon`. `DFX_BINDING` follows `EXPO_PUBLIC_DFX_TARGET`: unset or `sandbox-sepolia` binds wallet key `ethereum`, network `Sepolia`, and environment `sandbox`; `production-polygon` binds wallet key `polygon`, network `Polygon`, and environment `production`. The indexer still has no token type `eth`, so ETH does not appear in Activity.
- `src/wdk/useSend.ts` quotes an Ethereum token fee with `extension().quoteTransfer` and a native fee with `estimateFee` on the hook return. For native ETH that call is `quoteSendTransaction({ to, value })` and the fee is wei, already in the asset unit. `sendAsset` is unchanged.
- `src/components/Button.tsx` forwards `testID` to the pressable.
- `src/components/SeedWordInputGrid.tsx` adds a `testID` on the first word field, the field that already distributes a pasted phrase.
- `src/app/(onboarding)/import.tsx` adds `import-seed` and `import-submit`.
- `src/app/(onboarding)/password.tsx` adds `password-input`, `password-confirm`, and `password-submit`.
- `src/app/_layout.tsx` presents `sell` and `buy` as full-screen modals, the same way send is presented.
- `src/app/buy/_layout.tsx` uses the same stack-plus-toast shell as the other modal routes.
- `src/app/buy/index.tsx` reads `amount` as EUR cents (a positive safe integer; `1100` is 11.00 EUR) and calls `buy` of USDT paid in EUR on `DFX_BINDING.network`. The returned page is shown in a web view. The page URL is not rendered as text and is not logged.
- `src/app/sell/_layout.tsx` uses the same stack-plus-toast shell as the other modal routes.
- `src/app/sell/index.tsx` reads `asset` and an optional `amount`. `amount`, when present, is the crypto amount in base units (a positive safe integer). Without it, `ETH` sells 0.0001 ETH (`100000000000000` wei) and any other asset sells 1 USDT (`1000000` base units), to EUR, on `DFX_BINDING.network` (`Sepolia` or `Polygon`). `ETH` on the production target shows `No native ETH sale on Polygon` and does not call `sell`. The returned page is shown in a web view. The page URL is not rendered as text and is not logged.
- `src/app/(app)/(tabs)/wallet.tsx` adds `send-entry` and `sell-entry` (1 USDT). On that row, `wallet-buy` is labeled `Buy` and opens `/buy?amount=1100`, and `sell-eth-entry` is labeled `Sell ETH` and opens `/sell?asset=ETH`. The original Buy button on the first row stays disabled.
- `src/app/send/index.tsx` adds `send-asset-usdt-ethereum` on the Sepolia USDT row, `send-asset-eth-ethereum` on the Sepolia ETH row, and `send-asset-usdt-polygon` on the Polygon USDT row. Other rows have no send test id.
- `src/app/send/amount.tsx` adds `send-recipient`, `send-amount`, and `send-continue`.
- `src/app/send/review.tsx` adds `send-confirm`. A token fee line does not change the amount that is sent. A native ETH fee is included in the total. `onConfirm` and `disabled` are unchanged. Back is the header control labeled `Go back`.
- `src/app/send/success.tsx` adds `send-success-hash` and sets `accessibilityLabel` to the full hash, because the visible text is shortened.

`.npmrc` is not part of the patch. `build.sh` writes `install-links=true` into the starter checkout because the `file:` dependency needs one shared package copy.

## Prerequisites

Xcode, CocoaPods, the iOS 26.5 simulator runtime (the only permitted runtime), Maestro 2.10, a JDK on `PATH`, and Node.js 22 or newer. Install the module probes once with `npm ci` in `e2e/` before `run-sale.mjs`. The app aborts at launch on iOS 27.0. CocoaPods is required by `npx expo prebuild --platform ios`.

`STARTER_COMMIT` defaults to `031e210e8d7ef322a9c3100f5aed3f4b7c6e34e6`, the full hash of `031e210`. An override must be that same hash. The script stops if the checkout is any other commit. That hash is not in the patch. Leave `STARTER_WORKSPACE` and `STARTER_SCHEME` empty to use the single non-Pods workspace and the single shared scheme under `ios/`. Set them when that discovery is not unique.

The module working tree must be clean. `build.sh` stops if `e2e/wallet-ui/.starter` already exists. A failed build leaves that directory; delete it before running the script again. The script does not overwrite it.

## Build

From `e2e/wallet-ui/`:

```sh
./build.sh <simulator-udid>
```

The script clones the starter, checks out `STARTER_COMMIT`, applies `starter.patch`, copies `.env.example` to `.env`, writes `.npmrc`, and installs. The starter does not commit `ios/`. The script then runs `npx expo prebuild --clean --platform ios`, which creates that directory and needs CocoaPods, and only then looks up the workspace and scheme. It builds a Release simulator app with `IPHONEOS_DEPLOYMENT_TARGET=17.0`, terminates and uninstalls any copy already on the simulator, and installs the new app. The script checks the Ethereum provider in `.env` for the Sepolia chain id and does not print `.env`. The script then writes `out/build.json` with the module head, the starter commit, the patch digest, the digest of `main.jsbundle` in the installed app, and the build target.

`DFX_TARGET` selects the build. Unset or `sandbox-sepolia` keeps the Sepolia sandbox binding on the plain Ethereum account. `production-polygon` appends `EXPO_PUBLIC_DFX_TARGET=production-polygon` to the starter `.env` and requires `EXPO_PUBLIC_EVM_POLYGON_PROVIDER` to report chain id `0x89`. Any other value exits 2 before cloning. That production build binds DFX to `environment: 'production'` and the starter's Polygon gasless wallet, and both builds open Buy for 11.00 EUR beside Sell. `out/build.json` records `target`.

## Run

From `e2e/`:

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid>
```

That is the preflight. It does not paste the seed, does not start Maestro against the app, does not send, and writes no record. It requires the booted simulator to use iOS 26.5 and Maestro 2.10. Exit 0 means the tree, the installed sale build, the simulator, Maestro, the sandbox version, and the account balance are ready. `--asset` is `usdt` (default) or `eth`. Preflight for `usdt` requires at least 1 USDT and 0.0002 ETH. Preflight for `eth` requires at least 0.0001 ETH plus 0.0002 ETH, and does not also require 1 USDT. The same balance gate applies to a rejected run of that asset. The build checks that the starter's configured Ethereum provider reports the Sepolia chain ID before building. Preflight compares the installed module copy with the working tree right after it reads HEAD and checks that the tree is clean.

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid> \
  --send --confirm --follow <minutes> --screenshots <dir> --record <file>
```

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid> \
  --asset eth --send --confirm --follow <minutes> --screenshots <dir> --record <file>
```

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid> \
  --asset usdt --send --reject --follow <minutes> --screenshots <dir> --record <file>
```

`--send` needs exactly one of `--confirm` or `--reject`. Neither flag is accepted without `--send`, and the two flags are not accepted together. `--reject` has the same `--follow`, `--screenshots` and `--record` requirements as a sale. `--follow` is 1 to 240 minutes: the booking wait for a sale, and the observation window for a rejection. `--screenshots` must be a directory owned by the current user with mode `0700`. A sale must not already find `sell-widget-open.png`, `send-review.png`, or `send-success.png` there. A rejection must not already find `sell-widget-open.png`, `send-review.png`, or `send-rejected.png`. `--record` must not exist yet, must not be the seed file, and must not be inside the `--screenshots` directory. `--rpc` defaults to `https://ethereum-sepolia-rpc.publicnode.com`. A sale record has `mode` `sale` and `asset` `USDT` or `ETH`. A rejection record has `mode` `rejected`, `walletConfirmations` 0, and no hash, block, gas used, fee, module status, or explorer reload count.

A send takes a fixed lock directory in the system temporary directory before checking for another Maestro process and normally holds it through cleanup. A second signal during cleanup attempts to release it before exiting. A lock left after a crash must be deleted by hand. Preflight without a send takes no lock.

Exit 0 is a pass. Exit 1 is a failed check; the record file then holds one JSONL line with `result` `fail` and `failedCheck`, unless the record cannot be written. A failed flow records the first failed Maestro step as `failedStep` with the IBAN masked; it is also printed when the flow failure stops the run. Exit 2 is usage. Exit 3 means the run did not start: the reason is printed and no record is written; this includes an occupied or uncreatable lock. The runner starts each flow once and never restarts a flow or a step, so `maestroStepRetries` is always 0; it states how the runner works and is not a measurement of what Maestro does inside one step. On a sale, the receipt is read for up to 60 seconds, fixed-block balance reads are repeated when a node is lagging, the backend record is read every 20 seconds until `--follow` ends. At `PayoutInProgress` or `Completed`, `outputAmount` must be a finite number greater than 0 and `outputAsset` must be EUR; either may be absent while the sale is still open. The explorer page is reloaded for up to five minutes until it shows the hash and Success. A USDT receipt must have one token Transfer log. An ETH receipt must have the one EIP-7708 system Transfer log measured on Sepolia. On a rejection, the runner waits `--follow` minutes and then checks that the nonce is unchanged, that the balances are unchanged (three for USDT: account USDT, account ETH and deposit USDT; two for ETH: account ETH and deposit ETH), and that the transaction list has no new sale of that asset. The record counts backend reads in `backendReads` and RPC read retries in `rpcReadRetries`. A sale record also counts explorer reloads in `explorerReloads`. A second Maestro process on the machine makes the preflight exit 3, and makes the gap between the two flows exit 1 with `nothing sent`. Neither the runner nor the patched wallet reports the hash to DFX; the runner only reads the transaction list by `inputTxId`, and `detection` `self` states that rather than a value read from the backend. A rejection does not look up a hash. It compares the transaction list with the ids read after flow 1.

Exit 130 or 143 means the run was interrupted by SIGINT or SIGTERM. The runner then starts no further send flow, stops the running Maestro process unless the cleanup flow is running, clears the clipboard and the wallet state, writes a record with `failedCheck` `interrupted` when flow 1 had started, `--record` is set and no record was written yet, and releases the lock. A signal before flow 1 starts writes no record. If a record write is already in progress, it is allowed to finish and may record the earlier result instead. Cleanup errors are reported and can leave state behind. A termination that cannot be caught (SIGKILL, power loss), or a second signal during that cleanup, can leave the seed in the simulator; erase the simulator before the next run.

The seed file is given to the simulator clipboard through a file descriptor. The IBAN is a new Swiss IBAN for that run (clearing `00000`). Each run therefore adds one bank account to the test account, and the flow scrolls past all of them to reach the IBAN field; it allows three minutes for that. Each run also opens a second sandbox sale without a deposit, because `sell()` is the public call that returns a session for the backend reads. Flow 1 requires the IBAN of the run to be visible on the Payment Information screen. The record stores `CH 00000 (invented per run)` and does not store the IBAN. Before a record is written, the runner tries up to three times to clear the clipboard. The record reports the result in `clipboardCleared`. If clearing fails, the run exits 1 and the clipboard must be cleared by hand; an earlier failed check remains in the record. Once flow 1 has started, `flow/cleanup.yaml` clears the app state and keychain, waits for the import entry and stops the app. The record reports `walletStateCleared`; cleanup failure makes a passing run fail and preserves any earlier failure.

## Production sale

A production sale is `node wallet-ui/run-sale.mjs --target production-polygon --amount <USDT>`. Flow 1 is `flow/sell-1-widget-saved-iban.yaml`. The flow opens the sale screen by link with the amount. The payout goes to the account holder's single active bank account. That account is never typed, printed, or recorded. The send is an EIP-7702 gasless user operation. There is no rejection run on production.

## Traps

The send and cleanup flows are `flow/sell-1-widget.yaml`, `flow/sell-2-send.yaml`, `flow/sell-2-reject.yaml`, and `flow/cleanup.yaml`. The production sale uses `flow/sell-1-widget-saved-iban.yaml` in place of `flow/sell-1-widget.yaml`. Flow 1 taps `${SELL_ENTRY}` (`sell-entry` or `sell-eth-entry`). Flow 2 taps the asset row, types the amount, and opens review. `sell-2-send.yaml` taps `send-confirm` once. `sell-2-reject.yaml` taps `Go back` and does not tap `send-confirm`.

The flows are inputs of `run-sale.mjs` and are not meant to be started on their own. A flow started directly with Maestro can send without the runner's switches, lock, checks, cleanup and record; such a run proves nothing and is not recorded.

Only one Maestro run can use the machine. Two runs share one driver port.

The app aborts at launch on the iOS 27.0 runtime. Use the iOS 26.5 runtime.

Tapping Paste while the clipboard is empty crashes the app. That crash is upstream and is not fixed here.

`npm install` inside the starter follows `file:../../..` into this module. If that install changes the module tree, `build.sh` stops without a build record.

## Recorded runs

Each row holds for the module head it names. The runner, the build script, the patch and the flows changed between the rows; `git log` on this directory lists the changes.

| Date | Module head | Starter | Hash | Block | Backend | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-12 | `97f9e71` | `031e210` | [`0xee18075a60…`](https://eth-sepolia.blockscout.com/tx/0xee18075a60e268b19551da59cc800592ba2c1cb01e69dfe75bef1ab7131b6912) | 12119546 | `b71f7eb`, id 10047, `PayoutInProgress` | pass, exit 0 |
| 2026-11-12 | `2feecb3` | `031e210` | [`0x60036918ad…`](https://eth-sepolia.blockscout.com/tx/0x60036918ad68fffb1cfa69044650ae54e1f97d62c3b8d938ff3099fadb00e7a9) | 12120895 | `7ae9b19`, id 10063, `PayoutInProgress` | pass, exit 0 |
| 2026-11-16 | `9375cd1` | `031e210` | none (`--reject`, USDT) | none | `a46bd01`, no new sale | pass, exit 0; nonce 346 before and after |
| 2026-11-16 | `6150990` | `031e210` | [`0x3696c735fa…`](https://eth-sepolia.blockscout.com/tx/0x3696c735faa428928dccfc3933dbe3a96fe407ff0ceeaf7346e330bcc7ee639d) | 12148221 | `a46bd01`, id 10089, `PayoutInProgress` | pass, exit 0; 0.0001 ETH |
| 2026-11-16 | `6150990` | `031e210` | none (`--reject`, USDT) | none | `a46bd01`, no new sale | pass, exit 0; nonce 347 before and after |
| 2026-11-16 | `6150990` | `031e210` | [`0xd0228f4b7f…`](https://eth-sepolia.blockscout.com/tx/0xd0228f4b7f7236fd52214bb91cac177d056ec198612b3bd1cb2d0d72fe871138) | 12148277 | `a46bd01`, id 10090, `PayoutInProgress` | pass, exit 0; 1 USDT |

The records are in [../evidence/2026-11-12-wallet-ui-sale.jsonl](../evidence/2026-11-12-wallet-ui-sale.jsonl). On the same day each of fifteen checks in `run-sale.mjs` was changed once to a plausible wrong version and the run repeated: 15/15 runs exited 1 at the changed check (12 at `2feecb3`; 3 at `bb00b51`; 14 of them sent 1 USDT first; the record of one of the 14 has no hash because its changed check failed before the hash was stored), see [../evidence/2026-11-12-wallet-ui-sale-mutations.jsonl](../evidence/2026-11-12-wallet-ui-sale-mutations.jsonl). Two further runs ended red for other reasons, see [../evidence/2026-11-12-wallet-ui-sale-red.jsonl](../evidence/2026-11-12-wallet-ui-sale-red.jsonl).

The 2026-11-16 records are in [../evidence/2026-11-16-wallet-ui-runs.jsonl](../evidence/2026-11-16-wallet-ui-runs.jsonl). At `6150990` each of nineteen checks added for the ETH sale and for `--reject` was changed once to a plausible wrong version and the run repeated: 19/19 runs exited 1 at the changed check. The twelve ETH-sale mutants each sent 0.0001 ETH first; the seven `--reject` mutants sent nothing. See [../evidence/2026-11-16-wallet-ui-mutations.jsonl](../evidence/2026-11-16-wallet-ui-mutations.jsonl). Two runs ended red for other reasons: the ETH sale at `9375cd1`, whose check required a receipt without logs (0.0001 ETH sent), and a first run of mutant `e06` in which the sell page did not show the bank step (nothing sent). See [../evidence/2026-11-16-wallet-ui-red.jsonl](../evidence/2026-11-16-wallet-ui-red.jsonl).

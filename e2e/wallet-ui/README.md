# Wallet interface sale

One Sepolia sale of 1 USDT for EUR. The patched WDK starter wallet, installed on the iOS simulator, confirms the send. The sandbox must recognize that hash by itself and book the sale through `PayoutInProgress` or `Completed`.

This does not cover a rejected confirmation, a smart account, a purchase, or the bank payout. The wallet runs in a simulator, not on a device, and Maestro taps the controls. The flow screenshots are `sell-widget-open`, `send-review`, and `send-success`. The payment-information step is not captured, because that page prints the payout IBAN next to the deposit address. After the sale is booked, the runner saves the block explorer page and the booking page. The booking can stay in `Processing` on the sandbox; the run is then red and is recorded as red.

The starter is not upstream. `build.sh` checks out commit `031e210` and applies `starter.patch`. `ethereum` is switched from the gasless wallet package to the plain EVM wallet (`@tetherto/wdk-wallet-evm`) so a Sepolia account can sign the transfer. Arbitrum and Polygon stay gasless. The confirmation logic is unchanged: `sendAsset` and `onConfirm` still send the amount from the route, and `disabled` at `src/app/send/review.tsx:217` in the starter is unchanged. The Ethereum token fee line is display-only and is not added to the token total.

`starter.patch` changes these files:

- `package.json` adds `@tetherto/wdk-wallet-evm` 1.0.0-beta.17 and `@dfx.swiss/wdk-protocol-fiat-dfx` via `file:../../..`.
- `wdk.config.js` points `ethereum` at `@tetherto/wdk-wallet-evm`, registers protocol `dfx`, and limits that protocol's fiat methods to `quoteSell` and `sell`.
- `src/wdk/networks.ts` builds Ethereum as a plain account (provider only), sets Sepolia USDT to `0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0` with 6 decimals, and binds `dfx` to the sandbox environment.
- `src/wdk/useSend.ts` quotes an Ethereum token fee with `extension().quoteTransfer` and a native fee with `estimateFee`. `sendAsset` is unchanged.
- `src/components/Button.tsx` forwards `testID` to the pressable.
- `src/components/SeedWordInputGrid.tsx` adds a `testID` on the first word field, the field that already distributes a pasted phrase.
- `src/app/(onboarding)/import.tsx` adds `import-seed` and `import-submit`.
- `src/app/(onboarding)/password.tsx` adds `password-input`, `password-confirm`, and `password-submit`.
- `src/app/_layout.tsx` presents `sell` as a full-screen modal, the same way send is presented.
- `src/app/sell/_layout.tsx` uses the same stack-plus-toast shell as the other modal routes.
- `src/app/sell/index.tsx` calls `sell` for 1 USDT on Sepolia to EUR and shows the returned page in a web view. The page URL is not rendered as text and is not logged.
- `src/app/(app)/(tabs)/wallet.tsx` adds `send-entry` and `sell-entry`.
- `src/app/send/index.tsx` adds `send-asset-usdt-ethereum` on the Sepolia USDT row.
- `src/app/send/amount.tsx` adds `send-recipient`, `send-amount`, and `send-continue`.
- `src/app/send/review.tsx` adds `send-confirm`. The fee line does not change the amount that is sent. `onConfirm` and `disabled` are unchanged.
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

The script clones the starter, checks out `STARTER_COMMIT`, applies `starter.patch`, copies `.env.example` to `.env`, writes `.npmrc`, and installs. The starter does not commit `ios/`. The script then runs `npx expo prebuild --clean --platform ios`, which creates that directory and needs CocoaPods, and only then looks up the workspace and scheme. It builds a Release simulator app with `IPHONEOS_DEPLOYMENT_TARGET=17.0`, terminates and uninstalls any copy already on the simulator, and installs the new app. Only the Sepolia provider in `.env` is used for this sale. Do not print `.env`. The script then writes `out/build.json` with the module head, the starter commit, the patch digest, and the digest of `main.jsbundle` in the installed app.

## Run

From `e2e/`:

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid>
```

That is the preflight. It does not paste the seed, does not start Maestro against the app, does not send, and writes no record. It requires the booted simulator to use iOS 26.5. Exit 0 means the tree, the installed build, the simulator, Maestro, the sandbox version, and the account balance are ready. The account needs at least 1 USDT and 0.0002 ETH.

```sh
node wallet-ui/run-sale.mjs --seed-file <path> --udid <simulator-udid> \
  --send --confirm --follow <minutes> --screenshots <dir> --record <file>
```

`--follow` is 1 to 240 minutes. `--screenshots` must be a directory owned by the current user with mode `0700`, and it must not already contain `sell-widget-open.png`, `send-review.png`, or `send-success.png`. `--record` must not exist yet and must not be the seed file. `--rpc` defaults to `https://ethereum-sepolia-rpc.publicnode.com`.

A send takes a fixed lock directory in the system temporary directory before checking for another Maestro process and holds it through cleanup. A lock left after a crash must be deleted by hand. Preflight without a send takes no lock.

Exit 0 is a pass. Exit 1 is a failed check; the record file then holds one JSONL line with `result` `fail` and `failedCheck`, unless the record cannot be written. A failed flow records the first failed Maestro step as `failedStep` with the IBAN masked; it is also printed when the flow failure stops the run. Exit 2 is usage. Exit 3 means the run did not start: the reason is printed and no record is written; this includes an occupied or uncreatable lock. No Maestro flow, tap, or send is repeated. The receipt is read for up to 60 seconds, fixed-block balance reads are repeated when a node is lagging, the backend record is read every 20 seconds until `--follow` ends, and the explorer page is reloaded for up to five minutes until it shows the hash and Success. The record counts backend reads in `backendReads`, RPC read retries in `rpcReadRetries`, and explorer reloads in `explorerReloads`. A second Maestro process on the machine makes the preflight exit 3, and makes the gap between the two flows exit 1 with `nothing sent`.

The seed file is given to the simulator clipboard through a file descriptor. The IBAN is a new Swiss IBAN for that run (clearing `00000`). The record stores `CH 00000 (invented per run)` and does not store the IBAN. Before a record is written, the runner tries up to three times to clear the clipboard. The record reports the result in `clipboardCleared`. If clearing fails, the run exits 1 and the clipboard must be cleared by hand; an earlier failed check remains in the record.

## Traps

Only one Maestro run can use the machine. Two runs share one driver port.

The app aborts at launch on the iOS 27.0 runtime. Use the iOS 26.5 runtime.

Tapping Paste while the clipboard is empty crashes the app. That crash is upstream and is not fixed here.

`npm install` inside the starter follows `file:../../..` into this module. If that install changes the module tree, `build.sh` stops without a build record.

## Recorded runs

The table is filled after a run at the final head.

| Date | Module head | Starter | Hash | Block | Backend | Result |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

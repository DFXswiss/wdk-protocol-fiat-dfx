# Probes under `e2e/`

The directory name `e2e/` is historical. `real-sell.mjs` and `real-buy.mjs` are real runs without a wallet user interface (hybrid). `live-matrix.mjs` calls the live DFX API and sends no on-chain transaction. `wallet-ui/` is the run in which a wallet user interface confirms the transaction.

Install once from this directory. `e2e/.npmrc` sets `install-links=true` so this module and `@tetherto/wdk` share one `@tetherto/wdk-wallet` copy. A second copy makes registration fail.

```sh
npm ci
```

Node.js 22 or newer. Do not print a seed. A seed file must be a non-empty regular file owned by the current user, without group or other permission bits (for example mode `0600`), and not a symlink.

`DFX_ENV=production` selects production for `live-matrix.mjs` and `native-quotes.mjs`. Anything else, including an unset variable, selects the sandbox. Sandbox sign-in (`POST /v1/auth`) can create a DFX user. Production sign-in uses the same call on `api.dfx.swiss`.

## live-matrix.mjs

Live matrix for ethereum, polygon, arbitrum, base, optimism, bsc, sepolia, polygon-4337, base-4337, tron, solana, bitcoin and spark. Each case registers WDK and reads catalogs; cases with listed assets also quote, ask for an unknown transaction id, and open buy and sell widget URLs. Bitcoin with an empty catalog checks four `Missing decimals` rejections instead. It sends no on-chain transaction. Output: `out/matrix-results-sandbox.json` or `out/matrix-results-production.json`. Session URLs are redacted in that file. Exit 0 only when every step passed; exit 2 for an unknown chain or more than one argument; otherwise exit 1.

```sh
node live-matrix.mjs
node live-matrix.mjs base
DFX_ENV=production node live-matrix.mjs
```

An optional argument limits the run to one `chain` value from the script.

Before network access, the installed module copy is compared with the working tree; a mismatch exits 1 and requires `npm ci` in `e2e`.

Recorded sandbox: 178/186 steps on 2026-10-29 and again on 2026-11-05. The failures are assets the sandbox does not list as buyable. Recorded production: 182/187 on 2026-10-29 and 177/178 on 2026-11-05. See [TESTING.md](../TESTING.md).

## native-quotes.mjs

Read-only probe of Bitcoin, Lightning, Arkade and Firo. It sends no on-chain transaction. The sandbox is expected to list only Firo; production is expected to list none of the four. Unlisted assets must be rejected with `Missing decimals`. Exit code 1 on a mismatch.

Before network access, the installed module copy is compared with the working tree; a mismatch exits 1 and requires `npm ci` in `e2e`.

```sh
node native-quotes.mjs
DFX_ENV=production node native-quotes.mjs
```

## signature-diff.mjs

Compares signature normalization with `bs58` (20,000 Solana signatures) and `@noble/curves` (5,000 Spark signatures). No network. Exit code 1 if any mismatch is printed. A recorded run, including a re-run on 2026-11-05, reported 0 mismatches.

```sh
node signature-diff.mjs
```

## bare-smoke.mjs

Loads `../bare.js` and signs in through a stubbed `fetch`. No network and no DFX API. Recorded result: 4/4 on 2026-10-20 and on 2026-11-05. `bare@1.34.1` resolved Bare runtime v1.35.0 on 2026-10-20 and v1.36.0 on 2026-11-05.

```sh
npx --yes bare@1.34.1 bare-smoke.mjs
```

## real-sell.mjs

Real Sepolia sell against `dev.api.dfx.swiss`. WDK signs and sends from this script. No wallet user interface confirms the transaction, so a rejected wallet prompt is not covered.

Without `--send` the script quotes and opens the widget, and sends nothing. `--send` and `--confirm` are both required to send, and then `--follow` (1–240 minutes), `--screenshots` (directory mode `0700`) and `--record <file>` are required. `--asset` is `USDT`, `ETH` or `all` (default `all`). `--account` is `eoa`, `smart` or `all` (default `all`). `--rpc` defaults to a public Sepolia endpoint. `--bundler` defaults to the public Candide Sepolia bundler. `--lock <dir>` takes an exclusive directory lock for the wallet.

`--seed-file` is required. `--out <file>` optionally writes the log to a new file with owner-only permissions, and `--explorer <origin>` defaults to `https://eth-sepolia.blockscout.com` and must be an HTTP or HTTPS origin without credentials. `--follow` defaults to 0 and accepts integers from 0 to 240; a send requires at least 1. A send also takes a fixed lock in the system temporary directory named `wdk-real-sell-<lowercase EOA address>.lock`, in addition to any `--lock`; an occupied or uncreatable account lock exits 3 before sending.

The deposit-address balance in the receipt block must exceed the balance in the previous block by the amount sent, for an EOA and for a Safe. A mismatch exits 1.

The bundler quotes of a fresh Safe need its funded balance, so the prefund check runs after funding; if it fails, the funds stay in the Safe, whose address and account index the `safe-preflight` line names. No script in this tree returns them: `safe-rescue.mjs` covers index 0 on Base only.

Exit 2 is usage. Exit 3 is only a `NotRunError`: an unusable seed file, duplicate `@tetherto/wdk-wallet` copies, a module copy that differs from this tree (the digest differs, the file list differs, the installed copy is missing, or a symlink is rejected), an unreachable RPC, a preflight `/version` that is unreachable or without a usable answer, an unreachable bundler, a balance too small to send, or an unavailable fixed account lock. Any other failure exits 1, including a bundler HTTP status, a bundler that answers with the wrong chain or EntryPoint, a wrong chain id, a dirty tree, an unavailable optional lock, a git failure, an unavailable DFX protocol, a Safe that already has code, and any other exception. Exit 130 or 143 means SIGINT or SIGTERM: the script releases both locks and exits. The record is written in one synchronous step, so a signal leaves either no record or a complete one. A signal cannot recall a transaction that was already sent.

`--record` must not exist yet, must not be the seed file, and must not be `--out`. The file is created with owner-only permissions only after a passing send with a clean tree. Schema `dfx-real-run/v1`. The script does not write into the git directory.

```sh
node real-sell.mjs --seed-file /path/to/seed.txt --asset USDT --account eoa
node real-sell.mjs --seed-file /path/to/seed.txt --send --confirm --follow 30 \
  --screenshots /path/to/shots --record /path/to/run.json --lock /path/to/lock
```

## real-buy.mjs

Real Base purchase against production. The script quotes, and with `--confirm` writes a buy URL to `--url-file` and waits for the payout. The bank transfer is manual. No wallet user interface confirms the transaction. `--confirm` also requires `--screenshots` and `--record <file>`. `--lock <dir>` is optional. `--account` is `smart` or `eoa` (default `smart`). Only USDC. `--rpc` defaults to `https://mainnet.base.org`.

`--screenshots` must be a non-symlink directory owned by the current user with mode `0700`; it is created if missing.

`--seed-file` is required. `--index` defaults to 0 and accepts integers from 0 to 2147483647; `--asset` defaults to `USDC` and only accepts `USDC`. `--amount` defaults to 15 EUR and must be positive with at most two decimal places. `--wait-minutes` defaults to 240 and accepts integers from 1 to 10080. `--out <file>` optionally writes the log to a new file with owner-only permissions; `--explorer <origin>` defaults to `https://base.blockscout.com` and must be an HTTP or HTTPS origin without credentials. `--url-file` is required with `--confirm`.

For either script, a `--follow` or `--wait-minutes` period that outlasts the widget session ends in failure because the reads do not renew that session.

The file given by `--url-file` must not exist yet, contains the buy URL with a session, is created with owner-only permissions, and should be deleted after the purchase. `--record` must also name a new file and is created with owner-only permissions after a passing run.

The balance after the payout, at the receipt block, must exceed the balance at the previous block by the payout transfer amount.

Exit 2 is usage. Exit 3 is only a `NotRunError`: an unusable seed file, duplicate `@tetherto/wdk-wallet` copies, a module copy that differs from this tree (the digest differs, the file list differs, the installed copy is missing, or a symlink is rejected), an unreachable RPC, a preflight `/version` that is unreachable or without a usable answer, or a `--url-file` that cannot be created. A held lock, a dirty tree, a chain id that is not Base, an unavailable DFX protocol, a git failure, and any other exception exit 1. Exit 130 or 143 means SIGINT or SIGTERM: the script releases its lock and exits. The record is written in one synchronous step, so a signal leaves either no record or a complete one.

No purchase with this script is recorded in [TESTING.md](../TESTING.md). The record schema is the same `dfx-real-run/v1`. Deposit-address fields are omitted because this script does not observe a deposit address. `sandboxSwitches` is empty. The file is created only after a passing run with a clean tree.

```sh
node real-buy.mjs --seed-file /path/to/seed.txt --amount 15
node real-buy.mjs --seed-file /path/to/seed.txt --confirm --screenshots /path/to/shots \
  --url-file /path/to/url.txt --record /path/to/run.json --lock /path/to/lock
```

## bundler-send.mjs

Sends a Base ERC-4337 user operation through a bundler when `--send` is set. Without `--send` it prints a dry run and sends nothing. `--rpc <url>` is required. `--seed-file <path>` or `WALLET_SIM_SEED_FILE` is required. There is no default RPC and no default seed file. `--bundler`, `--to`, and `--amount` (or `--native --all`) are required. `--send` requires `--confirm` equal to the Safe address. A missing `--rpc` or seed exits 2 and the message does not include the path or URL. Other failures exit 1, except an unavailable account lock, which exits 3.

`--account` defaults to 0 and accepts decimal integers without leading zeroes through 2147483647. `--token` defaults to Base USDC and accepts a valid EVM address; `--native` selects ETH and cannot be combined with `--token`. `--all` is only for `--native` and cannot be combined with `--amount`; otherwise `--amount` is a decimal asset amount. `--max-fee` is an optional positive decimal ETH amount. `--fork-fund` is an optional positive decimal asset amount for a local RPC only, and supports only Base USDC when using a token. `--to` must be a valid nonzero address and, for tokens, must differ from the token contract. A confirmed send takes the same temporary `wdk-real-sell-<lowercase EOA address>.lock` as `real-sell.mjs`, using account 0 of the seed; an unavailable lock exits 3 before sending.

The ETH that leaves the Safe and its EntryPoint deposit together must equal the amount sent in ETH plus `actualGasCost` of the `UserOperationEvent`, exactly; a mismatch exits 1.

```sh
node bundler-send.mjs --rpc https://mainnet.base.org --bundler https://example.invalid \
  --to 0x0000000000000000000000000000000000000001 --amount 1 --seed-file /path/to/seed.txt
```

## safe-rescue.mjs

Moves the full token or ETH balance of a Base Safe to `--to` when `--send` is set. Without `--send` it prints a dry run. `--rpc <url>` is required. `--seed-file <path>` or `WALLET_SIM_SEED_FILE` is required. There is no default RPC and no default seed file. `--send` requires `--confirm` equal to the Safe address. A missing `--rpc` or seed exits 2 without echoing the value. Other failures exit 1, except an unavailable account lock, which exits 3.

`--token` defaults to Base USDC and accepts a valid EVM address; `--native` selects ETH and cannot be combined with `--token`. `--fork-fund` is an optional positive decimal asset amount for a local RPC only, and supports only Base USDC when using a token. `--priority-fee-gwei` is optional and defaults to the RPC estimate. Both the supplied value and the estimate must be greater than 0 and at most 1 gwei. `--to` must be a valid nonzero address and, for tokens, must differ from the token contract. A confirmed send takes the same temporary `wdk-real-sell-<lowercase EOA address>.lock` as `real-sell.mjs`; an unavailable lock exits 3 before sending.

The script reads two non-public WDK values (`_ownerAccount` and `_getInitCodeOverrides`) to check the owner and the predicted Safe. Those calls are not part of the module's public API.

```sh
node safe-rescue.mjs --rpc https://mainnet.base.org --to 0x0000000000000000000000000000000000000001 \
  --seed-file /path/to/seed.txt
```

## wallet-ui/

`wallet-ui/` is a Sepolia sale of 1 USDT for EUR in which the WDK starter wallet on the iOS simulator confirms the send and the sandbox must book that hash to `PayoutInProgress` or `Completed`.

It is the end-to-end run in this directory; the other scripts do not ask a wallet user interface to confirm.

Build and command: [wallet-ui/README.md](wallet-ui/README.md).

## Record

`real-sell.mjs` and `real-buy.mjs` write `dfx-real-run/v1` only after a passing run whose working tree is still clean. Keys are English. `wallets` is an array of `{ name, version }`, one entry for each wallet package that sent a transaction in the run. `real-buy.mjs` records the one package registered for the receiving account. A funding entry has no deposit, backend or booking fields by definition. `userInterface` is false. `clientReportedHash` is false. `readRetries` and `explorerReloads` are the counts the script measured. Screenshots are stored per transaction with a SHA-256 of the file.

# DFX module E2E probes

This private package contains the probes and wallet simulator used for the
module checks recorded in the repository's `TESTING.md`. It consumes the module from `file:..`; it is excluded
from the root package's publish allowlist and Standard lint scope. Historical
results belong in the repository's `TESTING.md`; copying these probes is not a
new successful test run.

## Prerequisites and installation

Use Node.js 22 and install the root package dependencies first, then this package
and its pinned Playwright Chromium browser. From the repository root:

```sh
npm install
cd e2e
npm install
npx playwright install chromium
mkdir -p out
```

The local `.npmrc` sets `install-links=true`, so npm installs `file:..` as a
packed copy, like a consumer installation, instead of a symlink to the repository.
A symlink can resolve a different `@tetherto/wdk-wallet` copy from the root:
the resulting `FiatProtocol` class mismatch causes the same silent registration
failure integrators encounter with duplicate wallet packages (`No fiat protocol
registered for label: dfx.`). The live matrix, full-stack probe and wallet server
abort early if DFX and WDK resolve different wallet paths. If an existing install
still uses a symlink, remove `e2e/node_modules` and reinstall from `e2e/` with
this setting enabled.

All commands below run from `e2e/`. Direct dependencies are pinned to the tested
versions, including `bs58` 6.0.0 and `@noble/curves` 1.2.0 read from the original
probe installation. `e2e/package-lock.json` freezes the transitive resolution;
`npm ci` installs exactly that set.

The network probes need access to DFX and the configured public chain RPCs. The
signature differential needs no network after installation. Wallet journeys need
loopback port 4748 free (override with `WALLET_SIM_PORT`); they start and stop their own simulator for every journey.
Do not start a separate simulator at the same time.

## Bare entry point

From `e2e/`, run the stubbed smoke probe with:

```sh
npx --yes bare@1.34.1 bare-smoke.mjs
```

It imports the package's `bare.js` entry point, performs a stubbed sandbox sign-in,
and checks the submitted Safe address and ERC-6492-wrapped signature. It does not
connect to a network or authenticate with a real DFX API. The expected wrapper
and its derivation details are in `fixtures/bare-smoke-expected.json`.

## Side effects and output

The live matrix creates fresh wallets and DFX users through authentication, both
in sandbox and, when explicitly selected, production. Production requires
`DFX_ENV=production`; the default is sandbox. The native quote probe only reads
catalogs and quotes, using the same environment selection. Wallet journeys always
use sandbox and can create sandbox users. The widget check opens authenticated
URLs and may create requests in the environment those URLs target. Use only
throwaway wallets for probes and sandbox exploration. For a deliberate real purchase
in the simulator, use a separate prepared wallet as described below; do not enter
the recovery phrase of a primary wallet in the browser.

Generated JSON, screenshots and the logs in the commands below go under `out/`,
which is ignored by Git. Seeds are never logged. Session values are masked in
console diagnostics and matrix result reports. The private handoff files
`out/e2e-urls-sandbox.json` and `out/e2e-urls-production.json` necessarily contain
active session URLs for the subsequent widget check. They are written with mode
`0600`; do not print, upload or share them. Remove them after the widget check.
This exception preserves the original file-based handoff; it is not a redacted
report. Screenshots show rendered test
account/payment information; treat output as local test data. Filenames are reused
on subsequent runs, except for the full-stack screenshots with unique run IDs.

These are the original exploratory probes, not a uniform assertion suite. The
matrix records failed steps but exits zero; native quotes exit nonzero on an
unexpected listing or rejection;
the differential prints mismatch counts. Inspect these probes' output, not just
exit codes. The journey runner exits nonzero if a journey records a `stop` or
page errors. In sandbox, `eth-too-low` is an ordinary flow because 1 EUR is
accepted; production rejects that amount. Full-stack exits nonzero for failed
or blocked steps.

## Commands

### Real purchase script (`real-purchase.mjs`)

This script prepares a real EUR-to-USDC purchase on Arbitrum in production and
tracks its DFX status and on-chain balance. `AMOUNT_EUR` defaults to `20`; use a
positive integer or exactly two decimal places (for example `20.50`).

```sh
# Show the production quote, then exit nonzero without calling buy():
node real-purchase.mjs prepare
# Explicitly authorize production authentication and purchase preparation:
AMOUNT_EUR=20 node real-purchase.mjs prepare --confirm
node real-purchase.mjs address
node real-purchase.mjs status
node real-purchase.mjs status --watch
```

`prepare --confirm` authenticates with DFX, can create a production user and
creates a session URL. Open the URL from the private `widget-url.txt` file
yourself in the browser; there is no automatic browser-opening option. Complete
the email verification in the widget and make the actual bank transfer yourself
using the payment instructions shown there. This uses real money; the script
does not execute the bank transfer.

`STATE_DIR` defaults to `~/.wdk-dfx-real`; use the same directory for every command
for this purchase. The directory uses mode `0700`. `prepare` creates `seed.txt`
if needed, including when run without `--confirm`. With confirmation it also
creates `state.json` (wallet, quote and tracking ID) and `widget-url.txt` (active
login session). Files are created with mode `0600`; existing files are rejected
on read if group or other permissions are set. The script never prints the seed.
Keep the seed and session file private and do not share or upload them.
Existing purchase state is not overwritten. `address` prints the wallet address;
`status` checks once, while `status --watch` polls every minute until completion
with a positive USDC balance, failure or a lookup/balance error.

### Live chain matrix

```sh
node live-matrix.mjs > out/live-matrix-sandbox.log 2>&1
# Optional single chain, using a CASES chain name:
node live-matrix.mjs solana > out/live-matrix-solana.log 2>&1
# Explicit production run (creates production users):
DFX_ENV=production node live-matrix.mjs > out/live-matrix-production.log 2>&1
```

Reports are `out/e2e-results-sandbox.json` or
`out/e2e-results-production.json`. A single-chain run replaces that environment's
output with only that chain's results.

### Widget check

Run after the corresponding live matrix. Default selections are `ethereum-buy`,
`ethereum-sell`, `tron-buy`, and `base-sell`.

```sh
node widget-check.mjs > out/widget-sandbox.log 2>&1
DFX_ENV=production node widget-check.mjs > out/widget-production.log 2>&1
PICK=solana-buy,solana-sell node widget-check.mjs > out/widget-solana.log 2>&1
```

`URLS` optionally supplies a different URL JSON file, relative to the current
working directory or absolute. Screenshot names use its basename and selection
key. A URL override determines the actual target environment; `DFX_ENV` selects
only the default filename. Use production URL input only with explicit
`DFX_ENV=production`.

The URL file must be a regular file owned by the current user with owner-only
permissions (no group or other access), e.g. `0600`. Reading rejects symlinks.

### Native-chain quotes

Verifies the listing of Bitcoin, Lightning, Arkade and Firo: in sandbox only
Firo is expected to be listed, with `DFX_ENV=production` none of the four. For
every unlisted asset, both quote methods must reject with `ValueError`
`Missing decimals for <blockchain>/<asset>`:

```sh
node native-quotes.mjs > out/native-quotes-sandbox.log 2>&1
DFX_ENV=production node native-quotes.mjs > out/native-quotes-production.log 2>&1
```

### Signature differential

Directly imports `../src/signature.js`, compares 20,000 Solana signatures with
`bs58` and 5,000 Spark signatures with `@noble/curves`. Both mismatch counts
must be zero.

```sh
node signature-diff.mjs > out/signature-diff.log 2>&1
```

### Wallet journeys

Runs all seven journeys, or one by name. Each journey gets a fresh server process
and wallet state, with a 600-second browser-page timeout (ten times the state timeout).
The ERC-4337 journey signs in with an undeployed Safe and follows the checkout,
return and order-status flow used by the EOA journeys. The Bitcoin journey checks
that BTC is not offered for selection; it fails if the catalog request fails or
offers no usable asset and fiat combination for the prepared wallet.
On ordinary completion or failure, cleanup sends SIGTERM, then SIGKILL after
5 seconds if needed. If the server still has not exited after another 5 seconds,
the runner reports its PID and sets a nonzero exit code; the remaining journeys still run.
SIGINT/SIGTERM also terminate the owned server. No shell runner or process-name killing is used.

```sh
node wallet-journeys.mjs > out/wallet-journeys.log 2>&1
node wallet-journeys.mjs eth-4337-buy-usdt > out/wallet-journey-4337.log 2>&1
```

The simulator consists of `wallet-sim/server.mjs` and `wallet-sim/public/`.
For manual sandbox exploration, run `node wallet-sim/server.mjs` and open
`http://127.0.0.1:4748`; stop that server before running automated journeys.

#### Simulator: real purchase in production

Production uses **real DFX accounts and real money**. From `e2e/`, start with the
prepared seed file already present on the machine:

```sh
WALLET_SIM_ENV=production \
WALLET_SIM_SEED_FILE="$HOME/.wdk-dfx-real/seed.txt" \
WALLET_SIM_ORDERS_FILE="$HOME/.wdk-dfx-real/orders-production.json" \
node wallet-sim/server.mjs
```

Open `http://127.0.0.1:4748`, verify the orange **PRODUCTION** badge and select
“Vorbereitete Wallet laden”. Choose Kaufen → USDC · Arbitrum → EUR → Angebot →
“Weiter zu DFX”. DFX opens inside the wallet at `app.dfx.swiss`; complete the DFX
steps to obtain payment details. The browser bar displays only the hostname
derived from the checkout URL. Sandbox uses `dev.app.dfx.swiss`.

`WALLET_SIM_ENV` defaults to `sandbox` and rejects other values. `PORT` still
defaults to 4748; the server binds only to `127.0.0.1`. The seed file must be a
nonempty regular file owned by the current user with owner-only permissions
(no group or other access), e.g. `0600`, and cannot be a symlink.
It is checked at startup and again when loaded. Its contents stay on
the server and are never returned to the browser or logged. A newly generated
wallet has no exported recovery phrase; use the prepared wallet for a purchase
that must remain accessible after restart.

The portfolio fetches native balances only for chains with public RPCs in
`CASES`, plus configured tokens (currently Arbitrum USDC at
`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, 6 decimals). Values are formatted
directly from bigint base units. “Aktualisieren” refreshes them manually;
production also refreshes every 30 seconds while the page is open. Failed or
unavailable reads display “–”; Bitcoin and Spark have no configured public RPC
and are not queried. Native balances follow the configured chain RPCs even in
DFX sandbox mode. Smart-account balances belong to the displayed smart-account
address. Authenticated DFX methods sign in as that address. On a known chain id,
when the recovered signer differs and the account implements `signTypedData`,
the module sends a Safe EIP-712 signature. The module wraps Safe signatures only
on networks in `ERC6492_NETWORKS` (Ethereum, Sepolia, BNB Smart Chain, Optimism,
Arbitrum, Polygon, Base, Gnosis and Plasma), for which the DFX API is intended to verify
ERC-6492; an API without ERC-6492 support rejects an undeployed Safe and a
wrapped signature from a deployed Safe. Wrapping also requires that the owner
predicts the account with the WDK Safe 0.3.0 parameters.

If `WALLET_SIM_ORDERS_FILE` is set, its parent directory must already exist.
Orders are saved atomically with permissions `0600` and loaded at startup.
Existing files must be regular files owned by the current user; reading rejects
symlinks and any group/other permissions. A missing file is allowed. Only
order metadata is persisted (ID, direction, asset, chain/network, amount and unit,
time, environment and wallet address); session URLs are never stored. The list
is filtered to the active environment and wallet accounts. Reopen the same wallet
after restarting, then use “Meine Aufträge” and select an order to fetch its
current DFX status. Without this variable, orders remain in memory only. Do not
run multiple simulator processes against the same orders file.

After payment and payout, return to the portfolio to see the received USDC.
The simulator does not send funds, transfer tokens or approve spending. Production
iframe embedding and a real payment must be verified in the actual browser;
sandbox observations alone do not establish production embedding support.

### Local full stack

Requires Docker on `PATH` and the disposable full-stack harness from
`DFXswiss/app`, directory `e2e-stack/`, already running with its initialized
PostgreSQL database. Follow that checkout's harness setup instructions. Default
API/frontend ports are 3020/3021. The probe neither builds nor starts the stack.

Build the frontend separately with
`REACT_APP_API_URL=http://localhost:3020` and serve that build on port 3021.
The frontend API URL is embedded at build time: redirecting the widget URL to
localhost does not change the backend used by an already-built frontend. A build
pointing at sandbox/production would send browser requests there rather than to
the local fixtures. When overriding `DFX_LOCAL_API`, rebuild the frontend with
the same API origin.

```sh
node fullstack.mjs > out/fullstack.log 2>&1
# Explicit defaults; endpoints must be origins, without path prefixes:
DFX_LOCAL_API=http://localhost:3020 \
DFX_LOCAL_APP=http://localhost:3021 \
DFX_LOCAL_DB_CONTAINER=dfx-e2e-wdk2-db-1 \
node fullstack.mjs > out/fullstack.log 2>&1
```

The DB container must provide `psql`, database `dfx`, user `sa`, and the harness
schema/fixtures. Deposit seeding reads `EVM_DEPOSIT_SEED` from the API container
unless `E2E_EVM_DEPOSIT_SEED` is already set in the environment. Never print that
seed. `DFX_LOCAL_API_CONTAINER` can override the API container; by default its
name is derived from the DB container by replacing the `-db-1` suffix with
`-api-1` (default `dfx-e2e-wdk2-api-1`).

This probe writes local fixture data: random users, an admin with staff clearance,
KYC data, price-rule updates, deposit addresses, bank transactions and simulated
transaction states. These remain in the disposable database for inspection.
Buy assignment uses the backend admin endpoint; sell assignment is an explicit
SQL fixture and does **not** prove automatic backend sell matching. No real bank
transfer, blockchain deposit or payout is tested. Use only a disposable harness
with the expected local `[loc]_` signing challenge.

Results update atomically at `out/fullstack/results.json`; screenshots are under
`out/fullstack/shots/`. Inspect per-step evidence and rendered screenshots.

### Local full stack with backend processing

`fullstack-processing.mjs` and `fullstack-lifecycle.mjs` need the same local stack,
but with selected background jobs **enabled** so that the real backend code
processes the transactions. Everything that talks to the outside world (blockchain
scanning and payout, bank transmission, pricing and liquidity) stays disabled.
Restart only the API service with a Compose override that sets
`DISABLED_PROCESSES` to every value of the backend `Process` enum
(`src/shared/services/process.service.ts`) **except**:

```
BuyCrypto, BuyFiat, AutoAmlCheck, BuyCryptoRefreshFee, BuyFiatSetFee,
Kyc, KycNationalityReview, KycIdentReview, KycFinancialReview,
KycDfxApproval, KycRecommendationReview, AutoCreateBankData, BankDataVerification
```

```sh
node fullstack-processing.mjs > out/fullstack-processing.log 2>&1
OBSERVE_MINUTES=15 node fullstack-lifecycle.mjs > out/fullstack-lifecycle.log 2>&1
LIFECYCLE_SCENARIOS=sell OBSERVE_MINUTES=15 node fullstack-lifecycle.mjs
```

`fullstack-lifecycle.mjs` simulates only external events. These are: an incoming
bank transfer (a `bank_tx` row as the bank import would write it, including
`senderAccount`), a blockchain confirmation of a crypto deposit, a completed
identification (KYC level 50, `verifiedName`, current `lastNameCheckDate`), and the
execution of a payout or refund by the bank. Compliance and operations act through
the real admin endpoints:
- bank transfer assignment;
- the phone-call check (`PUT /v1/userData/:id`);
- `reviewReset`;
- `PUT /v1/buyCrypto/:id/amlCheck`;
- refund request and approval.

The AML job needs about ten minutes per decision, so a full run takes 60–90
minutes. The environment step seeds a numeric referral code when none exists (see
`TESTING.md` for the backend finding behind it). Use a fresh IBAN per scenario: DFX
allows an active IBAN on one account only, and the script generates valid ones.

If a required milestone is not reached (compliance Pass, an AML decision within
the observation window, BuyFiat input assignment, or the backend boundary required
for a simulated payout or bank execution), the lifecycle probe records
`not_reached` as a failed step, logs `FAIL` with the reason, and exits nonzero.

### KYC in the widget

`kyc-widget.mjs` drives the DFX KYC screens in the local widget for a user who
signed in through the module: e-mail with confirmation code, personal data,
nationality. It stops where DFX calls the external identification provider
(Sumsub), which does not exist locally. It needs the KYC jobs listed above.

```sh
node kyc-widget.mjs > out/kyc-widget.log 2>&1
```

### Deployed ERC-4337 account

`safe-deployed.mjs` starts `anvil` (Foundry) as a Polygon fork. Before
deployment it signs with the WDK smart account and calls `buy`. The posted
signature must be an ERC-6492 wrapper: `factory` and `factoryData` match the
counterfactual account from `account._getSmartAccount()`, and the inner Safe
signature recovers to the owner. viem 2.38.5, the version the DFX API uses,
verifies that wrapper on the fork. The Safe still has no code afterwards. The
script then deploys the account without a bundler and signs again. The
post-deployment `buy` and `sell` signatures are checked byte-for-byte against
the pre-deployment `buy` wrapper. The forked contract accepts the inner
signature through ERC-1271 (`0x1626ba7e`), and viem accepts the wrapped
signature. Each sign-in records `sandbox` as `rejected` or `accepted`.
Wallet packages can include their own `@tetherto/wdk-wallet` copy; the probe's
initial resolution check compares only the copies used by DFX and WDK.
`rejected` is a `ProviderError` with reason `UNAUTHORIZED`. `accepted` is a
widget URL that contains a session. The sandbox accepts a Safe that is not
deployed on the fork, because the DFX API verifies ERC-6492 since 2026-10-23. It needs
`anvil` on `PATH`;
`ANVIL_PORT` defaults to 8547. `ANVIL_FORK_URL` selects the upstream Polygon RPC
and defaults to `https://polygon-bor-rpc.publicnode.com`. Only valid `https:` URLs
are accepted. Set the variable in the process environment; the probe does not
load `.env` files. Anvil startup and wait failures include the last ten stderr lines from a buffer
limited to 8192 characters, with URLs masked, to expose upstream RPC errors.
The fork URL is passed as an argument to `anvil` and is visible in the local
process list. Use an endpoint without a key or a dedicated key only for this probe.

```sh
node safe-deployed.mjs > out/safe-deployed.log 2>&1
# Alternative upstream if the default RPC is overloaded:
ANVIL_FORK_URL=https://polygon.drpc.org node safe-deployed.mjs > out/safe-deployed.log 2>&1
```

### Moving funds out of an undeployed ERC-4337 account

The wallet simulator does not send, and its ERC-4337 accounts have no bundler.
`safe-rescue.mjs` lets the owner move the whole balance of the Base smart account
of the prepared wallet (account 0, chain id 8453) to another address. The owner
deploys the account through the Safe proxy factory with the factory data WDK
predicts, if it has no code yet, and then calls `execTransaction` on it with a
pre-validated owner signature. The owner pays the gas with ordinary
transactions; the smart account pays nothing.

Before any transaction, the script checks the chain id, that the WDK account
address equals the address predicted from WDK's own Safe parameters, and that
`--to` is neither the account, its owner nor the zero address, and for a token
not the token contract. It reads the seed from
`WALLET_SIM_SEED_FILE` or `~/.wdk-dfx-real/seed.txt` and never prints it. The
seed file must meet the same rule as for the simulator: a nonempty regular file,
owned by the current user, owner-only permissions, not a symlink.

- Without `--send` it is a dry run: addresses, balances, gas and cost estimates.
- `--native` moves ETH; otherwise it moves the token given by `--token`
  (default: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- `--rpc` defaults to `http://127.0.0.1:8547`, an `anvil` fork of Base.
  `--send` always needs `--confirm` with the exact smart-account address, on a
  fork as well: a local node or a tunnel to Base also answers on `localhost`.
- `--fork-fund <amount>` works only on a local RPC. It sets the account's USDC
  balance by storage write, or its ETH balance with `--native`.
- `--priority-fee-gwei` overrides the RPC's priority fee. `anvil` suggests
  1 gwei, while Base suggests far less.
- It stops before any transaction, including the deployment, if the account
  holds none of the selected asset, or if the owner holds less than twice the
  estimated cost. The estimate includes the L1 data fee upper bound from Base's
  gas price oracle. After the deployment it estimates the transfer again and
  re-checks the owner's balance before sending it.
- After sending, it checks that the account is empty and the destination
  received the full balance. It also checks that the owner paid at least the
  receipt costs, including any reported L1 data fee.

This moves real funds when `--rpc` points to Base itself. `--confirm` names the
account the funds leave, not the destination: like any wallet send, `--to` is
the operator's choice, so check it in the dry run first. Destinations with code
are allowed on purpose; an EIP-7702 account, for example, has code.

```sh
anvil --fork-url https://base-rpc.publicnode.com --port 8547
node safe-rescue.mjs --native --to <address> --priority-fee-gwei 0.001 \
  --send --confirm <smart-account address>
# Base itself, after a dry run without --send:
node safe-rescue.mjs --native --rpc https://base-rpc.publicnode.com --to <address> \
  --send --confirm <smart-account address>
```

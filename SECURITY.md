# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories for DFXswiss/wdk-protocol-fiat-dfx](https://github.com/DFXswiss/wdk-protocol-fiat-dfx/security/advisories/new).
Do not open a public issue containing an exploit or sensitive account information.

Include the affected version, runtime, reproduction steps, expected and actual
behavior, and potential impact. Remove session URLs, bearer tokens, signatures,
private keys, seed phrases and personal data from attachments. No response-time
commitment is published for this prerelease.

## Scope and handling

This package signs provider authentication challenges through the supplied WDK
account. It does not access private keys or seeds, custody funds, or perform KYC.
Session tokens remain in instance memory and are included in the generated widget
URL. Do not log, persist or share those URLs. The caller must bind the account to
the correct constructor network and supply a trusted fetch implementation.

An instance holds its DFX access token until the token expires. The backend
default lifetime is 2 days. `getTransactionDetail` reuses that token. `buy` and
`sell` sign in on every call. When the wallet locks, drop the reference to the
instance. If the protocol is registered on the account, each `getFiatProtocol`
returns the same instance, so drop the account too. There is no `dispose()`:
WDK does not call it, and another public method would go through the policy
engine. The module signs only the expected DFX sign-in challenge.

The current prerelease line is `1.0.0-beta.1`. Runtime verification results and their
tested revisions are recorded in [TESTING.md](TESTING.md). `npm audit
--audit-level=critical` passes (TESTING.md section 1); its six low-severity
findings have not been assessed, so a dependency audit is still pending before
release. Report defects against this line; fixes will be
documented in the changelog. DFX API and hosted widget behavior are external to
this package and require separate integration verification.

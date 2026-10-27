# DFX WDK fiat module

This repository will hold the DFX fiat on/off-ramp module for Tether WDK.

The code is not on this branch yet. It will be added in one pull request.

Pull requests into `develop` are the working line. `main` only accepts `develop`, through the release pull request.

Quality gates follow the A38 standard in [DFXswiss/agent docs/a38.md](https://github.com/DFXswiss/agent/blob/e63980625f5b778c5a93104b0bf5de7fb5e379a8/docs/a38.md). Two reviews are required before Ready. One review is enough only when the pull request opener is listed in one_review_authors in the trusted .github/pr-guard.json on the default branch. A missing file, a missing key, or an empty list keeps two reviews required. An entry that exists only on the pull request head does not count. This repository does not keep its own copy of that process.

Report vulnerabilities through [GitHub Security Advisories](https://github.com/DFXswiss/wdk-protocol-fiat-dfx/security/advisories/new).

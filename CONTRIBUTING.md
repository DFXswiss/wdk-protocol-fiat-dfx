# Contributing

Changes land on `develop`. `main` is updated only by the release pull request from `develop`.

Until `package.json` exists on the base and the head, pull request CI and the local A38 jobs record that the module is not here yet and succeed. Removing it after it has landed fails them. Once `package.json` is present, those jobs are:

- `npm ci` and `npm run lint`
- `npm ci` and `npm run build:types`
- `npm ci` and `npm run test:coverage`
- `npm ci` and `npm audit --audit-level=critical`

Use Node 22.

The report process is the A38 standard in [DFXswiss/agent docs/a38.md](https://github.com/DFXswiss/agent/blob/e63980625f5b778c5a93104b0bf5de7fb5e379a8/docs/a38.md). Two reviews are required before Ready. One review is enough only when the pull request opener is listed in one_review_authors in the trusted .github/pr-guard.json on the default branch. A missing file, a missing key, or an empty list keeps two reviews required. An entry that exists only on the pull request head does not count. This repository does not keep its own copy of that process.

CodeQL is a GitHub check, not a local A38 job. It analyzes on pushes to `develop` and `main`, on a pull request into `main`, and on a pull request into `develop` that has the `ci:full` label. A pull request into `develop` without that label records that analysis is not required for that pull request.

Report vulnerabilities through the private advisory form linked from `SECURITY.md`.

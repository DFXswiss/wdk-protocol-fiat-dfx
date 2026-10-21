# Contributing

Changes land on `develop`. `main` is updated only by the release pull request from `develop`.

Once `package.json` is present, pull request CI and the local A38 jobs are:

- `npm ci` and `npm run lint`
- `npm ci` and `npm run build:types`
- `npm ci` and `npm run test:coverage`
- `npm ci` and `npm audit --audit-level=critical`

Use Node 22.

The report process is the A38 standard in [DFXswiss/agent docs/a38.md](https://github.com/DFXswiss/agent/blob/develop/docs/a38.md). This repository does not keep its own copy of that process.

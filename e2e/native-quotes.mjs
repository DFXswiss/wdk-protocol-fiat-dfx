// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

// Read-only probe of Bitcoin, Lightning, Arkade and Firo. Sends no on-chain transaction.
// A listed asset must quote for buy and for sell. These four are in the native decimals table,
// so an unlisted asset is rejected as unsupported, not for missing decimals. Exit code 1 on a mismatch.
import { createHash } from 'node:crypto'
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function assertModuleCopy () {
  const mismatch = () => new Error('installed module differs from the working tree; run npm ci in e2e')
  const installed = resolve(repoRoot, 'e2e/node_modules/@dfx.swiss/wdk-protocol-fiat-dfx')
  try {
    const collect = base => {
      const files = []
      const visit = relative => {
        const path = resolve(base, relative)
        let current = resolve('/')
        for (const part of path.split('/').filter(Boolean)) {
          current = resolve(current, part)
          if (lstatSync(current).isSymbolicLink()) throw mismatch()
        }
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
          for (const name of readdirSync(path)) visit(`${relative}/${name}`)
        } else if (stat.isFile()) files.push(relative)
        else throw mismatch()
      }
      for (const name of ['package.json', 'index.js', 'bare.js']) {
        if (!lstatSync(resolve(base, name)).isFile()) throw mismatch()
        visit(name)
      }
      for (const name of ['src', 'types']) {
        if (!lstatSync(resolve(base, name)).isDirectory()) throw mismatch()
        visit(name)
      }
      return files.sort()
    }
    const source = collect(repoRoot)
    const copy = collect(installed)
    if (source.length !== copy.length || source.some((file, i) => file !== copy[i])) throw mismatch()
    const digest = path => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return createHash('sha256').update(readFileSync(fd)).digest('hex') } finally { closeSync(fd) }
    }
    for (const file of source) {
      if (digest(resolve(repoRoot, file)) !== digest(resolve(installed, file))) throw mismatch()
    }
  } catch {
    throw mismatch()
  }
}

assertModuleCopy()

const err = e => `${e?.constructor?.name} ${e?.reason ?? ''} ${e?.message}`.replace(/\s+/g, ' ')
const cases = [
  ['bitcoin', 'Bitcoin', 'BTC'],
  ['lightning', 'Lightning', 'BTC'],
  ['arkade', 'Arkade', 'BTC'],
  ['firo', 'Firo', 'FIRO']
]
// Same keys as NATIVE_DECIMALS. Not imported: that table is not a package export.
const nativeTable = new Set(cases.map(([, blockchain, asset]) => `${blockchain}/${asset}`))

for (const environment of [process.env.DFX_ENV === 'production' ? 'production' : 'sandbox']) {
  const protocol = new DfxProtocol(undefined, { environment })
  const assets = await protocol.getSupportedCryptoAssets()
  for (const [network, blockchain, asset] of cases) {
    const listed = assets.some(row => row.networkCode === network && row.code === asset)
    console.log(`${environment} ${network} listed: ${listed}`)
    for (const method of ['quoteBuy', 'quoteSell']) {
      const direction = method === 'quoteBuy' ? 'buy' : 'sell'
      try {
        const quote = await protocol[method]({ cryptoAsset: asset, fiatCurrency: 'EUR', config: { network }, fiatAmount: 10000n })
        console.log(`  ${method} ${asset}/${network}: quoted`)
        if (!listed || typeof quote?.cryptoAmount !== 'bigint') process.exitCode = 1
      } catch (error) {
        console.log(`  ${method} ${asset}/${network}: ${err(error)}`)
        if (listed) {
          process.exitCode = 1
          continue
        }
        const key = `${blockchain}/${asset}`
        const expected = nativeTable.has(key)
          ? `Unsupported ${direction} asset or network: ${asset}`
          : `Missing decimals for ${key}`
        if (error?.constructor?.name !== 'ValueError' || error.message !== expected) process.exitCode = 1
      }
    }
  }
}

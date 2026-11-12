// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

const modulePackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)
const evmPackage = JSON.parse(
  readFileSync(
    new URL(
      '../node_modules/@tetherto/wdk-wallet-evm/package.json',
      import.meta.url
    ),
    'utf8'
  )
)

describe('package compatibility', () => {
  test('includes the wallet version pinned by wdk-wallet-evm', () => {
    const range = modulePackage.dependencies['@tetherto/wdk-wallet']
    const pin = evmPackage.dependencies['@tetherto/wdk-wallet']
    const rangeMatch = /^\^(1\.0\.0-beta\.)(\d+)$/.exec(range)
    const pinMatch = /^(1\.0\.0-beta\.)(\d+)$/.exec(pin)

    expect(rangeMatch).not.toBeNull()
    expect(pinMatch).not.toBeNull()
    expect(rangeMatch[1]).toBe(pinMatch[1])
    expect(Number(rangeMatch[2])).toBeLessThanOrEqual(Number(pinMatch[2]))
  })
})

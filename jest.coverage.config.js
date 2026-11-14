// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'

const { jest: unitConfig } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const { collectCoverageFrom, coverageThreshold, ...unitProject } = unitConfig

export default {
  collectCoverageFrom,
  coverageThreshold,
  projects: [
    { ...unitProject, displayName: 'unit' },
    '<rootDir>/tests/integration/jest.config.js'
  ]
}

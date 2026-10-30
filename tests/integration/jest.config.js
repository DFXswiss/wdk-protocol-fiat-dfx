// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

export default {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/*.test.js'],
  globalSetup: '<rootDir>/tests/integration/setup.js',
  globalTeardown: '<rootDir>/tests/integration/teardown.js',
  testTimeout: 15000
}

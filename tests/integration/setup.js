// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { startServer } from './dfx-server.js'

export default async function setup () {
  const server = await startServer()
  globalThis.dfxIntegrationServer = server
  process.env.DFX_INTEGRATION_ORIGIN = `http://127.0.0.1:${server.address().port}`
}

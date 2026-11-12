// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

export default async function teardown () {
  const server = globalThis.dfxIntegrationServer
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
  delete globalThis.dfxIntegrationServer
  delete process.env.DFX_INTEGRATION_ORIGIN
}

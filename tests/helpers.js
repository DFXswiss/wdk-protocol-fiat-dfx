// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@jest/globals'

const SIGN_IN_CHALLENGE = 'By_signing_this_message,_you_confirm_that_you_are_the_sole_owner_of_the_provided_Blockchain_address._Your_ID:_'

export function challengeMessage (address, environment = 'production') {
  const prefix = environment === 'sandbox' ? '[dev]_' : ''
  return prefix + SIGN_IN_CHALLENGE + address
}

export function response (data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text () { return typeof data === 'string' ? data : JSON.stringify(data) } }
}

// AbortSignal identity is allocated by the runtime, not a deterministic fixture.
// All HTTP data is compared verbatim; the signal is checked separately.
export function expectRequests (calls, expected, aborted = false) {
  expect(calls.map(([url, { signal, ...init }]) => [url, init])).toEqual(expected)
  for (const [, { signal }] of calls) {
    expect(signal.aborted).toBe(aborted)
  }
}

export function httpRequest (path, method = 'GET', body, token, environment = 'production') {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const base = environment === 'sandbox' ? 'https://dev.api.dfx.swiss' : 'https://api.dfx.swiss'
  return [`${base}${path}`, { method, headers, body }]
}

export async function failure (promise, ErrorClass, message, reason) {
  const error = await promise.then(() => undefined, error => error)
  expect(error?.constructor).toBe(ErrorClass)
  expect(error?.message).toBe(message)
  expect(error?.reason).toBe(reason)
  return error
}

export function failureSync (fn, ErrorClass, message, reason) {
  let error
  try {
    fn()
  } catch (cause) {
    error = cause
  }
  expect(error?.constructor).toBe(ErrorClass)
  expect(error?.message).toBe(message)
  expect(error?.reason).toBe(reason)
  return error
}

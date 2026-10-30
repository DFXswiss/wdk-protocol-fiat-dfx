// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { NoSuchElementError, ProviderError, ValueError } from '@tetherto/wdk-wallet/protocols'
import { ProviderErrorReason } from '@tetherto/wdk-wallet'
import { parseNumbers } from './json.js'
import { unexpected } from './amounts.js'
import { INPUT_ERRORS } from './constants.js'

function attributableInput (data, detail) {
  const code = data?.errors?.[0]?.error ?? data?.error
  if (INPUT_ERRORS.has(code)) return true
  if (code && code !== 'Bad Request' && code !== 'Unprocessable Entity') return false
  const messages = Array.isArray(data?.message) ? data.message : [data?.message]
  const field = detail ? 'uid' : '(?:amount|targetAmount|asset|currency)'
  // Accept explicit field validation, not arbitrary errors from an input-taking endpoint.
  const validation = new RegExp(`^(?:${field}\\b.*\\b(?:must|should)\\b|invalid ${field}\\b)`, 'i')
  return messages.some(message => typeof message === 'string' && validation.test(message))
}

export default class DfxClient {
  /** @internal */
  constructor (config) {
    /** @private */
    this._fetch = config.fetch ?? globalThis.fetch
    /** @private */
    this._timeout = config.timeout ?? 30000
    /** @private */
    this._base = config.environment === 'sandbox' ? 'https://dev.api.dfx.swiss' : 'https://api.dfx.swiss'
  }

  /** @internal */
  async _request (path, { method = 'GET', body, token, input = false, detail = false } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._timeout)
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token !== undefined) headers.Authorization = `Bearer ${token}`
    try {
      let response
      let text
      try {
        response = await this._fetch.call(globalThis, `${this._base}${path}`, { method, headers, body, signal: controller.signal })
        text = await response.text()
      } catch (cause) {
        throw new ProviderError(controller.signal.aborted ? 'DFX request timed out' : 'DFX network request failed', {
          reason: controller.signal.aborted ? ProviderErrorReason.REQUEST_TIMEOUT : ProviderErrorReason.NETWORK_ERROR,
          cause
        })
      }
      let data
      try {
        data = parseNumbers(text)
      } catch (cause) {
        if (response.ok) throw unexpected('Invalid JSON in DFX response', cause)
      }
      if (!response.ok) {
        const message = typeof data?.message === 'string' && data.message.length > 0
          ? data.message
          : Array.isArray(data?.message) && data.message.length > 0 && data.message.every(item => typeof item === 'string' && item.length > 0)
            ? data.message.join('; ')
            : `DFX HTTP ${response.status}`
        if (path === '/v1/auth' && method === 'POST' && (response.status === 401 || (response.status === 400 && data?.message === 'Invalid signature'))) {
          throw new ProviderError(message, { reason: ProviderErrorReason.UNAUTHORIZED })
        }
        if (response.status === 404 && detail) throw new NoSuchElementError(message)
        if ((response.status === 400 || response.status === 422) && input && attributableInput(data, detail)) throw new ValueError(message)
        const reason = {
          401: ProviderErrorReason.UNAUTHORIZED,
          403: ProviderErrorReason.FORBIDDEN,
          408: ProviderErrorReason.REQUEST_TIMEOUT
        }[response.status] ?? ProviderErrorReason.INTERNAL_SERVER_ERROR
        throw new ProviderError(message, { reason })
      }
      return data
    } finally {
      clearTimeout(timer)
    }
  }
}

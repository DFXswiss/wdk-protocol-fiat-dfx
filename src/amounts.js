// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import Big from 'big.js'
import { ProviderError, ValueError } from '@tetherto/wdk-wallet/protocols'
import { ProviderErrorReason } from '@tetherto/wdk-wallet'
import { RATE_SIGNIFICANT_DIGITS } from './constants.js'

// Keep arithmetic configuration independent of the application's Big constructor.
const Decimal = Big()
Decimal.DP = 0
Decimal.RM = Big.roundHalfUp

export function unexpected (message = 'Unexpected DFX response', cause) {
  return new ProviderError(message, { reason: ProviderErrorReason.INTERNAL_SERVER_ERROR, cause })
}

export function decimal (value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    throw unexpected('Invalid decimal in DFX response')
  }
  return new Decimal(value)
}

export function minorUnits (value, decimals) {
  const scaled = decimal(value).times(new Decimal(`1e${decimals}`))
  if (scaled.lt(0) || !scaled.eq(scaled.round(0, Big.roundDown))) {
    throw unexpected('DFX amount is not a non-negative integer in smallest units')
  }
  return BigInt(scaled.toFixed())
}

export function positiveAmount (value) {
  if (!((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'bigint' && value > 0n))) {
    throw new ValueError('amount must be a positive safe integer or positive bigint')
  }
  return BigInt(value)
}

export function displayAmount (amount, decimals) {
  const value = new Decimal(amount.toString()).times(new Decimal(`1e-${decimals}`))
  const result = value.toFixed()
  const number = Number(result)
  if (!Number.isFinite(number) || new Decimal(number.toString()).toFixed() !== result) {
    throw new ValueError('amount exceeds the precision the DFX API accepts')
  }
  return result
}

export function divideAmounts (numerator, denominator) {
  const fiat = decimal(numerator)
  const crypto = decimal(denominator)
  if (fiat.lte(0) || crypto.lte(0)) throw unexpected('DFX quote amounts must be positive')
  // Compare normalized significands to determine the quotient's exact exponent.
  let exponent = fiat.e - crypto.e
  if (fiat.lt(crypto.times(new Decimal(`1e${exponent}`)))) exponent--
  const shift = RATE_SIGNIFICANT_DIGITS - 1 - exponent
  const significand = fiat.times(new Decimal(`1e${shift}`)).div(crypto)
  return significand.times(new Decimal(`1e${-shift}`)).toFixed()
}

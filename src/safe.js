// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { SafeAccountV0_3_0 as SafeAccount030 } from 'abstractionkit'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { SAFE_V0_3_0_INIT_OVERRIDES } from './constants.js'

// abstractionkit 0.4.0 keeps its ABI encoder private. This encodes exactly
// (address, bytes, bytes), then appends the ERC-6492 magic.
const ERC_6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'

function stripHex (value) {
  return value.replace(/^0x/i, '')
}

function encodeWord (value) {
  return BigInt(value).toString(16).padStart(64, '0')
}

function encodeDynamic (hex) {
  const bytes = hexToBytes(stripHex(hex))
  const body = bytesToHex(bytes).padEnd(Math.ceil(bytes.length / 32) * 64, '0')
  return encodeWord(bytes.length) + body
}

function encodeErc6492 (factoryAddress, factoryData, signature) {
  const head = 96
  const factory = encodeDynamic(factoryData)
  const signed = encodeDynamic(signature)
  const words = stripHex(factoryAddress).toLowerCase().padStart(64, '0') +
    encodeWord(head) +
    encodeWord(head + (factory.length / 2))
  return `0x${words}${factory}${signed}${ERC_6492_MAGIC}`
}

/**
 * Wraps a Safe signature as ERC-6492 when the owner predicts `account` with the
 * WDK Safe 0.3.0 parameters. Any failure returns the signature unchanged.
 */
export function erc6492SafeSignature ({ owner, account, signature }) {
  try {
    const predicted = SafeAccount030.createAccountAddress([owner], SAFE_V0_3_0_INIT_OVERRIDES)
    if (predicted.toLowerCase() !== account.toLowerCase()) return signature
    const [factoryAddress, factoryData] = SafeAccount030.createFactoryAddressAndData([owner], SAFE_V0_3_0_INIT_OVERRIDES)
    return encodeErc6492(factoryAddress, factoryData, signature)
  } catch {
    return signature
  }
}

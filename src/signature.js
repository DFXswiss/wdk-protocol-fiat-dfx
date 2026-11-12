// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Recovers the EIP-191 personal-sign signer address from a message and its signature.
 * Returns undefined for unrecognized or invalid signatures.
 */
export function recoverEvmAddress (message, signature) {
  if (!/^(?:0x)?[0-9a-f]{130}$/i.test(signature)) return undefined
  try {
    const bytes = hexToBytes(signature.replace(/^0x/i, ''))
    const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64]
    if (recovery !== 0 && recovery !== 1) return undefined
    const payload = utf8ToBytes(message)
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${payload.length}`)
    const digest = keccak256(concatBytes(prefix, payload))
    const publicKey = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact')
      .addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(false)
    return `0x${bytesToHex(keccak256(publicKey.subarray(1)).subarray(12))}`
  } catch {
    // Unrecognized or invalid signatures remain the backend's decision.
    return undefined
  }
}

function base58 (hex) {
  let value = BigInt(`0x${hex}`)
  let encoded = ''
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded
    value /= 58n
  }
  for (let offset = 0; offset < hex.length && hex.slice(offset, offset + 2) === '00'; offset += 2) encoded = '1' + encoded
  return encoded
}

function compactDer (hex) {
  const bytes = hex.match(/../g).map(byte => parseInt(byte, 16))
  // Both scalars fit in 32 bytes plus a possible sign byte: DER lengths are short form.
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2 || bytes[1] >= 0x80) return hex
  let offset = 2
  const scalars = []
  for (let index = 0; index < 2; index++) {
    if (bytes[offset++] !== 0x02) return hex
    const length = bytes[offset++]
    if (!length || length > 33 || offset + length > bytes.length) return hex
    const scalar = bytes.slice(offset, offset + length)
    offset += length
    // DER INTEGERs must be nonnegative and minimally encoded.
    if (scalar[0] >= 0x80) return hex
    if (scalar[0] === 0 && scalar.length > 1) {
      if (scalar[1] < 0x80) return hex
      scalar.shift()
    }
    if (scalar.length > 32) return hex
    scalars.push(scalar.map(byte => byte.toString(16).padStart(2, '0')).join('').padStart(64, '0'))
  }
  return offset === bytes.length ? scalars.join('') : hex
}

const SAFE_MESSAGE_FIELDS = Object.freeze([{ name: 'message', type: 'bytes' }])

/** EIP-191 digest DFX passes to ERC-1271 isValidSignature. */
function personalMessageHash (message) {
  const payload = utf8ToBytes(message)
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${payload.length}`)
  return keccak256(concatBytes(prefix, payload))
}

/**
 * Safe 1.4.1 typed data whose owner signature satisfies CompatibilityFallbackHandler.
 * The message bytes are the personal-sign digest: abi.encode of that bytes32 is the digest itself.
 */
export function safeMessageTypedData (chainId, verifyingContract, message) {
  return {
    domain: { chainId, verifyingContract },
    types: { SafeMessage: SAFE_MESSAGE_FIELDS },
    message: { message: `0x${bytesToHex(personalMessageHash(message))}` }
  }
}

/** Converts Solana hex signatures to Base58 and Spark DER hex signatures to compact hex, preserving other formats. */
export function normalizeSignature (network, signature) {
  if (network === 'solana' && /^[0-9a-f]{128}$/i.test(signature)) return base58(signature)
  if (network === 'spark' && /^(?:[0-9a-f]{2}){4,}$/i.test(signature)) return compactDer(signature)
  return signature
}

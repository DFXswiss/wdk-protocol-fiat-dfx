// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js'
import { ADDRESS_PLACEHOLDER, DUMMY_TOKEN } from './helpers.js'

function validSignature (message, signature, address) {
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) return false
  try {
    const bytes = Buffer.from(signature.slice(2), 'hex')
    const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64]
    if (recovery !== 0 && recovery !== 1) return false
    const payload = Buffer.from(message, 'utf8')
    const digest = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${payload.length}`), payload]))
    const recovered = Uint8Array.from([recovery, ...bytes.subarray(0, 64)])
    const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false })
    const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false)
    const recoveredAddress = '0x' + Buffer.from(keccak256(uncompressed.subarray(1))).subarray(12).toString('hex')
    return recoveredAddress === address.toLowerCase()
  } catch {
    return false
  }
}

export async function startServer () {
  let fixture
  try {
    fixture = JSON.parse(await readFile(new URL('./fixtures/sandbox.json', import.meta.url), 'utf8'))
  } catch (cause) {
    throw new Error('Missing or invalid sandbox recording. Run node tests/integration/record.js manually first.', { cause })
  }
  const { responses } = fixture
  for (const key of ['asset', 'fiat', 'country', 'quoteBuy_fiatAmount', 'quoteBuy_cryptoAmount', 'quoteSell_fiatAmount', 'quoteSell_cryptoAmount', 'challenge', 'detail_uid', 'detail_external']) {
    if (!responses?.[key]) throw new Error(`Missing fixture: ${key}`)
  }
  const challenges = new Map()
  const tokens = new Set()
  const registeredAddresses = new Set()
  const events = []
  const authBodies = []
  let faults = {}
  let logins = 0
  const server = createServer(async (request, response) => {
    const send = (status, raw) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(raw)
    }
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8') || null
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'POST' && url.pathname === '/__reset') {
        challenges.clear()
        tokens.clear()
        if (url.searchParams.get('preserveRegistrations') !== 'true') registeredAddresses.clear()
        events.length = 0
        authBodies.length = 0
        logins = 0
        faults = JSON.parse(body || '{}')
        send(200, '{}')
        return
      }
      if (request.method === 'GET' && url.pathname === '/__events') {
        send(200, JSON.stringify(events))
        return
      }
      if (request.method === 'GET' && url.pathname === '/__auth-bodies') {
        send(200, JSON.stringify(authBodies))
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/auth/signMessage' && body === null &&
          [...url.searchParams.keys()].join() === 'address' && /^0x[0-9a-f]{40}$/i.test(url.searchParams.get('address'))) {
        const address = url.searchParams.get('address')
        events.push(`challenge:${address}`)
        const raw = responses.challenge.raw.replaceAll(ADDRESS_PLACEHOLDER, address)
        challenges.set(address.toLowerCase(), JSON.parse(raw).message)
        send(responses.challenge.status, raw)
        return
      }
      if (request.method === 'POST' && request.url === '/v1/auth') {
        const auth = JSON.parse(body)
        authBodies.push(auth)
        if (!auth || Object.keys(auth).sort().join() !== 'address,blockchain,signature' || auth.blockchain !== 'Ethereum') {
          throw new Error('Unrecorded DFX auth request: expected address, signature and blockchain Ethereum')
        }
        const address = typeof auth.address === 'string' ? auth.address.toLowerCase() : ''
        const rejectAuthentication = () => {
          if (registeredAddresses.has(address)) {
            send(401, JSON.stringify({ statusCode: 401, message: 'Invalid credentials', error: 'Unauthorized' }))
          } else {
            send(400, JSON.stringify({ statusCode: 400, message: 'Invalid signature', error: 'Bad Request' }))
          }
        }
        events.push(`login:${auth.address}`)
        const message = challenges.get(address)
        if (!message || !validSignature(message, auth.signature, address)) {
          rejectAuthentication()
          return
        }
        challenges.delete(address)
        ++logins
        if (logins === 1 && faults.auth === 'unauthorized') {
          rejectAuthentication()
          return
        }
        // Explicit corruption probe, not a recorded successful DFX response.
        if (logins === 1 && faults.auth === 'missing token') {
          send(201, '{}')
          return
        }
        const token = logins === 1 ? DUMMY_TOKEN : `${DUMMY_TOKEN}.${logins}`
        tokens.add(token)
        registeredAddresses.add(address)
        send(201, JSON.stringify({ accessToken: token }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/transaction/detail/single') {
        events.push(`detail:${request.url}:${request.headers.authorization}`)
        if (faults.expireDetails > 0) {
          --faults.expireDetails
          tokens.clear()
        }
        if (!tokens.has(request.headers.authorization?.slice(7))) {
          send(401, JSON.stringify({ statusCode: 401, message: 'Unauthorized', error: 'Unauthorized' }))
          return
        }
        // Explicit synthetic success, not a recorded sandbox transaction.
        if (faults.completedDetail) {
          send(200, JSON.stringify({ type: 'Buy', state: 'Completed', inputAsset: 'CHF', outputAsset: 'USDT', outputBlockchain: 'Ethereum' }))
          return
        }
      }
      const entry = Object.values(responses).find(entry => entry.request &&
        entry.request.method === request.method && entry.request.path === request.url && entry.request.body === body)
      if (!entry) throw new Error(`Unrecorded DFX request: ${request.method} ${request.url} body=${body}`)
      send(entry.status, entry.raw)
    } catch (error) {
      send(500, JSON.stringify({ message: error.message }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

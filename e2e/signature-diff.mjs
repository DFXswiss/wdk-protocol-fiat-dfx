// Differential check of the module's signature normalization against reference libraries.
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { normalizeSignature } from '../src/signature.js'
const require = createRequire(import.meta.url)
const bs58 = require('bs58').default ?? require('bs58')
const { secp256k1 } = await import('@noble/curves/secp256k1')

let bad = 0
// Solana: 20000 random 64-byte signatures, 1/4 with forced leading zero bytes.
for (let i = 0; i < 20000; i++) {
  const b = randomBytes(64)
  if (i % 4 === 0) b.fill(0, 0, 1 + (i % 3))
  const hex = b.toString('hex')
  if (normalizeSignature('solana', hex) !== bs58.encode(b)) { bad++; if (bad < 5) console.log('solana mismatch', hex) }
}
console.log('solana checked 20000, mismatches', bad)

// Spark: 5000 real secp256k1 signatures, DER from noble vs module compact.
let bad2 = 0
for (let i = 0; i < 5000; i++) {
  const priv = secp256k1.utils.randomPrivateKey ? secp256k1.utils.randomPrivateKey() : secp256k1.utils.randomSecretKey()
  const sig = secp256k1.sign(randomBytes(32), priv)
  const der = typeof sig.toDERHex === 'function' ? sig.toDERHex() : Buffer.from(sig.toBytes('der')).toString('hex')
  const compact = typeof sig.toCompactHex === 'function' ? sig.toCompactHex() : Buffer.from(sig.toBytes('compact')).toString('hex')
  if (normalizeSignature('spark', der) !== compact) { bad2++; if (bad2 < 5) console.log('spark mismatch', der) }
}
console.log('spark checked 5000, mismatches', bad2)

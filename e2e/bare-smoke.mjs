import DfxProtocol from '../bare.js'
import expected from './fixtures/bare-smoke-expected.json' with { type: 'json' }

// The deterministic public owner 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF,
// Safe and signatures were derived with ethers Wallet using private key 2 and
// abstractionkit SafeAccountV0_3_0 with WDK Safe 0.3.0 params.
const SAFE = '0xe5385ac47CD1964317428CD363cf59D976D12672'
const CHALLENGE = '[dev]_By_signing_this_message,_you_confirm_that_you_are_the_sole_owner_of_the_provided_Blockchain_address._Your_ID:_0xe5385ac47CD1964317428CD363cf59D976D12672'
const OWNER_SIGNATURE = '0xd68efac83e5d5ce82f4017fb82bd1b5a63c35e7e5cdca327a7658a5bfabb87713dd0d9562de8fed5d4d885945066e6af9c3ac3008094ac21336d030c155d36261b'
const SAFE_SIGNATURE = `0x${'11'.repeat(64)}1b`
// See ./fixtures/bare-smoke-expected.json for the wrapper and its derivation details.

let postedAuth

function reply (status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const fetch = async (input, init = {}) => {
  const path = new URL(input).pathname
  if ((init.method ?? 'GET') === 'GET' && path === '/v1/auth/signMessage') {
    return reply(200, { message: CHALLENGE })
  }
  if (init.method === 'POST' && path === '/v1/auth') {
    postedAuth = JSON.parse(init.body)
    return reply(201, { accessToken: 'stub' })
  }
  return reply(404, { message: 'Not found' })
}

const account = {
  getAddress: async () => SAFE,
  sign: async message => message === CHALLENGE ? OWNER_SIGNATURE : '0x',
  signTypedData: async () => SAFE_SIGNATURE
}

let checks = 0
let passed = 0
function check (name, condition, failureDetail) {
  checks++
  if (condition) {
    passed++
    console.log(`OK ${name}`)
  } else {
    process.exitCode = 1
    console.log(`FAIL ${name}${failureDetail ? `: ${failureDetail}` : ''}`)
  }
}

check('Bare entry point loads DfxProtocol as a class', typeof DfxProtocol === 'function' && /^class\s/.test(Function.prototype.toString.call(DfxProtocol)))

const protocol = new DfxProtocol(account, { environment: 'sandbox', network: 'polygon', fetch })
let detailError
try {
  await protocol.getTransactionDetail('bare-smoke')
} catch (error) {
  detailError = error
}

check('posted address is the predicted Safe', postedAuth?.address === SAFE)
check('posted signature matches the expected ERC-6492 wrapper', postedAuth?.signature === expected.signature)
check('transaction detail returns the stubbed 404 after login', postedAuth !== undefined && detailError?.message === 'Not found', detailError?.message ?? 'no error returned')
console.log(`SUMMARY: ${passed}/${checks}`)

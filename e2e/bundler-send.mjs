import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  formatEther,
  formatUnits,
  getAddress,
  id,
  isAddress,
  keccak256,
  parseUnits,
  toBeHex,
  zeroPadValue
} from 'ethers'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'

const DEFAULT_RPC = 'http://127.0.0.1:8547'
const DEFAULT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const DEFAULT_SEED_FILE = `${homedir()}/.wdk-dfx-real/seed.txt`
const CHAIN_ID = 8453n
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const USER_OPERATION_EVENT = 'UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'
const RECEIPT_TIMEOUT_MS = 180_000
const RECEIPT_POLL_MS = 2_000
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
]
const ENTRY_POINT_ABI = [
  'function balanceOf(address) view returns (uint256)'
]
const coder = AbiCoder.defaultAbiCoder()
const userOperationEventTopic = id(USER_OPERATION_EVENT)

function parseArgs (args) {
  const options = {
    rpc: DEFAULT_RPC,
    token: DEFAULT_TOKEN,
    account: '0',
    send: false,
    native: false,
    all: false,
    tokenProvided: false
  }
  const valued = new Map([
    ['--rpc', 'rpc'], ['--bundler', 'bundler'], ['--account', 'account'],
    ['--to', 'to'], ['--token', 'token'], ['--amount', 'amount'],
    ['--max-fee', 'maxFee'], ['--fork-fund', 'forkFund'], ['--confirm', 'confirm']
  ])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (name === '--send') {
      if (seen.has(name)) throw new Error('Duplicate argument: --send')
      seen.add(name)
      options.send = true
    } else if (name === '--native') {
      if (seen.has(name)) throw new Error('Duplicate argument: --native')
      seen.add(name)
      options.native = true
    } else if (name === '--all') {
      if (seen.has(name)) throw new Error('Duplicate argument: --all')
      seen.add(name)
      options.all = true
    } else if (valued.has(name)) {
      if (seen.has(name)) throw new Error(`Duplicate argument: ${name}`)
      seen.add(name)
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
      options[valued.get(name)] = value
      if (name === '--token') options.tokenProvided = true
    } else {
      throw new Error(`Unknown argument: ${name}`)
    }
  }
  if (!options.bundler) throw new Error('Required argument missing: --bundler <url>')
  if (!options.to) throw new Error('Required argument missing: --to <address>')
  if (!isAddress(options.to)) throw new Error('--to must be a valid EVM address')
  if (!isAddress(options.token)) throw new Error('--token must be a valid EVM address')
  options.to = getAddress(options.to)
  if (options.to === ZeroAddress) throw new Error('--to cannot be the zero address')
  if (!options.native && options.to === getAddress(options.token)) {
    throw new Error('--to cannot be the token contract address')
  }
  options.token = getAddress(options.token)
  if (options.native && options.tokenProvided) throw new Error('--native cannot be used together with --token')
  if (options.all && !options.native) throw new Error('--all is allowed only with --native')
  if (options.all && options.amount !== undefined) throw new Error('--all cannot be used together with --amount')
  if (!options.all && options.amount === undefined) throw new Error('Required argument missing: --amount <decimal> or --all')
  if (!/^(0|[1-9]\d*)$/.test(options.account)) {
    throw new Error('--account must be a decimal integer without leading zeroes')
  }
  if (BigInt(options.account) > 2147483647n) throw new Error('--account must be at most 2147483647')
  options.accountIndex = Number(options.account)
  if (options.amount !== undefined && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.amount)) {
    throw new Error('--amount must be a decimal asset amount')
  }
  if (options.maxFee !== undefined) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.maxFee)) {
      throw new Error('--max-fee must be a decimal ETH amount')
    }
    options.maxFeeWei = parseUnits(options.maxFee, 18)
    if (options.maxFeeWei <= 0n) throw new Error('--max-fee must be greater than zero')
  }
  let bundlerProtocol
  try {
    bundlerProtocol = new URL(options.bundler).protocol
  } catch {
    throw new Error('--bundler must use HTTP or HTTPS')
  }
  if (!['http:', 'https:'].includes(bundlerProtocol)) throw new Error('--bundler must use HTTP or HTTPS')
  options.local = ['127.0.0.1', 'localhost'].includes(new URL(options.rpc).hostname.toLowerCase())
  if (options.forkFund !== undefined && !options.local) throw new Error('--fork-fund is allowed only with a local RPC host')
  if (!options.native && options.forkFund !== undefined && options.token !== getAddress(DEFAULT_TOKEN)) {
    throw new Error('--fork-fund supports only Base USDC')
  }
  return options
}

async function readSeedFile (path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const seed = (await file.readFile('utf8')).trim()
    if (!seed) throw new Error()
    return seed
  } catch {
    throw new Error('Seed file must be a non-empty regular file owned by the current user with owner-only permissions (for example 0600), and must not be a symlink.')
  } finally {
    if (file) await file.close().catch(() => {})
  }
}

function maskSensitiveText (value, seed) {
  let message = String(value ?? 'Unknown error')
  if (seed) message = message.split(seed).join('[REDACTED SEED]')
  return message.replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED KEY]')
}

function asBytes32 (value) {
  return zeroPadValue(toBeHex(value), 32)
}

function quotedFeeOf (quote) {
  if (typeof quote?.fee !== 'bigint') throw new Error('WDK quote fee was not a bigint')
  return quote.fee
}

function quantity (value, source) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`${source} was not a quantity`)
  }
  try {
    return BigInt(value)
  } catch {
    throw new Error(`${source} was not a quantity`)
  }
}

async function bundlerRequest (url, method) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] })
  })
  if (!response.ok) throw new Error(`Bundler ${method} failed with HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`Bundler ${method} returned no JSON-RPC object`)
  }
  if (!body || typeof body !== 'object') throw new Error(`Bundler ${method} returned no JSON-RPC object`)
  if (body.error) {
    const detail = body.error.message ?? JSON.stringify(body.error)
    throw new Error(`Bundler ${method} failed: ${detail}`)
  }
  if (body.result === undefined) throw new Error(`Bundler ${method} returned no result`)
  return body.result
}

async function assertBundler (url) {
  const chainId = quantity(await bundlerRequest(url, 'eth_chainId'), 'Bundler eth_chainId')
  if (chainId !== CHAIN_ID) throw new Error(`Bundler chain id is ${chainId}; expected ${CHAIN_ID}`)
  const supported = await bundlerRequest(url, 'eth_supportedEntryPoints')
  const wanted = ENTRY_POINT.toLowerCase()
  if (!Array.isArray(supported) || !supported.some(entry => String(entry).toLowerCase() === wanted)) {
    throw new Error(`Bundler does not support EntryPoint ${ENTRY_POINT}`)
  }
}

async function waitForUserOperation (account, hash) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  let receipt = null
  while (Date.now() <= deadline) {
    try {
      receipt = await account.getUserOperationReceipt(hash)
    } catch {
      // Not included yet. A bundler error is not a terminal failure until the deadline.
      receipt = null
    }
    if (receipt) return receipt
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(RECEIPT_POLL_MS, remaining)))
  }
  throw new Error(`User operation ${hash} was not included within 180s`)
}

function userOperationLog (txReceipt, userOpHash, safe) {
  const topic0 = userOperationEventTopic.toLowerCase()
  const topic1 = userOpHash.toLowerCase()
  const topic2 = zeroPadValue(safe, 32).toLowerCase()
  const entryPoint = ENTRY_POINT.toLowerCase()
  const matches = txReceipt.logs.filter(log => {
    return log.address.toLowerCase() === entryPoint &&
      log.topics[0]?.toLowerCase() === topic0 &&
      log.topics[1]?.toLowerCase() === topic1 &&
      log.topics[2]?.toLowerCase() === topic2
  })
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one UserOperationEvent for ${userOpHash} from ${safe}, found ${matches.length}`)
  }
  return coder.decode(['uint256', 'bool', 'uint256', 'uint256'], matches[0].data)
}

async function main () {
  let seed
  let provider
  try {
    const options = parseArgs(process.argv.slice(2))
    const rpcUrl = new URL(options.rpc)
    if (!['http:', 'https:'].includes(rpcUrl.protocol)) throw new Error('--rpc must use HTTP or HTTPS')
    provider = new JsonRpcProvider(options.rpc, undefined, { cacheTimeout: -1 })
    const chainId = (await provider.getNetwork()).chainId
    if (chainId !== CHAIN_ID) throw new Error(`RPC chain id is ${chainId}; expected ${CHAIN_ID}`)
    await assertBundler(options.bundler)

    const seedFile = process.env.WALLET_SIM_SEED_FILE || DEFAULT_SEED_FILE
    seed = await readSeedFile(seedFile)
    const maxFeeConfig = options.maxFeeWei === undefined
      ? {}
      : { [options.native ? 'transactionMaxFee' : 'transferMaxFee']: options.maxFeeWei }
    const manager = new WalletManagerEvmErc4337(seed, {
      chainId: 8453,
      provider: options.rpc,
      bundlerUrl: options.bundler,
      safeModulesVersion: '0.3.0',
      useNativeCoins: true,
      ...maxFeeConfig
    })
    const account = await manager.getAccount(options.accountIndex)
    const safe = getAddress(await account.getAddress())
    if (options.to.toLowerCase() === safe.toLowerCase()) throw new Error('--to must differ from the Safe')

    const token = options.native ? undefined : new Contract(options.token, ERC20_ABI, provider)
    const decimals = options.native ? 18 : Number(await token.decimals())
    if (!options.native && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
      throw new Error('Token returned invalid decimals')
    }
    const readAsset = address => options.native ? provider.getBalance(address) : token.balanceOf(address)

    if (options.forkFund !== undefined) {
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.forkFund)) throw new Error('--fork-fund must be a decimal asset amount')
      const funded = parseUnits(options.forkFund, decimals)
      if (funded <= 0n) throw new Error('--fork-fund must be greater than zero')
      if (options.native) {
        await provider.send('anvil_setBalance', [safe, toBeHex(funded)])
      } else {
        const slot = keccak256(coder.encode(['address', 'uint256'], [safe, 9]))
        await provider.send('anvil_setStorageAt', [options.token, slot, asBytes32(funded)])
      }
      const fundedBalance = await readAsset(safe)
      if (fundedBalance !== funded) {
        throw new Error(`Fork funding verification failed: expected ${formatUnits(funded, decimals)}, got ${formatUnits(fundedBalance, decimals)}`)
      }
    }

    const code = await provider.getCode(safe)
    const deployed = code !== '0x'
    const safeEthBefore = await provider.getBalance(safe)
    const safeAssetBefore = options.native ? safeEthBefore : await token.balanceOf(safe)
    const recipientBefore = await readAsset(options.to)
    const entryPoint = new Contract(ENTRY_POINT, ENTRY_POINT_ABI, provider)
    const entryPointBefore = await entryPoint.balanceOf(safe)

    let amount
    if (options.all) {
      const sizingFee = quotedFeeOf(await account.quoteSendTransaction({ to: options.to, value: 1n }))
      // ceil(3 * q / 2): the Safe keeps this reserve, and the EntryPoint keeps the unspent deposit.
      const reserved = (3n * sizingFee + 1n) / 2n
      amount = safeEthBefore - reserved
      if (amount <= 0n) {
        throw new Error(`--all amount is ${formatEther(amount)}; expected greater than zero after reserving ${formatEther(reserved)}`)
      }
    } else {
      amount = parseUnits(options.amount, decimals)
      if (amount <= 0n) throw new Error('--amount must be greater than zero')
    }
    const quote = options.native
      ? await account.quoteSendTransaction({ to: options.to, value: amount })
      : await account.quoteTransfer({ token: options.token, recipient: options.to, amount })
    const fee = quotedFeeOf(quote)

    console.log(`chainId: ${chainId}`)
    console.log(`Bundler: ${options.bundler}`)
    console.log(`Account: ${options.accountIndex}`)
    console.log(`Safe: ${safe}`)
    console.log(`Safe deployed: ${deployed ? 'yes' : 'no'}`)
    console.log(options.native ? 'Asset: native ETH' : `Token: ${options.token}`)
    console.log(`Safe asset balance: ${formatUnits(safeAssetBefore, decimals)}`)
    console.log(`Safe ETH balance: ${formatEther(safeEthBefore)}`)
    console.log(`EntryPoint balance: ${formatEther(entryPointBefore)} ETH`)
    console.log(`Destination balance: ${formatUnits(recipientBefore, decimals)}`)
    console.log(`Amount: ${formatUnits(amount, decimals)}`)
    console.log(`Quoted fee: ${formatEther(fee)} ETH`)
    if (options.all) console.log('A remainder stays in the Safe and as a balance in the EntryPoint.')

    if (!options.send) {
      console.log('Dry run only; no user operation was sent.')
      return
    }
    if (options.confirm?.toLowerCase() !== safe.toLowerCase()) {
      throw new Error('--send requires --confirm with the exact Safe address')
    }
    if (amount <= 0n) throw new Error('Amount must be greater than zero')
    const gasBudget = safeEthBefore + entryPointBefore
    if (options.native && safeEthBefore < amount) {
      throw new Error(`Safe ETH balance ${formatEther(safeEthBefore)} is below amount ${formatEther(amount)}`)
    }
    if (!options.native && safeAssetBefore < amount) {
      throw new Error(`Safe token balance ${formatUnits(safeAssetBefore, decimals)} is below amount ${formatUnits(amount, decimals)}`)
    }
    const requiredGas = options.native ? amount + fee : fee
    if (gasBudget < requiredGas) {
      const reason = options.native ? 'amount plus quoted fee' : 'quoted fee'
      throw new Error(`Safe ETH plus EntryPoint balance ${formatEther(gasBudget)} is below ${reason} ${formatEther(requiredGas)}`)
    }

    const sent = options.native
      ? await account.sendTransaction({ to: options.to, value: amount })
      : await account.transfer({ token: options.token, recipient: options.to, amount })
    if (typeof sent?.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sent.hash)) {
      throw new Error('WDK did not return a user operation hash')
    }
    const userOpHash = sent.hash
    console.log(`User operation: ${userOpHash}`)
    const userOpReceipt = await waitForUserOperation(account, userOpHash)
    // abstractionkit nests the Ethereum receipt; the user-operation object itself has no transactionHash.
    const txHash = userOpReceipt.receipt && userOpReceipt.receipt.transactionHash
    if (!txHash) throw new Error(`User operation receipt for ${userOpHash} has no transaction hash`)
    const txReceipt = await provider.getTransactionReceipt(txHash)
    if (!txReceipt || txReceipt.status !== 1) {
      throw new Error(`Bundling transaction ${txHash} failed (receipt status was not 1)`)
    }
    const decoded = userOperationLog(txReceipt, userOpHash, safe)
    const eventSuccess = decoded[1]
    const actualGasCost = decoded[2]
    if (eventSuccess !== true) throw new Error(`UserOperationEvent success is ${eventSuccess}`)
    if (userOpReceipt.success !== true) throw new Error(`Bundler receipt success is ${userOpReceipt.success}`)

    const codeAfter = await provider.getCode(safe)
    const deployedAfter = codeAfter !== '0x'
    if (!deployedAfter) throw new Error('Safe has no code after the user operation')
    const safeEthAfter = await provider.getBalance(safe)
    const safeEthSpent = safeEthBefore - safeEthAfter
    const safeAssetAfter = options.native ? safeEthAfter : await token.balanceOf(safe)
    const recipientAfter = await readAsset(options.to)
    const entryPointAfter = await entryPoint.balanceOf(safe)
    const expectedRecipient = recipientBefore + amount
    if (recipientAfter !== expectedRecipient) {
      throw new Error(`Recipient balance is ${formatUnits(recipientAfter, decimals)}; expected ${formatUnits(expectedRecipient, decimals)}`)
    }
    if (options.native) {
      const upper = amount + 2n * fee
      if (safeEthSpent < amount || safeEthSpent > upper) {
        throw new Error(`Safe ETH spent ${formatEther(safeEthSpent)}; expected between ${formatEther(amount)} and ${formatEther(upper)}`)
      }
    } else {
      const expectedSafeAsset = safeAssetBefore - amount
      if (safeAssetAfter !== expectedSafeAsset) {
        throw new Error(`Safe token balance is ${formatUnits(safeAssetAfter, decimals)}; expected ${formatUnits(expectedSafeAsset, decimals)}`)
      }
    }

    console.log(`Transaction: ${txHash}`)
    console.log(`Block: ${txReceipt.blockNumber}`)
    console.log(`Actual gas cost: ${formatEther(actualGasCost)} ETH`)
    console.log(`Safe ETH spent: ${formatEther(safeEthSpent)} ETH`)
    console.log(`EntryPoint balance before: ${formatEther(entryPointBefore)} ETH`)
    console.log(`EntryPoint balance after: ${formatEther(entryPointAfter)} ETH`)
    console.log(`Safe balance after: ${formatUnits(safeAssetAfter, decimals)}`)
    console.log(`Destination balance after: ${formatUnits(recipientAfter, decimals)}`)
    console.log('result: ' + JSON.stringify({
      timestamp: new Date().toISOString(),
      safe,
      recipient: options.to,
      asset: options.native ? 'ETH' : options.token,
      amount: amount.toString(),
      deployedBefore: deployed,
      deployedAfter,
      userOperationHash: userOpHash,
      transactionHash: txHash,
      block: String(txReceipt.blockNumber),
      actualGasCost: actualGasCost.toString(),
      safeEthSpent: safeEthSpent.toString(),
      entryPointBalanceBefore: entryPointBefore.toString(),
      entryPointBalanceAfter: entryPointAfter.toString(),
      safeBalanceAfter: safeAssetAfter.toString(),
      recipientBalanceAfter: recipientAfter.toString()
    }))
  } catch (error) {
    console.error('bundler-send failed: ' + maskSensitiveText(error?.message ?? error, seed))
    process.exitCode = 1
  } finally {
    provider?.destroy()
  }
}

await main()

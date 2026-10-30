import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toBeHex,
  zeroPadValue
} from 'ethers'
import { SafeAccountV0_3_0 } from 'abstractionkit'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337, { WalletAccountReadOnlyEvmErc4337 } from '@tetherto/wdk-wallet-evm-erc-4337'

const DEFAULT_RPC = 'http://127.0.0.1:8547'
const DEFAULT_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F'
const DEFAULT_SEED_FILE = `${homedir()}/.wdk-dfx-real/seed.txt`
const CHAIN_ID = 8453n
const SAFE_CONFIG = {
  chainId: Number(CHAIN_ID),
  safeModulesVersion: '0.3.0',
  bundlerUrl: 'https://bundler.invalid',
  useNativeCoins: true
}
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address,uint256) returns (bool)'
]
const SAFE_ABI = [
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'
]
const GAS_PRICE_ORACLE_ABI = [
  'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)'
]
const erc20Interface = new Interface(ERC20_ABI)
const safeInterface = new Interface(SAFE_ABI)
const gasPriceOracleInterface = new Interface(GAS_PRICE_ORACLE_ABI)
const coder = AbiCoder.defaultAbiCoder()
// Safe execution cannot be estimated by an RPC while the counterfactual Safe has no code.
// This conservative allowance covers the Safe call path plus a standard ERC-20 transfer.
const UNDEPLOYED_TRANSFER_GAS_ESTIMATE = 180_000n

function parseArgs (args) {
  const options = { rpc: DEFAULT_RPC, token: DEFAULT_TOKEN, send: false, native: false, tokenProvided: false }
  const valued = new Map([
    ['--rpc', 'rpc'], ['--to', 'to'], ['--token', 'token'],
    ['--fork-fund', 'forkFund'], ['--confirm', 'confirm'],
    ['--priority-fee-gwei', 'priorityFeeGwei']
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
  options.local = ['127.0.0.1', 'localhost'].includes(new URL(options.rpc).hostname.toLowerCase())
  if (options.forkFund !== undefined && !options.local) throw new Error('--fork-fund is allowed only with a local RPC host')
  if (!options.native && options.forkFund !== undefined && options.token !== getAddress(DEFAULT_TOKEN)) {
    throw new Error('--fork-fund supports only Base USDC')
  }
  if (options.priorityFeeGwei !== undefined) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.priorityFeeGwei)) {
      throw new Error('--priority-fee-gwei must be a decimal gwei amount')
    }
    options.priorityFeeWei = parseUnits(options.priorityFeeGwei, 9)
    if (options.priorityFeeWei <= 0n || options.priorityFeeWei > 1_000_000_000n) {
      throw new Error('--priority-fee-gwei must be greater than 0 and at most 1')
    }
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

function withGasBuffer (estimate) {
  return (estimate * 120n + 99n) / 100n
}

async function l1FeeUpperBound (provider, data) {
  const unsignedTxSize = BigInt((data.length - 2) / 2 + 200)
  const result = await provider.call({
    to: BASE_GAS_PRICE_ORACLE,
    data: gasPriceOracleInterface.encodeFunctionData('getL1FeeUpperBound', [unsignedTxSize])
  })
  return BigInt(gasPriceOracleInterface.decodeFunctionResult('getL1FeeUpperBound', result)[0])
}

async function receiptCost (provider, hash, receipt) {
  const raw = await provider.send('eth_getTransactionReceipt', [hash])
  if (!raw) throw new Error(`Receipt unavailable for transaction ${hash}`)
  const effectiveGasPrice = raw.effectiveGasPrice !== undefined
    ? BigInt(raw.effectiveGasPrice)
    : (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n)
  const l2 = receipt.gasUsed * effectiveGasPrice
  const l1 = raw.l1Fee === undefined ? 0n : BigInt(raw.l1Fee)
  return { l2, l1, total: l2 + l1 }
}

function requireStatusOne (receipt, label) {
  if (!receipt || receipt.status !== 1) throw new Error(`${label} transaction failed (receipt status was not 1)`)
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

    const seedFile = process.env.WALLET_SIM_SEED_FILE || DEFAULT_SEED_FILE
    seed = await readSeedFile(seedFile)

    const ownerManager = new WalletManagerEvm(seed, { provider: options.rpc })
    const ownerAccount = await ownerManager.getAccount(0)
    const safeManager = new WalletManagerEvmErc4337(seed, { ...SAFE_CONFIG, provider: options.rpc })
    const safeAccount = await safeManager.getAccount(0)
    const owner = getAddress(await ownerAccount.getAddress())
    const safe = getAddress(await safeAccount.getAddress())
    const sendingSigner = getAddress(await ownerAccount.getAddress())
    const safeOwnerAccount = safeAccount._ownerAccount
    if (!safeOwnerAccount) throw new Error('WDK did not expose the ERC-4337 owner account for verification')
    const safeOwner = getAddress(await safeOwnerAccount.getAddress())
    if (owner.toLowerCase() !== sendingSigner.toLowerCase() || owner.toLowerCase() !== safeOwner.toLowerCase()) {
      throw new Error('The WDK owner does not match the address used for transaction signing')
    }
    if (safe.toLowerCase() === owner.toLowerCase()) throw new Error('The predicted Safe address equals its owner')
    if (options.to.toLowerCase() === safe.toLowerCase() || options.to.toLowerCase() === owner.toLowerCase()) {
      throw new Error('--to must differ from both the Safe and its owner')
    }

    const initOverrides = WalletAccountReadOnlyEvmErc4337._getInitCodeOverrides(SAFE_CONFIG)
    const predicted = getAddress(SafeAccountV0_3_0.createAccountAddress([owner], initOverrides))
    const [factory, factoryData] = SafeAccountV0_3_0.createFactoryAddressAndData([owner], initOverrides)
    if (predicted.toLowerCase() !== safe.toLowerCase()) {
      throw new Error(`Safe prediction mismatch: WDK ${safe}; abstractionkit ${predicted}`)
    }

    const code = await provider.getCode(safe)
    let deployed = code !== '0x'
    const token = options.native ? undefined : new Contract(options.token, ERC20_ABI, provider)
    const decimals = options.native ? 18 : Number(await token.decimals())
    const readBalance = address => options.native ? provider.getBalance(address) : token.balanceOf(address)
    if (!options.native && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
      throw new Error('Token returned invalid decimals')
    }

    if (options.forkFund !== undefined) {
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.forkFund)) throw new Error('--fork-fund must be a decimal asset amount')
      const amount = parseUnits(options.forkFund, decimals)
      if (amount <= 0n) throw new Error('--fork-fund must be greater than zero')
      if (options.native) {
        await provider.send('anvil_setBalance', [safe, toBeHex(amount)])
      } else {
        const slot = keccak256(coder.encode(['address', 'uint256'], [safe, 9]))
        const storageValue = asBytes32(amount)
        await provider.send('anvil_setStorageAt', [options.token, slot, storageValue])
      }
      const fundedBalance = await readBalance(safe)
      if (fundedBalance !== amount) throw new Error(`Fork funding verification failed: expected ${formatUnits(amount, decimals)}, got ${formatUnits(fundedBalance, decimals)}`)
    }

    const balance = await readBalance(safe)
    const destinationBalanceBefore = await readBalance(options.to)
    if (balance === 0n && options.send) {
      throw new Error(`Safe ${options.native ? 'ETH' : 'token'} balance is zero; refusing to send or deploy`)
    }
    const ownerEthBefore = await provider.getBalance(owner)
    const block = await provider.getBlock('latest')
    if (block?.baseFeePerGas == null) throw new Error('Latest block does not provide baseFeePerGas')
    const priorityFeeWei = options.priorityFeeWei ?? BigInt(await provider.send('eth_maxPriorityFeePerGas', []))
    if (priorityFeeWei <= 0n) throw new Error('RPC returned a non-positive priority fee')
    const maxFeePerGas = 2n * block.baseFeePerGas + priorityFeeWei

    let deployGas = 0n
    let deployL1Fee = 0n
    if (!deployed) {
      deployGas = await provider.estimateGas({ from: owner, to: factory, data: factoryData, value: 0n })
      deployL1Fee = await l1FeeUpperBound(provider, factoryData)
    }
    const transferData = options.native ? '0x' : erc20Interface.encodeFunctionData('transfer', [options.to, balance])
    const safeTransactionTarget = options.native ? options.to : options.token
    const safeTransactionValue = options.native ? balance : 0n
    const signature = `0x${owner.slice(2).padStart(64, '0')}${'00'.repeat(32)}01`
    const execData = safeInterface.encodeFunctionData('execTransaction', [
      safeTransactionTarget, safeTransactionValue, transferData, 0, 0n, 0n, 0n, ZeroAddress, ZeroAddress, signature
    ])
    let transferGasEstimate
    if (deployed) {
      transferGasEstimate = await provider.estimateGas({ from: owner, to: safe, data: execData, value: 0n })
    } else {
      transferGasEstimate = UNDEPLOYED_TRANSFER_GAS_ESTIMATE
    }
    const transferGas = deployed ? withGasBuffer(transferGasEstimate) : transferGasEstimate
    const transferL1Fee = await l1FeeUpperBound(provider, execData)

    const estimatedDeploymentCost = deployGas * maxFeePerGas + deployL1Fee
    const estimatedTransferCost = transferGas * maxFeePerGas + transferL1Fee
    const estimatedTotalCost = estimatedDeploymentCost + estimatedTransferCost
    console.log(`chainId: ${chainId}`)
    console.log(`Owner: ${owner}`)
    console.log(`Safe: ${safe}`)
    console.log(`Safe deployed: ${deployed ? 'yes' : 'no'}`)
    console.log(options.native ? 'Asset: native ETH' : `Token: ${options.token}`)
    console.log(`Safe ${options.native ? 'ETH' : 'token'} balance: ${formatUnits(balance, decimals)}`)
    console.log(`Destination ${options.native ? 'ETH' : 'token'} balance: ${formatUnits(destinationBalanceBefore, decimals)}`)
    if (balance === 0n) console.log(`No ${options.native ? 'ETH' : 'token'} balance to recover; --send would stop before any transaction.`)
    console.log(`Owner ETH balance: ${formatEther(ownerEthBefore)}`)
    console.log(`Estimated deployment gas: ${deployed ? 'not needed (already deployed)' : deployGas}`)
    console.log(`Estimated transfer gas: ${deployed ? transferGas : `approximately ${transferGas} (Safe is undeployed; conservative allowance)`}`)
    console.log(`Priority fee: ${formatUnits(priorityFeeWei, 9)} gwei`)
    console.log(`Max fee per gas: ${formatUnits(maxFeePerGas, 9)} gwei`)
    console.log(`Deployment L1 fee upper bound: ${formatEther(deployL1Fee)} ETH`)
    console.log(`Transfer L1 fee upper bound: ${formatEther(transferL1Fee)} ETH`)
    console.log(`Estimated deployment cost: ${formatEther(estimatedDeploymentCost)} ETH`)
    console.log(`Estimated transfer cost: ${formatEther(estimatedTransferCost)} ETH`)
    console.log(`Estimated total cost: ${formatEther(estimatedTotalCost)} ETH`)

    if (!options.send) {
      console.log('Dry run only; no transaction was sent.')
      return
    }
    if (options.confirm?.toLowerCase() !== safe.toLowerCase()) {
      throw new Error('--send requires --confirm with the exact Safe address')
    }
    const preflightLimit = 2n * estimatedTotalCost
    if (ownerEthBefore < preflightLimit) {
      throw new Error(`Owner ETH balance ${formatEther(ownerEthBefore)} is below the buffered preflight estimate ${formatEther(preflightLimit)}`)
    }

    let deploymentHash
    let deploymentReceipt
    if (!deployed) {
      const deploymentNonce = await provider.getTransactionCount(owner, 'pending')
      const sent = await ownerAccount.sendTransaction({
        to: factory,
        data: factoryData,
        value: 0n,
        nonce: deploymentNonce,
        type: 2,
        maxFeePerGas,
        maxPriorityFeePerGas: priorityFeeWei
      })
      deploymentHash = sent.hash
      deploymentReceipt = await provider.waitForTransaction(deploymentHash)
      requireStatusOne(deploymentReceipt, 'Safe deployment')
      let deployedCode = '0x'
      for (let attempt = 0; attempt < 10; attempt++) {
        deployedCode = await provider.getCode(safe)
        if (deployedCode !== '0x') break
        if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1_000))
      }
      if (deployedCode === '0x') throw new Error('Safe deployment receipt succeeded, but the Safe still has no code')
      deployed = true
    }

    const sendBalance = await readBalance(safe)
    if (sendBalance === 0n) throw new Error(`Safe ${options.native ? 'ETH' : 'token'} balance is zero; nothing to send`)
    const sendTransferData = options.native ? '0x' : erc20Interface.encodeFunctionData('transfer', [options.to, sendBalance])
    const sendTarget = options.native ? options.to : options.token
    const sendValue = options.native ? sendBalance : 0n
    const sendExecData = safeInterface.encodeFunctionData('execTransaction', [
      sendTarget, sendValue, sendTransferData, 0, 0n, 0n, 0n, ZeroAddress, ZeroAddress, signature
    ])
    const exactTransferGasEstimate = await provider.estimateGas({ from: owner, to: safe, data: sendExecData, value: 0n })
    const transferGasLimit = withGasBuffer(exactTransferGasEstimate)
    const currentOwnerBalance = await provider.getBalance(owner)
    const transferEstimatedCost = transferGasLimit * maxFeePerGas + transferL1Fee
    const transferPreflightLimit = 2n * transferEstimatedCost
    if (currentOwnerBalance < transferPreflightLimit) {
      throw new Error(`Insufficient owner ETH after Safe deployment for transfer; no transfer was sent and the Safe asset balance remains unchanged. Available ${formatEther(currentOwnerBalance)}, required ${formatEther(transferPreflightLimit)}`)
    }
    console.log(`Pre-transfer gas estimate: ${exactTransferGasEstimate}; gas limit with 20% buffer: ${transferGasLimit}`)
    console.log(`Pre-transfer L1 fee upper bound: ${formatEther(transferL1Fee)} ETH`)
    console.log(`Pre-transfer estimated cost: ${formatEther(transferEstimatedCost)} ETH`)
    const transferNonce = await provider.getTransactionCount(owner, 'pending')
    const transferSent = await ownerAccount.sendTransaction({
      to: safe,
      data: sendExecData,
      value: 0n,
      gasLimit: transferGasLimit,
      nonce: transferNonce,
      type: 2,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFeeWei
    })
    const transferReceipt = await provider.waitForTransaction(transferSent.hash)
    requireStatusOne(transferReceipt, 'Safe asset transfer')

    const safeBalanceAfter = await readBalance(safe)
    const destinationBalanceAfter = await readBalance(options.to)
    const expectedDestinationBalance = destinationBalanceBefore + sendBalance
    if (safeBalanceAfter !== 0n) throw new Error(`Post-transfer Safe ${options.native ? 'ETH' : 'token'} balance is ${formatUnits(safeBalanceAfter, decimals)}; expected 0`)
    if (destinationBalanceAfter !== expectedDestinationBalance) {
      throw new Error(`Post-transfer destination ${options.native ? 'ETH' : 'token'} balance is ${formatUnits(destinationBalanceAfter, decimals)}; expected ${formatUnits(expectedDestinationBalance, decimals)}`)
    }

    const ownerEthAfter = await provider.getBalance(owner)
    const deploymentCost = deploymentReceipt
      ? await receiptCost(provider, deploymentHash, deploymentReceipt)
      : { l2: 0n, l1: 0n, total: 0n }
    const transferCost = await receiptCost(provider, transferSent.hash, transferReceipt)
    const actualGasCost = deploymentCost.total + transferCost.total
    const ownerEthSpent = ownerEthBefore - ownerEthAfter
    const maximumExpectedCost = estimatedTotalCost + actualGasCost
    if (ownerEthSpent < actualGasCost || ownerEthSpent > maximumExpectedCost) {
      throw new Error(`Owner ETH spent ${formatEther(ownerEthSpent)}; expected between receipt cost ${formatEther(actualGasCost)} and ${formatEther(maximumExpectedCost)}`)
    }
    console.log(`Deployment transaction: ${deploymentHash ?? 'already deployed'}`)
    console.log(`Transfer transaction: ${transferSent.hash}`)
    console.log(`Safe ${options.native ? 'ETH' : 'token'} balance after: ${formatUnits(safeBalanceAfter, decimals)} (expected 0)`)
    console.log(`Destination ${options.native ? 'ETH' : 'token'} balance after: ${formatUnits(destinationBalanceAfter, decimals)} (expected ${formatUnits(expectedDestinationBalance, decimals)})`)
    console.log(`L2 gas cost: ${formatEther(deploymentCost.l2 + transferCost.l2)} ETH`)
    console.log(`L1 data fee: ${formatEther(deploymentCost.l1 + transferCost.l1)} ETH`)
    console.log(`Total receipt cost: ${formatEther(actualGasCost)} ETH`)
    console.log(`Unreported difference: ${formatEther(ownerEthSpent - actualGasCost)} ETH`)
    console.log(`Owner ETH spent: ${formatEther(ownerEthSpent)} ETH`)
  } catch (error) {
    console.error(`safe-rescue failed: ${maskSensitiveText(error?.message ?? error, seed)}`)
    process.exitCode = 1
  } finally {
    provider?.destroy()
  }
}

await main()

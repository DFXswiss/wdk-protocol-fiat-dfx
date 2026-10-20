// Live DFX sandbox probe. Only wallet RPCs use the local Polygon fork.
// buy/sell submit the Safe address as an ERC-6492 wrapper. viem 2.38.5, the
// version the DFX API uses, checks that wrapper on the fork before deployment
// and again after it. Each sign-in records sandbox as rejected or accepted.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { AbiCoder, hashMessage, Interface, verifyMessage, verifyTypedData } from 'ethers'
// viem 2.38.5 mirrors the DFX API's ERC-6492 verification.
import { createPublicClient, http } from 'viem'
import WDK from '@tetherto/wdk'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const require = createRequire(import.meta.url)
const walletRequire = createRequire(require.resolve('@tetherto/wdk-wallet-evm-erc-4337'))
const { SafeAccountV0_3_0: SafeAccount030 } = walletRequire('abstractionkit')
const API = 'https://dev.api.dfx.swiss'
const MESSAGE = 'DFX deployed Safe owner-signature probe v1'
const results = []
const stop = new AbortController()
let child, childDone, childError, wdk, rpcUrl, account, fiat, safe, owner, signatureBefore
const dfxRequests = []
const authBodies = []
let challengeMessage
let rpcId = 0
let anvilStderr = ''
let anvilStderrTruncated = false
let forkUrl

class ProbeFailure extends Error {}
function check (condition, message) {
  if (!condition) throw new ProbeFailure(message)
}

function maskRpcText (text) {
  if (forkUrl) {
    text = text.split(forkUrl).join('[RPC URL]')
      .split(forkUrl.replace(/^https:\/\//i, '')).join('[RPC URL]')
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[RPC URL]')
}

function anvilDiagnostic (message) {
  let text = anvilStderr
  if (anvilStderrTruncated) {
    const newline = text.indexOf('\n')
    text = newline === -1 ? '' : text.slice(newline + 1)
  }
  const tail = maskRpcText(text).trim().split(/\r?\n/).slice(-10).join('\n')
  return tail ? `${message}\nAnvil stderr (last 10 lines):\n${tail}` : message
}

async function step (name, fn) {
  const started = Date.now()
  try {
    stop.signal.throwIfAborted()
    const value = await fn()
    results.push({ chain: 'polygon-4337', name, ok: true, value })
    console.log(`  OK   ${name} (${Date.now() - started} ms)`)
    return value
  } catch (error) {
    // Third-party errors can contain signed requests, seeds or session URLs.
    // Only explicit probe diagnostics (including URL-masked Anvil stderr) are printed.
    const diagnostic = error instanceof ProbeFailure ? error.message : 'Operation failed; sensitive error details omitted'
    results.push({ chain: 'polygon-4337', name, ok: false, error: diagnostic })
    console.log(`  FAIL ${name}: ${diagnostic}`)
    throw error
  }
}

async function rpc (method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)])
  })
  check(response.ok, `RPC HTTP failure for ${method}: ${response.status}`)
  const body = await response.json()
  if (body.error) {
    const code = maskRpcText(String(body.error.code)).slice(0, 32)
    const message = maskRpcText(String(body.error.message ?? '')).slice(0, 200)
    throw new ProbeFailure(`RPC rejected ${method}: ${code} ${message}`)
  }
  check(Object.hasOwn(body, 'result'), `RPC rejected ${method}`)
  return body.result
}

async function waitFor (fn, timeout, diagnostic) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted()
    check(childError?.code !== 'ENOENT', 'Anvil executable not found; install anvil and add it to PATH')
    if (childError || child.exitCode !== null || child.signalCode !== null) {
      await Promise.race([childDone, delay(3000)]) // Wait for stderr to drain before reporting the failure.
      throw new ProbeFailure(anvilDiagnostic('Anvil exited unexpectedly'))
    }
    const value = await fn()
    if (value) return value
    await delay(250, undefined, { signal: stop.signal })
  }
  throw new ProbeFailure(anvilDiagnostic(typeof diagnostic === 'function' ? diagnostic() : diagnostic))
}

async function stopAnvil () {
  if (!child || child.exitCode !== null || child.signalCode !== null || childError) return
  child.kill('SIGTERM')
  const exited = await Promise.race([childDone.then(() => true), delay(3000).then(() => false)])
  if (!exited) {
    child.kill('SIGKILL')
    const killed = await Promise.race([childDone.then(() => true), delay(3000).then(() => false)])
    if (!killed) {
      console.error(`anvil did not exit after SIGKILL (PID ${child.pid})`)
      process.exitCode = 1
    }
  }
}

const ERC_6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'

function unwrapErc6492 (signature) {
  check(typeof signature === 'string' && signature.toLowerCase().endsWith(ERC_6492_MAGIC), 'Sign-in signature is not ERC-6492')
  let decoded
  try {
    decoded = AbiCoder.defaultAbiCoder().decode(
      ['address', 'bytes', 'bytes'],
      '0x' + signature.slice(2, -ERC_6492_MAGIC.length)
    )
  } catch {
    throw new ProbeFailure('ERC-6492 signature could not be decoded')
  }
  const [factory, factoryData, inner] = decoded
  return { factory, factoryData, inner }
}

function sameHex (left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase()
}

function sandboxOutcome (kind, result, rejection) {
  if (!rejection) {
    const field = kind === 'buy' ? 'buyUrl' : 'sellUrl'
    let session = ''
    try { session = new URL(result?.[field]).searchParams.get('session') ?? '' } catch { session = '' }
    check(session.length > 0, 'Sandbox acceptance did not return a session')
    return 'accepted'
  }
  check(rejection.constructor?.name === 'ProviderError', 'Sandbox did not reject the sign-in or return a session')
  check(rejection.reason === 'UNAUTHORIZED', 'Sandbox rejection was not an authentication failure')
  return 'rejected'
}

async function submitSignIn (kind, options) {
  dfxRequests.length = 0
  authBodies.length = 0
  challengeMessage = undefined
  let result
  let rejection
  try {
    result = await fiat[kind](options)
  } catch (error) {
    rejection = error
  }
  const sandbox = sandboxOutcome(kind, result, rejection)
  check(dfxRequests.filter(request => request === 'GET /v1/auth/signMessage').length === 1, 'Expected exactly one DFX sign-in challenge')
  check(authBodies.length === 1, 'Expected one DFX sign-in')
  const body = JSON.parse(authBodies[0])
  check(sameHex(body.address, safe), 'Sign-in address is not the Safe')
  check(!sameHex(body.address, owner), 'Sign-in address is the owner')
  check(body.blockchain === 'Polygon', 'Sign-in blockchain is not Polygon')
  check(typeof challengeMessage === 'string' && challengeMessage.length > 0, 'Missing DFX challenge')
  const signer = verifyMessage(challengeMessage, await account.sign(challengeMessage))
  check(sameHex(signer, owner), 'Owner personal signature changed')
  const wrapped = unwrapErc6492(body.signature)
  const typedSigner = verifyTypedData(
    { chainId: 137, verifyingContract: safe },
    { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    { message: hashMessage(challengeMessage) },
    wrapped.inner
  )
  check(sameHex(typedSigner, owner), 'Safe signature does not recover to the owner')
  return { signature: body.signature, sandbox, ...wrapped }
}

async function forkVerifiesWrapper (signature) {
  let accepted = false
  try {
    accepted = await createPublicClient({ transport: http(rpcUrl) }).verifyMessage({
      address: safe,
      message: challengeMessage,
      signature
    })
  } catch {
    throw new ProbeFailure('Fork rejected the ERC-6492 sign-in signature')
  }
  check(accepted === true, 'Fork rejected the ERC-6492 sign-in signature')
}

const onSignal = () => stop.abort(new ProbeFailure('Interrupted'))
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
// Bound library calls too, including calls that do not accept AbortSignal.
const watchdog = setTimeout(() => stop.abort(new ProbeFailure('Probe exceeded five minutes')), 300000)
const interrupted = new Promise((resolve, reject) => {
  stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true })
})

async function run () {
  await step('single @tetherto/wdk-wallet copy', async () => {
    const dfxWalletPath = createRequire(require.resolve('@dfx.swiss/wdk-protocol-fiat-dfx')).resolve('@tetherto/wdk-wallet')
    const wdkWalletPath = createRequire(require.resolve('@tetherto/wdk')).resolve('@tetherto/wdk-wallet')
    check(dfxWalletPath === wdkWalletPath, 'Duplicate @tetherto/wdk-wallet copies; reinstall e2e dependencies with install-links=true')
    return { copies: 1 }
  })

  await step('start Polygon fork and await eth_chainId', async () => {
    forkUrl = process.env.ANVIL_FORK_URL ?? 'https://polygon-bor-rpc.publicnode.com'
    let parsedForkUrl
    try { parsedForkUrl = new URL(forkUrl) } catch {
      throw new ProbeFailure('ANVIL_FORK_URL must be a valid HTTPS URL')
    }
    check(parsedForkUrl.protocol === 'https:', 'ANVIL_FORK_URL must be a valid HTTPS URL')
    const portText = process.env.ANVIL_PORT ?? '8547'
    check(/^\d+$/.test(portText), 'ANVIL_PORT must be an integer')
    const port = Number(portText)
    check(port > 0 && port <= 65535, 'ANVIL_PORT must be between 1 and 65535')
    rpcUrl = `http://127.0.0.1:${port}`
    // Refuse an occupied port instead of accidentally mutating another node.
    await new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', () => reject(new ProbeFailure('ANVIL_PORT is unavailable')))
      server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
    })
    child = spawn('anvil', [
      '--fork-url', forkUrl,
      '--chain-id', '137', '--host', '127.0.0.1', '--port', String(port)
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      anvilStderr += chunk
      if (anvilStderr.length > 8192) {
        anvilStderrTruncated = true
        anvilStderr = anvilStderr.slice(-8192)
      }
    })
    childDone = new Promise(resolve => {
      child.once('error', error => { childError = error; resolve() })
      child.once('close', resolve)
    })
    await waitFor(async () => {
      try { return await rpc('eth_chainId') === '0x89' } catch { return false }
    }, 60000, 'Anvil did not report Polygon chain ID 137')
    return { chainId: 137, port }
  })

  await step('register WDK and assert counterfactual Safe', async () => {
    wdk = new WDK(WDK.getRandomSeedPhrase())
      .registerWallet('polygon', WalletManagerEvmErc4337, {
        chainId: 137, provider: rpcUrl, bundlerUrl: 'https://bundler.invalid',
        safeModulesVersion: '0.3.0', useNativeCoins: true
      })
      .registerProtocol('polygon', 'dfx', DfxProtocol, {
        environment: 'sandbox',
        network: 'polygon',
        fetch: async (url, init) => {
          const path = new URL(url).pathname
          dfxRequests.push(`${init?.method ?? 'GET'} ${path}`)
          if (path === '/v1/auth' && init?.method === 'POST') authBodies.push(init.body)
          const response = await fetch(url, init)
          if (path === '/v1/auth/signMessage') challengeMessage = JSON.parse(await response.clone().text()).message
          return response
        }
      })
    account = await wdk.getAccount('polygon', 0)
    safe = await account.getAddress()
    fiat = account.getFiatProtocol('dfx')
    check(fiat instanceof DfxProtocol, 'DFX protocol registration failed')
    check(await rpc('eth_getCode', [safe, 'latest']) === '0x', 'Safe was already deployed')
    check(!await SafeAccount030.isDeployed(safe, rpcUrl), 'Package reports Safe already deployed')
    return { safe, deployed: false }
  })

  await step('sign before deployment and recover owner', async () => {
    signatureBefore = await account.sign(MESSAGE)
    owner = verifyMessage(MESSAGE, signatureBefore)
    check(owner.toLowerCase() !== safe.toLowerCase(), 'Recovered owner equals Safe')
    check(owner.toLowerCase() === (await account._ownerAccount.getAddress()).toLowerCase(), 'Signature does not recover package owner')
    return { owner, safe }
  })

  const asset = await step('find USDT on Polygon', async () => {
    const asset = (await fiat.getSupportedCryptoAssets()).find(a => a.code === 'USDT' && a.networkCode === 'polygon')
    check(asset && Number.isInteger(asset.decimals) && asset.decimals >= 0, 'USDT/Polygon missing or invalid decimals')
    return { code: asset.code, decimals: asset.decimals }
  })
  const buyOptions = { cryptoAsset: 'USDT', fiatCurrency: 'EUR', fiatAmount: 10000n }
  await step('buy submits the wrapped Safe signature before deployment', async () => {
    const posted = await submitSignIn('buy', buyOptions)
    const smartAccount = await account._getSmartAccount()
    check(sameHex(posted.factory, smartAccount.factoryAddress), 'Wrapper factory differs from the counterfactual Safe')
    check(sameHex(posted.factoryData, smartAccount.factoryData), 'Wrapper factory data differs from the counterfactual Safe')
    await forkVerifiesWrapper(posted.signature)
    check(await rpc('eth_getCode', [safe, 'latest']) === '0x', 'ERC-6492 verification deployed the Safe')
    return { safe, sandbox: posted.sandbox, wrapped: true, deployed: false }
  })

  await step('deploy package factory transaction without bundler', async () => {
    // beta.20 uses AbstractionKit, not Relay Kit. _getSmartAccount preserves
    // the exact init-code overrides used by WDK to predict this Safe address.
    // Its factoryAddress + factoryData are the first UserOperation's initCode.
    const smartAccount = await account._getSmartAccount()
    check(smartAccount.accountAddress.toLowerCase() === safe.toLowerCase(), 'Factory account differs from WDK Safe')
    check(/^0x[0-9a-f]{40}$/i.test(smartAccount.factoryAddress ?? ''), 'Package returned no deployment factory')
    check(/^0x[0-9a-f]+$/i.test(smartAccount.factoryData ?? ''), 'Package returned no deployment calldata')
    await rpc('anvil_setBalance', [owner, '0x56bc75e2d63100000']) // 100 POL on fork only.
    await rpc('anvil_impersonateAccount', [owner])
    let hash
    let primaryFailed = false
    try {
      hash = await rpc('eth_sendTransaction', [{ from: owner, to: smartAccount.factoryAddress, data: smartAccount.factoryData, value: '0x0', gas: '0x7a1200' }])
      let lastError
      const receipt = await waitFor(async () => {
        try {
          const receipt = await rpc('eth_getTransactionReceipt', [hash])
          lastError = undefined
          return receipt
        } catch (error) {
          lastError = maskRpcText(String(error?.message ?? error)).slice(0, 300)
          return false
        }
      }, 60000, () => lastError ? `Deployment receipt timed out; last RPC error: ${lastError}` : 'Deployment receipt timed out')
      check(receipt.status === '0x1', 'Safe deployment transaction reverted')
    } catch (error) {
      primaryFailed = true
      throw error
    } finally {
      try {
        await rpc('anvil_stopImpersonatingAccount', [owner])
      } catch (error) {
        if (!primaryFailed) throw error
      }
    }
    check(await rpc('eth_getCode', [safe, 'latest']) !== '0x', 'Safe has no deployed bytecode')
    check(await SafeAccount030.isDeployed(safe, rpcUrl), 'Package does not recognize deployed Safe')
    const deployed = await account._getSmartAccount()
    check(deployed.factoryAddress === null && deployed.factoryData === null, 'WDK still builds a counterfactual account')
    return { safe, transactionHash: hash, deployed: true }
  })

  await step('sign after deployment: identical signature and owner', async () => {
    const signatureAfter = await account.sign(MESSAGE)
    check(signatureAfter === signatureBefore, 'Signature changed after deployment')
    check(verifyMessage(MESSAGE, signatureAfter).toLowerCase() === owner.toLowerCase(), 'Signer changed after deployment')
    return { identical: true, owner }
  })

  await step('quoteBuy EUR to USDT/Polygon', async () => {
    const quote = await fiat.quoteBuy(buyOptions)
    check(typeof quote?.cryptoAmount === 'bigint' && quote.cryptoAmount > 0n, 'quoteBuy returned no positive crypto amount')
    check(quote.fiatAmount === buyOptions.fiatAmount, 'quoteBuy changed requested fiat amount')
    return { quoted: true, cryptoAmount: String(quote.cryptoAmount), fiatAmount: String(quote.fiatAmount) }
  })
  const erc1271 = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)'])
  for (const kind of ['buy', 'sell']) {
    await step(`${kind} submits the Safe and the fork accepts the signature`, async () => {
      const posted = await submitSignIn(kind, kind === 'buy' ? buyOptions : {
        cryptoAsset: 'USDT', fiatCurrency: 'EUR', cryptoAmount: 50n * 10n ** BigInt(asset.decimals)
      })
      const data = erc1271.encodeFunctionData('isValidSignature', [hashMessage(challengeMessage), posted.inner])
      const magic = await rpc('eth_call', [{ to: safe, data }, 'latest'])
      check(magic.startsWith('0x1626ba7e'), 'Forked Safe rejected the sign-in signature')
      await forkVerifiesWrapper(posted.signature)
      return { safe, erc1271: true, sandbox: posted.sandbox }
    })
  }
}

try {
  await Promise.race([run(), interrupted])
} catch {
  if (!results.some(result => !result.ok)) {
    results.push({ chain: 'polygon-4337', name: 'probe interrupted', ok: false, error: 'Interrupted or overall timeout exceeded' })
  }
  process.exitCode = 1
} finally {
  stop.abort(new ProbeFailure('Probe finished'))
  clearTimeout(watchdog)
  try {
    await stopAnvil()
  } finally {
    try { wdk?.dispose() } finally {
      const out = new URL('./out/', import.meta.url)
      mkdirSync(out, { recursive: true })
      writeFileSync(new URL('safe-deployed.json', out), JSON.stringify(results, null, 2) + '\n', { mode: 0o600 })
      const failures = results.filter(result => !result.ok).length
      console.log(`SUMMARY: ${results.length - failures}/${results.length} steps OK`)
      // Pending SDK requests must not outlive the bounded probe and child cleanup.
      process.exit(failures || process.exitCode ? 1 : 0)
    }
  }
}

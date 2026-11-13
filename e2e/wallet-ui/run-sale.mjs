// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

// Sepolia sale of 1 USDT for EUR.
// The WDK starter wallet on the iOS simulator confirms the send.
// Without --send and --confirm, only the preflight runs and the app is not driven.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { Contract, JsonRpcProvider, getAddress, parseUnits } from 'ethers'
import { chromium } from 'playwright'
import { FAILED_STATES } from '../../src/constants.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const flowDir = fileURLToPath(new URL('./flow', import.meta.url))
const buildPath = fileURLToPath(new URL('./out/build.json', import.meta.url))
const patchPath = fileURLToPath(new URL('./starter.patch', import.meta.url))
const API = 'https://dev.api.dfx.swiss'
const APP = 'https://dev.app.dfx.swiss'
const EXPLORER = 'https://eth-sepolia.blockscout.com'
const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const BUNDLE_ID = 'io.tether.wdk.starter.reactnative'
const CHAIN_ID = 11155111n
const USDT = getAddress('0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0')
const USDT_AMOUNT = 1000000n
const ETH_FEE = parseUnits('0.0002', 18)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const WALLET_INTERFACE = 'wdk-starter-react-native in the iOS simulator, driven by Maestro'
const IBAN_LABEL = 'CH 00000 (invented per run)'
const FLOW_SHOTS = ['sell-widget-open.png', 'send-review.png', 'send-success.png']
// Short transaction id in explorer-<hash>.png: 10 hex digits, no 0x prefix.
const HASH_SHORT = 10
const RECORD_FIELDS = [
  'date', 'moduleHead', 'dirty', 'starterCommit', 'patchSha256', 'mainJsbundleSha256',
  'maestroVersion', 'simulatorRuntime', 'walletInterface', 'backendCommitStart', 'backendCommitEnd',
  'account', 'depositAddress', 'ibanCountryAndClearing', 'hash', 'block', 'gasUsed', 'fee',
  'balances', 'walletConfirmations', 'backend', 'moduleStatus', 'backendReads', 'rpcReadRetries', 'explorerReloads', 'maestroStepRetries', 'clipboardCleared', 'walletStateCleared',
  'screenshots'
]

class UsageError extends Error {}
class NotRunError extends Error {}

function assertModuleCopy () {
  const mismatch = () => new NotRunError('not run: installed module differs from the working tree; run npm ci in e2e')
  const installed = resolve(repoRoot, 'e2e/node_modules/@dfx.swiss/wdk-protocol-fiat-dfx')
  try {
    const collect = base => {
      const files = []
      const visit = relative => {
        const path = resolve(base, relative)
        let current = resolve('/')
        for (const part of path.split('/').filter(Boolean)) {
          current = resolve(current, part)
          if (lstatSync(current).isSymbolicLink()) throw mismatch()
        }
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
          for (const name of readdirSync(path)) visit(`${relative}/${name}`)
        } else if (stat.isFile()) files.push(relative)
        else throw mismatch()
      }
      for (const name of ['package.json', 'index.js', 'bare.js']) {
        if (!lstatSync(resolve(base, name)).isFile()) throw mismatch()
        visit(name)
      }
      for (const name of ['src', 'types']) {
        if (!lstatSync(resolve(base, name)).isDirectory()) throw mismatch()
        visit(name)
      }
      return files.sort()
    }
    const source = collect(repoRoot)
    const copy = collect(installed)
    if (source.length !== copy.length || source.some((file, i) => file !== copy[i])) throw mismatch()
    const digest = path => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return createHash('sha256').update(readFileSync(fd)).digest('hex') } finally { closeSync(fd) }
    }
    for (const file of source) {
      if (digest(resolve(repoRoot, file)) !== digest(resolve(installed, file))) throw mismatch()
    }
  } catch (error) {
    if (error instanceof NotRunError) throw error
    throw mismatch()
  }
}
class CheckError extends Error {
  constructor (failedCheck, message, failedStep) {
    super(message)
    this.failedCheck = failedCheck
    this.failedStep = failedStep
  }
}

const state = {
  clipboard: false,
  clipboardClearAttempted: false,
  clipboardPromise: null,
  lockHeld: false,
  lockDir: '',
  udid: '',
  provider: null,
  wdk: null,
  options: null,
  recordWritten: false,
  backendReads: 0,
  rpcReadRetries: 0,
  explorerReloads: 0,
  browser: null,
  fiat: null,
  session: '',
  saleIban: '',
  flow1Started: false,
  cleanupAttempted: false,
  cleanupPromise: null,
  releasePromise: null,
  child: null,
  interrupted: false,
  signalExitCode: null,
  signalPromise: null,
  recordPromise: null,
  failedStep: undefined,
  screenshots: [],
  evidence: {},
  secrets: [],
  ibanPatterns: []
}

function redact (value) {
  let text = String(value ?? 'Unknown error')
  const ordered = state.secrets.filter(Boolean).sort((a, b) => b.length - a.length)
  for (const secret of ordered) text = text.split(secret).join('[REDACTED]')
  for (const pattern of state.ibanPatterns) {
    pattern.lastIndex = 0
    text = text.replace(pattern, '[REDACTED]')
  }
  return text
    .replace(/([?&]session=)[^&\s"'<>]+/g, '$1[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/https?:\/\/\S+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
}

function rememberSecret (value) {
  if (typeof value === 'string' && value !== '') state.secrets.push(value)
}

function compact (value) {
  return String(value ?? '').replace(/[\s\u00a0]/g, '')
}

function rememberIban (iban) {
  rememberSecret(iban)
  rememberSecret(compact(iban))
  const raw = compact(iban)
  const spaced = raw.replace(/(.{4})(?=.)/g, '$1 ')
  rememberSecret(spaced)
  rememberSecret(spaced.replace(/ /g, '\u00a0'))
  const body = [...raw].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\u00a0?]*')
  state.ibanPatterns.push(new RegExp(body, 'g'))
}

function inventedIban () {
  const bban = '00000' + Array.from({ length: 12 }, () => String(randomInt(10))).join('')
  const remainder = [...`${bban}121700`].reduce((n, digit) => (n * 10 + Number(digit)) % 97, 0)
  return `CH${String(98 - remainder).padStart(2, '0')}${bban}`
}

function git (args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function runCapture (command, args, stdinMode) {
  const stdin = stdinMode === 'empty' ? 'pipe' : stdinMode === 'ignore' || stdinMode == null ? 'ignore' : stdinMode
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    const finish = (handler, value) => {
      if (settled) return
      settled = true
      handler(value)
    }
    try {
      child = spawn(command, args, { stdio: [stdin, 'pipe', 'pipe'] })
      state.child = child
    } catch (error) {
      reject(error)
      return
    }
    if (stdinMode === 'empty') child.stdin.end()
    const out = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', () => {})
    child.on('error', error => {
      if (state.child === child) state.child = null
      finish(reject, error)
    })
    child.on('close', code => {
      if (state.child === child) state.child = null
      finish(resolve, {
        code: code == null ? 1 : code,
        stdout: Buffer.concat(out).toString('utf8')
      })
    })
  })
}

function captureSync (command, args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024
      })
    }
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    if (typeof error?.status === 'number') return { code: error.status, stdout }
    const wrapped = new Error('command failed')
    wrapped.code = error?.code
    throw wrapped
  }
}

function sha256File (path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return createHash('sha256').update(readFileSync(fd)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

function parseArgs (args) {
  const options = { rpc: DEFAULT_RPC, send: false, confirm: false }
  const valued = new Map([
    ['--seed-file', 'seedFile'],
    ['--udid', 'udid'],
    ['--record', 'record'],
    ['--screenshots', 'screenshots'],
    ['--follow', 'follow'],
    ['--rpc', 'rpc']
  ])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (name === '--send' || name === '--confirm') {
      if (seen.has(name)) throw new UsageError(`Duplicate argument: ${name}`)
      seen.add(name)
      options[name === '--send' ? 'send' : 'confirm'] = true
    } else if (valued.has(name)) {
      if (seen.has(name)) throw new UsageError(`Duplicate argument: ${name}`)
      seen.add(name)
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${name}`)
      options[valued.get(name)] = value
    } else {
      throw new UsageError('Unknown argument')
    }
  }
  if (!options.seedFile) throw new UsageError('Required argument missing: --seed-file <path>')
  if (!options.udid) throw new UsageError('Required argument missing: --udid <id>')
  if (options.send !== options.confirm) throw new UsageError('--send and --confirm are both required to send')
  if (options.follow != null) {
    if (!/^(?:[1-9]\d*)$/.test(options.follow) || Number(options.follow) > 240) {
      throw new UsageError('--follow must be an integer from 1 to 240')
    }
    options.follow = Number(options.follow)
  }
  let protocol
  try {
    protocol = new URL(options.rpc).protocol
  } catch {
    throw new UsageError('--rpc must use HTTP or HTTPS')
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new UsageError('--rpc must use HTTP or HTTPS')
  if (options.send) {
    if (!options.follow) throw new UsageError('--send requires --follow <minutes>')
    if (!options.screenshots) throw new UsageError('--send requires --screenshots <dir>')
    if (!options.record) throw new UsageError('--send requires --record <file>')
  }
  return options
}

function prepareScreenshots (dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new UsageError(`--screenshots cannot be created (${error.code || 'failed'})`)
  }
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw new UsageError('--screenshots must be a non-symlink directory owned by the current user with mode 0700')
  }
}

function assertRecordPath (path, seedFile) {
  let recordPath
  let seedPath
  try {
    recordPath = resolve(realpathSync(dirname(resolve(path))), basename(path))
    seedPath = resolve(realpathSync(dirname(resolve(seedFile))), basename(seedFile))
  } catch (error) {
    throw new UsageError(`--record or --seed-file parent cannot be resolved (${error.code || 'failed'})`)
  }
  if (recordPath === seedPath) throw new UsageError('--record must not name the seed file')
  try {
    lstatSync(path)
    throw new UsageError('--record must name a file that does not exist yet')
  } catch (error) {
    if (error instanceof UsageError) throw error
    if (error.code !== 'ENOENT') throw new UsageError(`--record cannot be checked (${error.code || 'failed'})`)
  }
}

async function readPrivateFile (path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error()
    const text = (await file.readFile('utf8')).trim()
    if (!text) throw new Error()
    return text
  } catch {
    throw new NotRunError('not run: --seed-file must be a non-empty regular file owned by the current user with owner-only permissions (for example 0600), and must not be a symlink.')
  } finally {
    if (file) await file.close().catch(() => {})
  }
}

function takeLock (dir) {
  try {
    mkdirSync(dir)
  } catch (error) {
    if (error.code === 'EEXIST') throw new NotRunError('not run: wallet locked')
    throw new NotRunError(`not run: cannot create lock (${error.code || 'failed'})`)
  }
  state.lockHeld = true
  state.lockDir = dir
}

function isLagging (error) {
  const pending = [error]
  const seen = new Set()
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (item.code === -32001 || (typeof item.message === 'string' && /(?:block|header) not found/i.test(item.message))) return true
    pending.push(item.error, item.info)
  }
  return false
}

async function readAtBlock (blockNumber, read) {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('A fixed block number is required')
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      return await read()
    } catch (error) {
      if (!isLagging(error) || Date.now() + 2_000 >= deadline) throw error
      await delay(2_000)
      state.rpcReadRetries++
    }
  }
}

function quantity (value, failedCheck) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  throw new CheckError(failedCheck, 'value was not a quantity')
}

function bootedRuntime (udid) {
  const listed = captureSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])
  if (listed.code !== 0) throw new NotRunError('not run: simulator list failed')
  let body
  try {
    body = JSON.parse(listed.stdout)
  } catch {
    throw new NotRunError('not run: simulator list was not JSON')
  }
  let runtime = null
  const devices = body && typeof body.devices === 'object' ? body.devices : {}
  for (const [key, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) continue
    for (const device of list) {
      if (!device || String(device.udid).toLowerCase() !== udid.toLowerCase() || device.state !== 'Booted') continue
      if (runtime) throw new NotRunError('not run: simulator udid is listed twice')
      runtime = key
    }
  }
  if (!runtime) throw new NotRunError('not run: simulator is not booted')
  if (runtime !== 'com.apple.CoreSimulator.SimRuntime.iOS-26-5') throw new NotRunError(`not run: the simulator runtime is ${runtime}; this run needs iOS 26.5`)
  return runtime
}

function foreignMaestro () {
  let text
  try {
    text = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024
    })
  } catch {
    throw new NotRunError('not run: process list unavailable')
  }
  const rows = []
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  const own = new Set([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (own.has(row.ppid) && !own.has(row.pid)) {
        own.add(row.pid)
        grew = true
      }
    }
  }
  return rows.some(row => !own.has(row.pid) && (/(^|\/|\s)maestro(\s|$)/.test(row.command) || /(^|\s)maestro\.cli\.AppKt(\s|$)/.test(row.command)))
}

function assertNoForeignMaestro (duringSend) {
  let busy
  try {
    busy = foreignMaestro()
  } catch (error) {
    if (duringSend) throw new CheckError('maestro-busy', 'nothing sent')
    throw error
  }
  if (!busy) return
  if (duringSend) throw new CheckError('maestro-busy', 'nothing sent')
  throw new NotRunError('not run: another Maestro process is running')
}

function readBuild () {
  let text
  try {
    text = readFileSync(buildPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new NotRunError('not run: out/build.json is missing')
    throw new NotRunError('not run: out/build.json cannot be read')
  }
  let build
  try {
    build = JSON.parse(text)
  } catch {
    throw new NotRunError('not run: out/build.json is not JSON')
  }
  if (!build || typeof build !== 'object') throw new NotRunError('not run: out/build.json is not an object')
  if (build.moduleDirty !== false) throw new NotRunError('not run: out/build.json does not record a clean module tree')
  if (typeof build.moduleHead !== 'string' || !/^[0-9a-f]{40,64}$/.test(build.moduleHead)) {
    throw new NotRunError('not run: out/build.json has no moduleHead')
  }
  if (typeof build.starterCommit !== 'string' || !/^[0-9a-f]{40}$/.test(build.starterCommit)) {
    throw new NotRunError('not run: out/build.json has no starterCommit')
  }
  for (const key of ['patchSha256', 'mainJsbundleSha256']) {
    if (typeof build[key] !== 'string' || !/^[0-9a-f]{64}$/.test(build[key])) {
      throw new NotRunError(`not run: out/build.json has no ${key}`)
    }
  }
  return build
}

function installedBundleSha (udid) {
  const listed = captureSync('xcrun', ['simctl', 'get_app_container', udid, BUNDLE_ID, 'app'])
  if (listed.code !== 0) throw new NotRunError('not run: starter app is not installed')
  const container = listed.stdout.trim()
  if (container === '' || container.includes('\n')) throw new NotRunError('not run: app container path is not a single line')
  try {
    return sha256File(join(container, 'main.jsbundle'))
  } catch {
    throw new NotRunError('not run: installed app has no readable main.jsbundle')
  }
}

async function readVersion (preflight) {
  const fail = message => {
    if (preflight) throw new NotRunError(`not run: ${message}`)
    throw new CheckError('backend-commit', message)
  }
  let response
  try {
    response = await fetch(`${API}/version`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch {
    fail('version unreachable')
  }
  if (!response.ok) fail(`version returned HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    fail('version returned no JSON')
  }
  if (!body || typeof body.commit !== 'string' || body.commit === '') fail('version has no commit')
  return body.commit
}

async function deriveAccount (seed, rpc) {
  const wdk = new WDK(seed).registerWallet('sepolia', WalletManagerEvm, { provider: rpc })
  try {
    const account = await wdk.getAccount('sepolia', 0)
    return getAddress(await account.getAddress())
  } finally {
    await wdk.dispose?.()
  }
}

async function preflight (options) {
  let porcelain
  let moduleHead
  try {
    porcelain = git(['status', '--porcelain'])
    moduleHead = git(['rev-parse', 'HEAD'])
  } catch {
    throw new NotRunError('not run: git failed')
  }
  if (porcelain !== '') throw new NotRunError('not run: the module working tree is not clean')
  assertModuleCopy()
  const build = readBuild()
  if (build.moduleHead !== moduleHead) throw new NotRunError('not run: out/build.json moduleHead is not HEAD')
  let patchSha
  try {
    patchSha = sha256File(patchPath)
  } catch {
    throw new NotRunError('not run: starter.patch cannot be read')
  }
  if (patchSha !== build.patchSha256) throw new NotRunError('not run: starter.patch does not match out/build.json')
  const bundleSha = installedBundleSha(options.udid)
  if (bundleSha !== build.mainJsbundleSha256) throw new NotRunError('not run: installed main.jsbundle does not match out/build.json')
  let maestroVersion
  try {
    const version = captureSync('maestro', ['--version'])
    if (version.code !== 0) throw new Error()
    maestroVersion = version.stdout.trim().split('\n')[0]
  } catch {
    throw new NotRunError('not run: maestro is not callable')
  }
  if (!maestroVersion) throw new NotRunError('not run: maestro did not report a version')
  if (!/^2\.10\.\d+$/.test(maestroVersion)) throw new NotRunError(`not run: maestro 2.10 is required, found ${maestroVersion}`)
  try {
    const simctl = captureSync('xcrun', ['--find', 'simctl'])
    if (simctl.code !== 0 || simctl.stdout.trim() === '') throw new Error()
  } catch {
    throw new NotRunError('not run: xcrun is not callable')
  }
  const simulatorRuntime = bootedRuntime(options.udid)
  assertNoForeignMaestro(false)
  const backendCommitStart = await readVersion(true)
  const provider = new JsonRpcProvider(options.rpc)
  state.provider = provider
  let network
  try {
    network = await provider.getNetwork()
  } catch {
    throw new NotRunError('not run: RPC unreachable')
  }
  if (network.chainId !== CHAIN_ID) throw new NotRunError(`not run: chain id is ${network.chainId}`)
  const seed = await readPrivateFile(options.seedFile)
  rememberSecret(seed)
  let account
  try {
    account = await deriveAccount(seed, options.rpc)
  } catch {
    throw new NotRunError('not run: account could not be derived')
  }
  const usdt = new Contract(USDT, ERC20_ABI, provider)
  let usdtBalance
  let ethBalance
  try {
    usdtBalance = BigInt(await usdt.balanceOf(account))
    ethBalance = BigInt(await provider.getBalance(account))
  } catch {
    throw new NotRunError('not run: balance could not be read')
  }
  if (usdtBalance < USDT_AMOUNT) throw new NotRunError('not run: account has less than 1 USDT')
  if (ethBalance < ETH_FEE) throw new NotRunError('not run: account has less than 0.0002 ETH')
  return { seed, moduleHead, build, maestroVersion, simulatorRuntime, backendCommitStart, account, provider, usdt }
}

function confirmationCount (stdout) {
  return stdout.split(/\r?\n/).filter(line => /send-confirm/.test(line) && /COMPLETED/.test(line) && /Tap on/i.test(line)).length
}

function failedStep (stdout) {
  const line = stripVTControlCharacters(stdout).split(/\r?\n/).find(line => /FAILED\s*$/.test(line))
  if (!line) return 'no failed step line in the Maestro output'
  return redact(line.trim().replace(/CH(?:[\s\u00a0]*\d){19}/g, 'CH[REDACTED]')).slice(0, 200)
}

function copyShots (fromDir, toDir) {
  const copied = []
  const visit = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && entry.name.endsWith('.png') && path.includes('takeScreenshot')) {
        const dest = join(toDir, entry.name)
        copyFileSync(path, dest, constants.COPYFILE_EXCL)
        copied.push({ file: entry.name, sha256: sha256File(dest) })
      }
    }
  }
  visit(fromDir)
  return copied
}

async function runFlow (file, env) {
  const debugDir = mkdtempSync(join(tmpdir(), 'wallet-ui-debug-'))
  const outDir = mkdtempSync(join(tmpdir(), 'wallet-ui-out-'))
  const args = ['--udid', state.udid, 'test']
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push('--debug-output', debugDir, '--test-output-dir', outDir, file)
  try {
    const result = await runCapture('maestro', args, 'ignore')
    if (result.code !== 0) state.failedStep = failedStep(result.stdout)
    let copied = []
    try {
      copied = copyShots(outDir, state.options.screenshots)
    } catch {
      const step = state.evidence.depositAddress && confirmationCount(result.stdout) === 1 ? undefined : state.failedStep
      throw new CheckError('screenshots', `screenshot copy failed${state.evidence.depositAddress ? '' : '; nothing sent'}`, step)
    }
    state.screenshots.push(...copied)
    return { code: result.code, stdout: result.stdout }
  } finally {
    rmSync(debugDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
}

function clearWalletState () {
  if (state.cleanupPromise) return state.cleanupPromise
  if (!state.flow1Started || state.cleanupAttempted) return Promise.resolve()
  state.cleanupPromise = (async () => {
    state.cleanupAttempted = true
    state.evidence.walletStateCleared = false
    const previousStep = state.failedStep
    try {
      const result = await runFlow(join(flowDir, 'cleanup.yaml'), {})
      if (result.code !== 0) throw new Error('cleanup flow failed')
      state.evidence.walletStateCleared = true
    } catch {
      throw new CheckError('cleanup', 'wallet state could not be cleared')
    } finally {
      state.failedStep = previousStep
    }
  })()
  return state.cleanupPromise
}

function clearClipboard () {
  if (state.clipboardPromise) return state.clipboardPromise
  state.clipboardPromise = (async () => {
    state.clipboardClearAttempted = true
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await runCapture('xcrun', ['simctl', 'pbcopy', state.udid], 'empty')
        if (result.code === 0) {
          state.clipboard = false
          state.evidence.clipboardCleared = true
          return
        }
      } catch {}
    }
    state.evidence.clipboardCleared = false
    throw new CheckError('clipboard', 'the simulator clipboard could not be cleared and may still hold the seed; clear it by hand')
  })()
  return state.clipboardPromise
}

async function copySeed (seedFile) {
  state.clipboard = true
  let fd
  try {
    fd = openSync(seedFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new CheckError('clipboard', 'nothing sent')
  }
  try {
    const result = await runCapture('xcrun', ['simctl', 'pbcopy', state.udid], fd)
    if (result.code !== 0) throw new CheckError('clipboard', 'nothing sent')
  } finally {
    closeSync(fd)
  }
}

function oneLine (text) {
  if (text.endsWith('\n')) return text.slice(0, -1).replace(/\r$/, '')
  return text
}

function labelValues (node) {
  const sources = [node]
  if (node.attributes && typeof node.attributes === 'object') sources.push(node.attributes)
  const values = []
  for (const source of sources) {
    for (const key of ['accessibilityLabel', 'accessibilityText', 'label', 'text']) {
      if (typeof source[key] === 'string') values.push(source[key])
    }
  }
  return values
}

function identifierValues (node) {
  const sources = [node]
  if (node.attributes && typeof node.attributes === 'object') sources.push(node.attributes)
  const values = []
  for (const source of sources) {
    for (const key of ['id', 'identifier', 'resource-id', 'resourceId', 'accessibilityIdentifier']) {
      if (typeof source[key] === 'string') values.push(source[key])
    }
  }
  return values
}

function collectHashes (node, hashes) {
  for (const value of labelValues(node)) {
    const found = value.match(/0x[0-9a-fA-F]{64}\b/g) || []
    for (const hash of found) hashes.add(hash.toLowerCase())
  }
}

function walkHierarchy (node, hashes, matched) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkHierarchy(item, hashes, matched)
    return
  }
  const matchedHere = matched || identifierValues(node).includes('send-success-hash')
  if (matchedHere) collectHashes(node, hashes)
  const children = Array.isArray(node.children) ? node.children : Array.isArray(node.elements) ? node.elements : []
  for (const child of children) walkHierarchy(child, hashes, matchedHere)
}

async function readSuccessHash () {
  const result = await runCapture('maestro', ['--udid', state.udid, 'hierarchy'], 'ignore')
  if (result.code !== 0) throw new CheckError('hash', 'hierarchy failed')
  const start = result.stdout.indexOf('{')
  const arrayStart = result.stdout.indexOf('[')
  const openAt = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart)
  const endBrace = result.stdout.lastIndexOf('}')
  const endBracket = result.stdout.lastIndexOf(']')
  const closeAt = Math.max(endBrace, endBracket)
  if (openAt < 0 || closeAt < openAt) throw new CheckError('hash', 'hierarchy was not JSON')
  let tree
  try {
    tree = JSON.parse(result.stdout.slice(openAt, closeAt + 1))
  } catch {
    throw new CheckError('hash', 'hierarchy was not JSON')
  }
  const hashes = new Set()
  walkHierarchy(tree, hashes, false)
  if (hashes.size !== 1) throw new CheckError('hash', `found ${hashes.size} hashes`)
  return [...hashes][0]
}

async function readReceipt (provider, hash) {
  const deadline = Date.now() + 60_000
  while (true) {
    let raw
    try {
      raw = await provider.send('eth_getTransactionReceipt', [hash])
    } catch (error) {
      if (!isLagging(error) || Date.now() + 2_000 >= deadline) throw new CheckError('receipt', 'receipt read failed')
      await delay(2_000)
      state.rpcReadRetries++
      continue
    }
    if (raw) return raw
    if (Date.now() + 2_000 >= deadline) throw new CheckError('receipt', 'no receipt')
    await delay(2_000)
    state.rpcReadRetries++
  }
}

function addressFromTopic (topic, failedCheck) {
  if (typeof topic !== 'string' || topic.length < 40) throw new CheckError(failedCheck, 'Transfer topic is not an address')
  return getAddress(`0x${topic.slice(-40)}`)
}

async function checkChain (prelude, hash, depositAddress) {
  const raw = await readReceipt(prelude.provider, hash)
  const status = quantity(raw.status, 'receipt-status')
  if (status !== 1n) throw new CheckError('receipt-status', `status is ${status}`)
  let from
  try {
    from = getAddress(raw.from)
  } catch {
    throw new CheckError('receipt-from', 'from is not an address')
  }
  if (from !== prelude.account) throw new CheckError('receipt-from', 'from is not the account')
  let to
  try {
    to = raw.to ? getAddress(raw.to) : null
  } catch {
    to = null
  }
  if (to !== USDT) throw new CheckError('receipt-to', 'to is not the token')
  const logs = Array.isArray(raw.logs)
    ? raw.logs.filter(log => {
      try {
        return getAddress(log.address) === USDT && String(log.topics?.[0] ?? '').toLowerCase() === TRANSFER_TOPIC
      } catch {
        return false
      }
    })
    : []
  if (logs.length !== 1) throw new CheckError('transfer', `found ${logs.length} USDT Transfer logs`)
  const transfer = logs[0]
  const transferFrom = addressFromTopic(transfer.topics?.[1], 'transfer')
  const transferTo = addressFromTopic(transfer.topics?.[2], 'transfer')
  const transferValue = quantity(transfer.data, 'transfer')
  if (transferFrom !== prelude.account || transferTo !== depositAddress || transferValue !== USDT_AMOUNT) {
    throw new CheckError('transfer', 'USDT Transfer is not 1 USDT from the account to the deposit address')
  }
  const block = Number(quantity(raw.blockNumber, 'receipt'))
  if (!Number.isSafeInteger(block) || block < 1) throw new CheckError('receipt', 'block number is not usable')
  const gasUsed = quantity(raw.gasUsed, 'balance-account-eth')
  if (typeof raw.effectiveGasPrice !== 'string' && typeof raw.effectiveGasPrice !== 'number') {
    throw new CheckError('balance-account-eth', 'receipt has no effectiveGasPrice')
  }
  const fee = gasUsed * quantity(raw.effectiveGasPrice, 'balance-account-eth')
  const usdtBalance = async (address, blockNumber) => {
    const value = await readAtBlock(blockNumber, () => prelude.usdt.balanceOf(address, { blockTag: blockNumber }))
    return BigInt(value)
  }
  const ethBalance = async (address, blockNumber) => {
    const value = await readAtBlock(blockNumber, () => prelude.provider.getBalance(address, blockNumber))
    return BigInt(value)
  }
  let accountUsdtBefore
  let accountUsdtAfter
  let depositUsdtBefore
  let depositUsdtAfter
  let accountEthBefore
  let accountEthAfter
  try {
    accountUsdtBefore = await usdtBalance(prelude.account, block - 1)
    accountUsdtAfter = await usdtBalance(prelude.account, block)
  } catch {
    throw new CheckError('balance-account-usdt', 'balance read failed')
  }
  if (accountUsdtBefore - accountUsdtAfter !== USDT_AMOUNT) {
    throw new CheckError('balance-account-usdt', 'account USDT balance did not fall by 1000000')
  }
  try {
    depositUsdtBefore = await usdtBalance(depositAddress, block - 1)
    depositUsdtAfter = await usdtBalance(depositAddress, block)
  } catch {
    throw new CheckError('balance-deposit-usdt', 'balance read failed')
  }
  if (depositUsdtAfter - depositUsdtBefore !== USDT_AMOUNT) {
    throw new CheckError('balance-deposit-usdt', 'deposit USDT balance did not rise by 1000000')
  }
  try {
    accountEthBefore = await ethBalance(prelude.account, block - 1)
    accountEthAfter = await ethBalance(prelude.account, block)
  } catch {
    throw new CheckError('balance-account-eth', 'balance read failed')
  }
  if (accountEthBefore - accountEthAfter !== fee) {
    throw new CheckError('balance-account-eth', 'account ETH balance did not fall by the effective fee')
  }
  state.evidence.block = block
  state.evidence.gasUsed = gasUsed.toString()
  state.evidence.fee = fee.toString()
  state.evidence.balances = [
    { address: prelude.account, asset: 'USDT', before: accountUsdtBefore.toString(), after: accountUsdtAfter.toString() },
    { address: prelude.account, asset: 'ETH', before: accountEthBefore.toString(), after: accountEthAfter.toString() },
    { address: depositAddress, asset: 'USDT', before: depositUsdtBefore.toString(), after: depositUsdtAfter.toString() }
  ]
}

function plain (value, failedCheck) {
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new CheckError(failedCheck, 'backend field is not a plain value')
}

function amountIsOne (value) {
  if (typeof value === 'number') return Object.is(value, 1)
  if (typeof value === 'string') return /^1(?:\.0+)?$/.test(value.trim())
  return false
}

function assertSaleShape (row) {
  if (!row || typeof row !== 'object') throw new CheckError('backend-shape', 'record is not an object')
  if (row.type !== 'Sell') throw new CheckError('backend-shape', 'type is not Sell')
  if (row.inputAsset !== 'USDT') throw new CheckError('backend-shape', 'asset is not USDT')
  if (row.inputBlockchain !== 'Sepolia') throw new CheckError('backend-shape', 'blockchain is not Sepolia')
  if (!amountIsOne(row.inputAmount)) throw new CheckError('backend-shape', 'amount is not 1')
  plain(row.id, 'backend-shape')
  plain(row.uid, 'backend-shape')
  plain(row.state, 'backend-shape')
  if (row.reason != null) plain(row.reason, 'backend-shape')
  if (row.outputAmount != null) plain(row.outputAmount, 'backend-shape')
  if (row.outputAsset != null) plain(row.outputAsset, 'backend-shape')
}

function backendView (row) {
  return {
    id: plain(row.id, 'backend-shape'),
    uid: plain(row.uid, 'backend-shape'),
    state: plain(row.state, 'backend-shape'),
    reason: row.reason == null ? null : plain(row.reason, 'backend-shape'),
    outputAmount: row.outputAmount == null ? null : plain(row.outputAmount, 'backend-shape'),
    outputAsset: row.outputAsset == null ? null : plain(row.outputAsset, 'backend-shape'),
    detection: 'self'
  }
}

async function sessionFor (seed, rpc) {
  const wdk = new WDK(seed)
    .registerWallet('sepolia', WalletManagerEvm, { provider: rpc })
    .registerProtocol('sepolia', 'dfx', DfxProtocol, { environment: 'sandbox', network: 'sepolia' })
  state.wdk = wdk
  let sellUrl
  try {
    const account = await wdk.getAccount('sepolia', 0)
    const fiat = account.getFiatProtocol('dfx')
    state.fiat = fiat
    // sell() is the public call that returns a session. It opens a second sandbox sale.
    ;({ sellUrl } = await fiat.sell({ cryptoAsset: 'USDT', fiatCurrency: 'EUR', cryptoAmount: USDT_AMOUNT }))
  } catch {
    throw new CheckError('backend-auth', 'sandbox sign-in failed')
  }
  rememberSecret(sellUrl)
  let session
  try {
    session = new URL(sellUrl).searchParams.get('session')
  } catch {
    session = null
  }
  if (!session) throw new CheckError('backend-auth', 'sandbox sign-in returned no session')
  rememberSecret(session)
  state.session = session
  return session
}

async function readTransactions (session) {
  state.backendReads++
  let response
  try {
    response = await fetch(`${API}/v1/transaction`, {
      headers: { authorization: `Bearer ${session}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    throw new CheckError('backend-read', 'transaction list unreachable')
  }
  if (!response.ok) throw new CheckError('backend-read', `transaction list returned HTTP ${response.status}`)
  let body
  try {
    body = await response.json()
  } catch {
    throw new CheckError('backend-read', 'transaction list was not JSON')
  }
  if (!Array.isArray(body)) throw new CheckError('backend-shape', 'transaction list was not an array')
  return body
}

async function followBackend (session, hash, followMinutes) {
  const deadline = Date.now() + followMinutes * 60_000
  let last = null
  while (true) {
    const rows = await readTransactions(session)
    const hits = rows.filter(row => String(row?.inputTxId ?? '').toLowerCase() === hash)
    if (hits.length > 1) throw new CheckError('backend-count', `found ${hits.length} records`)
    if (hits.length === 1) {
      assertSaleShape(hits[0])
      last = hits[0]
      state.evidence.backend = backendView(hits[0])
      if (hits[0].state === 'PayoutInProgress' || hits[0].state === 'Completed') return hits[0]
      if (FAILED_STATES.has(hits[0].state)) {
        throw new CheckError('backend-state', `state ${hits[0].state}; reason ${hits[0].reason ?? 'none'}`)
      }
    }
    if (Date.now() + 20_000 > deadline) {
      const reason = last?.reason ?? 'none'
      const current = last?.state ?? 'none'
      throw new CheckError('backend-deadline', `last state ${current}; reason ${reason}`)
    }
    await delay(20_000)
  }
}

function explorerShotName (hash) {
  if (typeof hash !== 'string' || !/^0x[a-f0-9]{64}$/.test(hash)) {
    throw new CheckError('explorer-capture', 'explorer capture failed')
  }
  return `explorer-${hash.slice(2, 2 + HASH_SHORT)}.png`
}

function bookingShotName (uid, session) {
  const text = typeof uid === 'number' ? String(uid) : uid
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(text)) {
    throw new CheckError('booking-capture', 'booking id is not a file name')
  }
  const name = `booking-${text}.png`
  if (typeof session === 'string' && session !== '' && name.includes(session)) {
    throw new CheckError('booking-capture', 'booking id is not a file name')
  }
  return name
}

function absentShot (name, failedCheck) {
  const filePath = resolve(state.options.screenshots, name)
  try {
    lstatSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return filePath
    throw new CheckError(failedCheck, 'screenshot path cannot be checked')
  }
  throw new CheckError(failedCheck, 'screenshot already exists')
}

async function maskedScreenshot (page, filePath, ibans, widget, step, keep, failedCheck) {
  const found = await page.evaluate(({ values, keep: evidence }) => {
    const compactText = text => (text || '').replace(/[\s\u00a0]/g, '').toUpperCase()
    const elements = [...globalThis.document.querySelectorAll('body *')]
    for (const el of elements) el.removeAttribute('data-iban-mask')
    const visible = el => {
      const rect = el.getBoundingClientRect()
      const style = globalThis.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const findIbans = text => {
      const raw = text || ''
      const shaped = raw.match(/(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[\s\u00a0]{0,2}[A-Z0-9]){11,30}(?![A-Za-z0-9])/g) || []
      return [...shaped.map(compactText), ...values.filter(value => compactText(raw).includes(value))]
    }
    for (const el of globalThis.document.querySelectorAll('input, textarea')) {
      if (visible(el) && findIbans(el.value.toUpperCase()).length > 0) el.setAttribute('data-iban-mask', 'true')
    }
    const hits = findIbans(globalThis.document.body.innerText)
    const holders = hits.map(value => ({
      value,
      elements: elements.filter(el => visible(el) && compactText(el.innerText).includes(value) &&
        ![...el.children].some(child => visible(child) && compactText(child.innerText).includes(value)))
    }))
    let missing = false
    const occurrences = (text, value) => {
      let count = 0
      for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + 1)) count++
      return count
    }
    for (const { value, elements: holdersFound } of holders) {
      if (holdersFound.length === 0) missing = true
      for (const el of holdersFound) {
        const expected = occurrences(compactText(el.innerText), value)
        if (compactText(el.innerText).length <= value.length + 24) {
          el.setAttribute('data-iban-mask', 'true')
        } else {
          const walker = globalThis.document.createTreeWalker(el, globalThis.NodeFilter.SHOW_TEXT)
          const nodes = []
          while (walker.nextNode()) nodes.push(walker.currentNode)
          const pattern = new RegExp([...value].join('[\\s\\u00a0]*'), 'g')
          for (const node of nodes) {
            if (node.parentElement.closest('[data-iban-mask="true"]')) continue
            const text = node.data.toUpperCase()
            if (text.length !== node.data.length) continue
            const foundText = [...text.matchAll(pattern)]
            for (const match of foundText.reverse()) {
              const range = globalThis.document.createRange()
              range.setStart(node, match.index)
              range.setEnd(node, match.index + match[0].length)
              const span = globalThis.document.createElement('span')
              span.setAttribute('data-iban-mask', 'true')
              range.surroundContents(span)
            }
          }
        }
        const marked = el.matches('[data-iban-mask="true"]')
          ? [el]
          : [...el.querySelectorAll('[data-iban-mask="true"]')].filter(visible)
        if (marked.reduce((count, item) => count + occurrences(compactText(item.innerText), value), 0) < expected) missing = true
      }
    }
    const matches = [...globalThis.document.querySelectorAll('[data-iban-mask="true"]')]
    const outermost = matches.filter(el => !el.parentElement?.closest('[data-iban-mask="true"]'))
    for (const value of hits) {
      const expected = occurrences(compactText(globalThis.document.body.innerText), value)
      if (outermost.reduce((count, el) => count + occurrences(compactText(el.innerText), value), 0) < expected) missing = true
    }
    return {
      text: hits.length > 0,
      count: matches.length,
      missing,
      coversEvidence: matches.some(el => evidence.some(value => compactText(el.innerText).includes(compactText(value))))
    }
  }, { values: ibans.map(iban => compact(iban).toUpperCase()), keep })
  if (found.missing) throw new CheckError(failedCheck, 'IBAN-shaped text has no small element to mask')
  if (widget && found.text && found.count === 0) throw new CheckError(failedCheck, 'IBAN is visible in widget text but no element is masked')
  if (found.coversEvidence) throw new CheckError(failedCheck, `The mask would cover the evidence on ${step}`)
  await page.screenshot({
    path: filePath,
    mask: [page.locator('[data-iban-mask="true"]'), page.locator('input[name="iban"]')],
    maskColor: '#000000'
  })
}

async function captureExplorer (browser, hash) {
  const name = explorerShotName(hash)
  const filePath = absentShot(name, 'explorer-capture')
  let context
  try {
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
    const page = await context.newPage()
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      try {
        await page.goto(`${EXPLORER}/tx/${hash}`, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) })
      } catch (error) {
        if (error.name === 'TimeoutError' && Date.now() >= deadline) break
        throw error
      }
      try {
        await page.waitForFunction(value => {
          const text = globalThis.document.body?.innerText || ''
          return text.toLowerCase().includes(value.toLowerCase()) && /\bSuccess\b/.test(text)
        }, hash, { timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) })
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error
        if (Date.now() >= deadline) break
        state.explorerReloads++
        continue
      }
      await maskedScreenshot(page, filePath, state.saleIban ? [state.saleIban] : [], false, 'explorer', [hash], 'explorer-capture')
      state.screenshots.push({ file: name, sha256: sha256File(filePath) })
      return
    }
    throw new CheckError('explorer-capture', 'explorer did not show the hash and Success within 5 minutes')
  } catch (error) {
    if (error instanceof CheckError) throw error
    throw new CheckError('explorer-capture', 'explorer capture failed')
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

async function captureBooking (browser, session, hash, sale) {
  const name = bookingShotName(sale.uid, session)
  const filePath = absentShot(name, 'booking-capture')
  const stateText = sale.state === 'Completed' ? 'Completed' : 'Payout in progress'
  const inputTx = (hash.slice(0, 24) + '...' + hash.slice(-22)).toLowerCase()
  const keep = [String(sale.id), 'Sell', stateText, inputTx]
  let context
  try {
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1100 } })
    const page = await context.newPage()
    await page.goto(`${APP}/tx/${encodeURIComponent(String(sale.uid))}?session=${encodeURIComponent(session)}&lang=en`)
    try {
      await page.waitForFunction(({ id, inputTx: shownHash, stateText: shownState }) => {
        const lines = (globalThis.document.body?.innerText || '').split('\n').map(line => line.trim()).filter(Boolean)
        const matches = (label, value, lowercase = false) => {
          const indexes = lines.flatMap((line, index) => line === label ? [index] : [])
          if (indexes.length !== 1) return false
          const next = lines[indexes[0] + 1]
          return lowercase ? next?.toLowerCase() === value : next === value
        }
        return matches('ID', id) && matches('Type', 'Sell') && matches('State', shownState) && matches('Input TX', shownHash, true)
      }, { id: String(sale.id), inputTx, stateText }, { timeout: 60_000 })
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
      throw new CheckError('booking-capture', 'Booking page did not show id, hash and state within 60 seconds')
    }
    await maskedScreenshot(page, filePath, state.saleIban ? [state.saleIban] : [], true, 'booking', keep, 'booking-capture')
    state.screenshots.push({ file: name, sha256: sha256File(filePath) })
  } catch (error) {
    if (error instanceof CheckError) throw error
    throw new CheckError('booking-capture', 'booking capture failed')
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

async function captureEvidence (session, hash, sale) {
  let browser
  try {
    try {
      browser = await chromium.launch({ headless: true })
    } catch {
      throw new CheckError('explorer-capture', 'explorer capture failed')
    }
    state.browser = browser
    await captureExplorer(browser, hash)
    await captureBooking(browser, session, hash, sale)
  } finally {
    state.browser = null
    if (browser) await browser.close().catch(() => {})
  }
}

async function assertModuleStatus (sale) {
  if (sale.state !== 'PayoutInProgress' && sale.state !== 'Completed') {
    throw new CheckError('module-status', 'module status does not match the sale')
  }
  const expected = sale.state === 'Completed' ? 'completed' : 'in_progress'
  let detail
  try {
    detail = await state.fiat.getTransactionDetail(String(sale.uid))
  } catch {
    throw new CheckError('module-status', 'module detail failed')
  }
  if (detail?.cryptoAsset !== 'USDT' || detail?.fiatCurrency !== 'EUR' || detail?.status !== expected) {
    throw new CheckError('module-status', 'module status does not match the sale')
  }
  state.evidence.moduleStatus = {
    cryptoAsset: detail.cryptoAsset,
    fiatCurrency: detail.fiatCurrency,
    status: detail.status
  }
}

async function sendAndCheck (prelude) {
  const options = state.options
  await copySeed(options.seedFile)
  const iban = inventedIban()
  state.saleIban = iban
  rememberIban(iban)
  if (state.interrupted) throw new CheckError('interrupted', 'nothing sent')
  state.flow1Started = true
  const flow1 = await runFlow(join(flowDir, 'sell-1-widget.yaml'), { IBAN: iban, IBAN_PATTERN: `.*${[...iban].join(' ?')}.*` })
  const flow1Code = flow1.code
  flow1.stdout = ''
  if (flow1Code !== 0) throw new CheckError('flow-1', 'nothing sent', state.failedStep)
  if (state.interrupted) throw new CheckError('interrupted', 'nothing sent')
  const pasted = await runCapture('xcrun', ['simctl', 'pbpaste', state.udid], 'ignore')
  if (pasted.code !== 0) throw new CheckError('clipboard', 'nothing sent')
  const depositRaw = oneLine(pasted.stdout)
  if (!/^0x[a-fA-F0-9]{40}$/.test(depositRaw)) throw new CheckError('clipboard', 'nothing sent')
  let depositAddress
  try {
    depositAddress = getAddress(depositRaw)
  } catch {
    throw new CheckError('clipboard', 'nothing sent')
  }
  state.evidence.depositAddress = depositAddress
  assertNoForeignMaestro(true)
  if (state.interrupted) throw new CheckError('interrupted', 'nothing sent')
  const flow2 = await runFlow(join(flowDir, 'sell-2-send.yaml'), {
    DEP_HEAD: depositRaw.slice(0, 6),
    DEP_TAIL: depositRaw.slice(-4)
  })
  const confirmations = confirmationCount(flow2.stdout)
  flow2.stdout = ''
  state.evidence.walletConfirmations = confirmations
  if (confirmations !== 1) {
    if (confirmations === 0 && flow2.code !== 0) throw new CheckError('flow-2', 'flow 2 failed before send-confirm', state.failedStep)
    throw new CheckError('wallet-confirmations', `completed send-confirm taps: ${confirmations}`, state.failedStep)
  }
  const hash = await readSuccessHash()
  state.evidence.hash = hash
  if (flow2.code !== 0) throw new CheckError('flow-2', 'flow 2 failed after send-confirm', state.failedStep)
  await checkChain(prelude, hash, depositAddress)
  const session = await sessionFor(prelude.seed, options.rpc)
  const sale = await followBackend(session, hash, options.follow)
  await assertModuleStatus(sale)
  await captureEvidence(session, hash, sale)
  const backendCommitEnd = await readVersion(false)
  if (backendCommitEnd !== prelude.backendCommitStart) {
    throw new CheckError('backend-commit', 'backend commit changed during the run')
  }
  state.evidence.backendCommitEnd = backendCommitEnd
  let porcelain
  let head
  try {
    porcelain = git(['status', '--porcelain'])
    head = git(['rev-parse', 'HEAD'])
  } catch {
    throw new CheckError('git', 'git failed')
  }
  state.evidence.dirty = porcelain !== ''
  state.evidence.moduleHead = head
  if (porcelain !== '' || head !== prelude.moduleHead) {
    throw new CheckError('dirty-tree', 'the module tree changed during the run')
  }
  let bundleSha
  try {
    bundleSha = installedBundleSha(options.udid)
  } catch {
    throw new CheckError('bundle', 'installed main.jsbundle cannot be read')
  }
  if (bundleSha !== prelude.build.mainJsbundleSha256) {
    throw new CheckError('bundle', 'installed main.jsbundle changed during the run')
  }
  const explorerName = explorerShotName(hash)
  const bookingName = bookingShotName(sale.uid, session)
  const expectedShots = [...FLOW_SHOTS, explorerName, bookingName]
  const shots = state.screenshots.map(item => {
    if (sha256File(join(options.screenshots, item.file)) !== item.sha256) throw new CheckError('screenshots', 'screenshot changed after capture')
    return item
  })
  const byName = new Map(shots.map(item => [item.file, item]))
  if (byName.size !== shots.length || FLOW_SHOTS.some(name => !byName.has(name))) {
    throw new CheckError('screenshots', `found ${shots.map(item => item.file).join(', ') || 'none'}`)
  }
  if (!byName.has(explorerName)) throw new CheckError('explorer-capture', 'explorer screenshot missing')
  if (!byName.has(bookingName)) throw new CheckError('booking-capture', 'booking screenshot missing')
  if (byName.size !== expectedShots.length) {
    throw new CheckError('screenshots', `found ${shots.map(item => item.file).join(', ') || 'none'}`)
  }
  state.evidence.screenshots = expectedShots.map(name => byName.get(name))
}

function measuredRecord () {
  const evidence = state.evidence
  const body = {}
  for (const key of RECORD_FIELDS) {
    if (key === 'date') body.date = new Date().toISOString()
    else if (key === 'backendReads') body.backendReads = state.backendReads
    else if (key === 'rpcReadRetries') body.rpcReadRetries = state.rpcReadRetries
    else if (key === 'explorerReloads') body.explorerReloads = state.explorerReloads
    else if (key === 'maestroStepRetries') body.maestroStepRetries = 0
    else if (key === 'screenshots') {
      if (state.screenshots.length || evidence.screenshots) body.screenshots = evidence.screenshots || state.screenshots
    } else if (evidence[key] !== undefined) body[key] = evidence[key]
  }
  if (state.failedStep !== undefined) body.failedStep = state.failedStep
  return body
}

function assertPass (body) {
  for (const key of RECORD_FIELDS) {
    if (body[key] === undefined) throw new CheckError('record', `missing ${key}`)
  }
  if (body.dirty !== false) throw new CheckError('dirty-tree', 'the module tree is not clean')
  if (body.walletInterface !== WALLET_INTERFACE) throw new CheckError('record', 'walletInterface changed')
  if (body.ibanCountryAndClearing !== IBAN_LABEL) throw new CheckError('record', 'iban label changed')
  if (body.walletConfirmations !== 1) throw new CheckError('wallet-confirmations', 'walletConfirmations is not 1')
  if (body.walletStateCleared !== true) throw new CheckError('cleanup', 'wallet state was not cleared')
  const expectedStatus = body.backend.state === 'Completed' ? 'completed' : 'in_progress'
  if (body.backend.state !== 'PayoutInProgress' && body.backend.state !== 'Completed') {
    throw new CheckError('module-status', 'module status does not match the sale')
  }
  if (!body.moduleStatus || body.moduleStatus.cryptoAsset !== 'USDT' || body.moduleStatus.fiatCurrency !== 'EUR' || body.moduleStatus.status !== expectedStatus) {
    throw new CheckError('module-status', 'module status does not match the sale')
  }
  const names = Array.isArray(body.screenshots) ? body.screenshots.map(item => item && item.file) : []
  const expectedNames = [...FLOW_SHOTS, explorerShotName(body.hash), bookingShotName(body.backend.uid, state.session)]
  if (names.length !== expectedNames.length || expectedNames.some((name, index) => names[index] !== name)) {
    throw new CheckError('screenshots', 'screenshot set changed')
  }
}

async function writeRecord (body) {
  const path = state.options.record
  const line = redact(JSON.stringify(body)) + '\n'
  if (state.secrets.some(secret => secret.length >= 16 && line.includes(secret))) {
    throw new CheckError('record', 'record redaction failed')
  }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error('record is not a private regular file')
    }
    await file.chmod(0o600)
    await file.writeFile(line)
  } finally {
    await file.close()
  }
  state.recordWritten = true
}

async function writeFail (error) {
  if (state.recordWritten || !state.options?.record) return
  const failedCheck = error instanceof CheckError ? error.failedCheck : 'run'
  const body = measuredRecord()
  body.result = 'fail'
  body.failedCheck = failedCheck
  try {
    state.recordPromise = writeRecord(body)
    await state.recordPromise
  } catch (writeError) {
    console.error(`wallet-ui failed: record: ${redact(writeError?.message ?? writeError)}`)
  }
}

function cleanupWarning (error) {
  console.error(`wallet-ui cleanup warning: ${redact(error?.message ?? error).replace(/[\r\n]+/g, ' ')}`)
}

function releaseResources () {
  if (state.releasePromise) return state.releasePromise
  state.releasePromise = (async () => {
    try {
      if (state.browser) {
        const browser = state.browser
        state.browser = null
        await browser.close()
      }
    } catch (error) { cleanupWarning(error) }
    try {
      if (state.provider) {
        const provider = state.provider
        state.provider = null
        provider.destroy()
      }
    } catch (error) { cleanupWarning(error) }
    try {
      if (state.wdk) {
        const wdk = state.wdk
        state.wdk = null
        await wdk.dispose?.()
      }
    } catch (error) { cleanupWarning(error) }
    try {
      if (state.lockHeld) {
        rmdirSync(state.lockDir)
        state.lockHeld = false
      }
    } catch (error) { cleanupWarning(error) }
  })()
  return state.releasePromise
}

async function stopChild (child) {
  const closed = new Promise(resolve => child.once('close', resolve))
  child.kill('SIGTERM')
  let timer
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(true), 10_000) })
  ])
  clearTimeout(timer)
  if (timedOut) {
    child.kill('SIGKILL')
    const killTimedOut = await Promise.race([
      closed.then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), 5_000) })
    ])
    clearTimeout(timer)
    if (killTimedOut) cleanupWarning('child process did not close after SIGKILL')
  }
}

function installSignalHandlers () {
  const onSignal = signal => {
    const exitCode = signal === 'SIGINT' ? 130 : 143
    if (state.interrupted) {
      console.error('wallet-ui: interrupted during cleanup; erase the simulator before the next run')
      try {
        if (state.lockHeld) {
          rmdirSync(state.lockDir)
          state.lockHeld = false
        }
      } catch (error) { cleanupWarning(error) }
      process.exit(state.signalExitCode)
    }
    state.interrupted = true
    state.signalExitCode = exitCode
    state.signalPromise = (async () => {
      try {
        if (state.cleanupPromise) await state.cleanupPromise
        else if (state.child) await stopChild(state.child)
      } catch (error) { cleanupWarning(error) }
      try {
        if (state.clipboard) await clearClipboard()
      } catch (error) { cleanupWarning(error) }
      try { await clearWalletState() } catch (error) { cleanupWarning(error) }
      try {
        if (state.recordPromise) await state.recordPromise.catch(() => {})
        if (state.options?.record && state.flow1Started && !state.recordWritten) await writeFail(new CheckError('interrupted', `received ${signal}`))
      } catch (error) { cleanupWarning(error) }
      try { await releaseResources() } catch (error) { cleanupWarning(error) }
      process.exit(exitCode)
    })()
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  state.options = options
  state.udid = options.udid
  if (options.screenshots) prepareScreenshots(options.screenshots)
  if (options.send) {
    assertRecordPath(options.record, options.seedFile)
    for (const name of FLOW_SHOTS) {
      try {
        lstatSync(join(options.screenshots, name))
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw new UsageError('--screenshots cannot be checked')
      }
      throw new UsageError('--screenshots already contains a result from this flow')
    }
  }
  if (options.send) {
    installSignalHandlers()
    takeLock(join(tmpdir(), 'wdk-wallet-ui-run.lock'))
  }
  const prelude = await preflight(options)
  if (state.interrupted) await state.signalPromise
  if (!options.send) {
    console.log('wallet-ui preflight ok')
    return
  }
  state.evidence = {
    moduleHead: prelude.moduleHead,
    dirty: false,
    starterCommit: prelude.build.starterCommit,
    patchSha256: prelude.build.patchSha256,
    mainJsbundleSha256: prelude.build.mainJsbundleSha256,
    maestroVersion: prelude.maestroVersion,
    simulatorRuntime: prelude.simulatorRuntime,
    walletInterface: WALLET_INTERFACE,
    backendCommitStart: prelude.backendCommitStart,
    account: prelude.account,
    ibanCountryAndClearing: IBAN_LABEL
  }
  try {
    await sendAndCheck(prelude)
    await clearClipboard()
    await clearWalletState()
    if (installedBundleSha(options.udid) !== prelude.build.mainJsbundleSha256) throw new CheckError('bundle', 'installed main.jsbundle changed during cleanup')
    for (const item of state.screenshots) {
      if (sha256File(join(options.screenshots, item.file)) !== item.sha256) throw new CheckError('screenshots', 'screenshot changed after capture')
    }
    const body = measuredRecord()
    body.result = 'pass'
    assertPass(body)
    if (state.interrupted) await state.signalPromise
    state.recordPromise = writeRecord(body)
    await state.recordPromise
    console.log(`wallet-ui pass: ${body.hash}`)
  } catch (error) {
    if (state.interrupted) {
      await state.signalPromise
      return
    }
    if (state.clipboard && !state.clipboardClearAttempted) {
      try {
        await clearClipboard()
      } catch (clipboardError) {
        console.error(`wallet-ui failed: ${redact(clipboardError.message)}`)
      }
    }
    try {
      await clearWalletState()
    } catch (cleanupError) {
      console.error(`wallet-ui failed: ${redact(cleanupError.message)}`)
    }
    if (state.interrupted) {
      await state.signalPromise
      return
    }
    if (error instanceof UsageError || error instanceof NotRunError) throw error
    if (state.evidence.dirty === false) {
      try {
        if (git(['status', '--porcelain']) !== '') state.evidence.dirty = true
      } catch {
        delete state.evidence.dirty
      }
    }
    await writeFail(error)
    throw error
  }
}

try {
  await main()
} catch (error) {
  const message = redact(error?.message ?? error)
  const name = error instanceof CheckError ? `${error.failedCheck}: ` : ''
  if (error instanceof UsageError || error instanceof NotRunError) console.error(`wallet-ui: ${message}`)
  else if (error instanceof CheckError && error.failedCheck === 'clipboard' && state.evidence.clipboardCleared === false) console.error(`wallet-ui failed: ${message}`)
  else console.error(`wallet-ui failed: ${name}${message}${error?.failedStep ? `; step: ${error.failedStep}` : ''}`)
  if (error instanceof UsageError) process.exitCode = 2
  else if (error instanceof NotRunError) process.exitCode = 3
  else process.exitCode = 1
} finally {
  if (state.interrupted) await state.signalPromise
  await releaseResources()
}

// Copyright 2026 DFX AG
// SPDX-License-Identifier: Apache-2.0

export const MAX_TIMEOUT_MS = 2147483647
export const MAX_ASSET_DECIMALS = 255
export const RATE_SIGNIFICANT_DIGITS = 18

// ISO 4217 minor units. No default: unlisted currencies are unsupported.
export const FIAT_DECIMALS = Object.freeze({
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BGN: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BOV: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHE: 2,
  CHF: 2,
  CHW: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  COU: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MXV: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  USN: 2,
  UYI: 0,
  UYU: 2,
  UYW: 4,
  UZS: 2,
  VED: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAF: 0,
  XCD: 2,
  XCG: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2
})

export const EVM_BLOCKCHAINS = new Set([
  'ethereum', 'sepolia', 'binancesmartchain', 'optimism', 'arbitrum', 'polygon',
  'base', 'haqq', 'gnosis', 'plasma', 'citrea', 'citreatestnet'
])

// WDK Safe 0.3.0 init code, without onChainIdentifierParams.
// Source: @tetherto/wdk-wallet-evm-erc-4337 1.0.0-beta.20,
// src/wallet-account-read-only-evm-erc-4337.js SALT_NONCE, SAFE_MODULES_MAP['0.3.0']
// and _getInitCodeOverrides. ENTRYPOINT_V7 in that file is the abstractionkit 0.4.0
// constant copied below. A wallet onChainIdentifier, or another abstractionkit
// build, predicts a different Safe and must not be wrapped.
export const SAFE_V0_3_0_INIT_OVERRIDES = Object.freeze({
  c2Nonce: BigInt('0x69b348339eea4ed93f9d11931c3b894c8f9d8c7663a053024b11cb7eb4e5a1f6'),
  entrypointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  safe4337ModuleAddress: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  safeModuleSetupAddress: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47'
})

// DFX API sign-in message: production has no prefix, sandbox prefixes `[dev]_`.
// The address is appended exactly as sent in ?address=. The prefix split matches
// DfxClient's API host and the widget app host.
export const SIGN_IN_CHALLENGE_PREFIX = Object.freeze({
  production: '',
  sandbox: '[dev]_'
})

export const SIGN_IN_CHALLENGE = 'By_signing_this_message,_you_confirm_that_you_are_the_sole_owner_of_the_provided_Blockchain_address._Your_ID:_'

// The module wraps a Safe signature only when the recovered owner predicts the
// account with the WDK Safe 0.3.0 parameters and the network is in
// ERC6492_NETWORKS (Ethereum, Sepolia, BNB Smart Chain, Optimism, Arbitrum,
// Polygon, Base and Gnosis), the networks for which the DFX API is intended to
// verify ERC-6492; otherwise, it sends the Safe signature unwrapped, and an API
// without ERC-6492 support rejects an undeployed Safe and a wrapped signature
// from a deployed Safe.
export const ERC6492_NETWORKS = Object.freeze(new Set([
  'ethereum', 'sepolia', 'binancesmartchain', 'optimism', 'arbitrum', 'polygon',
  'base', 'gnosis'
]))

// Chain ids DFX uses for ERC-1271. Haqq and Plasma are absent: DFX publishes no id for them.
export const EVM_CHAIN_IDS = Object.freeze({
  ethereum: 1,
  sepolia: 11155111,
  binancesmartchain: 56,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  gnosis: 100,
  citrea: 4114,
  citreatestnet: 5115
})

// Blockchain enum from AssetDetailDto in the DFX Swagger snapshot, 2026-09-24.
export const BLOCKCHAINS = Object.freeze([
  'Bitcoin', 'Lightning', 'Spark', 'Arkade', 'Firo', 'Monero', 'Zano', 'Ethereum',
  'Sepolia', 'BinanceSmartChain', 'Optimism', 'Arbitrum', 'Polygon', 'Base', 'Haqq',
  'Liquid', 'Arweave', 'Cardano', 'InternetComputer', 'DeFiChain', 'Railgun', 'Solana',
  'Gnosis', 'Plasma', 'Tron', 'Citrea', 'CitreaTestnet', 'BitcoinTestnet4', 'BinancePay',
  'KucoinPay', 'Kraken', 'Binance', 'XT', 'MEXC', 'MaerkiBaumann', 'Olkypay',
  'OlkyFrozen', 'Checkout', 'Sumixx', 'Yapeal', 'Frick', 'PLoan'
])

// Only unambiguously input-related StructuredErrorDto.error values belong here.
// KYC, account limits, bank setup and other account states use the provider fallback.
export const INPUT_ERRORS = new Set([
  'AmountTooLow', 'AmountTooHigh', 'PaymentMethodNotAllowed', 'IbanCurrencyMismatch',
  'AssetUnsupported', 'CurrencyUnsupported'
])

export const FAILED_STATES = new Set([
  'Failed', 'Returned', 'Stopped', 'LimitExceeded', 'FeeTooHigh', 'PriceUndeterminable'
])

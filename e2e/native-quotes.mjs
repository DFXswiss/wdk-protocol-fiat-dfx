// Read-only: checks per environment which of BTC/Bitcoin, Lightning, Arkade and FIRO are listed, and that both quote methods reject the unlisted ones with "Missing decimals".
import DfxProtocol from '@dfx.swiss/wdk-protocol-fiat-dfx'

const err = e => `${e?.constructor?.name} ${e?.reason ?? ''} ${e?.message}`.replace(/\s+/g, ' ')
const cases = [
  ['bitcoin', 'Bitcoin', 'BTC'],
  ['lightning', 'Lightning', 'BTC'],
  ['arkade', 'Arkade', 'BTC'],
  ['firo', 'Firo', 'FIRO']
]

for (const environment of [process.env.DFX_ENV === 'production' ? 'production' : 'sandbox']) {
  const protocol = new DfxProtocol(undefined, { environment })
  const assets = await protocol.getSupportedCryptoAssets()
  for (const [network, blockchain, asset] of cases) {
    const listed = assets.some(row => row.networkCode === network && row.code === asset)
    console.log(`${environment} ${network} listed: ${listed}`)
    const expectedListed = environment === 'sandbox' && network === 'firo'
    if (listed !== expectedListed) process.exitCode = 1
    if (expectedListed) continue
    for (const method of ['quoteBuy', 'quoteSell']) {
      try {
        await protocol[method]({ cryptoAsset: asset, fiatCurrency: 'EUR', config: { network }, fiatAmount: 10000n })
        console.log(`  ${method} ${asset}/${network}: NOT REJECTED`)
        process.exitCode = 1
      } catch (error) {
        const expected = `Missing decimals for ${blockchain}/${asset}`
        console.log(`  ${method} ${asset}/${network}: ${err(error)}`)
        if (error?.constructor?.name !== 'ValueError' || error.message !== expected) process.exitCode = 1
      }
    }
  }
}

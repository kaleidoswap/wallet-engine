/**
 * A five-minute tour of the engine — no SDKs, no node, no network.
 * Run it with:  npm run example:tour
 *
 * Everything comes from the SDK-free root barrel. The adapters are the in-memory
 * `MemoAdapter` stub standing in for four protocols, so the router, capability
 * manifest and unified receive below are all real — only the wallets are fake.
 */

import {
  ProtocolAdapterRegistry,
  ProtocolManager,
  CrossProtocolRouter,
  buildUnifiedReceiveURI,
  aggregateForLite,
  classifyDestination,
  PROTOCOL_CAPABILITIES,
} from '../../src/index'
import { MemoAdapter } from '../minimal-adapter/MemoAdapter'

const h = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m\n${'─'.repeat(title.length)}`)

async function main() {
  // ── 1. Register a few protocols ──────────────────────────────────────────
  // A registry is just a map of adapters. Real hosts build it with
  // `createWdkRegistry`; here each protocol is the same stub.
  const registry = new ProtocolAdapterRegistry()
  for (const [protocol, balanceSat] of [
    ['RGB_LN', 250_000],
    ['LIQUID', 100_000],
    ['SPARK', 40_000],
    ['ARKADE', 1_000_000],
  ] as const) {
    const adapter = new MemoAdapter({ protocol, balanceSat })
    await adapter.connect({ protocol, network: 'signet' })
    registry.register(adapter)
  }
  console.log(`Connected: ${registry.getSupportedProtocols().join(', ')}`)

  // ── 2. Differences as data ───────────────────────────────────────────────
  h('Capability manifest')
  for (const p of registry.getSupportedProtocols()) {
    const c = PROTOCOL_CAPABILITIES[p]
    const quirks = [
      c.supportsLightning && 'lightning',
      c.supportsAssets && 'assets',
      c.zeroFee && 'zero-fee',
      c.staticReceiveAddress && 'static-addr',
      c.needsChannelLiquidity && 'needs-liquidity',
      c.boarding && 'boarding',
    ].filter(Boolean)
    console.log(`  ${p.padEnd(7)} ${c.maturity.padEnd(7)} ${c.layers.join(', ').padEnd(34)} ${quirks.join(' · ')}`)
  }
  console.log('\n  Your UI reads this table. It never branches on a protocol name.')

  // ── 3. The router picks the rail ─────────────────────────────────────────
  h('Routing a send')
  const destinations = [
    'lnbc1p3xyz...',                                        // BOLT11
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',           // on-chain
    'lq1qqw8re0dvgm2xrmn3sh6dp3z2n5m2u3p5s0zzr7yzr5v9xk',   // Liquid
  ]
  let sawIndirect = false
  for (const dest of destinations) {
    const { best, routes } = router(registry).resolveSend(dest)
    const kind = classifyDestination(dest).kind
    sawIndirect ||= routes.some((r) => !r.direct)
    console.log(`  ${kind.padEnd(14)} → best: ${best ? best.protocol : '(none connected)'}`)
    console.log(`  ${''.padEnd(14)}   all:  ${routes.map((r) => `${r.protocol}${r.direct ? '' : '*'}`).join(', ') || '—'}`)
  }
  if (sawIndirect) console.log('\n  * = candidate the manifest says cannot settle this directly.')
  console.log('\n  Note what did NOT happen: no `if (protocol === …)`. The candidate set')
  console.log('  comes from the destination, and the manifest decides who can settle it.')
  console.log('  Lite mode uses `.best`. Advanced mode shows the whole ranked list.')

  // ── 4. One QR for every rail ─────────────────────────────────────────────
  h('Unified receive (BIP321)')
  const uri = buildUnifiedReceiveURI({
    btcAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    lightningInvoice: 'lnbc1p3xyz...',
    liquidAddress: 'lq1qqw8re0dvgm2xrmn3sh6dp3z2n5m2u3p5s0zzr7yzr5v9xk',
    label: 'tour',
  })
  console.log(`  ${uri}`)
  console.log('\n  A foreign wallet pays the on-chain address and ignores the rest.')
  console.log('  A Kaleido-aware wallet gets the full menu and lets the router choose.')

  // ── 5. Lite mode collapses the rails ─────────────────────────────────────
  h('Lite aggregation')
  const manager = new ProtocolManager({ defaultProtocol: 'RGB_LN' })
  for (const a of registry.getAll()) manager.registerAdapter(a)

  const assets = await manager.listAllAssets()
  console.log(`  advanced view: ${assets.length} assets across ${registry.getSupportedProtocols().length} protocols`)
  for (const a of assets) console.log(`    ${a.ticker} on ${a.protocol} (${a.layer}) — ${a.balance.total}`)

  const lite = aggregateForLite(assets)
  console.log(`\n  lite view:     BTC ${lite.btc} · USD ${lite.usd} · ${lite.other.length} other`)
  console.log('\n  Same data, one setting. Not two codebases.')

  h('Next')
  console.log('  · examples/minimal-adapter — the contract, implemented in 170 lines')
  console.log('  · src/capabilities/index.ts — add your protocol here')
  console.log('  · README "Extending: add a protocol"\n')
}

const router = (r: ProtocolAdapterRegistry) => new CrossProtocolRouter(r)

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

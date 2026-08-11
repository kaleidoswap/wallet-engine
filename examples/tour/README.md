# Five-minute tour

A runnable walk through the four things the engine gives you that you would
otherwise write twice — router, unified receive, capability manifest, lite
aggregation.

```bash
npm install
npm run example:tour
```

No node, no credentials, no network, no protocol SDKs. The four "wallets" are the
in-memory [`MemoAdapter`](../minimal-adapter/MemoAdapter.ts) standing in for
RGB-LN, Liquid, Spark and Arkade — but the router, the manifest and the BIP321
builder are the real ones. Swapping the stub for
`createWdkRegistry({ enabled: [...] })` is the only change between this and a
wallet that moves funds.

## What it shows

| Step | Point |
|---|---|
| **Capability manifest** | Layers, maturity and quirks per protocol, as data your UI reads |
| **Routing a send** | One destination string in, ranked protocols out — `.best` is lite mode's auto-route |
| **Unified receive** | One `bitcoin:` URI carrying on-chain + Lightning + Liquid at once |
| **Lite aggregation** | Four BTC balances on four rails collapsing into one number |

Expected output ends with:

```
  lite view:     BTC 1390000 · USD 0 · 0 other
```

## Then what

- [`examples/minimal-adapter`](../minimal-adapter) — the whole `IProtocolAdapter`
  contract implemented in ~170 dependency-free lines. Copy it to start a protocol.
- [`src/capabilities/index.ts`](../../src/capabilities/index.ts) — add one entry
  describing your protocol's layers and quirks.
- The README's [Extending: add a protocol](../../README.md#extending-add-a-protocol).

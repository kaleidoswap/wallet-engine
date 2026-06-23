# Minimal adapter example

[`MemoAdapter.ts`](MemoAdapter.ts) is a complete, dependency-free implementation
of the `IProtocolAdapter` contract against an in-memory BTC-only wallet. It is
the smallest thing that satisfies the contract — copy it as the starting point
for a new protocol.

```ts
import { ProtocolManager } from '@kaleidorg/wallet-engine'
import { MemoAdapter } from './MemoAdapter'

const manager = new ProtocolManager({ defaultProtocol: 'BTC' })
manager.registerAdapter(new MemoAdapter())
await manager.connect('BTC', { protocol: 'BTC' })

const assets = await manager.listAllAssets() // [{ id: 'BTC', ... }]
```

## Turning this into a real adapter

1. Replace the in-memory state with calls to your protocol's SDK, translating
   its responses into the domain types in `src/types`.
2. Add one entry to the capability manifest (`src/capabilities/index.ts` and
   `operations.ts`) describing your protocol's layers and quirks.
3. Register the adapter with a `ProtocolManager` (or add it to
   `createWdkRegistry` if it's WDK-backed).

The cross-protocol router, unified receive, lite-mode aggregation, and every
screen pick up the new protocol with **no changes to existing code** — that's the
whole point of the contract + manifest design.

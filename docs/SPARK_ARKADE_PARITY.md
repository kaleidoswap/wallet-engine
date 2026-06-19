# Spark & Arkade activity-history parity

Mobile (this engine, WDK modules) and the browser extension (`rate-extension`,
raw protocol SDKs) maintain separate Spark/Arkade adapters. The extension
adapters carry mature behavior; this engine is intended to become the shared
source of truth. This note records the behavior the engine mirrors and the
**intentional** differences, so the two implementations don't silently drift.

Reference: `rate-extension/src/protocols/{spark,arkade}/{adapter,converters,helpers}.ts`.
Engine tests/fixtures: `test/spark-history.test.ts`, `test/arkade-history.test.ts`,
`test/arkade-offboard.test.ts`, `test/fixtures/{spark,arkade}.ts`.

## Shared behavior (engine mirrors extension)

- **Direction from identity keys.** A Spark transfer has no direction flag; the
  wallet is the receiver iff its identity pubkey equals
  `receiverIdentityPublicKey`. The engine caches the identity key on connect and
  compares against it (extension reads `transfer.transferDirection`, which the
  WDK proto does not expose).
- **Arkade direction from `type`.** `tx.type === 'SENT'` ⇒ send; otherwise
  receive. The amount sign is **not** used (history reports a magnitude).
- **Arkade id resolution.** First non-empty of
  `key.arkTxid → key.commitmentTxid → key.boardingTxid` (empty fields are `''`,
  so `||` is required, not `??`).
- **Arkade `createdAt` is milliseconds.** Used as-is; the previous `* 1000`
  pushed timestamps ~50k years into the future.
- **Received off-chain VTXOs are spendable.** A non-boarding received row that
  is not yet L1-settled surfaces as `confirmed`, matching the Arkade reference
  wallet's preconfirmed/spendable UX rather than generic pending.

## Intentional differences (engine ≠ extension)

| Area | Extension | Engine | Why |
|------|-----------|--------|-----|
| Direct Spark transfer status | `convertTransferToTransaction` maps the raw status, so an intermediate `RECEIVER_KEY_TWEAKED` direct receive reads as `pending`. | `isDirectSparkTransfer()` forces direct transfers to `confirmed`, regardless of intermediate key-tweak state. | A direct Spark transfer is already user-visible/spendable in mobile; leaving it `pending` was the mobile activity bug in issue #3. userRequest (LN/on-chain) flows keep their real status. |
| Unsettled Arkade `SENT` status | All `SENT` rows are `confirmed` (`isSend || settled`). | `SENT` is `confirmed` only when `settled`; an unsettled `SENT` stays `pending`. | A BTC offboard is a `SENT` row that settles asynchronously (issue #5). Confirming every `SENT` would mark in-flight offboards as done in history, contradicting `sendBtcOnchain()`'s `pending` result. |
| Fully-empty Arkade id | Falls back to `ark-${timestamp}`. | Returns `''`. | The engine relies on at least one non-empty `key` field in practice; a synthetic id is not introduced. Covered as an edge case in tests. |
| Arkade asset rows | Expands one `UnifiedTransaction` per `tx.assets[]` entry (RGB-Arkade tokens), with per-asset metadata. | Emits a single BTC-shaped entry per row (`asset: undefined`). | Engine history is BTC-only today; per-asset expansion is a known gap, not a behavior conflict. Track separately before extension migration. |

## Status mapping quick reference

**Spark** (`SparkWdkAdapter.toUnifiedTx`):
- direct transfer (`type==='TRANSFER'` or no userRequest + transfer shape) ⇒ `confirmed`
- otherwise `mapSparkStatus(status)`: `*COMPLET*` ⇒ confirmed; `*FAIL*/*EXPIRED*/*RETURN*` ⇒ failed; else pending

**Arkade** (`ArkadeWdkAdapter.listTransactions`):
- `settled` ⇒ confirmed
- received & non-boarding (off-chain VTXO) ⇒ confirmed
- else ⇒ pending (unsettled boarding rows, unsettled sends)

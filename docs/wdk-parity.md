# WDK adapters — parity with the rate-extension reference

`rate-extension` (the browser extension) ships mature, SDK-backed Spark/Arkade
adapters. wallet-engine's WDK adapters are the shared successor and aim to match
that behavior. This note records where they match and the **intentional
differences** between the mobile/WDK path and the extension/SDK path.

Reference: `rate-extension/src/protocols/{spark,arkade}/{adapter,converters,helpers}.ts`.

## Spark — history (`SparkWdkAdapter.listTransactions`)

Matches the reference:

- **Direct transfers are confirmed.** A native Spark transfer that is still in an
  intermediate SDK state (`SENDER_INITIATED`, `RECEIVER_KEY_TWEAKED`) is already
  user-visible/spendable, so it maps to `confirmed` (`isDirectSparkTransfer`).
- **userRequest flows keep their real status.** Lightning / on-chain Spark flows
  that carry a `userRequest` are mapped through `mapSparkStatus`
  (completed → confirmed, failed/expired/returned → failed, else pending).
- **Direction from identity keys.** Derived from the receiver/sender identity
  pubkeys vs the wallet's own key, falling back to the legacy
  `transferDirection`/`direction` field only when no identity key is known.

Covered by `test/spark-history.test.ts`.

### Intentional difference

- **Spark token (RGB-Spark) transaction history is not yet converted.** The
  extension has `convertTokenTransactionToUnified` (direction-from-output-ownership,
  local outbox fallback). The WDK adapter currently surfaces native BTC transfers
  only. Token-tx history is a follow-up; it is **out of scope** for issues #3–#6.

## Arkade — history (`ArkadeWdkAdapter.listTransactions`)

Matches the reference:

- **Direction from `type === 'SENT'`**, not the amount sign (amount is a magnitude).
- **Stable id** = first non-empty of `key.arkTxid` → `key.commitmentTxid` →
  `key.boardingTxid` (empty-string fields are skipped; a row with no id yields `''`
  rather than crashing).
- **`createdAt` is already milliseconds** — no `* 1000` (the old bug pushed every
  row ~50k years into the future and broke sort order).

Covered by `test/arkade-history.test.ts`.

### Intentional difference

- **Received off-chain (non-boarding) VTXOs map to `confirmed`, not `pending`.**
  The extension keeps unsettled received rows as `pending` and renders them as a
  dedicated "preconfirmed/spendable" UX state in `use-activity-data.ts`.
  wallet-engine's `UnifiedTransaction.status` has no "preconfirmed" value, so the
  WDK adapter flattens a received, non-boarding Ark VTXO to `confirmed` (it is
  spendable) — avoiding the "received funds shown as pending/failed" bug on hosts
  that don't implement the extra UX state.
- **Unsettled SENT rows stay `pending` until settled** (the reference converter
  marks every SENT row `confirmed`). This is deliberate and consistent with the
  offboard rule below: an asynchronous Bitcoin offboard is a SENT row that is not
  yet settled, and must read as `pending` in history rather than falsely confirmed.
  A SENT row becomes `confirmed` once `settled` is true. Net status rule:
  `settled || (received && !boarding) → confirmed, else pending`.

## Arkade — send / offboard (`ArkadeWdkAdapter.sendPayment` / `sendBtcOnchain`)

Matches the reference:

- **Off-chain Ark address sends** settle immediately (`confirmed`) and return a
  tx id/hash.
- **Bitcoin destinations are offboards**: routed through `sendBtcOnchain`, returned
  as `pending` (they settle on-chain asynchronously), and a missing tx id/hash is
  treated as a **send error** (never silent success).

Covered by `test/arkade-offboard.test.ts`.

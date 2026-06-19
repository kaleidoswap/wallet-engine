/**
 * Arkade WDK transaction-history fixtures.
 *
 * These mirror the @arkade-os/sdk `ArkTransaction` shape returned by
 * `account.getTransactionHistory()`, as consumed by
 * `ArkadeWdkAdapter.listTransactions()`:
 *
 *   {
 *     key: { arkTxid, commitmentTxid, boardingTxid },  // unused fields are ''
 *     type: 'SENT' | 'RECEIVED',
 *     amount: number,        // net sats, reported as a signed magnitude
 *     settled: boolean,
 *     createdAt: number,     // milliseconds since epoch (NOT seconds)
 *   }
 */

/** Fixed timestamps (ms) so tests stay deterministic. */
export const TS_1 = 1_718_800_000_000 // 2024-06-19T...
export const TS_2 = 1_718_800_500_000
export const TS_3 = 1_718_801_000_000
export const TS_4 = 1_718_801_500_000
export const TS_5 = 1_718_802_000_000

/** Outgoing Ark transfer, not yet L1-settled. */
export const sentUnsettled = {
  key: { arkTxid: 'a'.repeat(64), commitmentTxid: '', boardingTxid: '' },
  type: 'SENT',
  amount: -5_000,
  settled: false,
  createdAt: TS_1,
}

/** Outgoing Ark transfer that has settled on L1. */
export const sentSettled = {
  key: { arkTxid: 'b'.repeat(64), commitmentTxid: '', boardingTxid: '' },
  type: 'SENT',
  amount: -12_000,
  settled: true,
  createdAt: TS_2,
}

/**
 * Received off-chain VTXO that is not L1-settled. Spendable in Arkade UX, so
 * it must surface as `confirmed`, not generic pending (issue #6).
 */
export const receivedOffchainUnsettled = {
  key: { arkTxid: 'c'.repeat(64), commitmentTxid: '', boardingTxid: '' },
  type: 'RECEIVED',
  amount: 8_000,
  settled: false,
  createdAt: TS_3,
}

/**
 * Boarding (on-chain → Ark) row, not yet settled. Boarding funds are genuinely
 * pending until confirmed, so this must stay `pending`. Its id comes from
 * `boardingTxid` since arkTxid/commitmentTxid are empty.
 */
export const boardingUnsettled = {
  key: { arkTxid: '', commitmentTxid: '', boardingTxid: 'd'.repeat(64) },
  type: 'RECEIVED',
  amount: 20_000,
  settled: false,
  createdAt: TS_4,
}

/**
 * Row whose arkTxid is empty but commitmentTxid is set — exercises the
 * non-empty id fallback (`||`, not `??`, since empty fields are '').
 */
export const commitmentIdRow = {
  key: { arkTxid: '', commitmentTxid: 'e'.repeat(64), boardingTxid: '' },
  type: 'RECEIVED',
  amount: 3_000,
  settled: true,
  createdAt: TS_5,
}

/** Degenerate row with no id fields at all. */
export const emptyIdRow = {
  key: { arkTxid: '', commitmentTxid: '', boardingTxid: '' },
  type: 'RECEIVED',
  amount: 100,
  settled: false,
  createdAt: TS_5,
}

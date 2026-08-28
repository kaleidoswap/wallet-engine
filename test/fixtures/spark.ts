/**
 * Spark WDK transfer fixtures, mirroring the spark-sdk Transfer proto shape the WDK
 * module surfaces via `account.getTransfers()` — id/sparkId, the type and
 * userRequest variants, receiver/sender identity keys, value, status, timestamps.
 *
 * Identity keys decide direction: the wallet is the receiver iff its identity key
 * equals `receiverIdentityPublicKey`.
 */

/** Our wallet's identity pubkey (hex). */
export const ME = '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
/** A counterparty identity pubkey (hex). */
export const OTHER = '03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/**
 * Direct Spark receive still in the intermediate key-tweak state. The raw status is
 * "pending", but a direct transfer is already spendable, so the adapter must surface
 * it as `confirmed` (issue #3).
 */
export const directReceiveKeyTweaked = {
  id: 'transfer-direct-receive',
  type: 'TRANSFER',
  receiverIdentityPublicKey: ME,
  senderIdentityPublicKey: OTHER,
  totalValue: 10_000,
  status: 'TRANSFER_STATUS_RECEIVER_KEY_TWEAKED',
  createdTime: '2026-06-19T10:00:00.000Z',
}

/** Direct Spark send, still SENDER_INITIATED → must surface as confirmed. */
export const directSendInitiated = {
  id: 'transfer-direct-send',
  type: 'TRANSFER',
  receiverIdentityPublicKey: OTHER,
  senderIdentityPublicKey: ME,
  totalValue: 5_000,
  status: 'TRANSFER_STATUS_SENDER_INITIATED',
  createdTime: '2026-06-19T11:00:00.000Z',
}

/**
 * Lightning receive carrying a userRequest, still in flight. NOT a direct transfer,
 * so its real pending status must be preserved (issue #3).
 */
export const lightningReceivePending = {
  id: 'ln-receive-pending',
  userRequest: { id: 'req-1' },
  receiverIdentityPublicKey: ME,
  senderIdentityPublicKey: OTHER,
  totalValue: 2_500,
  status: 'LIGHTNING_PAYMENT_INITIATED',
  createdTime: '2026-06-19T12:00:00.000Z',
}

/** On-chain send via userRequest that has completed → confirmed preserved. */
export const onchainSendCompleted = {
  id: 'onchain-send-completed',
  userRequestId: 'req-2',
  receiverIdentityPublicKey: OTHER,
  senderIdentityPublicKey: ME,
  totalValue: 30_000,
  status: 'TRANSFER_STATUS_COMPLETED',
  createdTime: '2026-06-19T13:00:00.000Z',
}

/** Lightning send via userRequest that failed → failed preserved. */
export const lightningSendFailed = {
  id: 'ln-send-failed',
  userRequest: { id: 'req-3' },
  receiverIdentityPublicKey: OTHER,
  senderIdentityPublicKey: ME,
  totalValue: 1_000,
  status: 'LIGHTNING_PAYMENT_FAILED',
  createdTime: '2026-06-19T14:00:00.000Z',
}

/**
 * A transfer with NO identity keys and only the legacy direction field — exercises
 * the fallback used when the cached identity key is unknown.
 */
export const legacyDirectionReceive = {
  id: 'legacy-incoming',
  type: 'TRANSFER',
  transferDirection: 'INCOMING',
  totalValue: 7_777,
  status: 'TRANSFER_STATUS_COMPLETED',
  createdTime: '2026-06-19T15:00:00.000Z',
}

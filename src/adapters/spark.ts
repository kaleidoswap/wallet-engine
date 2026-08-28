/**
 * Spark-only native adapter entry — sub-path export
 * `@kaleidorg/wallet-engine/adapters/spark`. Pulls only `@buildonspark/spark-sdk`
 * (+ `@scure/btc-signer` for PSBT signing). Flashnet/Orchestra is a separate slice.
 */
export { SparkAdapter, isEmptyBalance, invalidateSparkBalanceCache } from "./SparkAdapter";
export { sparkClientManager } from "../lib/spark-client-manager";
// Spark token send-outbox — shared so the extension's write sites (message
// routes) and the engine adapter's read path use ONE store (via ports storage).
export {
  loadSentTokenRecords,
  saveSentTokenRecord,
  normalizeTxHash,
  MAX_SENT_TOKEN_TX_HISTORY,
  type SentTokenTxRecord,
} from "../lib/spark-sent-token-records";

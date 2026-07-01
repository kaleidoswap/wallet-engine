/**
 * Spark-only native adapter entry.
 *
 * Opt-in sub-path export: `@kaleidorg/wallet-engine/adapters/spark`. Pulls only
 * `@buildonspark/spark-sdk` (+ `@scure/btc-signer` for PSBT signing) — not the
 * Arkade/RGB SDKs. Flashnet/Orchestra (bridge/swaps) is a separate slice and is
 * intentionally NOT exported here.
 */
export { SparkAdapter, isEmptyBalance, invalidateSparkBalanceCache } from "./SparkAdapter";
export { sparkClientManager } from "../lib/spark-client-manager";

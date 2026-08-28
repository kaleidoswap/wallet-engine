/**
 * Pure fee-rate policy for RGB on-chain operations, extracted from
 * `RgbAdapter#resolveFeeRate` so the priority order and mainnet floors are
 * unit-testable without a live client.
 *
 * The policy ([GL #26]):
 *   1. A positive caller-`provided` rate is honoured — the advanced UI can
 *      override the floor.
 *   2. Non-mainnet networks: `1 sat/vB`.
 *   3. Mainnet: ask the node at the urgency-mapped block target, floored at
 *      `MAINNET_FEE_FLOOR[urgency]` so a cold-started node returning `1 sat/vB`
 *      doesn't strand transactions.
 *   4. Mainnet + estimate failure: the floor.
 */

export type FeeUrgency = "low" | "normal" | "high";

/** Block-target mapping per urgency. high = next block, low = ~2 hours. */
const URGENCY_BLOCKS: Record<FeeUrgency, number> = {
  high: 1,
  normal: 6,
  low: 12,
};

/**
 * Conservative mainnet floors (sat/vB) — well above the dust-attack rate but cheap
 * relative to any user-facing payment, tuned for a 10-min-block target at "normal"
 * urgency. Every call site reads from this table.
 */
export const MAINNET_FEE_FLOOR: Record<FeeUrgency, number> = {
  low: 5,
  normal: 10,
  high: 25,
};

export interface ResolveRgbFeeRateInput {
  /** Caller-provided rate (advanced UI override). Wins when > 0. */
  provided: number | undefined;
  /** Urgency tier; maps to a block target + floor. */
  urgency: FeeUrgency;
  /** Active network from the adapter config. `null` = unknown / not connected. */
  network: string | null;
  /**
   * Async estimator, receiving the urgency-mapped block target. Returns the node's
   * `fee_rate` in sat/vB, or `null` on failure. Must not throw — the policy needs a
   * value to fall back on.
   */
  estimateFn: (blocks: number) => Promise<number | null>;
}

export async function resolveRgbFeeRatePolicy(input: ResolveRgbFeeRateInput): Promise<number> {
  const { provided, urgency, network, estimateFn } = input;
  if (typeof provided === "number" && Number.isFinite(provided) && provided > 0) {
    return provided;
  }
  // Case-insensitive so a `"Mainnet"`/`"MAINNET"` label can't slip past the
  // floor and broadcast a real mainnet transaction at 1 sat/vB (stuck funds).
  const isMainnet = network?.toLowerCase() === "mainnet";
  if (!isMainnet) {
    return 1;
  }
  const floor = MAINNET_FEE_FLOOR[urgency];
  const blocks = URGENCY_BLOCKS[urgency];
  const estimate = await estimateFn(blocks);
  if (estimate == null || !Number.isFinite(estimate) || estimate <= 0) {
    return floor;
  }
  // Round the fractional estimate UP: rounding down (Math.floor) systematically
  // underpays a fractional sat/vB rate, mildly slowing confirmation.
  return Math.max(Math.ceil(estimate), floor);
}

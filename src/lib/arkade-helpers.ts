/**
 * Pure helpers for the Arkade adapter.
 *
 * Every function here is side-effect free, has no `this` dependencies, and is
 * covered by test/arkade-helpers.test.ts. Keep helpers pure (no class state,
 * no SDK calls). Anything that needs the @arkade-os/sdk client or the adapter's
 * config belongs in ArkadeAdapter.ts.
 */

// ── Type coercion ──────────────────────────────────────────────────────────
// The Arkade SDK is loose about numeric types in some response shapes
// (bigint, number, numeric string). These helpers normalize without
// throwing — the alternative is sprinkling defensive `if (typeof …)` checks
// across the adapter.

/** Coerce a value to a finite number. Returns 0 for anything unparseable. */
export function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Coerce a value to a strictly-positive bigint. Returns 0n for
 * non-positive / unparseable input. Used where the SDK demands a
 * bigint quantity (e.g. asset send amounts) and we don't want to
 * silently send zero on a malformed numeric input.
 */
export function toPositiveIntegerBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return 0n;
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return 0n;
    return BigInt(trimmed);
  }
  return 0n;
}

/** Coerce to a string, or empty string for any non-string. */
export function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ── Arkade asset metadata accessors ───────────────────────────────────────
// `details` shape comes from `wallet.assetManager.getAssetDetails(assetId)`.
// We defensively unwrap so the adapter doesn't have to spread type checks
// across every consumer.

/** Pull the metadata sub-object out of an asset-details response. */
export function getAssetMetadata(
  details: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const metadata = details?.metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

/**
 * Asset display precision (number of decimal places). Reads `metadata.decimals`,
 * accepting both numeric and stringy values. Falls back to 0 (integer asset)
 * when absent / negative / non-finite — Arkade assets without an explicit
 * decimals field are integer-quantity tokens by convention.
 */
export function getAssetPrecision(metadata: Record<string, unknown> | undefined): number {
  const decimals = metadata?.decimals;
  if (typeof decimals === "number" && Number.isFinite(decimals) && decimals >= 0) {
    return decimals;
  }
  if (typeof decimals === "string" && decimals.trim() !== "") {
    const parsed = Number(decimals);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Asset ticker for display. Uses `metadata.ticker` when present (uppercased,
 * trimmed); falls back to the first 6 chars of the asset id, uppercased —
 * this is the "best effort label" path for newly-issued or partially-
 * documented assets.
 */
export function getAssetTicker(
  assetId: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const ticker = metadata?.ticker;
  if (typeof ticker === "string" && ticker.trim() !== "") {
    return ticker.trim().toUpperCase();
  }
  return assetId.slice(0, 6).toUpperCase();
}

/**
 * Asset display name. Uses `metadata.name` when present, otherwise builds a
 * synthetic `"Arkade Asset <TICKER>"` label so the UI never has to render
 * an empty string.
 */
export function getAssetName(
  assetId: string,
  ticker: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const name = metadata?.name;
  if (typeof name === "string" && name.trim() !== "") {
    return name.trim();
  }
  return `Arkade Asset ${ticker || assetId.slice(0, 6)}`;
}

// ── Display formatting ────────────────────────────────────────────────────

// Amount display formatting is centralized in ./amount (was duplicated here).
// `formatUnits` is the local name for the shared `formatAmount`.
export { formatAmount as formatUnits, formatSats } from "./amount";

// ── VTXO selection (expiry-first) ──────────────────────────────────────────

/**
 * Sort VTXOs by batchExpiry ascending (expiry-first coin selection).
 * VTXOs expiring soonest are consumed first, maximizing the lifetime
 * of remaining VTXOs and reducing the need for auto-renewal rounds.
 *
 * Stable secondary sort on `value` (descending) so when two VTXOs share
 * the same batch expiry we prefer the larger one — fewer inputs in the
 * resulting transaction means a smaller fee.
 */
export function sortVtxosByExpiry<
  T extends { virtualStatus?: { batchExpiry?: number }; value?: number | bigint },
>(vtxos: T[]): T[] {
  return [...vtxos].sort((a, b) => {
    const expiryA = a.virtualStatus?.batchExpiry ?? Infinity;
    const expiryB = b.virtualStatus?.batchExpiry ?? Infinity;
    if (expiryA !== expiryB) return expiryA - expiryB;
    const valueA = Number(a.value ?? 0);
    const valueB = Number(b.value ?? 0);
    return valueB - valueA;
  });
}

/**
 * Pure expiry-first selector. Picks the minimum set of VTXOs (sorted by
 * expiry, value-desc tiebreaker) whose summed value covers `targetSats`.
 * Returns `null` when the available VTXOs can't cover the target — the
 * caller should let the SDK error so the user gets a real "insufficient
 * funds" message rather than a half-formed selection.
 */
export function selectVtxosByExpiry<
  T extends { virtualStatus?: { batchExpiry?: number }; value?: number | bigint },
>(vtxos: T[], targetSats: number): T[] | null {
  if (targetSats <= 0) return [];
  const sorted = sortVtxosByExpiry(vtxos);
  const selected: T[] = [];
  let total = 0;
  for (const vtxo of sorted) {
    selected.push(vtxo);
    total += Number(vtxo.value ?? 0);
    if (total >= targetSats) return selected;
  }
  return null;
}

// ── VTXO normalization ────────────────────────────────────────────────────

export interface NormalizedVtxo {
  txid: string;
  vout: number;
  value: number;
  state: string;
  batchTxid?: string;
  batchExpiry?: number;
  createdAt?: number;
  assets?: Array<{ assetId: string; amount: number }>;
}

/**
 * Coerce the SDK's loose `getVtxos()` response shape into the strict
 * `NormalizedVtxo[]` the adapter consumes elsewhere.
 *
 *  - Accepts both a bare array and `{ vtxos: [...] }` wrapper (the SDK
 *    has shipped both shapes across versions).
 *  - Pulls fields from the outer entry and, when missing, falls back to
 *    `entry.outpoint.{txid,vout}` — older shapes nested those.
 *  - Resolves `state` from `virtualStatus.state`, then `isSwept` /
 *    `isPreconfirmed` / `isSpent` flags, defaulting to "settled".
 *  - Drops zero-value entries, spent entries, and entries with no txid —
 *    callers can rely on the returned array containing only spendable-
 *    looking VTXOs.
 */
export function normalizeVtxos(raw: unknown): NormalizedVtxo[] {
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { vtxos?: unknown[] } | null | undefined)?.vtxos)
      ? (raw as { vtxos: unknown[] }).vtxos
      : [];

  return entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const outpoint = (entry.outpoint as Record<string, unknown> | undefined) ?? {};
      const virtualStatus = (entry.virtualStatus as Record<string, unknown> | undefined) ?? {};
      const txid = toStringValue(entry.txid) || toStringValue(outpoint.txid);
      const vout = toNumber(entry.vout ?? outpoint.vout);
      const value = toNumber(entry.value ?? entry.amount);
      const state =
        toStringValue(virtualStatus.state) ||
        (entry.isSwept ? "swept" : "") ||
        (entry.isPreconfirmed ? "preconfirmed" : "") ||
        (entry.isSpent ? "spent" : "") ||
        "settled";
      const batchTxid =
        toStringValue(virtualStatus.batchTxID) || toStringValue(virtualStatus.batchTxId);
      const batchExpiry = toNumber(virtualStatus.batchExpiry);
      const createdAtRaw = entry.createdAt;
      const createdAt =
        createdAtRaw instanceof Date ? createdAtRaw.getTime() : toNumber(createdAtRaw);
      const assets = Array.isArray(entry.assets)
        ? entry.assets
            .filter(
              (asset): asset is Record<string, unknown> => !!asset && typeof asset === "object",
            )
            .map((asset) => ({
              assetId: toStringValue(asset.assetId),
              amount: toNumber(asset.amount),
            }))
            .filter((asset) => asset.assetId !== "" && asset.amount > 0)
        : [];

      return {
        txid,
        vout,
        value,
        state,
        batchTxid: batchTxid || undefined,
        batchExpiry: batchExpiry > 0 ? batchExpiry : undefined,
        createdAt: createdAt > 0 ? createdAt : undefined,
        assets: assets.length > 0 ? assets : undefined,
      };
    })
    .filter((entry) => entry.txid !== "" && entry.value > 0 && entry.state !== "spent");
}

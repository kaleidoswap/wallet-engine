/**
 * Pure helpers for the Arkade adapter — side-effect free, no `this`, no SDK calls.
 * Anything needing the @arkade-os/sdk client or adapter config belongs in
 * ArkadeAdapter.ts.
 */

// ── Type coercion ──────────────────────────────────────────────────────────
// The Arkade SDK is loose about numeric types (bigint, number, numeric string);
// these normalize without throwing.

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
 * Coerce to a strictly-positive bigint, 0n for non-positive/unparseable input.
 * Used where the SDK demands a bigint quantity and silently sending zero on a
 * malformed input would be wrong.
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
// `details` comes from `wallet.assetManager.getAssetDetails(assetId)`; unwrapped
// defensively so consumers don't each spread type checks.

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
 * Asset display precision, accepting numeric and stringy `metadata.decimals`.
 * Falls back to 0 — Arkade assets without the field are integer-quantity by
 * convention.
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
 * Asset ticker for display: `metadata.ticker` uppercased/trimmed, else the first
 * 6 chars of the asset id — best-effort label for newly-issued assets.
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
 * Asset display name, falling back to a synthetic `"Arkade Asset <TICKER>"` so
 * the UI never renders an empty string.
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
 * Sort VTXOs by batchExpiry ascending (expiry-first coin selection), maximizing
 * the lifetime of what remains. Secondary sort on `value` descending, so equal
 * expiries prefer the larger VTXO — fewer inputs, smaller fee.
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
 * Pure expiry-first selector: the minimum set of VTXOs covering `targetSats`.
 * Returns `null` when they can't cover it, so the caller lets the SDK raise a
 * real "insufficient funds" rather than acting on a half-formed selection.
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
 * Coerce the SDK's loose `getVtxos()` response into strict `NormalizedVtxo[]`:
 * accepts a bare array or `{ vtxos: [...] }` (both have shipped), falls back to
 * `entry.outpoint.{txid,vout}` for older shapes, resolves `state` from
 * `virtualStatus.state` then the isSwept/isPreconfirmed/isSpent flags, and drops
 * zero-value, spent and txid-less entries.
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

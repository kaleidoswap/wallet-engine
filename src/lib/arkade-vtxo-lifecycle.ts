/**
 * Arkade VTXO Lifecycle + Delegator management (platform-agnostic core).
 *
 * This module is deliberately free of any platform API (`chrome.*`, timers,
 * notifications, storage). Consumers drive it:
 *   - The browser extension runs `runArkadeVtxoLifecycle()` from a
 *     `chrome.alarms` tick and maps the result to `chrome.notifications` +
 *     runtime broadcasts via the `callbacks`.
 *   - React Native schedules it however it prefers.
 *
 * It covers:
 *   - VTXO auto-renewal      — renew VTXOs approaching expiry
 *   - Orphan VTXO recovery   — surface recoverable (swept/expired) balance
 *   - Boarding UTXO expiry   — surface expired boarding UTXOs
 *   - VTXO delegation        — delegate spendable VTXOs when enabled
 *
 * @arkade-os/sdk is referenced by TYPE only (erased at compile time), so this
 * module is safe to export from the engine's root barrel.
 */

import type { VtxoManager, Wallet, ContractVtxo } from "@arkade-os/sdk";

// ---------------------------------------------------------------------------
// Settings — normalized shape + sanitizers + defaults
// ---------------------------------------------------------------------------

/** Delegator service endpoints per network. */
export const ARKADE_DELEGATOR_URLS = {
  signet: "https://delegator.mutinynet.arkade.sh",
  mainnet: "https://delegate.arkade.money",
} as const;

export const DEFAULT_DELEGATOR_URL = ARKADE_DELEGATOR_URLS.mainnet;

/** Seconds before batch expiry at which a VTXO becomes eligible for auto-renewal (3 days). */
export const DEFAULT_VTXO_THRESHOLD_SECONDS = 259200;

export type ArkadeNetwork = "mainnet" | "signet";

export interface ArkadeLifecycleSettings {
  delegatorUrl: string;
  delegationEnabled: boolean;
  vtxoThresholdSeconds: number;
}

/**
 * Coerce a raw delegator URL to a safe HTTPS URL, falling back to the
 * network default when missing / non-HTTPS / unparseable.
 */
export function sanitizeDelegatorUrl(rawUrl: unknown, network: ArkadeNetwork = "mainnet"): string {
  const defaultUrl = ARKADE_DELEGATOR_URLS[network];
  if (typeof rawUrl !== "string") return defaultUrl;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return defaultUrl;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return defaultUrl;
  } catch {
    return defaultUrl;
  }
  return trimmed;
}

/** Coerce a raw delegation-enabled flag to a boolean (defaults to true when undefined). */
export function sanitizeDelegationEnabled(rawValue: unknown): boolean {
  if (rawValue === undefined) return true;
  if (typeof rawValue === "boolean") return rawValue;
  if (typeof rawValue === "number") return rawValue !== 0 && !Number.isNaN(rawValue);
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

/** Coerce a raw threshold to a positive integer of seconds, defaulting to 3 days. */
export function sanitizeVtxoThresholdSeconds(rawValue: unknown): number {
  const parsed =
    typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number(rawValue) : NaN;

  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_VTXO_THRESHOLD_SECONDS;
}

/**
 * Sanitize a raw lifecycle-settings object into a clean `ArkadeLifecycleSettings`.
 * Consumers read platform storage into a raw object and pass it here — storage
 * key naming stays consumer-side; the normalized shape + validation lives here.
 */
export function resolveArkadeLifecycleSettings(raw: {
  delegatorUrl?: unknown;
  delegationEnabled?: unknown;
  vtxoThresholdSeconds?: unknown;
  network?: ArkadeNetwork;
}): ArkadeLifecycleSettings {
  const network = raw.network ?? "mainnet";
  return {
    delegatorUrl: sanitizeDelegatorUrl(raw.delegatorUrl, network),
    delegationEnabled: sanitizeDelegationEnabled(raw.delegationEnabled),
    vtxoThresholdSeconds: sanitizeVtxoThresholdSeconds(raw.vtxoThresholdSeconds),
  };
}

// ---------------------------------------------------------------------------
// Delegator helpers
// ---------------------------------------------------------------------------

export interface ArkadeDelegateResult {
  delegated: number;
  failed: number;
}

export interface ArkadeDelegateInfo {
  configured: boolean;
  [key: string]: unknown;
}

/**
 * Delegate all currently-spendable (settled/preconfirmed) VTXOs to the
 * configured delegator. Returns `{ delegated: 0, failed: 0 }` when delegation
 * is not configured or there is nothing to delegate.
 */
export async function delegateSpendableVtxos(wallet: Wallet): Promise<ArkadeDelegateResult> {
  const delegatorManager = await wallet.getDelegatorManager();
  if (!delegatorManager) {
    return { delegated: 0, failed: 0 };
  }

  const vtxos = await wallet.getVtxos();
  const spendable = vtxos.filter(
    (v) => v.virtualStatus?.state === "settled" || v.virtualStatus?.state === "preconfirmed",
  );
  if (spendable.length === 0) {
    return { delegated: 0, failed: 0 };
  }

  const ownAddress = await wallet.getAddress();
  // ExtendedVirtualCoin carries all ContractVtxo fields at runtime; the SDK
  // populates contractScript on delegation-eligible VTXOs.
  const result = await delegatorManager.delegate(spendable as unknown as ContractVtxo[], ownAddress);

  return { delegated: result.delegated.length, failed: result.failed.length };
}

/**
 * Resolve delegate info from the wallet's delegator manager. Returns
 * `{ configured: false }` when delegation is not configured.
 */
export async function getArkadeDelegateInfo(wallet: Wallet): Promise<ArkadeDelegateInfo> {
  const delegatorManager = await wallet.getDelegatorManager();
  if (!delegatorManager) {
    return { configured: false };
  }
  const info = await delegatorManager.getDelegateInfo();
  return { configured: true, ...info };
}

// ---------------------------------------------------------------------------
// Lifecycle runner
// ---------------------------------------------------------------------------

export interface ArkadeLifecycleRunConfig {
  delegationEnabled?: boolean;
  delegatorUrl?: string;
}

export interface ArkadeLifecycleCallbacks {
  /** Fired after a successful renewal round with the renewed count + commitment txid. */
  onVtxosRenewed?(info: { count: number; txid: string }): void;
  /** Fired per SDK renewal-progress event (event.type). */
  onRenewalEvent?(eventType: string): void;
  /** Fired for any stage error; the run continues to the next stage. */
  onError?(stage: string, error: unknown): void;
}

export interface ArkadeRecoverableBalance {
  recoverable: bigint;
  subdust: bigint;
  includesSubdust: boolean;
  vtxoCount: number;
}

export interface ArkadeVtxoLifecycleResult {
  renewed: { count: number; txid: string } | null;
  recoverable: ArkadeRecoverableBalance | null;
  expiredBoardingCount: number;
  delegated: ArkadeDelegateResult | null;
  errors: string[];
}

/**
 * Run one pass of the VTXO lifecycle. Every stage is best-effort and isolated:
 * a failure in one stage is recorded in `result.errors` (and reported via
 * `callbacks.onError`) but never aborts the remaining stages.
 */
export async function runArkadeVtxoLifecycle(args: {
  vtxoManager: VtxoManager;
  wallet: Wallet;
  config?: ArkadeLifecycleRunConfig;
  callbacks?: ArkadeLifecycleCallbacks;
}): Promise<ArkadeVtxoLifecycleResult> {
  const { vtxoManager, wallet, config, callbacks } = args;
  const result: ArkadeVtxoLifecycleResult = {
    renewed: null,
    recoverable: null,
    expiredBoardingCount: 0,
    delegated: null,
    errors: [],
  };

  const record = (stage: string, error: unknown): void => {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`${stage}: ${msg}`);
    callbacks?.onError?.(stage, error);
  };

  // 1. Auto-renewal — renew VTXOs approaching expiry.
  try {
    const expiringVtxos = await vtxoManager.getExpiringVtxos();
    if (expiringVtxos.length > 0) {
      const txid = await vtxoManager.renewVtxos((event: { type: string }) => {
        callbacks?.onRenewalEvent?.(event.type);
      });
      result.renewed = { count: expiringVtxos.length, txid };
      callbacks?.onVtxosRenewed?.({ count: expiringVtxos.length, txid });
    }
  } catch (error) {
    record("renew", error);
  }

  // 2. Orphan recovery — surface recoverable balance.
  try {
    const balance = await vtxoManager.getRecoverableBalance();
    result.recoverable = {
      recoverable: balance.recoverable,
      subdust: balance.subdust,
      includesSubdust: balance.includesSubdust,
      vtxoCount: balance.vtxoCount,
    };
  } catch (error) {
    record("recoverable", error);
  }

  // 3. Boarding UTXO expiry — surface expired boarding UTXOs.
  try {
    const expired = await vtxoManager.getExpiredBoardingUtxos();
    result.expiredBoardingCount = expired.length;
  } catch (error) {
    record("boarding-expiry", error);
  }

  // 4. Delegation — delegate spendable VTXOs when enabled + configured.
  if (config?.delegationEnabled && config?.delegatorUrl) {
    try {
      result.delegated = await delegateSpendableVtxos(wallet);
    } catch (error) {
      record("delegate", error);
    }
  }

  return result;
}

/**
 * One-time removal of the retired Boltz swap store.
 *
 * Boltz swaps were persisted in IndexedDB (`kaleidoswap-arkade-swaps`, store
 * `swaps`). The integration is gone, so the database is deleted when it holds
 * nothing but final swaps. An unfinished swap may still guard funds in a VHTLC,
 * so the database is kept and the caller is told how many need attention.
 */

import { log } from "./log";

export const LEGACY_ARKADE_SWAPS_DB = "kaleidoswap-arkade-swaps";
const SWAPS_STORE = "swaps";

export type LegacyArkadeSwapsCleanup =
  | { status: "unavailable" | "absent" | "deleted" }
  | { status: "kept"; unfinished: string[] };

interface LegacySwapRecord {
  id?: string;
  type?: string;
  status?: string;
  refunded?: boolean;
}

const FINAL_REVERSE = new Set([
  "invoice.settled",
  "invoice.expired",
  "transaction.failed",
  "transaction.refunded",
  "swap.expired",
]);
const FINAL_CHAIN = new Set(["transaction.claimed", "transaction.refunded"]);

/** Conservative: anything not provably settled or refunded counts as unfinished. */
export function isFinalLegacySwap(record: LegacySwapRecord): boolean {
  if (record.refunded === true) return true;
  switch (record.type) {
    case "reverse":
      return FINAL_REVERSE.has(record.status ?? "");
    case "submarine":
      return record.status === "transaction.claimed";
    case "chain":
      return FINAL_CHAIN.has(record.status ?? "");
    default:
      return false;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Open without creating: a fresh database is aborted in `onupgradeneeded`. */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const req = idb.open(name);
    req.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        created = true;
        req.transaction?.abort();
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (created ? resolve(null) : reject(req.error));
    req.onblocked = () => reject(new Error(`${name} is open elsewhere`));
  });
}

async function readSwaps(db: IDBDatabase): Promise<LegacySwapRecord[]> {
  if (!db.objectStoreNames.contains(SWAPS_STORE)) return [];
  const tx = db.transaction(SWAPS_STORE, "readonly");
  return request(tx.objectStore(SWAPS_STORE).getAll() as IDBRequest<LegacySwapRecord[]>);
}

async function runCleanup(idb: IDBFactory | undefined): Promise<LegacyArkadeSwapsCleanup> {
  if (!idb) return { status: "unavailable" };
  const db = await openExisting(idb, LEGACY_ARKADE_SWAPS_DB);
  if (!db) return { status: "absent" };
  let records: LegacySwapRecord[];
  try {
    records = await readSwaps(db);
  } finally {
    db.close();
  }
  const unfinished = records.filter((r) => !isFinalLegacySwap(r)).map((r) => String(r.id ?? "?"));
  if (unfinished.length > 0) {
    log.warn(
      `[ArkadeAdapter] Kept ${LEGACY_ARKADE_SWAPS_DB}: ${unfinished.length} unfinished Boltz swap(s) may hold funds in a VHTLC (${unfinished.join(", ")}).`,
    );
    return { status: "kept", unfinished };
  }
  await request(idb.deleteDatabase(LEGACY_ARKADE_SWAPS_DB));
  log.info(`[ArkadeAdapter] Deleted legacy ${LEGACY_ARKADE_SWAPS_DB} database`);
  return { status: "deleted" };
}

let once: Promise<LegacyArkadeSwapsCleanup> | null = null;

/**
 * Delete the legacy Boltz swap database unless it holds unfinished swaps. Runs
 * once per process; pass `idb` to target a specific factory (tests, workers).
 * Never throws: a failure is logged and reported as `unavailable`.
 */
export function cleanupLegacyArkadeSwapsDb(
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
): Promise<LegacyArkadeSwapsCleanup> {
  once ??= runCleanup(idb).catch((error: unknown) => {
    log.warn(`[ArkadeAdapter] Legacy ${LEGACY_ARKADE_SWAPS_DB} cleanup failed:`, error);
    return { status: "unavailable" } as const;
  });
  return once;
}

/** @internal Test hook: allow the one-time cleanup to run again. */
export function resetLegacyArkadeSwapsCleanup(): void {
  once = null;
}

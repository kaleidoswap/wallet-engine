/**
 * Integration-test configuration
 * ------------------------------
 * Live tests connecting real WDK adapters to real test networks with two pre-funded
 * wallets, Alice and Bob: SPARK on regtest, LIQUID on testnet, ARKADE and RGB_L1 on
 * mutinynet (signet).
 *
 * None of this runs in the default `npm test` — the suites live under
 * `test/integration/**` (excluded by vitest.config.ts) and only run via
 * `npm run test:integration`. Even then each suite SKIPS unless its
 * secrets/endpoints are present, so a missing `.env` never fails CI.
 *
 * Configure via env vars or `test/integration/.env`. Mnemonics have NO defaults and
 * are never committed.
 */

/** Read an env var, falling back to a default (or `undefined`). */
function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

/** True when an env var is set to a truthy value ('1', 'true', 'yes'). */
function flag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? '')
}

/** A pre-funded test wallet. */
export interface WalletFixture {
  readonly name: 'alice' | 'bob'
  /** BIP-39 mnemonic — supplied via env, never committed. */
  readonly mnemonic: string | undefined
}

export const ALICE: WalletFixture = { name: 'alice', mnemonic: env('ALICE_MNEMONIC') }
export const BOB: WalletFixture = { name: 'bob', mnemonic: env('BOB_MNEMONIC') }
export const WALLETS: readonly WalletFixture[] = [ALICE, BOB]

/** True once both Alice and Bob have a mnemonic — the gate for every suite. */
export const HAVE_WALLETS = Boolean(ALICE.mnemonic && BOB.mnemonic)

/**
 * Send/transfer tests move real (test-network) funds and are slow + stateful, so
 * they stay OFF unless opted in with `RUN_SEND_TESTS=1`.
 */
export const RUN_SEND_TESTS = flag('RUN_SEND_TESTS')

// Per-protocol network + endpoint config. Endpoints default to public servers for
// the target test network; override any of them via env.

export const SPARK = {
  /** Spark runs on regtest for these tests (no extra endpoints needed). */
  network: 'regtest' as const,
  enabled: HAVE_WALLETS && !flag('SKIP_SPARK'),
}

export const LIQUID = {
  network: 'testnet' as const,
  /**
   * Waterfalls quick-sync by default — one request, versus a ~40-request gap-limit
   * scan that gets rate-limited by the public blockstream esplora, triggering
   * lwk_node's backoff sleep (a browser-only API that throws under Node). Override
   * with LIQUID_ESPLORA_URL; disable via LIQUID_WATERFALLS=0.
   */
  esploraUrl: env('LIQUID_ESPLORA_URL', 'https://waterfalls.liquidwebwallet.org/liquidtestnet/api')!,
  waterfalls: !/^(0|false|no)$/i.test(process.env.LIQUID_WATERFALLS?.trim() ?? ''),
  enabled: HAVE_WALLETS && !flag('SKIP_LIQUID'),
}

export const ARKADE = {
  /** Mutinynet is a custom signet — the adapter's network key is 'signet'. */
  network: 'signet' as const,
  arkServerUrl: env('ARKADE_SERVER_URL', 'https://mutinynet.arkade.sh')!,
  esploraUrl: env('ARKADE_ESPLORA_URL', 'https://mutinynet.com/api')!,
  delegatorUrl: env('ARKADE_DELEGATOR_URL', 'https://delegator.mutinynet.arkade.sh')!,
  enabled: HAVE_WALLETS && !flag('SKIP_ARKADE'),
}

export const RGB_L1 = {
  /** rgb-lib on mutinynet — surfaced to rgb-lib as its custom signet. */
  network: 'signet' as const,
  /** Electrum/Esplora indexer rgb-lib syncs against. */
  indexerUrl: env('RGB_INDEXER_URL', 'https://mutinynet.com/api')!,
  /** RGB proxy (RGB HTTP JSON-RPC transport) for consignment exchange. */
  transportEndpoint: env('RGB_TRANSPORT_ENDPOINT', 'rpcs://proxy.iriswallet.com/0.2/json-rpc')!,
  enabled: HAVE_WALLETS && !flag('SKIP_RGB_L1'),
}

/**
 * Per-wallet on-disk data directory for the stateful rgb-lib wallet, under the OS
 * temp dir keyed by wallet name so Alice and Bob never share state.
 */
export function rgbDataDir(wallet: WalletFixture): string {
  const base = env('RGB_DATA_DIR', `${process.env.TMPDIR ?? '/tmp'}/wallet-engine-it/rgb`)!
  return `${base}/${wallet.name}`
}

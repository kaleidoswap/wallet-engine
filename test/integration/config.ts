/**
 * Integration-test configuration
 * ------------------------------
 * These are *live* tests that connect real WDK adapters to real test networks
 * using two pre-funded wallets, **Alice** and **Bob**:
 *
 *   | Protocol | Network            | Backing adapter        |
 *   |----------|--------------------|------------------------|
 *   | SPARK    | regtest            | SparkWdkAdapter        |
 *   | LIQUID   | testnet            | LiquidWdkAdapter       |
 *   | ARKADE   | mutinynet (signet) | ArkadeWdkAdapter       |
 *   | RGB_L1   | mutinynet (signet) | RgbLibWdkAdapter       |
 *
 * Nothing here runs in the default `npm test` unit run — the suites live under
 * `test/integration/**` (excluded by `vitest.config.ts`) and only run via
 * `npm run test:integration`. Even then, each suite SKIPS unless the required
 * secrets/endpoints are present, so a missing `.env` never fails CI.
 *
 * Configure by exporting env vars or filling in `test/integration/.env`
 * (see `.env.example`). Mnemonics have NO defaults and are never committed —
 * without them every suite skips.
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
 * Send/transfer tests move real (test-network) funds and are slow + stateful,
 * so they stay OFF unless explicitly opted in with `RUN_SEND_TESTS=1`.
 */
export const RUN_SEND_TESTS = flag('RUN_SEND_TESTS')

// ---------------------------------------------------------------------------
// Per-protocol network + endpoint config. Endpoints have sensible public
// defaults for the target test network; override any of them via env if the
// public endpoint moves or you run your own.
// ---------------------------------------------------------------------------

export const SPARK = {
  /** Spark runs on regtest for these tests (no extra endpoints needed). */
  network: 'regtest' as const,
  enabled: HAVE_WALLETS && !flag('SKIP_SPARK'),
}

export const LIQUID = {
  network: 'testnet' as const,
  /** Liquid testnet Esplora. */
  esploraUrl: env('LIQUID_ESPLORA_URL', 'https://blockstream.info/liquidtestnet/api')!,
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
 * Per-wallet on-disk data directory for the stateful rgb-lib wallet. Kept under
 * the OS temp dir keyed by wallet name so Alice and Bob never share state.
 */
export function rgbDataDir(wallet: WalletFixture): string {
  const base = env('RGB_DATA_DIR', `${process.env.TMPDIR ?? '/tmp'}/wallet-engine-it/rgb`)!
  return `${base}/${wallet.name}`
}

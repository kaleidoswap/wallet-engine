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

/** True unless an env var is explicitly set to a falsy value ('0', 'false', 'no'). */
function flagUnlessOff(name: string): boolean {
  return !/^(0|false|no)$/i.test(process.env[name]?.trim() ?? '')
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

/**
 * After a send test, send the same amount back the way it came.
 *
 * Every send test is one-directional — Alice pays Bob — so each run moves sats
 * that never come back. Alice is the only wallet that ever pays, so Alice is
 * the only wallet that ever empties, and she empties on a schedule set by how
 * often CI runs. That is the drain behind #77: the suite spent its own
 * preconditions, and the skips and dispatch inputs added since report the
 * shortfall honestly without slowing it down.
 *
 * A return leg makes a run cost two fees instead of a hundred sats, which is
 * the difference between a wallet that needs a faucet every few weeks and one
 * that lasts. It runs in `afterAll`, only when a send actually happened, and
 * never fails the suite: a failed return is a funding fact for the next run,
 * not a broken adapter.
 *
 * Set `RETURN_TEST_FUNDS=0` to keep the sats where the test left them — when
 * you are deliberately moving balance from one wallet to the other, or
 * debugging a send and want its effect to persist.
 */
export const RETURN_TEST_FUNDS = flagUnlessOff('RETURN_TEST_FUNDS')

/**
 * Treat an underfunded wallet as a failure rather than a skip.
 *
 * The send tests spend from shared wallets that drain, and a drained wallet is
 * not a regression — but it used to fail the job exactly as loudly as a broken
 * transfer, which left `Live integration` red on `main` from 2026-09-08 and on
 * every PR touching `src/**` regardless of its diff (#77). A check that is
 * always red reports nothing, and the drift this suite exists to catch gets
 * waved through with it.
 *
 * So the default is: skip the send, say why, and let the rest of the suite
 * speak. Set this when the answer to "are the wallets funded?" is the question
 * being asked — a deliberate dispatch before a release, or a funding check —
 * and a short wallet fails the job again.
 */
export const REQUIRE_FUNDED_WALLETS = flag('REQUIRE_FUNDED_WALLETS')

/**
 * Treat an unreachable test-network endpoint as a failure rather than a skip.
 *
 * The sibling of `REQUIRE_FUNDED_WALLETS`, for the other thing that is not our
 * code: these suites connect to public mutinynet, liquidtestnet and regtest
 * services, and when one of them is down every test behind it fails at
 * `beforeAll` — which reads as "the adapter is broken" and turns the job red
 * for a reason no diff can fix.
 *
 * Default is to skip that suite and let the others report. Set this when
 * endpoint availability is the thing being tested, or in a run whose whole
 * purpose is to prove the live surface is reachable.
 */
export const REQUIRE_LIVE_ENDPOINTS = flag('REQUIRE_LIVE_ENDPOINTS')

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

/**
 * Mutinynet indexer, shared by the Arkade and RGB-L1 suites.
 *
 * Ours, not the public `https://mutinynet.com/api`, which answers CI with a
 * plain nginx 429: our GitLab and GitHub runners share one box, so a single
 * egress IP makes everyone's requests and the limit arrives long before any one
 * suite is unreasonable. It reads as an outage — `@utexo/rgb-sdk` reports every
 * `goOnline` failure as "Failed to establish online connection" — and the RGB-L1
 * red went unread for weeks on that description while the endpoint answered in
 * 240ms from anywhere else.
 *
 * `esplora.signet.kaleidoswap.com` is the same chain, not a similar one: it is
 * MutinyWallet/electrs `new-index` with `--signet-magic`, the only esplora build
 * that indexes Mutinynet's custom signet, and it tracks the public one tip for
 * tip and hash for hash. Same reasoning as the Liquid waterfalls default above:
 * an endpoint someone else rate-limits is not a dependency a suite can hold.
 *
 * Override per consumer with `ARKADE_ESPLORA_URL` / `RGB_INDEXER_URL`.
 */
const MUTINYNET_ESPLORA = env('MUTINYNET_ESPLORA_URL', 'https://esplora.signet.kaleidoswap.com')!

export const ARKADE = {
  /** Mutinynet is a custom signet — the adapter's network key is 'signet'. */
  network: 'signet' as const,
  arkServerUrl: env('ARKADE_SERVER_URL', 'https://mutinynet.arkade.sh')!,
  /** Ours — see MUTINYNET_ESPLORA. */
  esploraUrl: env('ARKADE_ESPLORA_URL', MUTINYNET_ESPLORA)!,
  delegatorUrl: env('ARKADE_DELEGATOR_URL', 'https://delegator.mutinynet.arkade.sh')!,
  enabled: HAVE_WALLETS && !flag('SKIP_ARKADE'),
}

export const RGB_L1 = {
  /** rgb-lib on mutinynet — surfaced to rgb-lib as its custom signet. */
  network: 'signet' as const,
  /** Electrum/Esplora indexer rgb-lib syncs against — ours, see MUTINYNET_ESPLORA. */
  indexerUrl: env('RGB_INDEXER_URL', MUTINYNET_ESPLORA)!,
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

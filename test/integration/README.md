# Integration tests — Alice & Bob on live test networks

These are **live** tests: they connect the real WDK adapters to real test
networks using two pre-funded wallets, **Alice** and **Bob**.

| Protocol | Network            | Adapter            |
|----------|--------------------|--------------------|
| SPARK    | regtest            | `SparkWdkAdapter`  |
| LIQUID   | testnet            | `LiquidWdkAdapter` |
| ARKADE   | mutinynet (signet) | `ArkadeWdkAdapter` |
| RGB_L1   | mutinynet (signet) | `RgbLibWdkAdapter` |

They are **excluded from `npm test`** (the unit CI) and run only via a separate
config. Each suite also **self-skips** unless the required secrets are present,
so nothing here can break CI when unconfigured.

## Running

```bash
cp test/integration/.env.example test/integration/.env
#   … fill in ALICE_MNEMONIC and BOB_MNEMONIC (test funds only) …
npm run test:integration
```

Without `ALICE_MNEMONIC` + `BOB_MNEMONIC`, every suite reports as skipped.

### What runs

- **Read paths (default):** connect both wallets, assert each is **funded** on
  its network, and check assets / receive addresses. Safe and idempotent.
- **Send paths (opt-in):** Alice→Bob transfers move real test-network funds and
  are OFF unless you set `RUN_SEND_TESTS=1`.

### The sats come back

Every send test runs one way — Alice pays Bob — so before this each run left
Alice short by the amount plus a fee and Bob up by the amount. Alice is the only
wallet that ever pays, so Alice is the only wallet that ever empties, on a
schedule set by how often CI runs. The suite was spending its own preconditions.

Teardown now sends the same amount back, which makes a run cost the two fees it
genuinely spent rather than a wallet. It runs only when a send actually
happened, after the assertions have reported, and it never fails the suite: a
return that does not go through is a funding fact for the next run to surface,
not evidence about the adapter. `RETURN_TEST_FUNDS=0` leaves the balance where
the test put it.

The return leg is not enough on Arkade on its own — see below.

### Arkade: settle before the batch expires

Arkade VTXOs live in a batch with an expiry, and a VTXO that is not settled
before it lapses is swept by the server. On 2026-09-08 that is what happened to
these wallets: Bob's Arkade balance was 76 VTXOs of 100 sat — one per send test
ever run — and every one of them reads `swept`, which is why his spendable
balance is 0 while his total is not. Alice's single 1,422,628-sat VTXO passed
the same expiry.

The SDK settles periodically by itself, and for these wallets that settle is
throwing (`Error during periodic settle: invalid scalar: out of range`, visible
in any run's stderr) so nothing is renewed. Until that is fixed, Arkade funds
here have a shelf life, and a returned 100 sat expires as surely as a sent one.

Both wallets also hold ~1.59M sat in **confirmed boarding UTXOs that were never
onboarded**. Those are on-chain and safe, and they are also invisible to
`spendable` — which is the other reason a send can report `Insufficient funds`
against a healthy-looking total.

### When a wallet runs dry

A send test whose wallet cannot cover the amount plus a fee buffer **skips**,
printing the wallet, the shortfall and what to do about it. It does not fail.

These wallets drain — that is what spending from them means — and a drained
wallet is a funding fact, not a regression. Failing on it made `Live
integration` red on `main` for three days and red on every PR touching
`src/**` whatever the diff (#77); a check that is always red is a check nobody
reads. The read-only assertions still run, so drift still turns the job red on
its own.

Set `REQUIRE_FUNDED_WALLETS=1` when the funding level is the thing you are
checking, and a short wallet fails again. The Integration workflow exposes it
as the `require_funded` dispatch input.

This covers both places the shortfall can surface. The balance precondition
runs first, but a wallet's reported balance and what its coin selection can
actually assemble are different numbers — VTXO granularity, preconfirmed
outputs and the real fee are invisible in a total — so a send that gets past
the precondition and still comes back `Insufficient funds` skips on the same
terms. A send error that is *not* about funds still fails.

### When a network is down

A suite whose `beforeAll` cannot connect **skips its tests one by one**, naming
the endpoint and the error, rather than failing the file. The other suites
carry on reporting.

The reasoning is the same as for drained wallets: mutinynet, liquidtestnet and
the regtest server are not ours, and a red that says "adapter broken" when the
truth is "the indexer is down" cannot be cleared by any diff. Only *setup* is
covered — an error inside a test is still a failure, because by then the
connection worked and what broke is what the test was exercising.

`REQUIRE_LIVE_ENDPOINTS=1` fails instead, exposed as the `require_endpoints`
dispatch input.

Note that a zero **spendable** balance is not always an empty wallet: on Arkade,
boarding UTXOs that were never onboarded read as 0 spendable while the funds are
there. Check before sending sats — the fix may be an onboard, not a faucet.

### The Mutinynet indexer is ours

Both the Arkade and RGB-L1 suites default to `https://esplora.signet.kaleidoswap.com`,
not the public `https://mutinynet.com/api`. The public one answers CI with a
plain nginx **429**: our GitLab and GitHub runners share a box, so one egress IP
carries everyone's requests. `@utexo/rgb-sdk` renders any `goOnline` failure as
`Failed to establish online connection`, so that rate limit was indistinguishable
from an outage and the RGB-L1 red went unread for weeks — the suite now prints
the whole `cause` chain, which is how it surfaced.

Ours is the same chain, not a similar one: MutinyWallet/electrs `new-index` with
`--signet-magic`, the only esplora build that indexes Mutinynet's custom signet.
Override with `MUTINYNET_ESPLORA_URL`, or per consumer with `ARKADE_ESPLORA_URL`
/ `RGB_INDEXER_URL`.

### RGB-L1 state is not derivable from the seed

rgb-lib keeps its wallet in SQLite under `RGB_DATA_DIR`, and which assets a
wallet holds is known **only** to that database — a seed does not reconstruct
it. Delete the directory and the wallet forgets its assets, though the coins
themselves are still on-chain.

That matters for the issuance test, which reuses an asset either wallet already
holds and issues only when neither does. A local run with a persistent
`RGB_DATA_DIR` reuses; CI, whose data directory is ephemeral, issues a fresh
asset each run. That costs one colorable UTXO and an on-chain fee per run —
a few hundred signet sats against the ~1.59M each wallet holds, so thousands
of runs — and the assets do not accumulate anywhere, because the database they
are recorded in does not survive the runner.

**Do not cache the CI data directory to avoid that.** It was tried, and it
breaks the suite outright: the cached database is authoritative about which
UTXOs the wallet owns, any other instance of the same seed spends some of
them, and the next restore fails `goOnline` with

```
RgbLib(Inconsistency { details: "spent bitcoins with another wallet: [...]" })
```

An RGB database can only be shared by instances that are the sole users of
their seed, which a test wallet run from CI and from laptops is not. `goOnline`
takes a skip-consistency-check flag; suppressing this particular check would be
hiding a real accounting disagreement about spent coins.

`RGB_FORCE_ISSUANCE=1` issues regardless, for a run whose point is issuance.

### Colorable UTXOs, and the two receive modes

rgb-lib runs `maxAllocationsPerUtxo: 1` here, so each allocation occupies a
whole colorable UTXO. Who needs one depends on the receive mode:

| | sender | recipient |
|---|---|---|
| **blinded** receive | 1 (for the change) | 1 (to receive into) |
| **witness** receive | 1 (for the change) | **0** — the sender creates the output |

Witness receive is therefore the mode that works for a wallet that has never
held RGB, and the suite covers both.

`createRgbUtxos` **broadcasts a transaction**, and its outputs do not exist for
the wallet until that transaction confirms. Creating one and immediately
sending fails with `InsufficientAllocationSlots` — which reads like a broken
transfer and means "the UTXO I just asked for has not arrived". `ensureColorableSlots`
creates and then polls until the slots are real, and the suite prepares both
wallets early so confirmation has the rest of the file to happen in.

This is the failure mode to expect from RGB tests generally: whether a wallet
has a spare slot depends on what earlier runs left **on-chain**, which outlives
the ephemeral rgb-lib database. The same commit can pass or fail depending on
which run went first, so preconditions here wait rather than assume.

Reuse keys off what a wallet **holds** (`total`), not what it can spend
(`available`). They differ: after a transfer the sender's change allocation is
unconfirmed, so `available` reads 0 against a `total` of nearly the whole
supply. The transfer test skips on that shortfall the way the BTC suites skip a
drained wallet, and `sendOrSkip` catches rgb-lib's own `InsufficientAssignments`
refusal when the precondition is too optimistic.

### Skipping a protocol

Set `SKIP_SPARK=1`, `SKIP_LIQUID=1`, `SKIP_ARKADE=1`, or `SKIP_RGB_L1=1` to skip
that suite (e.g. when its funds ran dry or an endpoint is down).

## Funding the wallets

The wallets must already hold a positive balance on each network before the
funded assertions pass:

- **Spark regtest** — fund via your Spark regtest faucet/gateway.
- **Liquid testnet** — L-BTC from a Liquid testnet faucet.
- **Arkade mutinynet** — board sats from the Mutinynet faucet into the boarding
  address, then onboard to Arkade.
- **RGB-L1 mutinynet** — send Mutinynet signet BTC to the wallet's on-chain
  address (rgb-lib needs vanilla sats to create colorable UTXOs).

> **RGB-L1 install note:** the RGB-L1 suite loads `@utexo/wdk-wallet-rgb`
> (an optional dependency), which is a **native** rgb-lib addon. Install with
> build scripts enabled (a normal `pnpm install` / `npm install` — *not*
> `--ignore-scripts`) and a C toolchain present, or the module resolves but
> fails at runtime with `Cannot find module './build/Release/rgblib'`.

Endpoints have public defaults for each test network; override any of them in
`.env` if a public endpoint moves or you run your own (see `.env.example`).

## Security

- `test/integration/.env` is git-ignored — **never commit mnemonics**, even
  test ones.
- Use throwaway, **test-network-only** seeds. Never a mainnet mnemonic.
- rgb-lib persists SQLite wallet state under `RGB_DATA_DIR` (also git-ignored).

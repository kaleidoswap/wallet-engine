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

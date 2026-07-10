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

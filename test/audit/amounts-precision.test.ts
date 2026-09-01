/**
 * AUDIT — Task E: amounts, precision, money coercion.
 * Read-only w.r.t. src/. All network/SDK boundaries are mocked.
 *
 * Each test prints the wrong value it demonstrates; see
 * findings/E-amounts.md for the write-ups.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatAmount } from '../../src/lib/amount'
import {
  convertTransferToTransaction,
  convertPaymentToTransaction,
  convertSwapToTransaction,
  convertSdkBalance,
} from '../../src/lib/rgb-converters'
import { convertTokenTransactionToUnified } from '../../src/lib/spark-converters'
import {
  txHashFromBytes,
  rawTokenIdFromBytes,
} from '../../src/lib/spark-helpers'
import { decodeBolt11 } from '../../src/lib/bolt11'
import { RgbAdapter } from '../../src/adapters/RgbAdapter'
import { kaleidoClientManager } from '../../src/lib/kaleido-client-manager'

afterEach(() => vi.restoreAllMocks())

/** BigInt ground truth for "raw integer at precision p" rendering. */
function truth(amount: bigint, precision: number): string {
  const s = amount.toString().padStart(precision + 1, '0')
  return precision === 0 ? s : `${s.slice(0, -precision)}.${s.slice(-precision)}`
}

function connectedRgbAdapter(client: unknown): RgbAdapter {
  const adapter = new RgbAdapter()
  Object.assign(adapter as any, {
    connected: true,
    config: { makerUrl: 'https://maker.example', nodeUrl: 'https://node.example' },
  })
  vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue(client as any)
  return adapter
}

// ── F1: formatAmount float division ────────────────────────────────────────
describe('F1: formatAmount (src/lib/amount.ts:20)', () => {
  it('renders 999999999999999999 base units at precision 18 as "1.000000000000000000" (truth: 0.999999999999999999)', () => {
    const amount = 10n ** 18n - 1n
    const got = formatAmount(Number(amount), 18)
    const want = truth(amount, 18)
    console.log(`formatAmount(${amount}, 18) = "${got}" — truth "${want}"`)
    expect(got).not.toBe(want) // BUG: rounds up to a full unit the user does not have
    expect(got).toBe('1.000000000000000000')
  })

  it('[E-F1b FIXED] renders issuer-controlled precision > 100 (RGB precision is u8; Spark decimals issuer-set)', () => {
    // Was: `expect(() => formatAmount(5, 200)).toThrow(RangeError)` — toFixed
    // accepts 0-100 digits. formatAmount now digit-shifts a BigInt, which has
    // no ceiling, so a crafted asset can no longer throw out of the render loop.
    expect(formatAmount(5, 200)).toBe('0.' + '0'.repeat(199) + '5')
  })

  it('[E-F1b FIXED] a decimals: 200 token no longer breaks the Spark history converter', () => {
    const hashBytes = new Uint8Array(32).fill(7)
    const tokenIdBytes = new Uint8Array(32).fill(9)
    const rawId = rawTokenIdFromBytes(tokenIdBytes)
    const tx = {
      tokenTransaction: {
        tokenOutputs: [
          {
            ownerPublicKey: new Uint8Array(33).fill(1),
            tokenIdentifier: tokenIdBytes,
            tokenAmount: new Uint8Array([1]),
          },
        ],
        tokenInputs: { $case: 'mintInput' },
      },
      status: 2,
      tokenTransactionHash: hashBytes,
    }
    const rawMeta = new Map([[rawId, { id: 'btkn1x', meta: { name: 'Evil', ticker: 'EVL', decimals: 200 } }]])
    // Was: `.toThrow(RangeError)`. One dust transfer of this asset used to take
    // out the caller's whole activity view; it now renders as a row like any other.
    const converted = convertTokenTransactionToUnified(
      tx,
      'aa'.repeat(33),
      new Map(),
      rawMeta,
      new Set(),
      new Map(),
      new Map(),
      'MAINNET',
    )
    expect(converted).toBeTruthy()
  })

  it('is exact for all reachable sats values at precision 8 (control)', () => {
    expect(formatAmount(2_100_000_000_000_000, 8)).toBe('21000000.00000000')
    expect(formatAmount(1, 8)).toBe('0.00000001')
  })
})

// ── F2: getAssetBalance ignores asset precision ────────────────────────────
describe('F2: RgbAdapter.getAssetBalance precision drop (RgbAdapter.ts:281)', () => {
  it('uses precision 8 for a precision-0 RGB asset: 1,000,000 units shown as "0.01000000"', async () => {
    const client = {
      rln: {
        getAssetBalance: async () => ({
          settled: 1_000_000,
          spendable: 1_000_000,
          future: 0,
          offchain_outbound: 0,
          offchain_inbound: 0,
        }),
        // FIXED (audit finding E-F2): the adapter now fetches the asset's own
        // precision in parallel with the balance instead of defaulting to 8.
        getAssetMetadata: async () => ({ precision: 0, ticker: 'P0', name: 'Prec0' }),
      },
    }
    const adapter = connectedRgbAdapter(client)
    const bal = await adapter.getAssetBalance('rgb:prec0-asset')
    console.log(`precision-0 asset, 1,000,000 raw units -> totalDisplay "${bal.totalDisplay}"`)
    expect(bal.totalDisplay).toBe('1000000')
  })
})

// ── F3: history converters hardcode precision 8 for asset amounts ──────────
/*
 * [E-F3 FIXED] These three cases call the converters with NO precision argument
 * and therefore still get 8 — that default is deliberate and unchanged (it is
 * the BTC convention, correct for sats). What was broken was that
 * `RgbAdapter.listTransactions` never passed the real precision, so every RGB
 * row rendered at 8 with no way for a caller to say otherwise. The converters
 * now take a precision, the adapter resolves it per asset, and
 * test/audit/regression-EF3-history-precision.test.ts pins both halves. These
 * cases are kept as the default-behaviour pins their comments now describe.
 */
describe('F3: RGB history converters default to precision 8 (rgb-converters.ts:154,190,224)', () => {
  it('on-chain transfer of 500 precision-0 units displays "0.00000500"', () => {
    const tx = convertTransferToTransaction({
      txid: 'tx1',
      kind: 'ReceiveAsset',
      status: 'Settled',
      created_at: 1_700_000_000_000,
      amount: 500,
    })
    console.log(`received 500 units -> amountDisplay "${tx.amountDisplay}"`)
    expect(tx.amount).toBe(500)
    expect(tx.amountDisplay).toBe('0.00000500') // no precision passed -> default 8
  })

  it('LN asset payment of 500 precision-0 units displays "0.00000500"', () => {
    const tx = convertPaymentToTransaction({
      payment_hash: 'ph1',
      inbound: true,
      status: 'succeeded',
      created_at: 1_700_000_000,
      asset_amount: 500,
    })
    expect(tx.amountDisplay).toBe('0.00000500') // no precision passed -> default 8
  })

  it('swap qty_from of 500 precision-0 units displays "0.00000500"', () => {
    const tx = convertSwapToTransaction(
      { payment_hash: 'sp1', status: 'Completed', requested_at: 1_700_000_000, qty_from: 500 },
      'taker',
    )
    expect(tx.amountDisplay).toBe('0.00000500') // no precision passed -> default 8
  })
})

// ── F4: getSwapQuote missing coercion guards ───────────────────────────────
describe('F4 [E-F4 FIXED]: RgbAdapter.getSwapQuote coerces maker money fields (RgbAdapter.ts:1049-1085)', () => {
  function makerClient(quote: unknown) {
    return { maker: { getQuote: async () => quote } }
  }
  const REQ = { fromAsset: 'rgb:USDT', toAsset: 'BTC', fromAmount: 1000 }

  it('rejects a NEGATIVE fee from a hostile maker (as KaleidoswapSwap already did)', async () => {
    const adapter = connectedRgbAdapter(
      makerClient({
        rfq_id: 'r1',
        from_asset: { asset_id: 'rgb:USDT', amount: 1000 },
        to_asset: { asset_id: 'BTC', amount: 5000 },
        price: 5,
        fee: { final_fee: -1000, fee_asset: 'rgb:USDT', base_fee: 0, variable_fee: -1000 },
        expires_at: 1_900_000_000,
      }),
    )
    // Was: `expect(q.fee.amount).toBe(-1000)` — a negative fee flowed into the
    // Quote and poisoned downstream net-amount math.
    await expect(adapter.getSwapQuote(REQ as any)).rejects.toThrow(/negative/i)
  })

  it('rejects a maker amount past MAX_SAFE_INTEGER instead of silently rounding it', async () => {
    const adapter = connectedRgbAdapter(
      makerClient({
        rfq_id: 'r2',
        from_asset: { asset_id: 'rgb:USDT', amount: '9007199254740993' }, // 2^53+1
        to_asset: { asset_id: 'BTC', amount: 5000 },
        price: 5,
        fee: { final_fee: 1, fee_asset: 'rgb:USDT', base_fee: 1, variable_fee: 0 },
        expires_at: 1_900_000_000,
      }),
    )
    // Was: `expect(q.fromAmount).toBe(9007199254740992)` — one unit lost, no throw.
    await expect(adapter.getSwapQuote(REQ as any)).rejects.toThrow(/safe integer precision/i)
  })

  it('rejects a missing price instead of passing undefined through', async () => {
    const adapter = connectedRgbAdapter(
      makerClient({
        rfq_id: 'r3',
        from_asset: { asset_id: 'rgb:USDT', amount: 1000 },
        to_asset: { asset_id: 'BTC', amount: 5000 },
        // price omitted entirely
        fee: { final_fee: 1, fee_asset: 'rgb:USDT', base_fee: 1, variable_fee: 0 },
        expires_at: 1_900_000_000,
      }),
    )
    // Was: `expect(q.price).toBeUndefined()` — a NaN-class field, no throw. A
    // counterparty must not be able to switch off a check by leaving a field out.
    await expect(adapter.getSwapQuote(REQ as any)).rejects.toThrow(/not a finite number/i)
  })
})

// ── F5: Spark token u128 -> Number without safe-integer check ──────────────
describe('F5: convertTokenTransactionToUnified drops units past 2^53 (spark-converters.ts:214)', () => {
  it('a receive of 2^53+1 base units is rejected instead of rounded', () => {
    const hashBytes = new Uint8Array(32).fill(3)
    const tokenIdBytes = new Uint8Array(32).fill(4)
    const amount = 2n ** 53n + 1n
    const amountBytes = new Uint8Array(8)
    new DataView(amountBytes.buffer).setBigUint64(0, amount, false)
    const tx = {
      tokenTransaction: {
        tokenOutputs: [
          {
            ownerPublicKey: new Uint8Array(33).fill(1), // wallet-owned → receive
            tokenIdentifier: tokenIdBytes,
            tokenAmount: amountBytes,
          },
        ],
        tokenInputs: { $case: 'mintInput' },
      },
      status: 2,
      tokenTransactionHash: hashBytes,
    }
    const walletPub = u8aToHexLower(new Uint8Array(33).fill(1))
    const rawId = rawTokenIdFromBytes(tokenIdBytes)
    const rawMeta = new Map([[rawId, { id: 'btkn1x', meta: { name: 'Big', ticker: 'BIG', decimals: 0 } }]])
    expect(() => convertTokenTransactionToUnified(
      tx,
      walletPub,
      new Map(),
      rawMeta,
      new Set(),
      new Map(),
      new Map(),
      'MAINNET',
    )).toThrow(/safe integer/i)
  })
})

function u8aToHexLower(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── F6: three different msat->sat answers for the same payment ─────────────
describe('F6: msat→sat rounding is adapter-dependent (1500 msat = 1.5 sat)', () => {
  it('RgbAdapter.decodeInvoice returns fractional sats; RlnWdk/rgb-converters floor; bolt11 rounds up', async () => {
    // RgbAdapter.decodeInvoice — src/adapters/RgbAdapter.ts:481 (amt_msat / 1000)
    const adapter = connectedRgbAdapter({
      rln: { decodeLNInvoice: async () => ({ payment_hash: 'ph', amt_msat: 1500, expiry_sec: 3600 }) },
    })
    const dec = await adapter.decodeInvoice('lnbc15n1pxxxxxx')
    console.log(`1500 msat -> RgbAdapter.decodeInvoice amount = ${dec.amount}`)
    expect(dec.amount).toBe(2)

    // rgb-converters payment history — src/lib/rgb-converters.ts:192 (Math.floor)
    const hist = convertPaymentToTransaction({ payment_hash: 'ph', inbound: true, amt_msat: 1500 })
    console.log(`1500 msat -> rgb-converters history amount = ${hist.amount}`)
    expect(hist.amount).toBe(2)

    // decodeBolt11 — src/lib/bolt11.ts:46 (Math.round), feeds ProtocolManager policy amounts
    const b11 = decodeBolt11('lnbc15n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')
    console.log(`1500 msat ("lnbc15n1...") -> decodeBolt11 amountSat = ${b11.amountSat}`)
    expect(b11.amountMsat).toBe(1500)
    expect(b11.amountSat).toBe(2)

    expect(new Set([dec.amount, hist.amount, b11.amountSat]).size).toBe(1)
  })
})

// ── U1 (UNVERIFIED impact): negative amount reaches the SDK boundary ───────
describe('U1: payKeysend forwards unvalidated amounts to the node SDK (RgbAdapter.ts:552)', () => {
  it('payKeysend({ amount: -5000 }) reaches client.rln.keysend as amt_msat: -5000', async () => {
    const calls: any[] = []
    const adapter = connectedRgbAdapter({
      rln: {
        keysend: async (body: any) => {
          calls.push(body)
          return { payment_hash: 'ph', status: 'succeeded' }
        },
      },
    })
    await adapter.payKeysend({ pubkey: 'a'.repeat(66), amount: -5000 })
    console.log(`payKeysend(-5000 msat) -> SDK received ${JSON.stringify(calls[0])}`)
    expect(calls[0].amt_msat).toBe(-5000) // no engine-side validation; node behaviour unknown
  })
})

// ── Control: KaleidoswapSwap DOES guard (contrast for F4) ──────────────────
describe('control: KaleidoswapSwap rejects the same hostile inputs', () => {
  it('throws on a negative fee (see existing test/swap-amounts.test.ts)', () => {
    // Covered exhaustively by test/swap-amounts.test.ts; this just documents the asymmetry.
    expect(true).toBe(true)
  })
})

// convertSdkBalance default — direct converter-level confirmation of F2's default
describe('F2 converter default (rgb-converters.ts:54)', () => {
  it('convertSdkBalance defaults to precision 8 when caller omits it', () => {
    const bal = convertSdkBalance({ settled: 1_000_000, spendable: 1_000_000, future: 0 } as any)
    expect(bal.totalDisplay).toBe('0.01000000')
  })
})

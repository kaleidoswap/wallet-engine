import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BarkAdapter } from '../src/adapters/BarkAdapter'
import { barkClientManager, setBarkModuleLoader } from '../src/lib/bark-client-manager'
import type { BarkConfig } from '../src/types/bark'

/**
 * The bark bindings are a 7.4 MB wasm blob with an IndexedDB + `instanceof
 * Window` runtime; these tests drive the adapter against a fake module so the
 * mapping (and the traps the real bindings impose) stay pinned without it.
 */

const BALANCE = {
  spendableSats: 100_000,
  pendingInRoundSats: 25_000,
  pendingExitSats: 0,
  pendingLightningSendSats: 0,
  claimableLightningReceiveSats: 0,
  pendingBoardSats: 5_000,
}

// A real invoice from ark.signet.2nd.dev, so decoding is exercised for real.
const INVOICE =
  'lntbs10u1p4tplctsp56ctf30jgccvj0xlm8egpw4h4jjakdusmvaxsguunx237dfsp6vlqpp5gda3p6a96u5wvj0klg3ddnuzf65r249ygjk7arfh3su8ykhr8kxsdqqxqy9gcqcqzpc9qyysgqtr8rql6jgxz2e0kcyztaxux46038xw0y2gfgmsxrkvkc6yscdw655suwjzl04zhn02v2w9t0ncv0jlr80cyqzdamsddjqx35mtrvx5qq77snxn'
const PAYMENT_HASH = '437b10eba5d728e649f6fa22d6cf824ea83554a444adee8d378c38725ae33d8d'

// Real addresses: the first from a bark wallet on ark.signet.2nd.dev, the
// second minted by @arkade-os/sdk. Same `tark1` HRP, different payloads.
const BARK_ADDRESS =
  'tark1pem36wcfzqqpc0zgce9q3jqgnt3t7w54dz6gtzddt9awugjx25uduq7fnzvvvzvezqyp82sv47phqky46zwd44dfzy3m9uvqztvza9ljmnd583e7wztchvwqpjpewg'
const ARKADE_ADDRESS =
  'tark1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqscqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jq5f04nj'

function fakeWallet(overrides: Record<string, unknown> = {}) {
  return {
    free: vi.fn(),
    sync: vi.fn().mockResolvedValue(0),
    maintenance: vi.fn().mockResolvedValue(undefined),
    progressPendingRounds: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockResolvedValue(BALANCE),
    properties: vi.fn().mockResolvedValue({ network: 'Signet', fingerprint: '6cdd67f0' }),
    arkInfo: vi.fn().mockResolvedValue({
      serverPubkey: '03244a5a',
      roundIntervalSecs: 300,
      vtxoLifetime: 144,
      minBoardAmountSats: 10_000,
    }),
    newAddress: vi.fn().mockResolvedValue('tark1pem36wcfzqqp'),
    history: vi.fn().mockResolvedValue([]),
    bolt11Invoice: vi
      .fn()
      .mockResolvedValue({ invoice: INVOICE, paymentHash: PAYMENT_HASH, amountSats: 1000 }),
    payLightningInvoice: vi
      .fn()
      .mockResolvedValue({ type: 'paid', payment_hash: PAYMENT_HASH, preimage: 'de'.repeat(32) }),
    sendArkoorPayment: vi.fn().mockResolvedValue(undefined),
    sendOnchain: vi.fn().mockResolvedValue('txid-1'),
    broadcastTx: vi.fn().mockResolvedValue('txid-2'),
    getVtxosToRefresh: vi.fn().mockResolvedValue([]),
    pendingRoundStates: vi.fn().mockResolvedValue([]),
    listClaimableExits: vi.fn().mockResolvedValue([]),
    getNextRequiredRefreshBlockheight: vi.fn().mockResolvedValue(323_141),
    refreshVtxosDelegated: vi.fn().mockResolvedValue({ id: 2, state: 'delegated-pending' }),
    lightningSendState: vi.fn(),
    lightningReceiveState: vi.fn(),
    ...overrides,
  }
}

let wallet: ReturnType<typeof fakeWallet>
let open: ReturnType<typeof vi.fn>

const CONFIG: BarkConfig = {
  protocol: 'BARK',
  mnemonic: 'web east vintage debate frequent rapid sweet embrace mask curve pistol ivory',
  arkServerUrl: 'https://ark.signet.2nd.dev',
  esploraUrl: 'https://esplora.signet.2nd.dev',
  network: 'signet',
  dbName: 'bark-test',
}

beforeEach(() => {
  wallet = fakeWallet()
  open = vi.fn().mockResolvedValue(wallet)
  // bark's own validator, standing in for the wasm: it takes this Ark's
  // 75-byte payload and rejects Arkade's 65-byte one.
  setBarkModuleLoader(
    async () =>
      ({
        Wallet: { open },
        validateArkAddress: (address: string) => address === BARK_ADDRESS,
      }) as never,
  )
  // The real bindings need all three; assertBarkRuntime fails loudly without them.
  ;(globalThis as Record<string, unknown>).indexedDB ??= {}
  ;(globalThis as Record<string, unknown>).Window ??= globalThis.constructor
})

afterEach(async () => {
  await barkClientManager.dispose()
  vi.restoreAllMocks()
})

describe('BarkAdapter.connect', () => {
  it('opens with the daemon off and an explicit database name', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    expect(adapter.isConnected()).toBe(true)
    const [network, mnemonic, config, onchain, args] = open.mock.calls[0]
    expect(network).toBe('Signet')
    expect(mnemonic).toBe(CONFIG.mnemonic)
    expect(config.serverAddress).toBe(CONFIG.arkServerUrl)
    expect(onchain).toBeNull()
    // A long-lived daemon cannot survive a service worker; the host ticks.
    expect(args.runDaemon).toBe(false)
    // Wallet.open does NOT check the mnemonic against the stored database.
    expect(args.indexedDbName).toBe('bark-test')
  })

  it('maps mainnet onto the bindings string-literal network', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect({ ...CONFIG, network: 'mainnet' } as never)
    expect(open.mock.calls[0][0]).toBe('Bitcoin')
  })

  it('refuses a config with no seed or server', async () => {
    const adapter = new BarkAdapter()
    await expect(adapter.connect({ ...CONFIG, mnemonic: '' } as never)).rejects.toThrow(
      /recovery secret/i,
    )
    await expect(adapter.connect({ ...CONFIG, arkServerUrl: '' } as never)).rejects.toThrow(
      /arkServerUrl/i,
    )
  })

  it('names the missing Window alias instead of failing inside the wasm', async () => {
    const saved = (globalThis as Record<string, unknown>).Window
    delete (globalThis as Record<string, unknown>).Window
    try {
      const adapter = new BarkAdapter()
      await expect(adapter.connect(CONFIG as never)).rejects.toThrow(/instanceof Window/)
    } finally {
      ;(globalThis as Record<string, unknown>).Window = saved
    }
  })
})

describe('BarkAdapter balances', () => {
  it('reports a VTXO waiting on a round as pending, not spendable', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    const [btc] = await adapter.listAssets()
    expect(btc.id).toBe('BTC')
    expect(btc.layer).toBe('BTC_BARK')
    expect(btc.balance.available).toBe(100_000)
    expect(btc.balance.total).toBe(130_000)
    expect(btc.balance.pending).toBe(30_000)
    expect(btc.capabilities.supportsLightning).toBe(true)
    expect(btc.capabilities.canSwap).toBe(false)
  })
})

describe('BarkAdapter payments', () => {
  it('reads the paid variant`s snake_case payment_hash', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    const result = await adapter.sendPayment({ invoice: INVOICE })
    expect(result.paymentHash).toBe(PAYMENT_HASH)
    expect(result.status).toBe('confirmed')
    expect(wallet.payLightningInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: INVOICE, wait: true }),
    )
  })

  it('reports an in-progress send as pending, keyed by the invoice hash', async () => {
    wallet.payLightningInvoice.mockResolvedValue({ type: 'inProgress', send: {} })
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    const result = await adapter.sendPayment({ invoice: INVOICE })
    expect(result.status).toBe('pending')
    expect(result.paymentHash).toBe(PAYMENT_HASH)
  })

  it('routes a bark address to an arkoor payment and requires an amount', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    await expect(adapter.sendPayment({ invoice: BARK_ADDRESS })).rejects.toThrow(/amount/i)
    await adapter.sendPayment({ invoice: BARK_ADDRESS, amount: 2_000 })
    expect(wallet.sendArkoorPayment).toHaveBeenCalledWith(BARK_ADDRESS, 2_000)
  })

  it("refuses an Arkade address rather than sending it to this Ark's server", async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    // Same HRP, different Ark. Routing on the prefix would lose the money.
    await expect(
      adapter.sendPayment({ invoice: ARKADE_ADDRESS, amount: 2_000 }),
    ).rejects.toThrow(/Unsupported bark destination/)
    expect(wallet.sendArkoorPayment).not.toHaveBeenCalled()
  })

  it('rejects a destination that is neither bolt11 nor an ark address', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)
    await expect(
      adapter.sendPayment({ invoice: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }),
    ).rejects.toThrow(/Unsupported bark destination/)
  })
})

describe('barkClientManager.runMaintenance', () => {
  it('delegates the refresh so the round does not need this host alive', async () => {
    wallet.getVtxosToRefresh.mockResolvedValue([{ id: 'vtxo-1' }, { id: 'vtxo-2' }])
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    const report = await barkClientManager.runMaintenance()
    expect(wallet.sync).toHaveBeenCalled()
    expect(wallet.progressPendingRounds).toHaveBeenCalled()
    expect(wallet.refreshVtxosDelegated).toHaveBeenCalledWith(['vtxo-1', 'vtxo-2'])
    expect(report.refreshed).toEqual(['vtxo-1', 'vtxo-2'])
    expect(report.nextRequiredRefreshHeight).toBe(323_141)
  })

  it('skips the refresh when nothing is near expiry', async () => {
    const adapter = new BarkAdapter()
    await adapter.connect(CONFIG as never)

    const report = await barkClientManager.runMaintenance()
    expect(wallet.refreshVtxosDelegated).not.toHaveBeenCalled()
    expect(report.refreshed).toEqual([])
  })
})

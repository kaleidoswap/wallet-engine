import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { BarkReactNativeAdapter } from '../src/adapters/BarkReactNativeAdapter.js'
import { ProtocolManager } from '../src/manager/ProtocolManager.js'
import { ProtocolAdapterRegistry, asBarkOperations } from '../src/adapters/IProtocolAdapter.js'
import { CrossProtocolRouter } from '../src/router/index.js'
import { bolt11Fixture, TEST_PAYMENT_HASH, TEST_PREIMAGE } from './fixtures/bolt11.js'
import { BIP39_TEST_VECTOR_MNEMONIC } from './fixtures/mnemonics.js'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../src/backends/bark-native.js', () => ({ loadBarkNative: load }))
vi.mock('@secondts/bark', () => { throw new Error('Native adapter must not load browser WASM') })
const NOW = 1_800_000_000
const INVOICE = bolt11Fixture({ hrp: 'lntbs10u', timestamp: NOW })
const ADDRESS = 'bark-native-address'
const CONFIG = { protocol: 'BARK' as const, network: 'signet' as const, mnemonic: BIP39_TEST_VECTOR_MNEMONIC,
  arkServerUrl: 'https://ark.signet.2nd.dev', esploraUrl: 'https://esplora.signet.2nd.dev',
  dataDir: '/app/bark-adapter-test', createIfMissing: true }
const fee = { grossAmountSats: 1002n, netAmountSats: 1000n, feeSats: 2n, vtxosSpent: ['vtxo-1'] }
const movement = { id: 1, status: 'completed', subsystemName: 'lightning', subsystemKind: 'send',
  intendedBalanceSats: -1002n, effectiveBalanceSats: -1002n, offchainFeeSats: 2n,
  createdAt: '2027-01-15T08:00:00Z', completedAt: '2027-01-15T08:01:00Z',
  paymentHash: TEST_PAYMENT_HASH, lightningInvoice: INVOICE,
  sentToAddresses: [], receivedOnAddresses: [], inputVtxoIds: [], outputVtxoIds: [] }
function fixtures() {
  const onchain = {
    newAddress: vi.fn().mockResolvedValue('tb1ponchain'),
    balance: vi.fn().mockResolvedValue({ confirmedSats: 100n, pendingSats: 2n, totalSats: 102n }),
    sync: vi.fn().mockResolvedValue(0n), initialScan: vi.fn().mockResolvedValue(100n), uniffiDestroy: vi.fn(),
  }
  const wallet = {
    properties: vi.fn().mockResolvedValue({ network: 2, fingerprint: 'abc' }),
    recoveryStatus: vi.fn().mockReturnValue({ tag: 'NotRun' }),
    balance: vi.fn().mockResolvedValue({ spendableSats: 10000n, pendingInRoundSats: 0n, pendingExitSats: 0n,
      pendingLightningSendSats: 0n, claimableLightningReceiveSats: 0n, pendingBoardSats: 0n }),
    arkInfo: vi.fn().mockResolvedValue({ serverPubkey: 'pubkey', roundIntervalSecs: 300n, vtxoLifetime: 144,
      minBoardAmountSats: 1000n, requiredBoardConfirmations: 1 }),
    history: vi.fn().mockResolvedValue([movement]),
    newAddress: vi.fn().mockResolvedValue(ADDRESS), sync: vi.fn().mockResolvedValue(undefined),
    validateArkoorAddress: vi.fn().mockResolvedValue(true), sendArkoorPayment: vi.fn().mockResolvedValue(undefined),
    bolt11Invoice: vi.fn().mockResolvedValue({ invoice: INVOICE, paymentHash: TEST_PAYMENT_HASH, amountSats: 1000n }),
    payLightningInvoice: vi.fn().mockResolvedValue({ tag: 'Paid', inner: { paymentHash: TEST_PAYMENT_HASH, preimage: TEST_PREIMAGE } }),
    lightningSendState: vi.fn().mockResolvedValue({ tag: 'Unknown' }),
    lightningReceiveState: vi.fn().mockRejectedValue(new Error('unknown')),
    sendOnchain: vi.fn().mockResolvedValue('txid'), broadcastTx: vi.fn().mockResolvedValue('claim-txid'),
    boardFundingAddress: vi.fn().mockResolvedValue({ address: 'tb1pboard', expiryHeight: 1234, keypairIndex: 2 }),
    boardAmount: vi.fn().mockResolvedValue({ vtxoId: 'vtxo', amountSats: 1000n, txid: 'board' }),
    boardAll: vi.fn().mockResolvedValue({ vtxoId: 'vtxo', amountSats: 1000n, txid: 'board' }),
    pendingBoards: vi.fn().mockResolvedValue([{ vtxoId: 'vtxo', amountSats: 1000n, txid: 'board' }]),
    vtxos: vi.fn().mockResolvedValue([{ id: 'vtxo', amountSats: 1000n, state: { tag: 'Spendable' } }]),
    refreshVtxosDelegated: vi.fn().mockResolvedValue({ id: 3, state: 0 }),
    pendingRoundStates: vi.fn().mockResolvedValue([]), progressPendingRounds: vi.fn().mockResolvedValue(undefined),
    offboardVtxos: vi.fn().mockResolvedValue({ txid: 'offboard-tx' }),
    startExitForVtxos: vi.fn().mockResolvedValue(undefined),
    getExitVtxos: vi.fn().mockResolvedValue([{ vtxoId: 'vtxo', amountSats: 1000n, isClaimable: true }]),
    progressExits: vi.fn().mockResolvedValue([{ vtxoId: 'vtxo', state: { tag: 'Claimable', inner: { amount: 1000n } } }]),
    drainExits: vi.fn().mockResolvedValue({ psbtBase64: 'unsigned', feeSats: 10n }),
    signExitClaimInputs: vi.fn().mockResolvedValue('signed'),
    recoverVtxos: vi.fn().mockResolvedValue({ isComplete: false, failed: { totalSats: 100n, vtxoIds: ['vtxo'] } }),
    estimateArkoorPaymentFee: vi.fn().mockResolvedValue(fee),
    estimateLightningSendFee: vi.fn().mockResolvedValue(fee), estimateSendOnchainFee: vi.fn().mockResolvedValue(fee),
    stopDaemonWait: vi.fn().mockResolvedValue(undefined), uniffiDestroy: vi.fn(),
  }
  return { wallet, onchain, sdk: { Network: { Bitcoin: 0, Testnet: 1, Signet: 2, Regtest: 3 },
    Wallet: { open: vi.fn().mockResolvedValue(wallet) }, OnchainWallet: { default_: vi.fn().mockResolvedValue(onchain) },
    validateArkAddress: vi.fn((address: string) => address === ADDRESS), extractTxFromPsbt: vi.fn(() => 'signed-hex') } }
}
let f: ReturnType<typeof fixtures>
let adapter: BarkReactNativeAdapter
beforeEach(async () => {
  f = fixtures(); load.mockReset().mockResolvedValue(f.sdk)
  adapter = new BarkReactNativeAdapter({ runtime: { now: () => NOW * 1000 } })
  await adapter.connect(CONFIG)
})
afterEach(async () => { await adapter.disconnect() })

describe('native Bark adapter', () => {
  it('opens BDK and native Bark without browser APIs or implicit spending', async () => {
    expect(f.sdk.OnchainWallet.default_).toHaveBeenCalledWith(2, CONFIG.mnemonic, expect.anything(), CONFIG.dataDir)
    expect(f.sdk.Wallet.open).toHaveBeenCalledWith(2, CONFIG.mnemonic, expect.anything(), expect.objectContaining({ onchain: f.onchain, runDaemon: false }))
    expect(f.wallet.sync).not.toHaveBeenCalled()
    expect(f.wallet.boardAll).not.toHaveBeenCalled()
    expect(f.wallet.refreshVtxosDelegated).not.toHaveBeenCalled()
    expect((await adapter.getConnectionInfo()).network).toBe('signet')
    expect((await adapter.getConnectionInfo()).syncStatus?.synced).toBe(false)
    await adapter.refreshBalances()
    expect((await adapter.getConnectionInfo()).syncStatus?.synced).toBe(true)
    expect((await adapter.listAssets())[0]).toMatchObject({ protocol: 'BARK', layer: 'BTC_BARK', balance: { available: 10000 } })
  })

  it('registers with ProtocolManager and routes BOLT11 and Bitcoin through BARK', async () => {
    const manager = new ProtocolManager(); manager.registerAdapter(adapter)
    await manager.setActiveProtocol('BARK')
    expect(await manager.getReceiveAddress()).toMatchObject({ address: ADDRESS })
    const registry = new ProtocolAdapterRegistry(); registry.register(adapter)
    const router = new CrossProtocolRouter(registry)
    expect(router.resolveSend(INVOICE).best?.protocol).toBe('BARK')
    expect(router.resolveSend('tb1qtestaddress').best?.protocol).toBe('BARK')
    expect(router.resolveReceive('BTC_BARK')[0].protocol).toBe('BARK')
  })

  it('pays a routed Bitcoin address through the core payment contract', async () => {
    const result = await adapter.sendPayment({ invoice: 'tb1qtestaddress', amount: 1000 })
    expect(f.wallet.sendOnchain).toHaveBeenCalledWith('tb1qtestaddress', 1000n)
    expect(result).toMatchObject({ txid: 'txid', status: 'pending', amount: 1000, feeKnown: false })
  })

  it('normalizes history and filters by asset and status', async () => {
    const [tx] = await adapter.listTransactions({ asset: 'BTC', status: 'confirmed' })
    expect(tx.protocolData?.paymentHash).toBe(TEST_PAYMENT_HASH)
    expect(tx.fee).toBe(2)
    expect(tx.amount).toBe(1000)
    expect(tx.protocolData?.balanceDeltaSats).toBe(-1002)
    expect(await adapter.listTransactions({ asset: 'OTHER' })).toEqual([])
    expect(() => JSON.stringify(tx)).not.toThrow()
  })

  it('preserves pending send direction before its balance delta settles', async () => {
    f.wallet.history.mockResolvedValue([{ ...movement, status: 'pending', completedAt: undefined, effectiveBalanceSats: 0n }])
    expect(await adapter.listTransactions()).toMatchObject([{ type: 'send', amount: 1000, fee: 2, status: 'pending' }])
  })

  it('creates an amount-bound Lightning invoice and passes its description', async () => {
    expect(await adapter.createInvoice({ amount: 1000, description: 'test' })).toMatchObject({ paymentHash: TEST_PAYMENT_HASH, amount: 1000 })
    expect(f.wallet.bolt11Invoice).toHaveBeenCalledWith(1000n, 'test', undefined)
  })

  it.each([{ amount: 0 }, { amount: 1.1 }, { amount: 1000, asset: 'USDT' },
    { amount: 1000, expirySeconds: 60 }, { amount: 1000, layer: 'BTC_L1' as const }])('rejects unsupported invoice request %j', async request => {
    await expect(adapter.createInvoice(request)).rejects.toThrow()
    expect(f.wallet.bolt11Invoice).not.toHaveBeenCalled()
  })

  it('verifies Lightning settlement and reports the actual persisted fee', async () => {
    expect(await adapter.sendPayment({ invoice: INVOICE })).toMatchObject({ paymentHash: TEST_PAYMENT_HASH,
      preimage: TEST_PREIMAGE, amount: 1000, fee: 2, feeKnown: true, status: 'confirmed' })
    expect(f.wallet.payLightningInvoice).toHaveBeenCalledWith(INVOICE, undefined, false)
  })

  it('does not call a payment failed when post-payment history is unavailable', async () => {
    f.wallet.history.mockRejectedValue(new Error('read failed'))
    expect(await adapter.sendPayment({ invoice: INVOICE })).toMatchObject({ status: 'confirmed', feeKnown: false })
    expect(f.wallet.payLightningInvoice).toHaveBeenCalledOnce()
  })

  it('leaves a bad settlement proof unknown', async () => {
    f.wallet.payLightningInvoice.mockResolvedValue({ tag: 'Paid', inner: { paymentHash: TEST_PAYMENT_HASH, preimage: '00'.repeat(32) } })
    expect(await adapter.sendPayment({ invoice: INVOICE })).toMatchObject({ status: 'unknown', feeKnown: false })
  })

  it('preserves pending Lightning amount and fee without marking it settled', async () => {
    f.wallet.payLightningInvoice.mockResolvedValue({ tag: 'InProgress', inner: { send: { amountSats: 1000n, feeSats: 3n } } })
    expect(await adapter.sendPayment({ invoice: INVOICE })).toMatchObject({ status: 'pending', amount: 1000, fee: 3, feeKnown: true })
  })

  it.each([
    { invoice: INVOICE, maxFeeSats: 2 }, { invoice: INVOICE, amount: 1001 },
    { invoice: bolt11Fixture({ hrp: 'lnbc10u', timestamp: NOW }) },
    { invoice: bolt11Fixture({ hrp: 'lntbs10u', timestamp: NOW - 7200 }) },
    { invoice: bolt11Fixture({ hrp: 'lntbs1p', timestamp: NOW }) },
  ])('rejects unauthorized fee, amount, network or expiry before payment', async request => {
    await expect(adapter.sendPayment(request)).rejects.toThrow()
    expect(f.wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('supplies an exact amount for amountless invoices', async () => {
    const invoice = bolt11Fixture({ hrp: 'lntbs', timestamp: NOW })
    await expect(adapter.sendPayment({ invoice })).rejects.toThrow()
    await adapter.sendPayment({ invoice, amount: 1000 })
    expect(f.wallet.payLightningInvoice).toHaveBeenCalledWith(invoice, 1000n, false)
  })

  it('never retries Lightning after an uncertain native error', async () => {
    f.wallet.payLightningInvoice.mockRejectedValue(new Error(CONFIG.mnemonic))
    await expect(adapter.sendPayment({ invoice: INVOICE })).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' })
    expect(f.wallet.payLightningInvoice).toHaveBeenCalledOnce()
  })

  it('submits Ark payments without inventing a fee or payment hash', async () => {
    expect(await adapter.sendPayment({ invoice: ADDRESS, amount: 1000 })).toEqual({ paymentHash: '',
      amount: 1000, fee: 0, feeKnown: false, status: 'pending', timestamp: NOW * 1000 })
    expect(f.wallet.validateArkoorAddress).toHaveBeenCalledWith(ADDRESS)
    expect(f.wallet.sendArkoorPayment).toHaveBeenCalledWith(ADDRESS, 1000n)
  })

  it('polls payment state without triggering sync or payment progression', async () => {
    f.wallet.lightningSendState.mockResolvedValue({ tag: 'Paid', inner: { paymentHash: TEST_PAYMENT_HASH, preimage: TEST_PREIMAGE } })
    expect(await adapter.getPaymentStatus(TEST_PAYMENT_HASH)).toMatchObject({ status: 'confirmed' })
    expect(f.wallet.sync).not.toHaveBeenCalled()
  })

  it('maps settled receives and unknown statuses', async () => {
    f.wallet.lightningReceiveState.mockResolvedValue({ state: 'settled', amountSats: 1000n, settledAt: BigInt(NOW) })
    expect(await adapter.getPaymentStatus(TEST_PAYMENT_HASH)).toMatchObject({ status: 'confirmed', amount: 1000, timestamp: NOW * 1000 })
    f.wallet.lightningReceiveState.mockRejectedValue(new Error(CONFIG.mnemonic))
    const status = await adapter.getPaymentStatus(TEST_PAYMENT_HASH)
    expect(status.status).toBe('unknown'); expect(JSON.stringify(status)).not.toContain(CONFIG.mnemonic)
  })

  it('boards explicit BDK funds and returns JSON-safe pending boards', async () => {
    const operations = asBarkOperations(adapter)!
    expect(await operations.boardingTerms()).toEqual({ minBoardAmountSats: 1000, requiredConfirmations: 1 })
    await expect(operations.boardAmount(999)).rejects.toThrow()
    expect(await operations.boardAmount(1000)).toMatchObject({ amountSats: 1000, txid: 'board' })
    expect(f.wallet.boardAmount).toHaveBeenCalledWith(1000n)
    expect(await operations.pendingBoards()).toMatchObject([{ amountSats: 1000 }])
  })

  it('exposes local on-chain funding and explicit restore/sync', async () => {
    expect(await adapter.backend.getOnchainAddress()).toBe('tb1ponchain')
    expect(await adapter.backend.getOnchainBalance()).toEqual({ confirmedSats: 100, pendingSats: 2, totalSats: 102 })
    await adapter.backend.syncOnchain(); expect(await adapter.backend.restoreOnchain()).toBe(100)
    expect(f.onchain.initialScan).toHaveBeenCalledWith(undefined)
  })

  it('offboards selected VTXOs and rejects an implicit sweep', async () => {
    await expect(adapter.backend.offboard('tb1pdestination', [])).rejects.toThrow()
  })

  it('refreshes and exits only the caller’s selected VTXOs', async () => {
    await adapter.backend.refreshVtxos(['vtxo'])
    await adapter.backend.offboard('tb1pdestination', ['vtxo'])
    await adapter.backend.startExit(['vtxo'])
    expect(f.wallet.refreshVtxosDelegated).toHaveBeenCalledWith(['vtxo'])
    expect(f.wallet.offboardVtxos).toHaveBeenCalledWith(['vtxo'], 'tb1pdestination')
    expect(f.wallet.startExitForVtxos).toHaveBeenCalledWith(['vtxo'])
    expect(await adapter.backend.progressExits(2)).toMatchObject([{ state: { inner: { amount: 1000 } } }])
    expect(f.wallet.progressExits).toHaveBeenCalledWith(2n)
  })

  it('prepares exit claims without broadcasting them', async () => {
    expect(await adapter.backend.prepareExitClaim(['vtxo'], 'tb1pdestination', 2)).toEqual({ transactionHex: 'signed-hex', feeSats: 10 })
    expect(f.wallet.drainExits).toHaveBeenCalledWith(['vtxo'], false, 'tb1pdestination', 2n)
    expect(f.wallet.broadcastTx).not.toHaveBeenCalled()
    expect(await adapter.broadcastTransaction('signed-hex')).toEqual({ txid: 'claim-txid' })
  })

  it('returns recoverability and fee estimates without executing a payment', async () => {
    expect(await adapter.backend.recoverVtxos(['vtxo'])).toMatchObject({ isComplete: false, failed: { totalSats: 100 } })
    for (const kind of ['ark', 'lightning', 'onchain'] as const) {
      expect(await adapter.backend.estimatePaymentFee(kind, 1000, 'tb1pdestination')).toMatchObject({ feeSats: 2, netAmountSats: 1000 })
    }
    expect(f.wallet.sendOnchain).not.toHaveBeenCalled()
  })

  it('rejects a retained wallet port after a reconnect', async () => {
    const stale = adapter.backend.getWalletPort()
    await adapter.disconnect()
    await adapter.connect(CONFIG)
    await expect(stale.payLightningInvoice({ invoice: INVOICE, wait: false })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(f.wallet.payLightningInvoice).not.toHaveBeenCalled()
  })

  it('cleans up BDK when native wallet opening fails', async () => {
    await adapter.disconnect()
    f.sdk.Wallet.open.mockRejectedValueOnce(new Error(CONFIG.mnemonic))
    await expect(adapter.connect(CONFIG)).rejects.not.toThrow(CONFIG.mnemonic)
    expect(f.onchain.uniffiDestroy).toHaveBeenCalledTimes(2)
    await adapter.connect(CONFIG)
  })

  it('keeps handles available when daemon shutdown fails and closes on retry', async () => {
    f.wallet.stopDaemonWait.mockRejectedValueOnce(new Error('busy'))
    await expect(adapter.disconnect()).rejects.toMatchObject({ code: 'SDK_ERROR' })
    expect(f.wallet.uniffiDestroy).not.toHaveBeenCalled()
    expect(f.onchain.uniffiDestroy).not.toHaveBeenCalled()
    await adapter.disconnect()
  })

  it('rejects unsafe nested lifecycle integers instead of rounding them', async () => {
    f.wallet.vtxos.mockResolvedValue([{ amountSats: 9007199254740992n }])
    await expect(adapter.backend.getVtxos()).rejects.toMatchObject({ code: 'SDK_ERROR' })
  })

  it('awaits native daemon shutdown before dropping wallet and BDK handles', async () => {
    await adapter.disconnect()
    expect(f.wallet.stopDaemonWait).toHaveBeenCalledOnce()
    expect(f.wallet.uniffiDestroy.mock.invocationCallOrder[0]).toBeLessThan(f.onchain.uniffiDestroy.mock.invocationCallOrder[0])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BarkReactNativeBackend } from '../src/backends/BarkReactNativeBackend.js'
import type { BarkConfig } from '../src/types/bark.js'
import type { NativeBarkModule, NativeBarkWallet } from '../src/backends/bark-native.js'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../src/backends/bark-native.js', () => ({ loadBarkNative: load }))
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const config: BarkConfig = {
  network: 'signet', mnemonic, dataDir: '/app/bark',
  serverUrl: 'https://ark.signet.2nd.dev', esploraUrl: 'https://esplora.signet.2nd.dev',
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let wallet: NativeBarkWallet
let native: NativeBarkModule
let backend: BarkReactNativeBackend
beforeEach(() => {
  wallet = {
    balance: vi.fn().mockResolvedValue({
      spendableSats: 123n, pendingInRoundSats: 20n, pendingExitSats: 30n,
      pendingLightningSendSats: 40n, claimableLightningReceiveSats: 50n, pendingBoardSats: 60n,
    }),
    properties: vi.fn().mockResolvedValue({ network: 2, fingerprint: 'wallet-fingerprint' }),
    recoveryStatus: vi.fn().mockReturnValue({ tag: 'Completed', inner: { report: { isComplete: true } } }),
    history: vi.fn().mockResolvedValue([]),
    newAddress: vi.fn().mockResolvedValue('ark-address-from-native'),
    sync: vi.fn().mockResolvedValue(undefined),
    validateArkoorAddress: vi.fn().mockResolvedValue(true),
    sendArkoorPayment: vi.fn().mockResolvedValue(undefined),
    stopDaemonWait: vi.fn().mockResolvedValue(undefined),
    uniffiDestroy: vi.fn(),
  }
  native = { Network: { Bitcoin: 0, Testnet: 1, Signet: 2, Regtest: 3 }, Wallet: { open: vi.fn().mockResolvedValue(wallet) } }
  load.mockReset().mockResolvedValue(native)
  backend = new BarkReactNativeBackend()
})
afterEach(async () => { await backend.disconnect() })

describe('Bark React Native backend', () => {
  it('loads native code only on connect and opens without a daemon or implicit creation', async () => {
    expect(load).not.toHaveBeenCalled()
    await backend.connect(config)
    expect(native.Wallet.open).toHaveBeenCalledWith(2, mnemonic, {
      serverAddress: config.serverUrl, esploraAddress: config.esploraUrl, daemonManualSync: true,
    }, { datadir: config.dataDir, runDaemon: false, createIfNotExists: false, createWithoutServer: false, skipRecovery: false })
    expect(wallet.sync).not.toHaveBeenCalled()
    expect(wallet.sendArkoorPayment).not.toHaveBeenCalled()
    expect(backend.isConnected()).toBe(true)
    expect(await backend.getWalletInfo()).toEqual({ network: 'signet', fingerprint: 'wallet-fingerprint', recovery: 'complete' })
  })

  it.each(['mainnet', 'testnet', 'signet', 'regtest'] as const)('maps %s explicitly and allows explicit creation', async network => {
    const value = { mainnet: 0, testnet: 1, signet: 2, regtest: 3 }[network]
    vi.mocked(wallet.properties).mockResolvedValue({ network: value, fingerprint: 'id' })
    await backend.connect({ ...config, network, createIfMissing: true })
    expect(native.Wallet.open).toHaveBeenCalledWith(value, mnemonic, expect.anything(), expect.objectContaining({ createIfNotExists: true }))
  })

  it.each([
    { mnemonic: 'invalid' }, { network: undefined }, { network: 'unknown' },
    { dataDir: 'file:///app/bark' }, { dataDir: '/' }, { dataDir: '/app/../bark' },
    { serverUrl: 'http://example.com' }, { serverUrl: 'https://user:secret@example.com' },
    { esploraUrl: 'https://example.com?token=secret' }, { createIfMissing: 'true' },
  ])('rejects invalid configuration before loading native code: %j', async invalid => {
    await expect(backend.connect({ ...config, ...invalid } as BarkConfig)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(load).not.toHaveBeenCalled()
  })

  it('permits HTTP for explicit regtest only', async () => {
    vi.mocked(wallet.properties).mockResolvedValue({ network: 3, fingerprint: 'id' })
    await backend.connect({ ...config, network: 'regtest', serverUrl: 'http://localhost:3535', esploraUrl: 'http://localhost:3000' })
    expect(backend.isConnected()).toBe(true)
  })

  it('never recreates a wallet after an open error, and redacts native errors', async () => {
    vi.mocked(native.Wallet.open).mockRejectedValue(new Error(mnemonic))
    const error = await backend.connect(config).catch(e => e)
    expect(error.code).toBe('SDK_ERROR')
    expect(String(error)).not.toContain(mnemonic)
    expect(error.cause).toBeUndefined()
    expect(native.Wallet.open).toHaveBeenCalledTimes(1)
    expect(backend.isConnected()).toBe(false)
    vi.mocked(native.Wallet.open).mockResolvedValue(wallet)
    await backend.connect(config)
  })

  it('reports missing native installation without leaking loader errors', async () => {
    load.mockRejectedValue(new Error('native module missing'))
    await expect(backend.connect(config)).rejects.toMatchObject({ code: 'SDK_UNAVAILABLE' })
  })

  it('rejects a wallet from the wrong network and releases the handle', async () => {
    vi.mocked(wallet.properties).mockResolvedValue({ network: 0, fingerprint: 'id' })
    await expect(backend.connect(config)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(wallet.stopDaemonWait).toHaveBeenCalledOnce()
    expect(wallet.uniffiDestroy).toHaveBeenCalledOnce()
  })

  it.each([
    [{ tag: 'NotRun' }, 'not-run'],
    [{ tag: 'Failed' }, 'failed'],
    [{ tag: 'Completed', inner: { report: { isComplete: false } } }, 'incomplete'],
  ] as const)('preserves recovery uncertainty: %j', async (status, expected) => {
    vi.mocked(wallet.recoveryStatus).mockReturnValue(status)
    await backend.connect(config)
    expect((await backend.getWalletInfo()).recovery).toBe(expected)
  })

  it('keeps balance categories separate and returns no native bigint values', async () => {
    await backend.connect(config)
    const balance = await backend.getBalance()
    expect(balance).toEqual({ spendableSats: 123, pendingInRoundSats: 20, pendingExitSats: 30,
      pendingLightningSendSats: 40, claimableLightningReceiveSats: 50, pendingBoardSats: 60 })
    expect(() => JSON.stringify(balance)).not.toThrow()
    expect(wallet.sync).not.toHaveBeenCalled()
  })

  it.each([-1n, 2_100_000_000_000_001n, 123, undefined])('rejects invalid native monetary values: %s', async bad => {
    await backend.connect(config)
    const balance = await wallet.balance()
    vi.mocked(wallet.balance).mockResolvedValue({ ...balance, spendableSats: bad } as never)
    await expect(backend.getBalance()).rejects.toMatchObject({ code: 'SDK_ERROR' })
  })

  it('exposes history for reconciliation without relabeling balance deltas as payments', async () => {
    await backend.connect(config)
    vi.mocked(wallet.history).mockResolvedValue([{
      id: 1, status: 'finished', subsystemKind: 'arkoor-send',
      intendedBalanceSats: -102n, effectiveBalanceSats: -102n, offchainFeeSats: 2n,
      createdAt: '2026-10-01T12:00:00Z', sentToAddresses: ['destination'], receivedOnAddresses: [],
    }])
    expect(await backend.getHistory()).toEqual([{
      id: '1', state: 'finished', kind: 'arkoor-send',
      intendedBalanceDeltaSats: -102, effectiveBalanceDeltaSats: -102, feeSats: 2,
      createdAt: '2026-10-01T12:00:00Z', sentToAddresses: ['destination'], receivedOnAddresses: [],
    }])
  })

  it('delegates receiving and sync only when explicitly requested', async () => {
    await backend.connect(config)
    expect(await backend.getReceiveAddress()).toBe('ark-address-from-native')
    await backend.sync()
    expect(wallet.sync).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2_100_000_000_000_001])('rejects invalid send amount %s before native calls', async amountSats => {
    await backend.connect(config)
    await expect(backend.sendArkPayment({ address: 'destination', amountSats })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(wallet.validateArkoorAddress).not.toHaveBeenCalled()
    expect(wallet.sendArkoorPayment).not.toHaveBeenCalled()
  })

  it('rejects a fee cap rather than silently dropping it', async () => {
    await backend.connect(config)
    await expect(backend.sendArkPayment({ address: 'destination', amountSats: 10, maxFeeSats: 0 })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(wallet.sendArkoorPayment).not.toHaveBeenCalled()
  })

  it('lets the SDK validate address, server and network before spending', async () => {
    await backend.connect(config)
    vi.mocked(wallet.validateArkoorAddress).mockResolvedValue(false)
    await expect(backend.sendArkPayment({ address: 'foreign-server-address', amountSats: 10 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(wallet.sendArkoorPayment).not.toHaveBeenCalled()
  })

  it('snapshots the authorized payment and does not fabricate a receipt or fee', async () => {
    await backend.connect(config)
    const request = { address: ' destination ', amountSats: 21 }
    const sending = backend.sendArkPayment(request)
    request.address = 'attacker'
    request.amountSats = 100
    expect(await sending).toEqual({ status: 'submitted', address: 'destination', amountSats: 21 })
    expect(wallet.sendArkoorPayment).toHaveBeenCalledWith('destination', 21n)
  })

  it('never automatically retries an uncertain payment', async () => {
    await backend.connect(config)
    vi.mocked(wallet.sendArkoorPayment).mockRejectedValue(new Error('timeout'))
    await expect(backend.sendArkPayment({ address: 'destination', amountSats: 10 })).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' })
    expect(wallet.sendArkoorPayment).toHaveBeenCalledOnce()
    expect(await backend.getReceiveAddress()).toBe('ark-address-from-native')
  })

  it('waits for an in-flight payment before shutdown and rejects new work', async () => {
    await backend.connect(config)
    const pending = deferred<void>()
    vi.mocked(wallet.sendArkoorPayment).mockReturnValue(pending.promise)
    const sending = backend.sendArkPayment({ address: 'destination', amountSats: 10 })
    await vi.waitFor(() => expect(wallet.sendArkoorPayment).toHaveBeenCalledOnce())
    const closing = backend.disconnect()
    expect(backend.disconnect()).toBe(closing)
    expect(backend.isConnected()).toBe(false)
    await expect(backend.getBalance()).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(wallet.stopDaemonWait).not.toHaveBeenCalled()
    pending.resolve()
    await sending
    await closing
    expect(wallet.stopDaemonWait).toHaveBeenCalledOnce()
    expect(wallet.uniffiDestroy).toHaveBeenCalledOnce()
  })

  it('disconnect during opening waits and closes the resulting native handle', async () => {
    const pending = deferred<NativeBarkWallet>()
    vi.mocked(native.Wallet.open).mockReturnValue(pending.promise)
    const opening = backend.connect(config)
    const closing = backend.disconnect()
    await expect(backend.connect(config)).rejects.toMatchObject({ code: 'ALREADY_CONNECTED' })
    pending.resolve(wallet)
    await opening
    await closing
    expect(backend.isConnected()).toBe(false)
    expect(wallet.uniffiDestroy).toHaveBeenCalledOnce()
  })

  it('does not reopen a directory until failed cleanup has been retried', async () => {
    await backend.connect(config)
    vi.mocked(wallet.stopDaemonWait).mockRejectedValueOnce(new Error('shutdown'))
    await expect(backend.disconnect()).rejects.toMatchObject({ code: 'SDK_ERROR' })
    await expect(backend.connect(config)).rejects.toMatchObject({ code: 'ALREADY_CONNECTED' })
    expect(wallet.uniffiDestroy).not.toHaveBeenCalled()
    await backend.disconnect()
    await backend.connect(config)
  })

  it('guards the same normalized directory across instances', async () => {
    await backend.connect({ ...config, dataDir: '/app//bark/' })
    const second = new BarkReactNativeBackend()
    await expect(second.connect(config)).rejects.toMatchObject({ code: 'ALREADY_CONNECTED' })
    await backend.disconnect()
    await second.connect(config)
    await second.disconnect()
  })

  it('rejects all wallet access after disconnect', async () => {
    await backend.connect(config)
    await backend.disconnect()
    for (const op of [backend.getBalance(), backend.getReceiveAddress(), backend.sync(), backend.getWalletInfo(),
      backend.sendArkPayment({ address: 'destination', amountSats: 10 })]) {
      await expect(op).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    }
  })
})

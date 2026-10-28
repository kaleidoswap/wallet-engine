/**
 * Security review 2026-10-28, findings 14 and 18.
 *
 * 14: the native Spark, RGB, Arkade and browser Bark adapters share one signing
 *     client per protocol (a module singleton). Operations were not bound to the
 *     client an instance's own connect() installed, so after connect(A) on one
 *     instance and connect(B) on another, A's instance still read as connected
 *     and sent, signed and swapped through B's wallet. Each manager now hands
 *     out an ownership token on install; the adapter keeps it and every
 *     operation checks that the singleton still serves that token.
 *
 * 18: on a direct Arkade re-connect the singleton tears the current wallet down
 *     before opening the replacement. When that open failed the adapter read as
 *     disconnected but kept the previous config.mnemonic, and signMessage()
 *     checked only the mnemonic, so it kept signing as the torn-down identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BIP39_TEST_VECTOR_MNEMONIC } from './fixtures/mnemonics'

// --- @arkade-os/sdk: Wallet.create resolves whatever the test queued ----------

const arkSdk = vi.hoisted(() => ({
  queue: [] as Array<() => Promise<object>>,
}))

vi.mock('@arkade-os/sdk', () => {
  const identity = (fill: number) => ({ xOnlyPublicKey: async () => new Uint8Array(32).fill(fill) })
  return {
    Wallet: {
      create: () => {
        const next = arkSdk.queue.shift()
        if (!next) throw new Error('test: no Arkade wallet queued')
        return next()
      },
    },
    SingleKey: { fromHex: () => identity(7) },
    MnemonicIdentity: { fromMnemonic: () => identity(8) },
    IndexedDBWalletRepository: class {},
    IndexedDBContractRepository: class {},
    VtxoManager: class {},
    RestDelegatorProvider: class {},
  }
})

import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { ArkadeAdapter } from '../src/adapters/ArkadeAdapter'
import { RgbAdapter } from '../src/adapters/RgbAdapter'
import { BarkAdapter } from '../src/adapters/BarkAdapter'
import { sparkClientManager } from '../src/lib/spark-client-manager'
import { arkadeClientManager } from '../src/lib/arkade-client-manager'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'
import { barkClientManager, setBarkModuleLoader } from '../src/lib/bark-client-manager'
import { _resetSparkBalanceCacheForTests } from '../src/lib/spark-balance-cache'
import { ClientOwnership, assertOwnedSession } from '../src/lib/wallet-session'
import { verifyLnMessage } from '../src/lib/ln-message-sign'
import { ErrorCode } from '../src/types/base'

const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

const SUPERSEDED = { code: ErrorCode.SESSION_SUPERSEDED }
const NOT_CONNECTED = { code: 'NOT_CONNECTED' }

// ---------------------------------------------------------------------------
// ClientOwnership
// ---------------------------------------------------------------------------

describe('ClientOwnership', () => {
  it('only the latest issued token owns the install, and none after revoke', () => {
    const ownership = new ClientOwnership('test')
    expect(ownership.owns(null)).toBe(false)
    const first = ownership.issue()
    expect(ownership.owns(first)).toBe(true)
    const second = ownership.issue()
    expect(ownership.owns(first)).toBe(false)
    expect(ownership.owns(second)).toBe(true)
    ownership.revoke()
    expect(ownership.owns(second)).toBe(false)
    expect(ownership.current).toBeNull()
  })

  it('assertOwnedSession tells a never-connected adapter from a superseded one', () => {
    const ownership = new ClientOwnership('test')
    const owns = (t: symbol | null) => ownership.owns(t)
    expect(() => assertOwnedSession('SPARK', null, owns)).toThrow(/not connected/i)
    const token = ownership.issue()
    expect(() => assertOwnedSession('SPARK', token, owns)).not.toThrow()
    ownership.issue()
    expect(() => assertOwnedSession('SPARK', token, owns)).toThrowError(
      expect.objectContaining(SUPERSEDED),
    )
  })
})

// ---------------------------------------------------------------------------
// Spark
// ---------------------------------------------------------------------------

function sparkConfig(mnemonic: string) {
  return { protocol: 'SPARK', network: 'regtest', mnemonic } as never
}

function fakeSparkWallet(marker: string, balance: bigint) {
  return {
    marker,
    cleanupConnections: vi.fn(async () => {}),
    setPrivacyEnabled: async () => {},
    getBalance: async () => ({ balance, tokenBalances: new Map() }),
    getSparkAddress: async () => `spark-${marker}`,
    payLightningInvoice: vi.fn(async () => ({ id: 'req', status: 'LIGHTNING_PAYMENT_SUCCEEDED' })),
  }
}

describe('SparkAdapter is bound to the wallet its own connect() installed (finding 14)', () => {
  let wallets: Record<string, ReturnType<typeof fakeSparkWallet>>

  beforeEach(() => {
    wallets = {
      [BIP39_TEST_VECTOR_MNEMONIC]: fakeSparkWallet('A', 1_000n),
      [OTHER_MNEMONIC]: fakeSparkWallet('B', 2_000n),
    }
    sparkClientManager.setSdkFactory({
      initializeWallet: async ({ mnemonicOrSeed }) => ({ wallet: wallets[mnemonicOrSeed] }),
    })
    _resetSparkBalanceCacheForTests()
  })

  afterEach(() => {
    sparkClientManager.reset()
    _resetSparkBalanceCacheForTests()
  })

  it('a stale instance reads as disconnected and can neither send nor sign through the replacement', async () => {
    const a = new SparkAdapter()
    const b = new SparkAdapter()
    await a.connect(sparkConfig(BIP39_TEST_VECTOR_MNEMONIC))
    expect(a.isConnected()).toBe(true)

    await b.connect(sparkConfig(OTHER_MNEMONIC))

    expect(a.isConnected()).toBe(false)
    expect(b.isConnected()).toBe(true)
    await expect(a.sendPayment({ invoice: 'lnbcrt1fake' } as never)).rejects.toMatchObject(SUPERSEDED)
    await expect(a.sendBtcOnchain({ address: 'bcrt1qfake', amount: 1 })).rejects.toMatchObject(SUPERSEDED)
    await expect(a.signMessage('hello')).rejects.toMatchObject(SUPERSEDED)
    await expect(a.signPsbt('70736274ff')).rejects.toMatchObject(SUPERSEDED)
    await expect(a.getBtcBalance()).rejects.toMatchObject(SUPERSEDED)
    expect(wallets[OTHER_MNEMONIC].payLightningInvoice).not.toHaveBeenCalled()

    // Happy path: the instance that owns the install keeps working.
    expect(await b.getBtcBalance()).toMatchObject({ total: 2_000 })
    const sig = await b.signMessage('hello')
    expect(verifyLnMessage('hello', sig)).toBeTruthy()
  })

  it('a stale instance cannot tear down the wallet another instance owns', async () => {
    const a = new SparkAdapter()
    const b = new SparkAdapter()
    await a.connect(sparkConfig(BIP39_TEST_VECTOR_MNEMONIC))
    await b.connect(sparkConfig(OTHER_MNEMONIC))

    await a.disconnect()
    expect(b.isConnected()).toBe(true)
    expect(sparkClientManager.isInitialized()).toBe(true)
    expect(wallets[OTHER_MNEMONIC].cleanupConnections).not.toHaveBeenCalled()

    await b.disconnect()
    expect(b.isConnected()).toBe(false)
    expect(sparkClientManager.isInitialized()).toBe(false)
    await expect(b.signMessage('hello')).rejects.toMatchObject(NOT_CONNECTED)
  })

  it('a wallet adopted from a WDK adapter supersedes the native instance too', async () => {
    const a = new SparkAdapter()
    await a.connect(sparkConfig(BIP39_TEST_VECTOR_MNEMONIC))
    const adopted = { marker: 'WDK' }
    sparkClientManager.adoptExternalWallet(adopted, 'regtest')
    expect(a.isConnected()).toBe(false)
    await expect(a.getBtcBalance()).rejects.toMatchObject(SUPERSEDED)
    sparkClientManager.releaseExternalWallet(adopted)
  })

  it('re-connecting the same instance moves it to the new wallet', async () => {
    const a = new SparkAdapter()
    await a.connect(sparkConfig(BIP39_TEST_VECTOR_MNEMONIC))
    await a.connect(sparkConfig(OTHER_MNEMONIC))
    expect(a.isConnected()).toBe(true)
    expect(await a.getBtcBalance()).toMatchObject({ total: 2_000 })
  })
})

// ---------------------------------------------------------------------------
// Arkade
// ---------------------------------------------------------------------------

function arkadeConfig(mnemonic: string) {
  return {
    protocol: 'ARKADE',
    network: 'signet',
    mnemonic,
    arkServerUrl: 'https://ark.example',
    esploraUrl: 'https://esplora.example',
  } as never
}

function fakeArkWallet(marker: string) {
  return {
    marker,
    getVtxoManager: async () => ({ dispose: async () => {} }),
    getContractManager: async () => ({ refreshVtxos: async () => {} }),
    sendBitcoin: vi.fn(async () => 'txid'),
  }
}

describe('ArkadeAdapter is bound to the wallet its own connect() installed (finding 14)', () => {
  afterEach(() => {
    arkadeClientManager.reset()
    arkSdk.queue.length = 0
  })

  it('a stale instance reads as disconnected and can neither send nor sign through the replacement', async () => {
    const walletB = fakeArkWallet('B')
    arkSdk.queue.push(async () => fakeArkWallet('A'), async () => walletB)
    const a = new ArkadeAdapter()
    const b = new ArkadeAdapter()
    await a.connect(arkadeConfig(BIP39_TEST_VECTOR_MNEMONIC))
    expect(a.isConnected()).toBe(true)

    await b.connect(arkadeConfig(OTHER_MNEMONIC))

    expect(a.isConnected()).toBe(false)
    expect(b.isConnected()).toBe(true)
    await expect(a.sendPayment({ invoice: 'tark1qfake', amount: 1 } as never)).rejects.toMatchObject(
      SUPERSEDED,
    )
    await expect(a.sendBtcOnchain({ address: 'tb1qfake', amount: 1 })).rejects.toMatchObject(SUPERSEDED)
    await expect(a.signMessage('hello')).rejects.toMatchObject(SUPERSEDED)
    await expect(a.getBtcBalance()).rejects.toMatchObject(SUPERSEDED)
    expect(walletB.sendBitcoin).not.toHaveBeenCalled()

    // Happy path for the owner, and a stale disconnect() leaves it alone.
    const sig = await b.signMessage('hello')
    expect(verifyLnMessage('hello', sig)).toBeTruthy()
    await a.disconnect()
    expect(b.isConnected()).toBe(true)
    expect(arkadeClientManager.isInitialized()).toBe(true)

    await b.disconnect()
    expect(arkadeClientManager.isInitialized()).toBe(false)
  })
})

describe('ArkadeAdapter after a failed direct re-connect (finding 18)', () => {
  afterEach(() => {
    arkadeClientManager.reset()
    arkSdk.queue.length = 0
  })

  it('signMessage() rejects instead of signing as the torn-down wallet', async () => {
    arkSdk.queue.push(
      async () => fakeArkWallet('A'),
      async () => {
        throw new Error('ark server unreachable')
      },
    )
    const a = new ArkadeAdapter()
    await a.connect(arkadeConfig(BIP39_TEST_VECTOR_MNEMONIC))
    expect(verifyLnMessage('challenge', await a.signMessage('challenge'))).toBeTruthy()

    await expect(a.connect(arkadeConfig(OTHER_MNEMONIC))).rejects.toThrow(/ark server unreachable/)

    expect(a.isConnected()).toBe(false)
    expect(arkadeClientManager.isInitialized()).toBe(false)
    // Neither the previous nor the rejected secret survives the failed re-init.
    expect((a as unknown as { config: unknown }).config).toBeNull()
    expect(arkadeClientManager.getConfig()).toBeNull()
    await expect(a.signMessage('challenge')).rejects.toMatchObject(NOT_CONNECTED)
    await expect(a.sendBtcOnchain({ address: 'tb1qfake', amount: 1 })).rejects.toMatchObject(NOT_CONNECTED)
  })

  it('a later successful connect restores signing (happy path)', async () => {
    arkSdk.queue.push(
      async () => fakeArkWallet('A'),
      async () => {
        throw new Error('ark server unreachable')
      },
      async () => fakeArkWallet('B'),
    )
    const a = new ArkadeAdapter()
    await a.connect(arkadeConfig(BIP39_TEST_VECTOR_MNEMONIC))
    await expect(a.connect(arkadeConfig(OTHER_MNEMONIC))).rejects.toThrow()
    await a.connect(arkadeConfig(OTHER_MNEMONIC))
    expect(a.isConnected()).toBe(true)
    expect(verifyLnMessage('challenge', await a.signMessage('challenge'))).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// RGB
// ---------------------------------------------------------------------------

function rgbConfig(nodeUrl: string) {
  return { protocol: 'RGB_LN', network: 'regtest', nodeUrl } as never
}

function fakeRlnClient(spendable: number) {
  return {
    rln: {
      getNodeInfo: async () => ({ pubkey: `pk-${spendable}` }),
      getBtcBalance: async () => ({ vanilla: { spendable, future: spendable } }),
      sendPayment: vi.fn(async () => ({ payment_hash: 'ph', status: 'Succeeded' })),
      decodeLNInvoice: async () => ({ amt_msat: 1_000 }),
    },
    maker: {},
    hasNode: () => true,
    hasMaker: () => false,
    close: async () => {},
  }
}

describe('RgbAdapter is bound to the client its own connect() installed (finding 14)', () => {
  afterEach(() => {
    kaleidoClientManager.reset()
    vi.restoreAllMocks()
  })

  it('a stale instance reads as disconnected and cannot spend through the replacement node', async () => {
    const clients = { a: fakeRlnClient(1_000), b: fakeRlnClient(2_000) }
    let current = clients.a
    vi.spyOn(kaleidoClientManager, 'getClient').mockImplementation(() => current as never)

    const a = new RgbAdapter()
    const b = new RgbAdapter()
    await a.connect(rgbConfig('http://node-a:3001'))
    expect(a.isConnected()).toBe(true)

    current = clients.b
    await b.connect(rgbConfig('http://node-b:3001'))

    expect(a.isConnected()).toBe(false)
    expect(b.isConnected()).toBe(true)
    await expect(a.sendPayment({ invoice: 'lnbcrt1fake' } as never)).rejects.toMatchObject(SUPERSEDED)
    await expect(a.payKeysend({ pubkey: '02'.padEnd(66, 'a'), amount: 1 } as never)).rejects.toMatchObject(
      SUPERSEDED,
    )
    await expect(a.sendBtcOnchain({ address: 'bcrt1qfake', amount: 1 })).rejects.toMatchObject(SUPERSEDED)
    await expect(a.getBtcBalance()).rejects.toMatchObject(SUPERSEDED)
    expect(clients.b.rln.sendPayment).not.toHaveBeenCalled()

    // Happy path for the owner, and a stale disconnect() leaves it alone.
    expect(await b.getBtcBalance()).toMatchObject({ confirmed: 2_000 })
    await a.disconnect()
    expect(b.isConnected()).toBe(true)
    expect(kaleidoClientManager.isInitialized()).toBe(true)

    await b.disconnect()
    expect(kaleidoClientManager.isInitialized()).toBe(false)
    await expect(b.getBtcBalance()).rejects.toMatchObject(NOT_CONNECTED)
  })

  it('a failed handshake only resets the client this attempt installed', async () => {
    const clients = { a: fakeRlnClient(1_000), broken: fakeRlnClient(0) }
    clients.broken.rln.getNodeInfo = async () => {
      throw new Error('node unreachable')
    }
    let current = clients.a
    vi.spyOn(kaleidoClientManager, 'getClient').mockImplementation(() => current as never)

    const a = new RgbAdapter()
    await a.connect(rgbConfig('http://node-a:3001'))

    // Another instance fails to connect: it must not reset A's live client.
    current = clients.broken
    const b = new RgbAdapter()
    const failing = b.connect(rgbConfig('http://node-broken:3001'))
    // B's initialize already replaced the singleton, so A is superseded…
    await expect(failing).rejects.toThrow(/node unreachable/)
    expect(a.isConnected()).toBe(false)
    // …and B's failed attempt resets only what it installed.
    expect(b.isConnected()).toBe(false)
    expect(kaleidoClientManager.isInitialized()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bark (browser singleton)
// ---------------------------------------------------------------------------

const BARK_BALANCE = {
  spendableSats: 0,
  pendingInRoundSats: 0,
  pendingExitSats: 0,
  pendingLightningSendSats: 0,
  claimableLightningReceiveSats: 0,
  pendingBoardSats: 0,
}

function fakeBarkWallet(spendableSats: number) {
  return {
    free: vi.fn(),
    balance: vi.fn(async () => ({ ...BARK_BALANCE, spendableSats })),
    sendArkoorPayment: vi.fn(async () => {}),
  }
}

function barkConfig(mnemonic: string, dbName: string) {
  return {
    protocol: 'BARK',
    mnemonic,
    arkServerUrl: 'https://ark.signet.2nd.dev',
    esploraUrl: 'https://esplora.signet.2nd.dev',
    network: 'signet',
    dbName,
  } as never
}

describe('BarkAdapter is bound to the wallet its own connect() installed (finding 14)', () => {
  let wallets: Record<string, ReturnType<typeof fakeBarkWallet>>

  beforeEach(() => {
    wallets = {
      [BIP39_TEST_VECTOR_MNEMONIC]: fakeBarkWallet(1_000),
      [OTHER_MNEMONIC]: fakeBarkWallet(2_000),
    }
    setBarkModuleLoader(
      async () =>
        ({
          Wallet: { open: async (_network: string, mnemonic: string) => wallets[mnemonic] },
          validateArkAddress: () => true,
        }) as never,
    )
    ;(globalThis as Record<string, unknown>).indexedDB ??= {}
    ;(globalThis as Record<string, unknown>).Window ??= globalThis.constructor
  })

  afterEach(async () => {
    await barkClientManager.dispose()
  })

  it('a stale instance reads as disconnected and cannot spend from the replacement', async () => {
    const a = new BarkAdapter()
    const b = new BarkAdapter()
    await a.connect(barkConfig(BIP39_TEST_VECTOR_MNEMONIC, 'bark-a'))
    expect(a.isConnected()).toBe(true)

    await b.connect(barkConfig(OTHER_MNEMONIC, 'bark-b'))

    expect(a.isConnected()).toBe(false)
    expect(b.isConnected()).toBe(true)
    await expect(a.getBtcBalance()).rejects.toMatchObject(SUPERSEDED)
    await expect(a.sendPayment({ invoice: 'tark1qfake', amount: 1 } as never)).rejects.toMatchObject(
      SUPERSEDED,
    )
    expect(wallets[OTHER_MNEMONIC].sendArkoorPayment).not.toHaveBeenCalled()

    // Happy path for the owner, and a stale disconnect() leaves it alone.
    expect(await b.getBtcBalance()).toMatchObject({ confirmed: 2_000 })
    await a.disconnect()
    expect(b.isConnected()).toBe(true)
    expect(wallets[OTHER_MNEMONIC].free).not.toHaveBeenCalled()

    await b.disconnect()
    expect(b.isConnected()).toBe(false)
    expect(wallets[OTHER_MNEMONIC].free).toHaveBeenCalledOnce()
  })
})

/**
 * TASK A audit probes — ArkadeClientManager teardown race + nsec/hex-rooted
 * signMessage/signPsbt key mismatch.
 *
 * Self-contained: @arkade-os/sdk is module-mocked (vi.mock is per-file); no
 * network access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { Transaction, p2wpkh, bip32Path } from '@scure/btc-signer'
import { bech32 } from '@scure/base'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { signPsbt } from '../../src/lib/psbt-signer'


// --- Mock @arkade-os/sdk with a deferred Wallet.create -----------------------

const sdkState = {
  pending: null as null | { resolve: (w: object) => void; reject: (e: unknown) => void },
}

vi.mock('@arkade-os/sdk', () => {
  class FakeSingleKey {
    static fromHex(_hex: string) {
      return {
        xOnlyPublicKey: async () => new Uint8Array(32).fill(7),
      }
    }
  }
  class FakeMnemonicIdentity {
    static fromMnemonic(_m: string, _o: unknown) {
      return { xOnlyPublicKey: async () => new Uint8Array(32).fill(8) }
    }
  }
  class FakeRepo {
    constructor(_dbName: string) {}
  }
  class FakeRestDelegatorProvider {
    constructor(_url: string) {}
  }
  const Wallet = {
    create: (_cfg: unknown) =>
      new Promise<object>((resolve, reject) => {
        sdkState.pending = { resolve, reject }
      }),
  }
  return {
    Wallet,
    SingleKey: FakeSingleKey,
    MnemonicIdentity: FakeMnemonicIdentity,
    IndexedDBWalletRepository: FakeRepo,
    IndexedDBContractRepository: FakeRepo,
    VtxoManager: class {},
    RestDelegatorProvider: FakeRestDelegatorProvider,
  }
})

import { arkadeClientManager } from '../../src/lib/arkade-client-manager'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function arkCfg(mnemonic: string) {
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
  }
}

afterEach(() => {
  arkadeClientManager.reset()
  sdkState.pending = null
})

describe('ArkadeClientManager teardown race', () => {
  it('F3 [FIXED]: disconnect() during in-flight initialize() no longer resurrects the wallet', async () => {
    const init = arkadeClientManager.initialize(arkCfg(MNEMONIC))
    // Let _doInitialize run up to the awaited Wallet.create() call.
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    // Host locks / tears down while Wallet.create() is still pending.
    await arkadeClientManager.disconnect()
    expect(arkadeClientManager.isInitialized()).toBe(false)

    // The pending SDK call resolves AFTER teardown completed. The generation
    // guard discards the orphan instead of installing it — a locked wallet must
    // not come back live and signing-capable.
    sdkState.pending!.resolve(fakeArkWallet('ARK_A'))
    await init

    expect(arkadeClientManager.isInitialized()).toBe(false)
    expect(() => arkadeClientManager.getWallet()).toThrow()
    // …and the mnemonic-bearing config was not restored with it.
    expect(arkadeClientManager.getConfig()).toBeNull()
  })

  it('F3b [FIXED]: reset() during in-flight initialize() also discards the orphan', async () => {
    const init = arkadeClientManager.initialize(arkCfg(MNEMONIC))
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    // reset() nulls _initPromise but cannot cancel the in-flight _doInitialize —
    // the generation guard is what makes that safe.
    arkadeClientManager.reset()
    expect(arkadeClientManager.isInitialized()).toBe(false)

    sdkState.pending!.resolve(fakeArkWallet('ARK_A'))
    await init

    expect(arkadeClientManager.isInitialized()).toBe(false)
    expect(arkadeClientManager.getConfig()).toBeNull()
  })

  it('F3c [FIXED]: a wallet switch racing the handshake installs B, never A', async () => {
    const OTHER =
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    const initA = arkadeClientManager.initialize(arkCfg(MNEMONIC))
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    const pendingA = sdkState.pending!

    // Host switches wallets: reset() clears the in-flight slot (disconnect()
    // alone leaves _initPromise set, so a different config is rejected — see
    // the availability note in REPORT-2), then B connects.
    arkadeClientManager.reset()
    sdkState.pending = null
    const initB = arkadeClientManager.initialize(arkCfg(OTHER))
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    const pendingB = sdkState.pending!

    // B comes up, then A's superseded handshake lands LAST — the dangerous
    // ordering: without the generation guard A's wallet overwrites B's.
    pendingB.resolve(fakeArkWallet('ARK_B'))
    await initB
    pendingA.resolve(fakeArkWallet('ARK_A'))
    await initA

    expect(arkadeClientManager.isInitialized()).toBe(true)
    expect((arkadeClientManager.getWallet() as { marker: string }).marker).toBe('ARK_B')
  })
})

// --- nsec/hex-rooted secret vs mnemonicToSeedSync mismatch -------------------

// A real 32-byte key, bech32 nsec-encoded (valid checksum).
const RAW_KEY = hexToBytes('11'.repeat(32))
const NSEC = bech32.encode('nsec', bech32.toWords(RAW_KEY))

describe('nsec/hex-rooted wallets: signMessage / signPsbt resolve the secret [A-F4 FIXED]', () => {
  it('F4: an nsec secret is not a BIP39 mnemonic — mnemonicToSeedSync alone cannot serve it', () => {
    // This is the underlying fact the finding rested on, and it stays true:
    // `mnemonicToSeedSync` throws for anything that is not 12-24 wordlist
    // words. connect() never had this problem because it resolves the secret
    // (resolveWalletSeed / resolveSparkMnemonicOrSeed /
    // resolveArkadePrivateKeyHex); the four signMessage paths did not, so an
    // nsec-rooted wallet — the DEFAULT Arkade wallet type — could not sign at
    // all. They now call `resolveWalletSeed` too.
    expect(() => mnemonicToSeedSync(NSEC)).toThrow(/Invalid mnemonic/)
  })

  it("F4b: signPsbt() signs the nsec-rooted wallet's own PSBT", () => {
    // Wallet's actual tree (raw key as master seed, as connect() resolves it).
    const root = HDKey.fromMasterSeed(RAW_KEY)
    const PATH = "m/84'/1'/0'/0/0"
    const child = root.derive(PATH)
    const spk = p2wpkh(child.publicKey!).script

    const tx = new Transaction()
    tx.addInput({
      txid: hexToBytes('22'.repeat(32)),
      index: 0,
      witnessUtxo: { script: spk, amount: 50_000n },
      bip32Derivation: [[child.publicKey!, { fingerprint: root.fingerprint, path: bip32Path(PATH) }]],
    })
    tx.addOutput({ script: spk, amount: 40_000n })
    const psbtHex = bytesToHex(tx.toPSBT())

    // signPsbt(psbtHex, secret) now resolves the secret through
    // resolveWalletSeed, so the same secret connect() accepted signs.
    expect(signPsbt(psbtHex, NSEC).signedCount).toBe(1)
    // Same for a raw 64-hex-char private-key secret.
    expect(signPsbt(psbtHex, '11'.repeat(32)).signedCount).toBe(1)
  })
})

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
  it('F3: disconnect() during in-flight initialize() resurrects the wallet after teardown', async () => {
    const init = arkadeClientManager.initialize(arkCfg(MNEMONIC))
    // Let _doInitialize run up to the awaited Wallet.create() call.
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    // Host locks / tears down while Wallet.create() is still pending.
    await arkadeClientManager.disconnect()
    expect(arkadeClientManager.isInitialized()).toBe(false)

    // The pending SDK call resolves after teardown -> wallet installed anyway.
    sdkState.pending!.resolve(fakeArkWallet('ARK_A'))
    await init

    expect(arkadeClientManager.isInitialized()).toBe(true)
    expect((arkadeClientManager.getWallet() as { marker: string }).marker).toBe('ARK_A')
  })

  it('F3b: reset() during in-flight initialize() also resurrects the wallet', async () => {
    const init = arkadeClientManager.initialize(arkCfg(MNEMONIC))
    await vi.waitFor(() => expect(sdkState.pending).not.toBeNull())
    // reset() nulls _initPromise but cannot cancel the in-flight _doInitialize.
    arkadeClientManager.reset()
    expect(arkadeClientManager.isInitialized()).toBe(false)

    sdkState.pending!.resolve(fakeArkWallet('ARK_A'))
    await init

    expect(arkadeClientManager.isInitialized()).toBe(true)
    expect((arkadeClientManager.getWallet() as { marker: string }).marker).toBe('ARK_A')
  })
})

// --- nsec/hex-rooted secret vs mnemonicToSeedSync mismatch -------------------

// A real 32-byte key, bech32 nsec-encoded (valid checksum).
const RAW_KEY = hexToBytes('11'.repeat(32))
const NSEC = bech32.encode('nsec', bech32.toWords(RAW_KEY))

describe('nsec/hex-rooted wallets: signMessage / signPsbt assume a BIP39 secret', () => {
  it('F4: connect() accepts an nsec secret, but the signMessage derivation path throws on it', () => {
    // connect() resolves nsec to raw key bytes (resolveWalletSeed /
    // resolveSparkMnemonicOrSeed / resolveArkadePrivateKeyHex) — the wallet
    // connects and operates fine. But all four signMessage implementations
    // (SparkAdapter.ts:1137, SparkWdkAdapter.ts:977, ArkadeAdapter.ts:856,
    // ArkadeWdkAdapter.ts:510) run mnemonicToSeedSync(rawSecret), which throws
    // for anything that is not 12-24 words. An nsec-rooted wallet therefore
    // CANNOT sign messages at all — every dApp "verify wallet ownership" /
    // LNURL-style login fails with an opaque "Invalid mnemonic".
    expect(() => mnemonicToSeedSync(NSEC)).toThrow(/Invalid mnemonic/)
  })

  it('F4b: signPsbt() throws on the nsec-rooted wallet\'s own PSBT', () => {
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

    // signPsbt(psbtHex, secret) at src/lib/psbt-signer.ts:70 does
    // mnemonicToSeedSync(secret) with no nsec/hex resolution — the same
    // secret connect() accepted makes PSBT signing unusable.
    expect(() => signPsbt(psbtHex, NSEC)).toThrow(/Invalid mnemonic/)
    // Same for a raw 64-hex-char private-key secret.
    expect(() => signPsbt(psbtHex, '11'.repeat(32))).toThrow(/Invalid mnemonic/)
  })
})

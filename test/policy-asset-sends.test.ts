/**
 * Security review 2026-10-28, finding 15: a satoshi-capped send/keysend grant
 * ignored the RGB asset attached to the payment. The native RGB keysend
 * forwards `assetId`/`assetAmount`, the RLN WDK send forwards runtime
 * `asset_id`/`asset_amount`, and an RGB Lightning invoice can encode the
 * asset itself — so the policy only ever saw the satoshi carrier.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProtocolManager } from '../src/manager/ProtocolManager'
import { evaluatePolicy, normalizeAssetTerms, PolicyError, type SigningPolicy } from '../src/policy'
import { RgbAdapter } from '../src/adapters/RgbAdapter'
import { RlnWdkAdapter } from '../src/adapters/wdk/RlnWdkAdapter'
import { kaleidoClientManager } from '../src/lib/kaleido-client-manager'
import { bolt11Fixture } from './fixtures/bolt11'

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQafzswCN-av4gTsJjX-ttx6CNou5-M98k8Zd'
// lnbc10u encodes 1000 sats: the satoshi carrier of an RGB Lightning payment.
const INV_1000 = bolt11Fixture({ hrp: 'lnbc10u' })

afterEach(() => vi.restoreAllMocks())

describe('evaluatePolicy — asset-bearing send/keysend', () => {
  const satOnly: SigningPolicy = { maxAmountSat: 1000 }
  const withAssetCap: SigningPolicy = { maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '5000' } }

  it('a satoshi cap alone fails closed on any attached non-BTC asset', () => {
    for (const operation of ['send', 'keysend'] as const) {
      expect(evaluatePolicy({ operation, amountSat: 1, assetId: ASSET, assetAmount: '1' }, satOnly)).toMatchObject({
        allowed: false,
        code: 'AMOUNT_UNKNOWN',
        details: { asset: ASSET, cap: null },
      })
    }
  })

  it('enforces the per-asset cap and still caps the satoshi carrier', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1000, assetId: ASSET, assetAmount: '5000' }, withAssetCap)).toEqual({ allowed: true })
    expect(evaluatePolicy({ operation: 'keysend', amountSat: 1, assetId: ASSET, assetAmount: '5001' }, withAssetCap)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_OVER_GLOBAL_LIMIT',
      details: { asset: ASSET, amount: '5001', cap: '5000' },
    })
    expect(evaluatePolicy({ operation: 'send', amountSat: 1001, assetId: ASSET, assetAmount: '1' }, withAssetCap)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_OVER_GLOBAL_LIMIT',
    })
    // Unknown carrier amount is still unknown.
    expect(evaluatePolicy({ operation: 'send', assetId: ASSET, assetAmount: '1' }, withAssetCap)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_UNKNOWN',
    })
  })

  it('an asset with no amount, or an amount with no asset, cannot pass a cap', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1, assetId: ASSET }, withAssetCap)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_UNKNOWN',
    })
    expect(evaluatePolicy({ operation: 'send', amountSat: 1, assetAmount: '1' }, satOnly)).toMatchObject({
      allowed: false,
      code: 'ASSET_UNKNOWN',
    })
    expect(evaluatePolicy({ operation: 'keysend', amountSat: 1, assetId: ASSET, assetAmount: '1.5' }, withAssetCap)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_INVALID',
    })
  })

  it('a BTC identifier is the satoshi path, not an asset', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1000, assetId: 'BTC', assetAmount: '1000' }, satOnly)).toEqual({ allowed: true })
  })

  it('a policy with no caps at all leaves asset sends to the grant/destination rules', () => {
    expect(evaluatePolicy({ operation: 'send', amountSat: 1, assetId: ASSET, assetAmount: '1' }, { mode: 'allow' })).toEqual({ allowed: true })
  })

  it('a satoshi-capped grant fails closed on assets until it lists them', () => {
    const grantOnly: SigningPolicy = {
      mode: 'deny',
      grants: [{ id: 'app', operations: ['send', 'keysend'], maxAmountSat: 1000 }],
    }
    expect(evaluatePolicy({ operation: 'keysend', grantId: 'app', amountSat: 1, assetId: ASSET, assetAmount: '1' }, grantOnly)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_UNKNOWN',
      details: { asset: ASSET, cap: null },
    })
    const listed: SigningPolicy = {
      mode: 'deny',
      grants: [{ id: 'app', operations: ['send', 'keysend', 'swap'], maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '10' } }],
    }
    expect(evaluatePolicy({ operation: 'keysend', grantId: 'app', amountSat: 1, assetId: ASSET, assetAmount: '10' }, listed)).toEqual({ allowed: true })
    expect(evaluatePolicy({ operation: 'keysend', grantId: 'app', amountSat: 1, assetId: ASSET, assetAmount: '11' }, listed)).toMatchObject({
      allowed: false,
      code: 'AMOUNT_OVER_GRANT_LIMIT',
      details: { asset: ASSET, amount: '11', cap: '10' },
    })
    // A grant asset cap also authorises a non-BTC swap, which a sat cap never could.
    expect(evaluatePolicy({ operation: 'swap', grantId: 'app', assetId: ASSET, assetAmount: '10' }, listed)).toEqual({ allowed: true })
  })
})

describe('normalizeAssetTerms', () => {
  it('reads either spelling and renders base units as a decimal string', () => {
    expect(normalizeAssetTerms({ assetId: ASSET, assetAmount: 42 })).toEqual({ assetId: ASSET, assetAmount: '42' })
    expect(normalizeAssetTerms({ asset_id: ` ${ASSET} `, asset_amount: 42n })).toEqual({ assetId: ASSET, assetAmount: '42' })
    expect(normalizeAssetTerms({ asset_id: ASSET, asset_amount: '7' })).toEqual({ assetId: ASSET, assetAmount: '7' })
    expect(normalizeAssetTerms({})).toEqual({})
    expect(normalizeAssetTerms({ assetId: 'btc', assetAmount: 5 })).toEqual({})
  })

  it('keeps malformed amounts in a shape the policy rejects', () => {
    expect(normalizeAssetTerms({ assetId: ASSET, assetAmount: 1.5 })).toEqual({ assetId: ASSET, assetAmount: '1.5' })
    expect(normalizeAssetTerms({ assetId: ASSET, assetAmount: Number.NaN })).toEqual({ assetId: ASSET, assetAmount: 'NaN' })
    expect(normalizeAssetTerms({ assetId: ASSET, assetAmount: -1 })).toEqual({ assetId: ASSET, assetAmount: '-1' })
    expect(normalizeAssetTerms({ assetAmount: 1 })).toEqual({ assetAmount: '1' })
  })

  it('refuses spellings that disagree instead of picking one', () => {
    expect(() => normalizeAssetTerms({ assetId: ASSET, asset_id: 'rgb:other' })).toThrow(PolicyError)
    expect(() => normalizeAssetTerms({ assetId: ASSET, assetAmount: 1, asset_amount: 2 })).toThrow(PolicyError)
    expect(normalizeAssetTerms({ assetId: ASSET, asset_id: ASSET, assetAmount: 1, asset_amount: '1' })).toEqual({ assetId: ASSET, assetAmount: '1' })
  })
})

// --- end to end through the manager -----------------------------------------

function rgbNativeManager(policy: SigningPolicy | undefined, decoded: Record<string, unknown> = {}) {
  const rln = {
    keysend: vi.fn(async () => ({ payment_hash: 'h', status: 'Succeeded' })),
    sendPayment: vi.fn(async () => ({ payment_hash: 'h', status: 'Succeeded' })),
    decodeLNInvoice: vi.fn(async () => ({ amt_msat: 1_000_000, payment_hash: 'h', ...decoded })),
  }
  vi.spyOn(kaleidoClientManager, 'isInitialized').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'ownsSession').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'hasNode').mockReturnValue(true)
  vi.spyOn(kaleidoClientManager, 'getClient').mockReturnValue({ rln } as any)
  const adapter = Object.assign(new RgbAdapter(), { connected: true })
  const manager = new ProtocolManager({ policy })
  manager.registerAdapter(adapter)
  ;(manager as any).activeProtocol = 'RGB_LN'
  return { manager, rln }
}

function rlnWdkManager(policy: SigningPolicy | undefined, decoded: Record<string, unknown> = {}) {
  const node = { sendPayment: vi.fn(async () => ({ payment_hash: 'h', status: 'Succeeded' })) }
  const account = {
    _rln: node,
    decodeLNInvoice: vi.fn(async () => ({ amt_msat: 1_000_000, payment_hash: 'h', ...decoded })),
  }
  const adapter = Object.assign(new RlnWdkAdapter(), { connected: true, account })
  const manager = new ProtocolManager({ policy })
  manager.registerAdapter(adapter)
  ;(manager as any).activeProtocol = 'RGB_LN'
  return { manager, node, account }
}

describe('ProtocolManager: RGB assets attached to keysend (native RgbAdapter)', () => {
  it('a satoshi cap no longer lets an arbitrarily large asset amount through', async () => {
    const { manager, rln } = rgbNativeManager({ maxAmountSat: 1000 })
    await expect(
      manager.payKeysend({ pubkey: '02ab', amount: 1000, assetId: ASSET, assetAmount: 1_000_000 }),
    ).rejects.toMatchObject({ name: 'PolicyError', code: 'AMOUNT_UNKNOWN' })
    expect(rln.keysend).not.toHaveBeenCalled()
  })

  it('an explicit per-asset cap authorises the asset in base units', async () => {
    const { manager, rln } = rgbNativeManager({ maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '500' } })
    await expect(
      manager.payKeysend({ pubkey: '02ab', amount: 1000, assetId: ASSET, assetAmount: 501 }),
    ).rejects.toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT', details: { asset: ASSET, amount: '501', cap: '500' } })
    expect(rln.keysend).not.toHaveBeenCalled()
    await manager.payKeysend({ pubkey: '02ab', amount: 1000, assetId: ASSET, assetAmount: 500 })
    expect(rln.keysend).toHaveBeenCalledWith(
      expect.objectContaining({ dest_pubkey: '02ab', amt_msat: 1000, asset_id: ASSET, asset_amount: 500 }),
    )
  })

  it('runtime snake_case asset fields are seen by the policy too', async () => {
    const { manager, rln } = rgbNativeManager({ maxAmountSat: 1000 })
    await expect(
      manager.payKeysend({ pubkey: '02ab', amount: 1000, asset_id: ASSET, asset_amount: 1_000_000 } as any),
    ).rejects.toMatchObject({ code: 'AMOUNT_UNKNOWN' })
    expect(rln.keysend).not.toHaveBeenCalled()
  })

  it('a plain satoshi keysend is unchanged', async () => {
    const { manager, rln } = rgbNativeManager({ maxAmountSat: 1000 })
    await manager.payKeysend({ pubkey: '02ab', amount: 1000 })
    expect(rln.keysend).toHaveBeenCalledTimes(1)
  })

  it('without a policy nothing is gated or normalised', async () => {
    const { manager, rln } = rgbNativeManager(undefined)
    await manager.payKeysend({ pubkey: '02ab', amount: 1000, assetId: ASSET, assetAmount: 1_000_000 })
    expect(rln.keysend).toHaveBeenCalledTimes(1)
  })
})

describe('ProtocolManager: RGB assets attached to sendPayment (RLN WDK)', () => {
  it('runtime asset_id/asset_amount on a satoshi-capped send fail closed', async () => {
    const { manager, node } = rlnWdkManager({ maxAmountSat: 1000 })
    await expect(
      manager.sendPayment({ invoice: INV_1000, asset_id: ASSET, asset_amount: 1_000_000 } as any),
    ).rejects.toMatchObject({ name: 'PolicyError', code: 'AMOUNT_UNKNOWN', details: { asset: ASSET } })
    expect(node.sendPayment).not.toHaveBeenCalled()
  })

  it('an explicit per-asset cap authorises the runtime asset fields', async () => {
    const { manager, node } = rlnWdkManager({ maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '500' } })
    await manager.sendPayment({ invoice: INV_1000, asset_id: ASSET, asset_amount: 500 } as any)
    expect(node.sendPayment).toHaveBeenCalledWith(expect.objectContaining({ asset_id: ASSET, asset_amount: 500 }))
    await expect(
      manager.sendPayment({ invoice: INV_1000, asset_id: ASSET, asset_amount: 501 } as any),
    ).rejects.toMatchObject({ code: 'AMOUNT_OVER_GLOBAL_LIMIT' })
    expect(node.sendPayment).toHaveBeenCalledTimes(1)
  })

  it('invoice-encoded RGB terms are decoded and authorised even when the caller attaches none', async () => {
    const { manager, node, account } = rlnWdkManager({ maxAmountSat: 1000 }, { asset_id: ASSET, asset_amount: 1_000_000 })
    await expect(manager.sendPayment({ invoice: `lightning:${INV_1000}` })).rejects.toMatchObject({
      code: 'AMOUNT_UNKNOWN',
      details: { asset: ASSET, cap: null },
    })
    expect(account.decodeLNInvoice).toHaveBeenCalledWith(INV_1000)
    expect(node.sendPayment).not.toHaveBeenCalled()

    const listed = rlnWdkManager({ maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '1000000' } }, { asset_id: ASSET, asset_amount: 1_000_000 })
    await listed.manager.sendPayment({ invoice: INV_1000 })
    expect(listed.node.sendPayment).toHaveBeenCalledTimes(1)
  })

  it('caller terms that contradict the invoice are refused', async () => {
    const { manager, node } = rlnWdkManager({ maxAmountSat: 1000, maxAmountByAsset: { [ASSET]: '1000000' } }, { asset_id: ASSET, asset_amount: 1_000_000 })
    await expect(manager.sendPayment({ invoice: INV_1000, asset_id: 'rgb:other', asset_amount: 1 } as any)).rejects.toMatchObject({
      code: 'ASSET_MISMATCH',
    })
    await expect(manager.sendPayment({ invoice: INV_1000, asset_id: ASSET, asset_amount: 1 } as any)).rejects.toMatchObject({
      code: 'ASSET_MISMATCH',
    })
    expect(node.sendPayment).not.toHaveBeenCalled()
  })

  it('an invoice that cannot be decoded fails closed under a policy', async () => {
    const { manager, node, account } = rlnWdkManager({ maxAmountSat: 1000 })
    account.decodeLNInvoice.mockRejectedValueOnce(new Error('node down'))
    await expect(manager.sendPayment({ invoice: INV_1000 })).rejects.toMatchObject({ name: 'PolicyError', code: 'AMOUNT_UNKNOWN' })
    expect(node.sendPayment).not.toHaveBeenCalled()
  })

  it('a plain satoshi invoice still pays under the cap', async () => {
    const { manager, node } = rlnWdkManager({ maxAmountSat: 1000 })
    await manager.sendPayment({ invoice: INV_1000 })
    expect(node.sendPayment).toHaveBeenCalledTimes(1)
  })

  it('the native RgbAdapter decodes invoice terms through the node as well', async () => {
    const { manager, rln } = rgbNativeManager({ maxAmountSat: 1000 }, { asset_id: ASSET, asset_amount: 7 })
    await expect(manager.sendPayment({ invoice: INV_1000 })).rejects.toMatchObject({ code: 'AMOUNT_UNKNOWN', details: { asset: ASSET } })
    expect(rln.sendPayment).not.toHaveBeenCalled()
  })
})

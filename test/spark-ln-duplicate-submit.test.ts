import { afterEach, describe, expect, it, vi } from 'vitest'

const sparkState = vi.hoisted(() => ({ wallet: null as unknown }))
vi.mock('../src/lib/spark-client-manager', () => ({
  sparkClientManager: {
    isInitialized: () => sparkState.wallet !== null,
    getWallet: () => sparkState.wallet,
    getConfig: () => ({ protocol: 'SPARK', network: 'regtest', mnemonic: '' }),
    initialize: async () => {},
    disconnect: async () => {},
    adoptExternalWallet: () => {},
    releaseExternalWallet: () => {},
  },
}))

import { SparkAdapter } from '../src/adapters/SparkAdapter'
import { SparkWdkAdapter } from '../src/adapters/wdk/SparkWdkAdapter'
import {
  findLightningSendForInvoice,
  isDuplicatePreimageSwapError,
} from '../src/lib/spark-lightning-settlement'

const INVOICE = 'lnbc1m1pexample'
const REQ_ID = 'SparkLightningSendRequest:01a0f985-c175-e342-0000-c36adb788a8a'
// Verbatim shape of the operator's rejection (SDK SparkRequestError message).
const DUPLICATE = new Error(
  'Failed to initiate preimage swap: /spark.SparkService/initiate_preimage_swap_v3 ALREADY_EXISTS: consensus initiate preimage swap failed: prepare failed: rpc error: code = AlreadyExists desc = unable to validate request for payment hash ffa9: preimage request already exists for paymentHash ffa9',
)

function sendRequest(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: REQ_ID,
    createdAt: '2026-10-02T10:00:00.000Z',
    encodedInvoice: INVOICE,
    fee: { originalValue: 1, originalUnit: 'SATOSHI' },
    status,
    ...extra,
  }
}

/** Raw SDK wallet whose pay call rejects as a duplicate and whose history holds `entities`. */
function duplicateWallet(entities: Record<string, unknown>[]) {
  return {
    payLightningInvoice: vi.fn(async () => {
      throw DUPLICATE
    }),
    getUserRequests: vi.fn(async () => ({ entities, pageInfo: { hasNextPage: false } })),
    getLightningSendRequest: vi.fn(async () => entities[0] ?? null),
  }
}

function nativeAdapter(wallet: unknown) {
  sparkState.wallet = wallet
  const adapter = new SparkAdapter()
  Object.assign(adapter as any, { connected: true })
  return adapter
}

function wdkAdapter(wallet: any) {
  const adapter = new SparkWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: { payLightningInvoice: wallet.payLightningInvoice, _wallet: wallet },
  })
  return adapter
}

afterEach(() => {
  sparkState.wallet = null
})

describe('isDuplicatePreimageSwapError', () => {
  it('recognises the operator rejection and nothing else', () => {
    expect(isDuplicatePreimageSwapError(DUPLICATE)).toBe(true)
    expect(isDuplicatePreimageSwapError(new Error('maxFeeSats does not cover fee estimate'))).toBe(false)
    expect(isDuplicatePreimageSwapError(new Error('ALREADY_EXISTS: token already registered'))).toBe(false)
  })
})

describe('findLightningSendForInvoice', () => {
  it('matches case-insensitively and pages through history', async () => {
    const getUserRequests = vi
      .fn()
      .mockResolvedValueOnce({
        entities: [{ id: 'other', encodedInvoice: 'lnbc1other' }],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      })
      .mockResolvedValueOnce({
        entities: [sendRequest('PENDING')],
        pageInfo: { hasNextPage: false },
      })
    const found = await findLightningSendForInvoice({ getUserRequests }, INVOICE.toUpperCase())
    expect(found?.id).toBe(REQ_ID)
    expect(getUserRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: 'c1', types: ['LIGHTNING_SEND'] }),
    )
  })

  it('returns null when the lookup throws or is missing', async () => {
    expect(await findLightningSendForInvoice({}, INVOICE)).toBeNull()
    const getUserRequests = vi.fn(async () => {
      throw new Error('ssp down')
    })
    expect(await findLightningSendForInvoice({ getUserRequests }, INVOICE)).toBeNull()
  })
})

describe.each([
  ['SparkAdapter', nativeAdapter],
  ['SparkWdkAdapter', wdkAdapter],
] as const)('%s duplicate submit', (_name, make) => {
  it('reports the earlier settled attempt instead of failing', async () => {
    const preimage = 'ab'.repeat(32)
    const wallet = duplicateWallet([sendRequest('TRANSFER_COMPLETED', { paymentPreimage: preimage })])
    const result = await make(wallet).sendPayment({ invoice: INVOICE } as any)
    expect(result).toMatchObject({ paymentHash: REQ_ID, status: 'confirmed', preimage })
  })

  it('tells the user to get a new invoice when the earlier attempt failed', async () => {
    const wallet = duplicateWallet([sendRequest('USER_SWAP_RETURNED')])
    await expect(make(wallet).sendPayment({ invoice: INVOICE } as any)).rejects.toThrow(
      /does not allow paying it again/,
    )
  })

  it('names the duplicate when the earlier attempt cannot be found', async () => {
    const wallet = duplicateWallet([])
    await expect(make(wallet).sendPayment({ invoice: INVOICE } as any)).rejects.toThrow(
      /already submitted from this wallet/,
    )
  })

  it('reads lightning send status from the SSP, not the transfer list', async () => {
    const wallet = duplicateWallet([sendRequest('TRANSFER_COMPLETED')])
    const status = await make(wallet).getPaymentStatus(REQ_ID)
    expect(status).toMatchObject({ paymentHash: REQ_ID, status: 'confirmed', fee: 1 })
    expect(wallet.getLightningSendRequest).toHaveBeenCalledWith('01a0f985-c175-e342-0000-c36adb788a8a')
  })
})

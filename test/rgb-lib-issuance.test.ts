import { describe, expect, it } from 'vitest'
import { RgbLibWdkAdapter } from '../src/adapters/wdk/RgbLibWdkAdapter'

/** Connected adapter whose rgb-lib account issues via the given stub. */
function adapterIssuing(issue: (options: any) => unknown) {
  const calls: any[] = []
  const adapter = new RgbLibWdkAdapter()
  Object.assign(adapter as any, {
    connected: true,
    account: {
      issueAssetNia: async (options: any) => {
        calls.push(options)
        return issue(options)
      },
    },
  })
  return { adapter, calls }
}

const ISSUED = {
  asset_id: 'rgb:2dkS5abc-issued',
  ticker: 'KSTEST',
  name: 'KaleidoSwap test',
  precision: 0,
  balance: { settled: 1_000_000, future: 1_000_000, spendable: 1_000_000 },
}

describe('RgbLibWdkAdapter.issueAssetNia', () => {
  it('issues and returns a unified RGB_L1 asset', async () => {
    const { adapter, calls } = adapterIssuing(() => ISSUED)
    const asset = await (adapter as any).issueAssetNia({
      ticker: 'KSTEST',
      name: 'KaleidoSwap test',
      precision: 0,
      amounts: [1_000_000],
    })

    expect(asset.id).toBe('rgb:2dkS5abc-issued')
    expect(asset.protocol).toBe('RGB_L1')
    expect(asset.balance.available).toBe(1_000_000)
    // The native binding takes an options object; the wasm one takes positional
    // arguments. Callers should not have to know which backing they have.
    expect(calls[0]).toEqual({
      ticker: 'KSTEST',
      name: 'KaleidoSwap test',
      precision: 0,
      amounts: [1_000_000],
    })
  })

  it('defaults precision to 0 rather than passing undefined into the binding', async () => {
    const { adapter, calls } = adapterIssuing(() => ISSUED)
    await (adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts: [1] })

    expect(calls[0].precision).toBe(0)
  })

  it('refuses an empty amounts list', async () => {
    const { adapter, calls } = adapterIssuing(() => ISSUED)
    await expect((adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts: [] })).rejects.toThrow(
      /at least one issuance amount/i,
    )
    expect(calls).toHaveLength(0)
  })

  it('refuses amounts that would be truncated crossing into u64', async () => {
    for (const amounts of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 2], [NaN]]) {
      const { adapter, calls } = adapterIssuing(() => ISSUED)
      await expect(
        (adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts }),
      ).rejects.toThrow(/positive safe integers/i)
      expect(calls).toHaveLength(0)
    }
  })

  it('treats a result with no asset id as a failure, not a hollow success', async () => {
    // rgb-lib can answer without an asset id when the wallet has nothing to
    // colour; reporting that as issued would invent an asset that does not exist.
    const { adapter } = adapterIssuing(() => ({ ticker: 'KS', name: 'KS' }))
    await expect(
      (adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts: [1_000] }),
    ).rejects.toThrow(/no asset id/i)
  })

  it('wraps a binding failure with a stable code', async () => {
    const { adapter } = adapterIssuing(() => {
      throw new Error('InsufficientAllocationSlots')
    })
    await expect(
      (adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts: [1_000] }),
    ).rejects.toThrow(/NIA issuance failed: InsufficientAllocationSlots/)
  })

  it('refuses when not connected', async () => {
    const adapter = new RgbLibWdkAdapter()
    await expect(
      (adapter as any).issueAssetNia({ ticker: 'KS', name: 'KS', amounts: [1] }),
    ).rejects.toThrow(/not connected/i)
  })
})

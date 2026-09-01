/** F-F2 residual: non-BTC swaps use explicit BigInt base-unit caps. */
import { describe, expect, it } from "vitest";
import type { IProtocolAdapter } from "../../src/adapters/IProtocolAdapter";
import { ProtocolManager } from "../../src/manager/ProtocolManager";
import { evaluatePolicy, type SigningPolicy } from "../../src/policy";
import type { Quote } from "../../src/types/base";

const quote = (fromAsset: string, fromAmount: number): Quote => ({
  id: "q1",
  fromAsset,
  fromAmount,
  toAsset: "BTC",
  toAmount: 1,
  price: 1,
  fee: { amount: 0, asset: fromAsset },
  expiresAt: 0,
});

async function managerWith(policy: SigningPolicy) {
  const executed: Quote[] = [];
  let connected = false;
  const adapter = {
    protocolName: "RGB_LN",
    capabilities: [],
    supportedLayers: [],
    version: "test",
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
    isConnected: () => connected,
    supportsSwaps: () => true,
    executeSwap: async (approved: Quote) => {
      executed.push(approved);
      return { swapId: "s1", status: "pending", quote: approved, timestamp: 0 };
    },
  } as unknown as IProtocolAdapter;
  const manager = new ProtocolManager({ policy });
  manager.registerAdapter(adapter);
  await manager.connect("RGB_LN", { protocol: "RGB_LN" });
  return { manager, executed };
}

describe("F-F2 per-asset spending caps", () => {
  it("leaves the BTC satoshi path unchanged", async () => {
    const { manager, executed } = await managerWith({ maxAmountSat: 100_000 });
    await manager.executeSwap(quote("BTC", 100_000));
    await expect(manager.executeSwap(quote("BTC", 100_001))).rejects.toMatchObject({
      code: "AMOUNT_OVER_GLOBAL_LIMIT",
    });
    expect(executed).toHaveLength(1);
  });

  it("allows a non-BTC swap under its base-unit cap", async () => {
    const { manager, executed } = await managerWith({
      maxAmountSat: 100_000,
      maxAmountByAsset: { XAUT: "90000" },
    });
    await manager.executeSwap(quote("XAUT", 89_999));
    expect(executed).toHaveLength(1);
  });

  it("denies a non-BTC swap over its cap with asset/cap details", async () => {
    const { manager, executed } = await managerWith({
      maxAmountSat: 100_000,
      maxAmountByAsset: { XAUT: "89999" },
    });
    await expect(manager.executeSwap(quote("XAUT", 90_000))).rejects.toMatchObject({
      code: "AMOUNT_OVER_GLOBAL_LIMIT",
      details: { asset: "XAUT", amount: "90000", cap: "89999" },
    });
    expect(executed).toHaveLength(0);
  });

  it("keeps an unconfigured non-BTC asset fail-closed", async () => {
    const { manager, executed } = await managerWith({
      maxAmountSat: 100_000,
      maxAmountByAsset: { USDT: "1000000" },
    });
    await expect(manager.executeSwap(quote("XAUT", 1))).rejects.toMatchObject({
      code: "AMOUNT_UNKNOWN",
      details: { asset: "XAUT", cap: null },
    });
    expect(executed).toHaveLength(0);
  });

  it("honours a cap beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const policy: SigningPolicy = {
      maxAmountSat: 1,
      maxAmountByAsset: { XAUT: "900719925474099312345" },
    };
    expect(
      evaluatePolicy(
        {
          operation: "swap",
          assetId: "XAUT",
          assetAmount: "900719925474099312345",
        },
        policy,
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluatePolicy(
        {
          operation: "swap",
          assetId: "XAUT",
          assetAmount: "900719925474099312346",
        },
        policy,
      ),
    ).toMatchObject({
      allowed: false,
      code: "AMOUNT_OVER_GLOBAL_LIMIT",
      details: { cap: "900719925474099312345" },
    });
  });
});

/** B-F1: maker quote terms must stay bound to the caller's request. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RgbAdapter } from "../../src/adapters/RgbAdapter";
import { kaleidoClientManager } from "../../src/lib/kaleido-client-manager";
import { KaleidoswapSwap } from "../../src/swap/KaleidoswapSwap";

const REQUEST = {
  fromAsset: "rgb:USDT",
  toAsset: "BTC",
  fromLayer: "RGB_LN",
  toLayer: "BTC_LN",
  fromAmount: 100_000,
};

type Path = "WDK" | "native";

function getQuote(
  path: Path,
  changes: Record<string, unknown> = {},
  maxQuoteSlippageBps?: number,
) {
  if (path === "WDK") {
    const swap = new KaleidoswapSwap(
      {},
      { baseUrl: "https://maker.example", maxQuoteSlippageBps },
    );
    Object.assign(swap as unknown as Record<string, unknown>, {
      proto: {
        quoteSwap: async () => ({
          rfqId: "rfq-1",
          tokenInAmount: 100_000,
          tokenOutAmount: 5_000,
          price: 20,
          fee: 10,
          expiresAt: 1_900_000_000,
          ...changes,
        }),
      },
    });
    return swap.getQuote(REQUEST);
  }

  const adapter = new RgbAdapter();
  Object.assign(adapter as unknown as Record<string, unknown>, {
    connected: true,
    config: {
      protocol: "RGB_LN",
      network: "regtest",
      makerUrl: "https://maker.example",
      maxQuoteSlippageBps,
    },
  });
  vi.spyOn(kaleidoClientManager, "isInitialized").mockReturnValue(true);
  vi.spyOn(kaleidoClientManager, "getClient").mockReturnValue({
    maker: {
      getQuote: async () => ({
        rfq_id: "rfq-1",
        from_asset: { asset_id: "rgb:USDT", amount: 100_000 },
        to_asset: { asset_id: "BTC", amount: 5_000 },
        price: 20,
        fee: { final_fee: 10, fee_asset: "BTC", base_fee: 10, variable_fee: 0 },
        expires_at: 1_900_000_000,
        ...changes,
      }),
    },
  } as never);
  return adapter.getSwapQuote(REQUEST);
}

function fromAmount(path: Path, amount: number): Record<string, unknown> {
  return path === "WDK"
    ? { tokenInAmount: amount }
    : { from_asset: { asset_id: "rgb:USDT", amount } };
}

function fromAsset(path: Path, asset: string): Record<string, unknown> {
  return path === "WDK"
    ? { fromAsset: asset }
    : { from_asset: { asset_id: asset, amount: 100_000 } };
}

function toAsset(path: Path, asset: string): Record<string, unknown> {
  return path === "WDK"
    ? { toAsset: asset }
    : { to_asset: { asset_id: asset, amount: 5_000 } };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["WDK", "native"] as const)("B-F1 quote validation — %s path", (path) => {
  it("accepts a faithful quote", async () => {
    await expect(getQuote(path)).resolves.toMatchObject({
      fromAsset: REQUEST.fromAsset,
      fromAmount: REQUEST.fromAmount,
      toAsset: REQUEST.toAsset,
      toAmount: 5_000,
    });
  });

  it("rejects a from-leg inflated past the default 100-bps tolerance", async () => {
    await expect(getQuote(path, fromAmount(path, 101_001))).rejects.toMatchObject({
      code: "QUOTE_AMOUNT_DIVERGENCE",
      details: {
        requested: 100_000,
        returned: 101_001,
        toleranceBps: 100,
        divergenceBps: 100.1,
      },
    });
  });

  it("accepts a from-leg inside the tolerance", async () => {
    await expect(getQuote(path, fromAmount(path, 100_999))).resolves.toMatchObject({
      fromAmount: 100_999,
    });
  });

  it("rejects a substituted fromAsset", async () => {
    await expect(getQuote(path, fromAsset(path, "rgb:WORTHLESS"))).rejects.toMatchObject({
      code: "QUOTE_ASSET_MISMATCH",
      details: {
        requested: { fromAsset: "rgb:USDT", toAsset: "BTC" },
        returned: { fromAsset: "rgb:WORTHLESS", toAsset: "BTC" },
      },
    });
  });

  it("rejects a substituted toAsset", async () => {
    await expect(getQuote(path, toAsset(path, "rgb:WORTHLESS"))).rejects.toMatchObject({
      code: "QUOTE_ASSET_MISMATCH",
      details: {
        requested: { fromAsset: "rgb:USDT", toAsset: "BTC" },
        returned: { fromAsset: "rgb:USDT", toAsset: "rgb:WORTHLESS" },
      },
    });
  });

  it("requires an exact from-leg match when tolerance is 0", async () => {
    await expect(getQuote(path, fromAmount(path, 100_001), 0)).rejects.toMatchObject({
      code: "QUOTE_AMOUNT_DIVERGENCE",
    });
    await expect(getQuote(path, fromAmount(path, 100_000), 0)).resolves.toMatchObject({
      fromAmount: 100_000,
    });
  });
});

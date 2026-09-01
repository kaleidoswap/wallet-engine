/** G-F2: lookup transport failure is not an in-flight payment. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkadeAdapter } from "../../src/adapters/ArkadeAdapter";
import { ArkadeWdkAdapter } from "../../src/adapters/wdk/ArkadeWdkAdapter";
import { RlnWdkAdapter } from "../../src/adapters/wdk/RlnWdkAdapter";
import { SparkWdkAdapter } from "../../src/adapters/wdk/SparkWdkAdapter";
import { arkadeClientManager } from "../../src/lib/arkade-client-manager";

function connected<T extends object>(adapter: T, account: Record<string, unknown>): T {
  Object.assign(adapter as object, { connected: true, account });
  return adapter;
}

afterEach(() => vi.restoreAllMocks());

describe("G-F2 payment status lookup failures", () => {
  it("returns unknown on every implementation that used to map a throw to pending", async () => {
    const fail = async () => {
      throw new Error("lookup unavailable");
    };
    const spark = connected(new SparkWdkAdapter(), { getTransactionReceipt: fail });
    const arkadeWdk = connected(new ArkadeWdkAdapter(), { getTransactionReceipt: fail });
    const rln = connected(new RlnWdkAdapter(), { listPayments: fail });

    vi.spyOn(arkadeClientManager, "isInitialized").mockReturnValue(true);
    vi.spyOn(arkadeClientManager, "getWallet").mockReturnValue({
      getTransactionHistory: fail,
    } as never);
    const arkade = new ArkadeAdapter();

    await expect(spark.getPaymentStatus("spark-id")).resolves.toMatchObject({ status: "unknown" });
    await expect(arkadeWdk.getPaymentStatus("ark-id")).resolves.toMatchObject({ status: "unknown" });
    await expect(rln.getPaymentStatus("rln-id")).resolves.toMatchObject({ status: "unknown" });
    await expect(arkade.getPaymentStatus("native-id")).resolves.toMatchObject({ status: "unknown" });
  });
});

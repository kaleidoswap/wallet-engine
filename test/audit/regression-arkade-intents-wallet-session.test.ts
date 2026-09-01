/**
 * Task 1: Arkade Intents owns a venue bound to an IWallet. A second wallet that
 * arrived while the module load was pending used to share the first wallet's
 * promise and inherit its signing venue.
 */
import { afterEach, describe, expect, it } from "vitest";
import { registerWdkModule } from "../../src/adapters/wdk/moduleLoader";
import { arkadeIntentsClientManager } from "../../src/lib/arkade-intents-client-manager";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ArkadeIntentsClientManager wallet-session guard", () => {
  afterEach(async () => {
    await arkadeIntentsClientManager.dispose();
  });

  it("does not serve wallet A's in-flight venue to wallet B", async () => {
    const firstLoad = deferred();
    const constructed: Array<{ wallet: unknown }> = [];
    let loads = 0;

    class FakeVenue {
      constructor(readonly options: { wallet: unknown }) {
        constructed.push(options);
      }
    }

    registerWdkModule("@kaleidorg/swap-sdk/arkade", async () => {
      loads += 1;
      if (loads === 1) await firstLoad.promise;
      return { ArkadeIntentsVenue: FakeVenue };
    });

    const walletA = { id: "wallet-a" } as never;
    const walletB = { id: "wallet-b" } as never;
    let closedA = 0;
    let closedB = 0;
    const initA = arkadeIntentsClientManager.initialize(walletA, {
      arkServerUrl: "https://ark.example",
      transport: { close: () => (closedA += 1) },
      store: {},
    });
    const initB = arkadeIntentsClientManager.initialize(walletB, {
      arkServerUrl: "https://ark.example",
      transport: { close: () => (closedB += 1) },
      store: {},
    });

    firstLoad.resolve();
    await Promise.all([initA, initB]);

    expect(loads).toBe(2);
    expect(constructed.map(({ wallet }) => wallet)).toEqual([walletB, walletA]);
    expect(
      (arkadeIntentsClientManager.getVenue() as unknown as FakeVenue).options.wallet,
    ).toBe(walletB);
    expect(closedA).toBe(1);
    expect(closedB).toBe(0);
  });
});

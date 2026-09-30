import { describe, expect, it, vi } from "vitest";

import { DirectoryLoader } from "../src/player/directory-loader.js";

describe("DirectoryLoader", () => {
  it("expires completed directory data after its bounded TTL", async () => {
    let now = 1_000;
    let loadCount = 0;
    const refreshModes: boolean[] = [];
    const loader = new DirectoryLoader<number>(
      async (forceRefresh: boolean): Promise<number> => {
        refreshModes.push(forceRefresh);
        loadCount += 1;
        return loadCount;
      },
      { ttlMs: 100, now: (): number => now },
    );

    await expect(loader.get()).resolves.toBe(1);
    now += 99;
    await expect(loader.get()).resolves.toBe(1);
    now += 1;
    await expect(loader.get()).resolves.toBe(2);
    expect(loadCount).toBe(2);
    expect(refreshModes).toEqual([false, true]);
  });

  it("bypasses the provider raw cache on signal-bound expiry too", async (): Promise<void> => {
    let now = 0;
    const load = vi.fn(async (forceRefresh: boolean): Promise<number> => forceRefresh ? 2 : 1);
    const loader = new DirectoryLoader<number>(load, { ttlMs: 100, now: (): number => now });
    await loader.get();
    now = 100;
    const signal = new AbortController().signal;
    await expect(loader.get(signal)).resolves.toBe(2);
    expect(load).toHaveBeenLastCalledWith(true, signal);
    await expect(loader.refreshAfterMiss()).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces forced refreshes and observes the miss cooldown", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let now = 0;
    let value = 1;
    const load = vi.fn(async (forceRefresh: boolean): Promise<number> => {
      if (forceRefresh) await gate;
      value += 1;
      return value;
    });
    const loader = new DirectoryLoader<number>(load, {
      ttlMs: 1_000,
      refreshCooldownMs: 50,
      now: (): number => now,
    });

    await expect(loader.get()).resolves.toBe(2);
    const first = loader.refreshAfterMiss();
    const second = loader.refreshAfterMiss();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([3, 3]);
    await expect(loader.refreshAfterMiss()).resolves.toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
    now += 50;
    await expect(loader.refreshAfterMiss()).resolves.toBe(4);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("lets one refresh waiter cancel without cancelling other consumers", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = vi.fn(async (forceRefresh: boolean): Promise<number> => {
      if (forceRefresh) await gate;
      return forceRefresh ? 2 : 1;
    });
    const loader = new DirectoryLoader<number>(load);
    await loader.get();
    const controller = new AbortController();
    const cancelled = loader.refreshAfterMiss(controller.signal);
    const surviving = loader.refreshAfterMiss();

    controller.abort(new Error("report deadline"));
    await expect(cancelled).rejects.toThrow("report deadline");
    release();
    await expect(surviving).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

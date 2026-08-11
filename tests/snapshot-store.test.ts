import { describe, expect, it, vi } from "vitest";

import { SnapshotStore, type SnapshotStoreOptions } from "../src/services/snapshot-store.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred promise handlers were not initialized.");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function storeOptions<T>(
  loader: SnapshotStoreOptions<T>["loader"],
  now: () => number,
  overrides: Partial<SnapshotStoreOptions<T>> = {},
): SnapshotStoreOptions<T> {
  return {
    loader,
    freshTtlMs: 100,
    maxStaleMs: 1_000,
    now,
    ...overrides,
  };
}

describe("SnapshotStore", () => {
  it("returns the in-memory value while it is fresh", async () => {
    let currentTime = 1_000;
    const loader = vi.fn<() => Promise<string>>().mockResolvedValue("snapshot-1");
    const store = new SnapshotStore(storeOptions(loader, () => currentTime));

    await expect(store.get()).resolves.toMatchObject({
      value: "snapshot-1",
      dataAgeMs: 0,
      stale: false,
      fetchedAt: new Date(1_000).toISOString(),
    });

    currentTime = 1_050;
    await expect(store.get()).resolves.toMatchObject({
      value: "snapshot-1",
      dataAgeMs: 50,
      stale: false,
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    const request = deferred<number>();
    const loader = vi.fn<() => Promise<number>>().mockReturnValue(request.promise);
    const store = new SnapshotStore(storeOptions(loader, () => 2_000));

    const first = store.get();
    const second = store.get();

    expect(loader).toHaveBeenCalledTimes(1);
    request.resolve(42);

    await expect(first).resolves.toMatchObject({ value: 42, stale: false });
    await expect(second).resolves.toMatchObject({ value: 42, stale: false });
  });

  it("returns stale data immediately while refreshing it in the background", async () => {
    let currentTime = 3_000;
    const refresh = deferred<string>();
    const loader = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("snapshot-1")
      .mockReturnValueOnce(refresh.promise);
    const store = new SnapshotStore(storeOptions(loader, () => currentTime));

    await store.preload();
    currentTime = 3_150;

    await expect(store.get()).resolves.toMatchObject({
      value: "snapshot-1",
      dataAgeMs: 150,
      stale: true,
    });
    expect(loader).toHaveBeenCalledTimes(2);

    refresh.resolve("snapshot-2");
    await refresh.promise;
    await expect(store.get()).resolves.toMatchObject({
      value: "snapshot-2",
      dataAgeMs: 0,
      stale: false,
    });
  });

  it("fails after the cached value exceeds the maximum stale age", async () => {
    let currentTime = 4_000;
    const loader = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("snapshot-1")
      .mockRejectedValue(new Error("upstream unavailable"));
    const store = new SnapshotStore(storeOptions(loader, () => currentTime, {
      onBackgroundError: vi.fn<(error: unknown) => void>(),
    }));

    await store.preload();
    currentTime = 4_150;
    await expect(store.get()).resolves.toMatchObject({ value: "snapshot-1", stale: true });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));

    currentTime = 5_001;
    await expect(store.get()).rejects.toThrow("upstream unavailable");
    expect(loader).toHaveBeenCalledTimes(3);
  });
});

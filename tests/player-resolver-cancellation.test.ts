import { describe, expect, it, vi } from "vitest";

import { PlayerResolver } from "../src/player/resolver.js";
import type { PlayerStatsResponse } from "../src/schemas/player.js";
import { readPlayerStatsFixture } from "./helpers.js";

describe("PlayerResolver cancellation single-flight", () => {
  it("shares one directory load for simultaneous lookups with the same signal", async () => {
    let release: () => void = () => undefined;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const response = readPlayerStatsFixture();
    const getPlayerStats = vi.fn(async (): Promise<PlayerStatsResponse> => {
      await loading;
      return response;
    });
    const resolver = new PlayerResolver({ getPlayerStats });
    const controller = new AbortController();

    const first = resolver.resolvePlayer("Damon Heta", controller.signal);
    const second = resolver.resolvePlayer("Robert Thornton", controller.signal);
    await vi.waitFor(() => expect(getPlayerStats).toHaveBeenCalledTimes(1));
    release();

    await expect(first).resolves.toMatchObject({ name: "Damon Heta" });
    await expect(second).resolves.toMatchObject({ name: "Robert Thornton" });
    expect(getPlayerStats).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected signal-owned load so a later lookup can retry", async () => {
    const response = readPlayerStatsFixture();
    const getPlayerStats = vi.fn<(signal?: AbortSignal) => Promise<PlayerStatsResponse>>()
      .mockRejectedValueOnce(new Error("temporary directory failure"))
      .mockResolvedValueOnce(response);
    const resolver = new PlayerResolver({ getPlayerStats });
    const controller = new AbortController();

    await expect(resolver.resolvePlayer("Damon Heta", controller.signal)).rejects.toThrow("temporary directory failure");
    await expect(resolver.resolvePlayer("Damon Heta", controller.signal)).resolves.toMatchObject({ name: "Damon Heta" });
    expect(getPlayerStats).toHaveBeenCalledTimes(2);
  });

  it("keeps independent signal-owned loads isolated", async () => {
    let releaseFirst: () => void = () => undefined;
    let releaseSecond: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = new AbortController();
    const second = new AbortController();
    const response = readPlayerStatsFixture();
    const getPlayerStats = vi.fn(async (signal?: AbortSignal): Promise<PlayerStatsResponse> => {
      if (signal === first.signal) await firstGate;
      if (signal === second.signal) await secondGate;
      return response;
    });
    const resolver = new PlayerResolver({ getPlayerStats });

    const firstResult = resolver.resolvePlayer("Damon Heta", first.signal);
    const secondResult = resolver.resolvePlayer("Robert Thornton", second.signal);
    await vi.waitFor(() => expect(getPlayerStats).toHaveBeenCalledTimes(2));
    releaseFirst();
    releaseSecond();

    await expect(firstResult).resolves.toMatchObject({ name: "Damon Heta" });
    await expect(secondResult).resolves.toMatchObject({ name: "Robert Thornton" });
    expect(getPlayerStats).toHaveBeenCalledTimes(2);
  });
});

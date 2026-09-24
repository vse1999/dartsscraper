import { describe, expect, it, vi } from "vitest";

import { InsufficientMatchDataError } from "../src/errors.js";
import { PlayerMatchesService } from "../src/services/player-matches.js";
import type { Match } from "../src/schemas/match.js";

const matches: Match[] = [
  { date: "2026-01-02", tournament: "Example", round: null, result: "Won", opponent: "One", score: "6 V 1", average: 91.2 },
  { date: "2026-01-01", tournament: "Example", round: "Final", result: "Lost", opponent: "Two", score: "4 V 6", average: null },
];

describe("player match service", () => {
  it("returns fewer than the requested limit when fewer matches exist", async () => {
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer: async () => ({ id: 1, name: "Example", slug: "example" }) },
      scraper: { getPlayerMatches: async () => matches },
    });

    await expect(service.getLastMatches("Example", 10)).resolves.toEqual({
      player: { id: 1, name: "Example", slug: "example" },
      matches,
    });
  });

  it("raises insufficient-data error when there are no completed matches", async () => {
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer: async () => ({ id: 1, name: "Example", slug: "example" }) },
      scraper: { getPlayerMatches: async () => [] },
    });

    await expect(service.getLastMatches("Example", 10)).rejects.toBeInstanceOf(InsufficientMatchDataError);
  });

  it("shares one player scrape across simultaneous identical requests", async () => {
    const getPlayerMatches = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return matches;
    });
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer: async () => ({ id: 1, name: "Example", slug: "example" }) },
      scraper: { getPlayerMatches },
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const [first, second] = await Promise.all([
      service.getLastMatches("Example", 2),
      service.getLastMatches("Example", 2),
    ]);

    expect(first).toEqual(second);
    expect(getPlayerMatches).toHaveBeenCalledTimes(1);
    expect(getPlayerMatches).toHaveBeenCalledWith(
      { id: 1, name: "Example", slug: "example" },
      2,
      "2026-08-12",
    );
  });

  it("reuses an existing snapshot for a cancellable consumer", async () => {
    const getPlayerMatches = vi.fn(async () => matches);
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer: async () => ({ id: 1, name: "Example", slug: "example" }) },
      scraper: { getPlayerMatches },
      now: () => new Date("2026-08-11T12:00:00Z"),
    });
    await service.getLastMatches("Example", 2);

    const controller = new AbortController();
    await expect(service.getLastMatches("Example", 2, controller.signal)).resolves.toEqual({
      player: { id: 1, name: "Example", slug: "example" },
      matches,
    });
    expect(getPlayerMatches).toHaveBeenCalledTimes(1);
  });

  it("uses an isolated signal load instead of refreshing an expired store", async () => {
    let currentTime = Date.parse("2026-08-11T12:00:00Z");
    const resolvePlayer = vi.fn(async (_name: string, signal?: AbortSignal) => {
      if (signal === undefined) return { id: 1, name: "Example", slug: "example" };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason instanceof Error ? signal.reason : new Error("cancelled");
    });
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer },
      scraper: { getPlayerMatches: async () => matches },
      freshTtlMs: 100,
      maxStaleMs: 200,
      now: () => new Date(currentTime),
    });
    await service.getLastMatches("Example", 2);

    currentTime += 201;
    const controller = new AbortController();
    const pending = service.getLastMatches("Example", 2, controller.signal);
    await vi.waitFor(() => expect(resolvePlayer).toHaveBeenCalledTimes(2));
    controller.abort(new Error("expired snapshot deadline"));

    await expect(pending).rejects.toThrow("expired snapshot deadline");
    expect(resolvePlayer).toHaveBeenNthCalledWith(2, "Example", controller.signal);
  });

  it("keeps the shared snapshot valid when an isolated consumer is cancelled", async () => {
    let releaseShared: () => void = () => undefined;
    const sharedGate = new Promise<void>((resolve) => { releaseShared = resolve; });
    const resolvePlayer = vi.fn(async (_name: string, signal?: AbortSignal) => {
      if (signal !== undefined) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason instanceof Error ? signal.reason : new Error("cancelled");
      }
      await sharedGate;
      return { id: 1, name: "Example", slug: "example" };
    });
    const getPlayerMatches = vi.fn(async () => matches);
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer },
      scraper: { getPlayerMatches },
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const shared = service.getLastMatches("Example", 2);
    const controller = new AbortController();
    const cancelled = service.getLastMatches("Example", 2, controller.signal);
    controller.abort(new Error("snapshot deadline"));
    await expect(cancelled).rejects.toThrow("snapshot deadline");
    releaseShared();
    await expect(shared).resolves.toMatchObject({ player: { name: "Example" } });
    await expect(service.getLastMatches("Example", 2)).resolves.toMatchObject({ player: { name: "Example" } });
    expect(getPlayerMatches).toHaveBeenCalledTimes(1);
  });

  it("uses the Budapest calendar date for the completed-match cutoff", async () => {
    const getPlayerMatches = vi.fn(async () => matches);
    const service = new PlayerMatchesService({
      resolver: { resolvePlayer: async () => ({ id: 1, name: "Example", slug: "example" }) },
      scraper: { getPlayerMatches },
      now: () => new Date("2026-09-10T22:30:00Z"),
    });

    await service.getLastMatches("Example", 2);

    expect(getPlayerMatches).toHaveBeenCalledWith(
      { id: 1, name: "Example", slug: "example" },
      2,
      "2026-09-12",
    );
  });
});

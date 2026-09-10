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

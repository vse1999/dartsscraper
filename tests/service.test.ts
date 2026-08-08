import { describe, expect, it } from "vitest";

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
});

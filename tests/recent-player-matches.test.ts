import { describe, expect, it, vi } from "vitest";

import type { DartsOrakelMatchRequestOptions } from "../src/dartsorakel/client.js";
import type { DartsOrakelMatchesResponse } from "../src/dartsorakel/parser.js";
import { parseDartsOrakelMatches } from "../src/dartsorakel/parser.js";
import { DartsOrakelScraper } from "../src/dartsorakel/scraper.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import { readMatchFixture } from "./helpers.js";

const player: PlayerIdentity = { id: 29, name: "Rob Cross", slug: "rob-cross" };

describe("bounded DartsOrakel player history", () => {
  it("starts at 90 days and stops expanding as soon as enough completed matches exist", async () => {
    const fixture = readMatchFixture("rob-cross-matches.json");
    const requests: DartsOrakelMatchRequestOptions[] = [];
    const getPlayerMatches = vi.fn(async (_playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> => {
      requests.push(options);
      const count = requests.length === 1 ? 2 : 5;
      return responseWithRows(fixture, count);
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const matches = await scraper.getRecentPlayerMatches(player, { limit: 5 });

    expect(matches).toHaveLength(5);
    expect(requests).toEqual([
      { dateFrom: "2026-05-14", dateTo: "2026-08-12", limit: 50 },
      { dateFrom: "2026-02-13", dateTo: "2026-08-12", limit: 50 },
    ]);
  });

  it("preserves the same newest matches as a complete-history parse", async () => {
    const fixture = readMatchFixture("rob-cross-matches.json");
    const getPlayerMatches = vi.fn(async (_playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> => {
      const dateFrom = options.dateFrom ?? "1900-01-01";
      const rows = fixture.data.filter((row) => row.match_date.slice(0, 10) >= dateFrom);
      return { ...fixture, recordsTotal: rows.length, recordsFiltered: rows.length, data: rows };
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });
    const full = parseDartsOrakelMatches(player, fixture);

    const recent = await scraper.getRecentPlayerMatches(player, { limit: 10 });

    expect(recent.slice(0, 10)).toEqual(full.slice(0, 10));
    expect(getPlayerMatches).toHaveBeenCalledTimes(1);
  });

  it("uses complete history only after all bounded windows are insufficient", async () => {
    const fixture = readMatchFixture("rob-cross-matches.json");
    const getPlayerMatches = vi.fn(async (_playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> => {
      return options.dateFrom === "1900-01-01" ? fixture : responseWithRows(fixture, 1);
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const matches = await scraper.getRecentPlayerMatches(player, { limit: 1_000 });

    expect(matches.length).toBeGreaterThan(1);
    expect(getPlayerMatches).toHaveBeenCalledTimes(5);
    expect(getPlayerMatches).toHaveBeenLastCalledWith(29, {
      dateFrom: "1900-01-01",
      dateTo: "2026-08-12",
      limit: 1_000,
    });
  });
});

function responseWithRows(fixture: DartsOrakelMatchesResponse, count: number): DartsOrakelMatchesResponse {
  const rows = fixture.data.slice(0, count);
  return { ...fixture, recordsTotal: rows.length, recordsFiltered: rows.length, data: rows };
}

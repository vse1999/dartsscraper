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
      const averageRequestCount = requests.filter((request) => request.statistic === undefined || request.statistic === "average").length;
      const count = averageRequestCount === 1 ? 2 : 5;
      return responseForStatistic(responseWithRows(fixture, count), options.statistic);
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const matches = await scraper.getRecentPlayerMatches(player, { limit: 5 });

    expect(matches).toHaveLength(5);
    expect(requests.filter((request) => request.statistic === undefined)).toEqual([
      { dateFrom: "2026-05-14", dateTo: "2026-08-12", limit: 50 },
      { dateFrom: "2026-02-13", dateTo: "2026-08-12", limit: 50 },
    ]);
    expect(requests.slice(-2).map((request) => request.statistic)).toEqual(["oneEighties", "checkoutPercentage"]);
  });

  it("preserves the same newest matches as a complete-history parse", async () => {
    const fixture = readMatchFixture("rob-cross-matches.json");
    const getPlayerMatches = vi.fn(async (_playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> => {
      const dateFrom = options.dateFrom ?? "1900-01-01";
      const rows = fixture.data.filter((row) => row.match_date.slice(0, 10) >= dateFrom);
      return responseForStatistic(
        { ...fixture, recordsTotal: rows.length, recordsFiltered: rows.length, data: rows },
        options.statistic,
      );
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });
    const full = parseDartsOrakelMatches(player, fixture);

    const recent = await scraper.getRecentPlayerMatches(player, { limit: 10 });

    expect(recent.slice(0, 10).map(coreMatch)).toEqual(full.slice(0, 10).map(coreMatch));
    expect(getPlayerMatches).toHaveBeenCalledTimes(3);
  });

  it("uses complete history only after all bounded windows are insufficient", async () => {
    const fixture = readMatchFixture("rob-cross-matches.json");
    const getPlayerMatches = vi.fn(async (_playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> => {
      const response = options.dateFrom === "1900-01-01" ? fixture : responseWithRows(fixture, 1);
      return responseForStatistic(response, options.statistic);
    });
    const scraper = new DartsOrakelScraper({ getPlayerMatches }, {
      now: () => new Date("2026-08-11T12:00:00Z"),
    });

    const matches = await scraper.getRecentPlayerMatches(player, { limit: 1_000 });

    expect(matches.length).toBeGreaterThan(1);
    expect(getPlayerMatches).toHaveBeenCalledTimes(7);
    expect(getPlayerMatches).toHaveBeenNthCalledWith(5, 29, {
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

function responseForStatistic(
  response: DartsOrakelMatchesResponse,
  statistic: DartsOrakelMatchRequestOptions["statistic"],
): DartsOrakelMatchesResponse {
  if (statistic === undefined || statistic === "average") return response;
  return {
    ...response,
    data: response.data.map((row, index) => {
      if (statistic === "oneEighties") {
        const count = index % 3;
        return { ...row, stat: count, stat1: count, stat2: null };
      }
      const hits = index % 3;
      const attempts = hits + 1;
      return {
        ...row,
        stat: `${((hits / attempts) * 100).toFixed(2)}%`,
        stat1: hits,
        stat2: attempts,
      };
    }),
  };
}

function coreMatch(match: ReturnType<typeof parseDartsOrakelMatches>[number]): object {
  return {
    date: match.date,
    tournament: match.tournament,
    round: match.round,
    result: match.result,
    opponent: match.opponent,
    score: match.score,
    average: match.average,
  };
}

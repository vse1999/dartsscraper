import { describe, expect, it } from "vitest";
import { DartsAgentToolExecutor } from "../src/agent/tools.js";
import type { MatchResult } from "../src/schemas/match.js";
import type { ModusResultsSnapshot } from "../src/modus/results-schemas.js";

function matchResult(limit: number): MatchResult {
  return {
    player: { id: 1, name: "Test Player", slug: "test-player" },
    matches: Array.from({ length: limit }, (_value, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`, tournament: "Example", round: null,
      result: "Won" as const, opponent: `Opponent ${index}`, score: "4 V 0", average: 80 + index,
    })),
  };
}
function executor(failure?: Error): DartsAgentToolExecutor {
  return new DartsAgentToolExecutor({
    modusService: { getModusPlayers: async (date) => ({ event: "MODUS Super Series", date, players: [] }) },
    modusResultsService: { getResults: async (date) => modusSnapshot(date) },
    playerMatchesService: { getLastMatches: async (_player, limit) => { if (failure !== undefined) throw failure; return matchResult(limit); } },
    now: () => new Date("2026-08-08T12:00:00Z"),
  });
}
function modusSnapshot(date: string): ModusResultsSnapshot {
  return {
    event: "MODUS Super Series",
    date,
    generatedAt: `${date}T12:00:00Z`,
    fetchedAt: `${date}T12:00:01Z`,
    context: { seriesId: "26", seriesName: "Series 15", weekId: "192", weekName: "Week 2", group: "Group A" },
    matches: [{
      id: "sr:sport_event:1", matchNumber: 1, startTime: `${date}T08:38:00Z`, status: "completed",
      home: { name: "Jack Drayton", score: 4, average: 91.58 },
      away: { name: "Ryan Branley", score: 2, average: 81 },
    }],
    weekAverages: [{ position: 1, player: "Jack Drayton", played: 5, points: 13_139, darts: 447, average: 88.18 }],
    source: {
      dailyFeedUrl: "https://modussuperseries.com/live-scores-json.php",
      resultsUrl: "https://modussuperseries.com/results.php",
      weekAveragesUrl: "https://modussuperseries.com/week-averages.php?series_id=26&week_id=192",
    },
    warnings: [],
  };
}

describe("agent tools", () => {
  it.each([[5, 82], [10, 84.5], [20, 89.5]])("calculates the last %i match average deterministically", async (limit, expected) => {
    await expect(executor().execute({ name: "getPlayerMatchAverage", arguments: { player: "Test Player", limit } })).resolves.toEqual({
      ok: true, data: { player: "Test Player", requestedLimit: limit, matchCount: limit, average: expected },
    });
  });
  it("returns a structured error for an unresolved player", async () => {
    const result = await executor(new Error("No DartsOrakel player matched \"Missing\".")).execute({ name: "getPlayerMatchAverage", arguments: { player: "Missing", limit: 10 } });
    expect(result).toEqual({ ok: false, error: { code: "TOOL_FAILED", message: "No DartsOrakel player matched \"Missing\"." } });
  });
  it("returns a structured error when DartsOrakel is unavailable", async () => {
    const result = await executor(new Error("DartsOrakel request failed with HTTP 503.")).execute({ name: "getPlayerMatches", arguments: { player: "Test", limit: 10 } });
    expect(result).toMatchObject({ ok: false, error: { code: "TOOL_FAILED" } });
  });
  it("rejects malformed tool arguments", async () => {
    const result = await executor().execute({ name: "getPlayerMatchAverage", arguments: "not-json" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });
  it("rejects a nonexistent tool", async () => {
    await expect(executor().execute({ name: "deleteEverything", arguments: {} })).resolves.toEqual({
      ok: false, error: { code: "UNKNOWN_TOOL", message: "Tool \"deleteEverything\" does not exist." },
    });
  });
  it("resolves a Hungarian weekday through a deterministic tool", async () => {
    const result = await executor().execute({ name: "resolveDate", arguments: { expression: "hétfői" } });
    expect(result).toMatchObject({ ok: true, data: { date: "2026-08-10" } });
  });
  it("returns one authoritative official MODUS result snapshot", async () => {
    const result = await executor().execute({ name: "getModusResults", arguments: { date: "2026-08-10" } });
    expect(result).toMatchObject({
      ok: true,
      data: { date: "2026-08-10", matches: [{ home: { average: 91.58 }, away: { average: 81 } }], weekAverages: [{ average: 88.18 }] },
    });
  });
  it("forwards cancellation to the official MODUS results service", async () => {
    let receivedSignal: AbortSignal | undefined;
    const toolExecutor = new DartsAgentToolExecutor({
      modusService: { getModusPlayers: async (date) => ({ event: "MODUS Super Series", date, players: [] }) },
      modusResultsService: {
        getResults: async (date, signal) => {
          receivedSignal = signal;
          return modusSnapshot(date);
        },
      },
      playerMatchesService: { getLastMatches: async (_player, limit) => matchResult(limit) },
    });
    const controller = new AbortController();

    await toolExecutor.execute({ name: "getModusResults", arguments: { date: "2026-08-10" } }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});

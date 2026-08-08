import { describe, expect, it } from "vitest";
import { DartsAgentToolExecutor } from "../src/agent/tools.js";
import type { MatchResult } from "../src/schemas/match.js";

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
    playerMatchesService: { getLastMatches: async (_player, limit) => { if (failure !== undefined) throw failure; return matchResult(limit); } },
    now: () => new Date("2026-08-08T12:00:00Z"),
  });
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
});

import { describe, expect, it, vi } from "vitest";
import { DartsOrakelRequestError, PlayerNotFoundError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import type { ModusPlayerHistoryResult } from "../src/modus/player-history-service.js";
import type { MatchResult } from "../src/schemas/match.js";
import { DartsPlayerStatsService, SourceRoutedPlayerStatsService, type PlayerStatsReader } from "../src/telegram/stats-service.js";

function testLogger(): Logger & { readonly info: ReturnType<typeof vi.fn>; readonly warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function matches(): MatchResult {
  return {
    player: { id: 13, name: "Damon Heta", slug: "damon-heta" },
    matches: [{ date: "2026-09-30", tournament: "Test", round: "Final", result: "Won", opponent: "Opponent", score: "6-3", average: 90 }],
  };
}

describe("player statistics outcome observability", (): void => {
  it("reports source and actual coverage without player names or raw input", async (): Promise<void> => {
    const logger = testLogger();
    const service = new DartsPlayerStatsService({ getLastMatches: async (): Promise<MatchResult> => matches() }, logger);
    const result = await service.getPlayerStats("private request spelling", 10);
    expect(result.playerName).toBe("Damon Heta");
    expect(logger.info).toHaveBeenCalledWith("player_research_outcome", expect.objectContaining({
      provider: "dartsorakel", outcome: "available", returnedMatches: 1, requestedMatches: 10, availableAverages: 1,
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private request|Damon Heta/u);
  });

  it("preserves the identity-miss error and does not log sensitive error contents", async (): Promise<void> => {
    const logger = testLogger();
    const error = new PlayerNotFoundError("sensitive request");
    const service = new DartsPlayerStatsService({ getLastMatches: async (): Promise<MatchResult> => { throw error; } }, logger);
    await expect(service.getPlayerStats("sensitive request", 10)).rejects.toBe(error);
    expect(logger.warn).toHaveBeenCalledWith("player_research_outcome", expect.objectContaining({ outcome: "identity_not_found" }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("sensitive");
  });

  it("classifies rate limiting separately from identity absence", async (): Promise<void> => {
    const logger = testLogger();
    const error = new DartsOrakelRequestError("sensitive provider text", { url: "https://dartsorakel.com/test", status: 429, retryable: true });
    const service = new DartsPlayerStatsService({ getLastMatches: async (): Promise<MatchResult> => { throw error; } }, logger);
    await expect(service.getPlayerStats("Damon Heta", 10)).rejects.toBe(error);
    expect(logger.warn).toHaveBeenCalledWith("player_research_outcome", expect.objectContaining({ outcome: "source_rate_limited" }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("sensitive");
  });

  it("forwards cancellation to official MODUS without routing to another provider", async (): Promise<void> => {
    const controller = new AbortController();
    const findPlayerHistory = vi.fn(async (): Promise<ModusPlayerHistoryResult> => ({
      playerName: "Damon Heta", matches: matches().matches, sourceUrl: "https://modussuperseries.com/results.php", evidenceUrls: [],
    }));
    const darts: PlayerStatsReader = { getPlayerStats: vi.fn() };
    const service = new SourceRoutedPlayerStatsService({ findPlayerHistory }, darts, testLogger());
    const result = await service.getPlayerStats("Damon Heta", 10, "modus", controller.signal);
    expect(findPlayerHistory).toHaveBeenCalledWith("Damon Heta", 10, { forceLiveLookup: true, signal: controller.signal });
    expect(darts.getPlayerStats).not.toHaveBeenCalled();
    expect(result.provider).toBe("modus-official");
  });
});

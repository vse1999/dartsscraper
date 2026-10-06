import { describe, expect, it, vi } from "vitest";
import { DartsOrakelRequestError, PlayerNotFoundError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import type { ModusPlayerHistoryResult } from "../src/modus/player-history-service.js";
import type { MatchResult } from "../src/schemas/match.js";
import type { ResearchEvidenceReference } from "../src/research/history-service.js";
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

function evidenceReference(playerId: number): ResearchEvidenceReference {
  return {
    playerId,
    id: "snapshot-test",
    observedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    sourceObservation: "normalized-response",
    persistence: "memory",
    stale: false,
    quality: {
      identity: "canonical",
      sourceFreshness: "unknown",
      completeness: "unknown",
      ordering: "date-ordered",
      comparability: "unknown-format",
    },
  };
}

describe("player statistics outcome observability", (): void => {
  it("withholds rejected MODUS rows rather than returning contradictory statistics", async (): Promise<void> => {
    const darts: PlayerStatsReader = { getPlayerStats: vi.fn() };
    const findPlayerHistory = async (): Promise<ModusPlayerHistoryResult> => ({
      playerName: "Damon Heta", matches: matches().matches.map((row) => ({ ...row, date: "2099-01-01" })),
      sourceUrl: "https://modussuperseries.com/results.php", evidenceUrls: [],
    });
    const service = new SourceRoutedPlayerStatsService({ findPlayerHistory }, darts, testLogger());
    await expect(service.getPlayerStats("Damon Heta", 10, "modus")).rejects.toThrow("Research evidence rejected");
    expect(darts.getPlayerStats).not.toHaveBeenCalled();
  });
  it("reports source and actual coverage without player names or raw input", async (): Promise<void> => {
    const logger = testLogger();
    const service = new DartsPlayerStatsService({ getLastMatches: async (): Promise<MatchResult> => matches() }, logger);
    const result = await service.getPlayerStats("private request spelling", 10);
    expect(result.playerName).toBe("Damon Heta");
    expect(result.assessment?.validity.status).toBe("valid");
    expect(result.assessment?.dimensions.identity).toBe("unknown");
    expect(logger.info).toHaveBeenCalledWith("player_research_outcome", expect.objectContaining({
      provider: "dartsorakel", outcome: "available", returnedMatches: 1, requestedMatches: 10, availableAverages: 1,
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/private request|Damon Heta/u);
  });

  it("rejects snapshot evidence for a different canonical player ID", async (): Promise<void> => {
    const value = matches();
    const service = new DartsPlayerStatsService({
      getLastMatches: async (): Promise<MatchResult> => value,
      getLastMatchesSnapshot: async () => ({
        value,
        fetchedAt: "2026-09-30T12:00:00.000Z",
        dataAgeMs: 0,
        stale: false,
        evidence: evidenceReference(value.player.id + 1),
      }),
    }, testLogger());

    await expect(service.getPlayerStats("Damon Heta", 10)).rejects.toThrow("Research evidence rejected; statistics are unavailable.");
  });

  it("accepts snapshot evidence matching the canonical player ID", async (): Promise<void> => {
    const value = matches();
    const service = new DartsPlayerStatsService({
      getLastMatches: async (): Promise<MatchResult> => value,
      getLastMatchesSnapshot: async () => ({
        value,
        fetchedAt: "2026-09-30T12:00:00.000Z",
        dataAgeMs: 0,
        stale: false,
        evidence: evidenceReference(value.player.id),
      }),
    }, testLogger());

    const result = await service.getPlayerStats("Damon Heta", 10);
    expect(result.assessment?.validity.status).toBe("valid");
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

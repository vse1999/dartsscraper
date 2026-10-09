import { describe, expect, it, vi } from "vitest";
import { ReportDeadlineExceededError } from "../src/daily/report-budget.js";
import { noopLogger } from "../src/logger.js";
import { PdcTournamentService, type PdcPlayerStats, type PdcPlayerStatsReader, type PdcUpcomingReport } from "../src/pdc/service.js";
import type { PdcFixture } from "../src/pdc/schemas.js";

function stats(name: string): PdcPlayerStats {
  return { playerName: name, requestedCount: 10, matches: [{ date: "2026-10-08", tournament: "Test", round: null, opponent: "Other", score: "6-3", result: "Won", average: 95 }], meanAverage: 95, availableAverageCount: 1, sourceUrl: "https://dartsorakel.com/player/details/1/example", sourceLabel: "DartsOrakel", provider: "dartsorakel", evidenceUrls: [] };
}
function service(reader: PdcPlayerStatsReader, count: number = 32): PdcTournamentService {
  const fixtures: PdcFixture[] = Array.from({ length: count / 2 }, (_, index): PdcFixture => ({ id: String(index), date: "2026-10-09", tournamentName: "Swiss Darts Trophy", startTime: null, session: null, round: null, playerOne: `Player ${index * 2}`, playerTwo: `Player ${index * 2 + 1}`, sourceUrl: "https://www.pdc.tv/matches" }));
  return new PdcTournamentService({ source: { getCalendar: async () => [], getResults: async () => { throw new Error("Not used"); } }, fixtureSource: { name: "test", getFixtures: async () => fixtures }, playerStats: reader, logger: noopLogger });
}

describe("progressive PDC player coverage", () => {
  it("reads all 32 base histories before enriching any player", async () => {
    const order: string[] = [];
    const reader: PdcPlayerStatsReader = {
      getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => { order.push(`base:${name}`); return stats(name); },
      getPlayerStats: async (name: string): Promise<PdcPlayerStats> => { order.push(`full:${name}`); return { ...stats(name), matches: stats(name).matches.map((match) => ({ ...match, oneEighties: 3, checkoutPercentage: 50, checkoutHits: 6, checkoutAttempts: 12 })) }; },
    };
    const result = await service(reader).getUpcomingReportForDate("2026-10-09");
    expect(order.slice(0, 32).every((call) => call.startsWith("base:"))).toBe(true);
    expect(result.players).toHaveLength(32);
    expect(result.players.every((player) => player.stats !== null && player.failureCode === null)).toBe(true);
    expect(result.players[0]?.stats?.matches[0]?.oneEighties).toBe(3);
  });

  it("retains every player's average/history when enrichment hits the report deadline", async () => {
    const controller = new AbortController();
    const partials: PdcUpcomingReport[] = [];
    const reader: PdcPlayerStatsReader = {
      getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => stats(name),
      getPlayerStats: async (): Promise<PdcPlayerStats> => new Promise<PdcPlayerStats>(() => {}),
    };
    const work = service(reader).getUpcomingReportForDate("2026-10-09", controller.signal, (report: PdcUpcomingReport): void => { partials.push(report); });
    await vi.waitFor(() => expect(partials.some((report) => report.players.every((player) => player.stats !== null))).toBe(true));
    controller.abort(new ReportDeadlineExceededError("research"));
    const result = await work;
    expect(result.players.every((player) => player.stats?.meanAverage === 95)).toBe(true);
    expect(result.players.every((player) => player.failureCode === "timeout")).toBe(true);
    expect(partials.at(-1)?.players.every((player) => player.stats !== null)).toBe(true);
    expect(result.players[0]?.stats?.matches[0]?.oneEighties).toBeUndefined();
  });

  it("keeps usable base data on optional enrichment errors, without inventing metrics", async () => {
    const reader: PdcPlayerStatsReader = { getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => stats(name), getPlayerStats: async (): Promise<PdcPlayerStats> => { throw new Error("Checkout endpoint unavailable"); } };
    const result = await service(reader, 2).getUpcomingReportForDate("2026-10-09");
    expect(result.players.every((player) => player.stats?.meanAverage === 95 && player.failureCode === "unavailable")).toBe(true);
    expect(result.players[0]?.stats?.matches[0]?.checkoutPercentage).toBeUndefined();
  });

  it("does not repeatedly request a genuine base identity/history failure", async () => {
    const getPlayerStats = vi.fn(async (name: string): Promise<PdcPlayerStats> => stats(name));
    const reader: PdcPlayerStatsReader = { getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => { if (name === "Player 0") throw new Error("Player absent"); return stats(name); }, getPlayerStats };
    const result = await service(reader, 2).getUpcomingReportForDate("2026-10-09");
    expect(getPlayerStats).toHaveBeenCalledTimes(1);
    expect(getPlayerStats).toHaveBeenCalledWith("Player 1", 10, "dartsorakel", undefined);
    expect(result.players[0]).toMatchObject({ stats: null, failureCode: "unavailable" });
  });

  it("preserves completed base histories when cancellation occurs during the base pass", async () => {
    const controller = new AbortController();
    const getPlayerStats = vi.fn(async (name: string): Promise<PdcPlayerStats> => stats(name));
    let count = 0;
    const reader: PdcPlayerStatsReader = { getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => { count += 1; if (count > 4) return new Promise<PdcPlayerStats>(() => {}); return stats(name); }, getPlayerStats };
    const work = service(reader).getUpcomingReportForDate("2026-10-09", controller.signal);
    await vi.waitFor(() => expect(count).toBe(8));
    controller.abort(new ReportDeadlineExceededError("research"));
    const result = await work;
    expect(result.players.slice(0, 4).every((player) => player.stats !== null)).toBe(true);
    expect(getPlayerStats).not.toHaveBeenCalled();
    expect(result.players).toHaveLength(32);
  });

  it("preserves a genuine late base failure instead of relabelling it unstarted at enrichment timeout", async () => {
    const controller = new AbortController();
    const partials: PdcUpcomingReport[] = [];
    const reader: PdcPlayerStatsReader = {
      getPlayerStatsBase: async (name: string): Promise<PdcPlayerStats> => { if (name === "Player 31") throw new Error("Player absent"); return stats(name); },
      getPlayerStats: async (): Promise<PdcPlayerStats> => new Promise<PdcPlayerStats>(() => {}),
    };
    const work = service(reader).getUpcomingReportForDate("2026-10-09", controller.signal, (report: PdcUpcomingReport): void => { partials.push(report); });
    await vi.waitFor(() => expect(partials.some((report) => report.players[31]?.failureCode === "unavailable")).toBe(true));
    controller.abort(new ReportDeadlineExceededError("research"));
    expect((await work).players[31]).toMatchObject({ stats: null, failureCode: "unavailable" });
  });
});

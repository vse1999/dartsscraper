import { describe, expect, it, vi } from "vitest";
import { DefaultValueReader } from "../src/value/reader.js";
import type { OddsMatch, OddsReport } from "../src/odds/contracts.js";
import type { Match } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { ValuePlayerDirectory } from "../src/value/contracts.js";

const alice: PlayerIdentity = { id: 1, name: "Alice Smith", slug: "alice-smith" };
const bob: PlayerIdentity = { id: 2, name: "Bob Jones", slug: "bob-jones" };
const noppert: PlayerIdentity = { id: 4, name: "Danny Noppert", slug: "danny-noppert" };
const joyce: PlayerIdentity = { id: 5, name: "Ryan Joyce", slug: "ryan-joyce" };
const oddsMatch = (player1 = "A. Smith", player2 = "Bob Jones"): OddsMatch => ({
  eventId: `${player1}-${player2}`,
  competition: "Test",
  player1,
  player2,
  odds1: 2.2,
  odds2: 1.7,
  bookmaker: "TippmixPro",
  scheduledTime: "20:00",
  sourceUrl: "https://www.eredmenyek.com/event",
});
const odds = (matches: readonly OddsMatch[]): OddsReport => ({
  source: "eredmenyek",
  sourceUrl: "https://www.eredmenyek.com/darts/oddsok/",
  observedAt: "2026-09-30T12:00:00.000Z",
  date: "2026-09-30",
  timeZone: "Europe/Budapest",
  matches,
  warnings: [],
});
function history(player: PlayerIdentity, count = 20, withMetrics = true): PlayerStatsResult {
  const matches: Match[] = Array.from({ length: count }, (_, index): Match => ({
    date: `2026-09-${String(30 - Math.floor(index / 2)).padStart(2, "0")}`,
    tournament: "Test",
    round: "Final",
    result: "Won",
    opponent: "Opponent",
    score: `6-${3 + index}`,
    average: withMetrics ? 90 + index : null,
    oneEighties: withMetrics ? index % 3 : null,
    checkoutHits: withMetrics ? 2 : null,
    checkoutAttempts: withMetrics ? 4 : null,
    checkoutPercentage: withMetrics ? 50 : null,
  }));
  return {
    playerName: player.name,
    requestedCount: 20,
    matches,
    meanAverage: 0,
    availableAverageCount: matches.length,
    sourceUrl: `https://dartsorakel.com/player/details/${player.id}/${player.slug}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}
function resultWithMatches(player: PlayerIdentity, matches: readonly Match[]): PlayerStatsResult {
  return { ...history(player, 0), matches };
}
function readerWithDirectory(
  matches: readonly OddsMatch[],
  stats: PlayerStatsReader,
  playerDirectory: ValuePlayerDirectory,
  researchBudgetMs?: number,
): DefaultValueReader {
  return new DefaultValueReader({
    oddsReader: { getOdds: vi.fn(async (): Promise<OddsReport> => odds(matches)) },
    playerStatsReader: stats,
    playerDirectory,
    maxConcurrency: 2,
    ...(researchBudgetMs === undefined ? {} : { researchBudgetMs }),
  });
}
function makeReader(matches: readonly OddsMatch[], stats: PlayerStatsReader, directory: readonly PlayerIdentity[] = [alice, bob], options: { readonly researchBudgetMs?: number } = {}): DefaultValueReader {
  const playerDirectory: ValuePlayerDirectory = { getPlayers: vi.fn(async (): Promise<readonly PlayerIdentity[]> => directory) };
  return new DefaultValueReader({
    oddsReader: { getOdds: vi.fn(async (): Promise<OddsReport> => odds(matches)) },
    playerStatsReader: stats,
    playerDirectory,
    maxConcurrency: 2,
    ...(options.researchBudgetMs === undefined ? {} : { researchBudgetMs: options.researchBudgetMs }),
  });
}

describe("value research", () => {
  it("retains odds order and resolves surname-initial names without fuzzy guesses", async () => {
    const calls: string[] = [];
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => { calls.push(name); return history(name === alice.name ? alice : bob); }) };
    const reader = makeReader([oddsMatch("A. Smith", "Bob Jones"), oddsMatch("Bob Jones", "A. Smith")], stats);
    const report = await reader.getReport("today");
    expect(report.cards).toHaveLength(2);
    expect(report.cards[0]?.players[0].identity).toEqual(alice);
    expect(report.cards[0]?.players[1].identity).toEqual(bob);
    expect(report.cards[1]?.players[0].identity).toEqual(bob);
    expect(report.cards[1]?.players[1].identity).toEqual(alice);
    expect(calls.sort()).toEqual(["Alice Smith", "Bob Jones"]);
  });

  it("deduplicates a player lookup and computes weighted checkout from one history", async () => {
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (name: string): Promise<PlayerStatsResult> => history(name === alice.name ? alice : bob));
    const report = await makeReader([oddsMatch(), oddsMatch()], { getPlayerStats }).getReport("today");
    expect(getPlayerStats).toHaveBeenCalledTimes(2);
    const summary = report.cards[0]?.player1.last20;
    expect(summary?.checkout.hits).toBe(40);
    expect(summary?.checkout.attempts).toBe(80);
    expect(summary?.checkout.percentage).toBe(50);
    expect(summary?.checkout.coverage).toEqual({ available: 20, total: 20, ratio: 1, status: "available" });
  });

  it("shows insufficient history and missing metrics instead of dropping cards", async () => {
    const getPlayerStats: PlayerStatsReader["getPlayerStats"] = async (name: string): Promise<PlayerStatsResult> => history(name === alice.name ? alice : bob, 5, false);
    const report = await makeReader([oddsMatch()], { getPlayerStats }).getReport("today");
    expect(report.cards).toHaveLength(1);
    expect(report.cards[0]?.status).toBe("partial");
    expect(report.cards[0]?.player1.last10?.matchCount).toBe(5);
    expect(report.cards[0]?.player1.last20?.average.coverage.status).toBe("unavailable");
  });

  it("marks ambiguous directory identities unresolved without stats calls", async () => {
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (): Promise<PlayerStatsResult> => history(alice));
    const directory: readonly PlayerIdentity[] = [alice, { id: 3, name: "Aaron Smith", slug: "aaron-smith" }, bob];
    const report = await makeReader([oddsMatch("A. Smith", "Bob Jones")], { getPlayerStats }, directory).getReport("today");
    expect(report.cards[0]?.player1.status).toBe("unresolved");
    expect(getPlayerStats).toHaveBeenCalledOnce();
  });

  it.each([
    ["Noppert D.", noppert],
    ["Joyce R.", joyce],
  ])("maps surname + first initial source labels (%s)", async (label: string, identity: PlayerIdentity) => {
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (): Promise<PlayerStatsResult> => history(identity));
    const report = await makeReader([oddsMatch(label, "Bob Jones")], { getPlayerStats }, [identity, bob]).getReport("today");
    expect(report.cards[0]?.player1.identity).toEqual(identity);
  });

  it("returns all cards with timeout status when enrichment budget expires", async () => {
    const getPlayerStats: PlayerStatsReader["getPlayerStats"] = async (): Promise<PlayerStatsResult> => new Promise<PlayerStatsResult>((resolve) => { setTimeout(() => resolve(history(alice)), 100); });
    const report = await makeReader([oddsMatch()], { getPlayerStats }, [alice, bob], { researchBudgetMs: 5 }).getReport("today");
    expect(report.cards).toHaveLength(1);
    expect(report.status).toBe("partial");
    expect(report.cards[0]?.status).toBe("timed_out");
  });

  it("uses weighted checkout counts rather than averaging percentages", async () => {
    const matches = history(alice, 2).matches.map((match, index): Match => ({
      ...match,
      checkoutHits: 1,
      checkoutAttempts: index === 0 ? 2 : 10,
      checkoutPercentage: index === 0 ? 50 : 10,
    }));
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, matches)) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    expect(report.cards[0]?.player1.last20?.checkout.percentage).toBe(16.67);
  });

  it("keeps zero-attempt checkout rows as known coverage but with no percentage", async () => {
    const matches = history(alice, 2).matches.map((match): Match => ({ ...match, checkoutHits: 0, checkoutAttempts: 0, checkoutPercentage: null }));
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, matches)) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    const checkout = report.cards[0]?.player1.last20?.checkout;
    expect(checkout?.percentage).toBeNull();
    expect(checkout?.coverage).toEqual({ available: 2, total: 2, ratio: 1, status: "available" });
    expect(checkout?.zeroAttemptMatches).toBe(2);
  });

  it("does not report an empty 180s window as zero", async () => {
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, [])) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    expect(report.cards[0]?.player1.last20?.oneEighties.total).toBeNull();
  });

  it("derives last 10 and 20 from one newest-first history without filling missing rows from older data", async () => {
    const matches = history(alice, 20).matches.map((match, index): Match => ({
      ...match,
      date: `2026-09-${String(30 - index).padStart(2, "0")}`,
      average: index < 10 ? 90 : 110,
    }));
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, matches)) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    expect(report.cards[0]?.player1.last10?.average.value).toBe(90);
    expect(report.cards[0]?.player1.last20?.average.value).toBe(100);

    const lastMatch = matches.at(-1);
    if (lastMatch === undefined) throw new Error("Expected test history.");
    const withMissingNewest: readonly Match[] = [...matches.slice(0, 3).map((match): Match => ({ ...match, average: null })), ...matches.slice(3), {
      ...lastMatch, date: "2026-08-01", average: 150,
    }];
    const missingStats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, withMissingNewest)) };
    const missingReport = await makeReader([oddsMatch()], missingStats).getReport("today");
    expect(missingReport.cards[0]?.player1.last20?.average.coverage.available).toBe(17);
    expect(missingReport.cards[0]?.player1.last20?.average.value).toBe(101.76);
    expect(missingReport.cards[0]?.player1.last20?.average.value).not.toBe(150);
  });

  it("marks a full twenty-match history partial when a metric has incomplete coverage", async () => {
    const matches = history(alice, 20).matches.map((match, index): Match => index === 0 ? { ...match, oneEighties: null } : match);
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, matches)) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    expect(report.cards[0]?.player1.status).toBe("partial");
    expect(report.cards[0]?.player1.last20?.oneEighties.coverage).toEqual({ available: 19, total: 20, ratio: 0.95, status: "partial" });
  });

  it("does not resolve a full unknown name through surname initials and reports Rock J ambiguity", async () => {
    const james: PlayerIdentity = { id: 6, name: "James Rock", slug: "james-rock" };
    const jonny: PlayerIdentity = { id: 7, name: "Jonny Rock", slug: "jonny-rock" };
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (): Promise<PlayerStatsResult> => history(james));
    const fullName = await makeReader([oddsMatch("Aaron Smith", "Bob Jones")], { getPlayerStats }).getReport("today");
    expect(fullName.cards[0]?.player1.status).toBe("unresolved");
    const ambiguous = await makeReader([oddsMatch("Rock J.", "Bob Jones")], { getPlayerStats }, [james, jonny, bob]).getReport("today");
    expect(ambiguous.cards[0]?.player1.status).toBe("unresolved");
    expect(ambiguous.cards[0]?.player1.last20).toBeNull();
  });

  it("keeps directory failures failed, not cancelled, and bounds a provider that ignores abort", async () => {
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (): Promise<PlayerStatsResult> => history(alice)) };
    const failedDirectory: ValuePlayerDirectory = { getPlayers: vi.fn(async (): Promise<readonly PlayerIdentity[]> => { throw new Error("upstream"); }) };
    const failed = await readerWithDirectory([oddsMatch()], stats, failedDirectory).getReport("today");
    expect(failed.cards[0]?.player1.status).toBe("failed");

    const hangingDirectory: ValuePlayerDirectory = { getPlayers: vi.fn((): Promise<readonly PlayerIdentity[]> => new Promise(() => undefined)) };
    const timedOut = await readerWithDirectory([oddsMatch()], stats, hangingDirectory, 5).getReport("today");
    expect(timedOut.cards[0]?.status).toBe("timed_out");
  });

  it("returns cancelled cards when the caller aborts enrichment", async () => {
    const controller = new AbortController();
    const directory: ValuePlayerDirectory = { getPlayers: vi.fn((): Promise<readonly PlayerIdentity[]> => new Promise(() => undefined)) };
    const reader = readerWithDirectory([oddsMatch()], { getPlayerStats: vi.fn() }, directory, 10_000);
    const pending = reader.getReport("today", controller.signal);
    setTimeout(() => controller.abort(new Error("caller cancelled")), 5);
    const report = await pending;
    expect(report.cards[0]?.status).toBe("cancelled");
  });

  it("withholds numeric history when both odds slots resolve to the same identity", async () => {
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (): Promise<PlayerStatsResult> => history(alice)) };
    const report = await makeReader([oddsMatch("Alice Smith", "A. Smith")], stats, [alice]).getReport("today");
    expect(report.cards[0]?.status).toBe("unresolved");
    expect(report.cards[0]?.player1.last20).toBeNull();
    expect(report.cards[0]?.player2.last10).toBeNull();
    expect(stats.getPlayerStats).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed history instead of backfilling around it", async () => {
    const malformed = { ...history(alice, 1).matches[0], average: "not-a-number" } as unknown as Match;
    const matches = [malformed, ...history(alice, 20).matches];
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, matches)) };
    const report = await makeReader([oddsMatch()], stats).getReport("today");
    expect(report.cards[0]?.player1.last20).toEqual(null);
    expect(report.cards[0]?.player1.error).toContain("invalid match");
  });

  it("excludes duplicate, future, and live rows from honest history counts", async () => {
    const base = history(alice, 3).matches;
    const rows: Match[] = [
      base[0] as Match,
      { ...(base[0] as Match) },
      { ...(base[1] as Match), date: "2026-10-01" },
      { ...(base[2] as Match), result: "live" },
    ];
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (name: string): Promise<PlayerStatsResult> => resultWithMatches(name === alice.name ? alice : bob, rows)) };
    const report = await new DefaultValueReader({
      oddsReader: { getOdds: async (): Promise<OddsReport> => odds([oddsMatch()]) },
      playerStatsReader: stats,
      playerDirectory: { getPlayers: async (): Promise<readonly PlayerIdentity[]> => [alice, bob] },
      now: (): Date => new Date("2026-09-30T12:00:00Z"),
    }).getReport("today");
    expect(report.cards[0]?.player1.last20?.matchCount).toBe(1);
  });

  it("blocks a stats response whose player name differs from the resolved identity", async () => {
    const stats: PlayerStatsReader = { getPlayerStats: vi.fn(async (): Promise<PlayerStatsResult> => history(bob)) };
    const report = await makeReader([oddsMatch("Alice Smith", "Bob Jones")], stats).getReport("today");
    expect(report.cards[0]?.player1.status).toBe("failed");
    expect(report.cards[0]?.player1.last20).toBeNull();
  });

  it("preserves identity-provider failure state and skips stats for the affected abbreviated slot", async () => {
    const getPlayerStats = vi.fn<PlayerStatsReader["getPlayerStats"]>(async (name: string): Promise<PlayerStatsResult> => history(name === alice.name ? alice : bob));
    const getIdentityEvidence = vi.fn(async (): Promise<ReadonlyMap<string, never>> => { throw new Error("provider unavailable"); });
    const reader = new DefaultValueReader({
      oddsReader: {
        getOdds: vi.fn(async (): Promise<OddsReport> => odds([oddsMatch("A. Smith", "Bob Jones")])),
        getIdentityEvidence,
        maxIdentityEvidenceMatches: 5,
      },
      playerStatsReader: { getPlayerStats },
      playerDirectory: { getPlayers: vi.fn(async (): Promise<readonly PlayerIdentity[]> => [alice, bob]) },
    });
    const report = await reader.getReport("today");
    expect(report.cards[0]?.player1.status).toBe("failed");
    expect(report.cards[0]?.player2.status).toBe("available");
    expect(getPlayerStats).toHaveBeenCalledTimes(1);
    expect(report.warnings.some((warning: string): boolean => warning.includes("identity verification failed"))).toBe(true);
  });
});

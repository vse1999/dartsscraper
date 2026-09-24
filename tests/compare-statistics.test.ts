import { describe, expect, it } from "vitest";

import type { Match } from "../src/schemas/match.js";
import { analyzePlayerHistories } from "../src/services/matchup-analysis.js";
import { formatCompareMessages } from "../src/telegram/compare-formatter.js";
import { parseCompareCommand } from "../src/telegram/compare-query.js";
import type { CompareReport } from "../src/telegram/compare-command.js";
import type { PlayerStatsResult } from "../src/telegram/stats-service.js";

function match(index: number, overrides: Partial<Match> = {}): Match {
  return {
    date: `2026-09-${String(20 - (index % 10)).padStart(2, "0")}`,
    tournament: "Boundary Open",
    round: "Last 16",
    result: "Won",
    opponent: `Opponent ${index}`,
    score: "6 V 3",
    average: 90 + index,
    oneEighties: 1,
    checkoutPercentage: 50,
    checkoutHits: 1,
    checkoutAttempts: 2,
    ...overrides,
  };
}

function result(playerName: string, matches: readonly Match[], sourceUrl?: string): PlayerStatsResult {
  return {
    playerName,
    requestedCount: matches.length,
    matches,
    meanAverage: null,
    availableAverageCount: matches.filter((item: Match): boolean => item.average !== null).length,
    sourceUrl: sourceUrl ?? `https://example.test/player/${playerName}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

describe("compare parser boundaries", () => {
  it("normalizes Unicode whitespace and accepts only the supported counts", () => {
    expect(parseCompareCommand("/compare  Rob\u00a0Cross, Luke\u202fLittler LAST 20 ")).toEqual({
      playerNames: ["Rob Cross", "Luke Littler"],
      matchCount: 20,
    });
    expect(parseCompareCommand("/compare Rob Cross, Luke Littler last 10")).toEqual({
      playerNames: ["Rob Cross", "Luke Littler"],
      matchCount: 10,
    });
  });

  it("rejects reserved malformed suffixes, unsupported instructions, and overlong names", () => {
    const invalid = [
      "/compare Rob Cross, Luke Littler last banana",
      "/compare Rob Cross, Luke Littler last 11",
      "/compare Rob Cross, Luke Littler last99",
      "/compare Rob Cross, Luke Littler /last20 extra",
      "/compare Rob Cross, Luke Littler last 20 extra",
      "/compare Rob Cross, Luke Littler last20 extra",
      "/compare Rob Cross, Luke Littler from MODUS",
      `/compare ${"A".repeat(81)}, B`,
    ];
    for (const command of invalid) expect(parseCompareCommand(command)).toBeNull();
  });
});

describe("compare statistics formatting", () => {
  it("keeps every row and complete source URL across bounded evidence pages", () => {
    const firstMatches = Array.from({ length: 20 }, (_: unknown, index: number): Match => match(index, {
      tournament: `Tournament ${"x".repeat(100)}`,
      opponent: `Opponent ${index}-${"y".repeat(40)}`,
    }));
    const secondMatches = Array.from({ length: 20 }, (_: unknown, index: number): Match => match(index + 20, {
      tournament: `Tournament ${"x".repeat(100)}`,
      opponent: `Opponent ${index + 20}-${"y".repeat(40)}`,
    }));
    const first = result("Alpha Player", firstMatches);
    const second = result("Beta Player", secondMatches);
    const report: CompareReport = {
      requestedCount: 20,
      players: [
        { requestedName: "Alpha Player", result: first, failureCode: null, failureMessage: "" },
        { requestedName: "Beta Player", result: second, failureCode: null, failureMessage: "" },
      ],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const messages = formatCompareMessages(report);
    expect(messages.every((message: string): boolean => message.length <= 4_096)).toBe(true);
    const output = messages.join("\n");
    for (let index = 0; index < 40; index += 1) {
      const opponent = `Opponent ${index}-${"y".repeat(40)}`;
      expect(output.split(opponent)).toHaveLength(2);
    }
    expect(output).toContain(first.sourceUrl);
    expect(output).toContain(second.sourceUrl);
  });

  it("keeps a boundary-length URL intact and gives an actionable result for an oversized URL", () => {
    const boundaryUrl = `https://example.test/${"u".repeat(4_071)}`;
    const boundaryReport: CompareReport = {
      requestedCount: 10,
      players: [{ requestedName: "Alpha", result: result("Alpha", [], boundaryUrl), failureCode: null, failureMessage: "" }],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const boundaryMessages = formatCompareMessages(boundaryReport);
    expect(boundaryMessages).toContain(boundaryUrl);
    expect(boundaryMessages.every((message: string): boolean => message.length <= 4_096)).toBe(true);

    const oversizedUrl = `https://example.test/${"u".repeat(4_100)}`;
    const oversizedReport: CompareReport = {
      requestedCount: 10,
      players: [{ requestedName: "Alpha", result: result("Alpha", [], oversizedUrl), failureCode: null, failureMessage: "" }],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const oversizedMessages = formatCompareMessages(oversizedReport);
    expect(oversizedMessages.join("\n")).toContain("too long to send safely");
    expect(oversizedMessages.every((message: string): boolean => message.length <= 4_096)).toBe(true);
  });

  it("uses available 180 rows for the rate while keeping a partial total unavailable", () => {
    const matches = [
      match(0, { oneEighties: 0 }),
      match(1, { oneEighties: null }),
      match(2, { oneEighties: 4 }),
    ];
    const report: CompareReport = {
      requestedCount: 10,
      players: [{ requestedName: "Alpha", result: result("Alpha", matches), failureCode: null, failureMessage: "" }],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const output = formatCompareMessages(report).join("\n");
    expect(output).toContain("180s — total · 2.00 per available match");
  });

  it("reports weighted checkout and unclassified outcomes explicitly", () => {
    const matches = [
      match(0, { result: "Won", checkoutHits: 1, checkoutAttempts: 2, checkoutPercentage: 50 }),
      match(1, { result: "Mystery", checkoutHits: 3, checkoutAttempts: 10, checkoutPercentage: 30 }),
      match(2, { result: "Lost", checkoutHits: null, checkoutAttempts: null, checkoutPercentage: null }),
    ];
    const report: CompareReport = {
      requestedCount: 10,
      players: [{ requestedName: "Alpha", result: result("Alpha", matches), failureCode: null, failureMessage: "" }],
      analysis: null,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const output = formatCompareMessages(report).join("\n");
    expect(output).toContain("Form 1W-1L-0D · Unknown/unclassified 1");
    expect(output).toContain("Avg 91.00 · Best 92.00");
    expect(output).toContain("Checkout 33.33% (4/12)");
  });

  it("labels exact five-match trend windows and deduplicates H2H perspective", () => {
    const firstMatches = Array.from({ length: 20 }, (_: unknown, index: number): Match => match(index, {
      opponent: "Beta Player",
      average: index < 5 ? 100 : index < 10 ? 90 : 80,
      result: index % 2 === 0 ? "Won" : "Lost",
    }));
    const secondMatches = Array.from({ length: 20 }, (_: unknown, index: number): Match => match(index + 20, {
      opponent: "Alpha Player",
      average: 85,
      result: index % 2 === 0 ? "Lost" : "Won",
    }));
    const analysis = analyzePlayerHistories(
      { playerName: "Alpha Player", requestedCount: 20, matches: firstMatches },
      { playerName: "Beta Player", requestedCount: 20, matches: secondMatches },
      20,
    );
    expect(analysis.playerOne.trend).toMatchObject({ windowSize: 5, recentAverage: 100, previousAverage: 90 });
    expect(analysis.headToHead.meetings).toBe(20);
    const report: CompareReport = {
      requestedCount: 20,
      players: [
        { requestedName: "Alpha Player", result: result("Alpha Player", firstMatches), failureCode: null, failureMessage: "" },
        { requestedName: "Beta Player", result: result("Beta Player", secondMatches), failureCode: null, failureMessage: "" },
      ],
      analysis,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const output = formatCompareMessages(report).join("\n");
    expect(output).toContain("Trend Alpha Player: latest 5 avg 100.00 vs preceding 5 avg 90.00");
    expect(output).toContain("H2H (20 meetings in retrieved window)");
  });
});

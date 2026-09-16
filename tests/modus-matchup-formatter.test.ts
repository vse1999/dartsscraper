import { describe, expect, it } from "vitest";

import type { ModusFixture } from "../src/modus/schemas.js";
import type { Match } from "../src/schemas/match.js";
import { analyzeMatchup, type MatchupPlayerHistory } from "../src/services/matchup-analysis.js";
import { formatModusMatchupMessages } from "../src/telegram/modus-matchup-formatter.js";

function fixture(index: number): ModusFixture {
  const startTime = new Date(Date.parse("2026-09-15T08:30:00Z") + index * 20 * 60_000).toISOString();
  return {
    id: `match-${index}`,
    event: "MODUS Super Series",
    date: "2026-09-15",
    startTime,
    playerOne: `Alpha ${index}`,
    playerTwo: `Beta ${index}`,
    source: `https://example.test/match-${index}`,
  };
}

function history(playerName: string, average: number): MatchupPlayerHistory {
  const matches = Array.from({ length: 10 }, (_, index): Match => ({
    date: `2026-09-${String(14 - index).padStart(2, "0")}`,
    tournament: "MODUS Super Series",
    round: null,
    result: index % 2 === 0 ? "Won" : "Lost",
    opponent: "Other Player",
    score: "4 V 2",
    average,
    oneEighties: 1,
    checkoutPercentage: 50,
    checkoutHits: 2,
    checkoutAttempts: 4,
  }));
  return { playerName, requestedCount: 10, matches };
}

describe("MODUS matchup card formatter", () => {
  it("renders a decision-ready paired matchup card", () => {
    const scheduled = fixture(1);
    const analysis = analyzeMatchup(
      scheduled,
      history(scheduled.playerOne, 96),
      history(scheduled.playerTwo, 91),
      10,
    );
    const messages = formatModusMatchupMessages({
      date: scheduled.date,
      dateLabel: "today",
      matchCount: 10,
      analyses: [analysis],
      timeZone: "UTC",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🎯 MODUS TODAY · 15 Sep 2026");
    expect(messages[0]).toContain("1 scheduled matchup");
    expect(messages[0]).toContain("1. 08:50 · Alpha 1 vs Beta 1");
    expect(messages[0]).toContain("Alpha 1: 96.00 avg · 5W–5L · 1.00 180/m · 50.00% CO");
    expect(messages[0]).toContain("Signal: Alpha 1 recent-form advantage (+5.00 avg)");
    expect(messages[0]).toContain("Confidence: HIGH · Avg coverage 20/20");
  });

  it("splits large reports only between matchup cards", () => {
    const analyses = Array.from({ length: 60 }, (_, index) => {
      const scheduled = fixture(index);
      return analyzeMatchup(
        scheduled,
        history(scheduled.playerOne, 95),
        history(scheduled.playerTwo, 92),
        10,
      );
    });
    const messages = formatModusMatchupMessages({
      date: "2026-09-15",
      dateLabel: "today",
      matchCount: 10,
      analyses,
      timeZone: "UTC",
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 4_096)).toBe(true);
    expect(messages.join("\n")).toContain("1. 08:30 · Alpha 0 vs Beta 0");
    expect(messages.join("\n")).toContain("60.");
  });
});

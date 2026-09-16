import { describe, expect, it } from "vitest";

import type { Match } from "../src/schemas/match.js";
import type { PdcUpcomingReport, PdcPlayerStats } from "../src/pdc/service.js";
import { formatPdcMatchupMessages } from "../src/telegram/pdc-matchup-formatter.js";

function matches(average: number, opponent: string): readonly Match[] {
  return Array.from({ length: 10 }, (_, index): Match => ({
    date: `2026-09-${String(15 - index).padStart(2, "0")}`,
    tournament: "PDC",
    round: "Round One",
    result: index % 2 === 0 ? "Won" : "Lost",
    opponent,
    score: index % 2 === 0 ? "6 V 3" : "3 V 6",
    average: average + (index < 5 ? 2 : -2),
    oneEighties: 1,
    checkoutPercentage: 50,
    checkoutHits: 2,
    checkoutAttempts: 4,
  }));
}

function stats(playerName: string, average: number, opponent: string): PdcPlayerStats {
  return {
    playerName,
    requestedCount: 10,
    matches: matches(average, opponent),
    meanAverage: average,
    availableAverageCount: 10,
    sourceUrl: `https://dartsorakel.com/player/${encodeURIComponent(playerName)}`,
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

function report(): PdcUpcomingReport {
  return {
    date: "2026-09-17",
    fixtures: [{
      id: "pdpa:1",
      tournamentName: "World Series of Darts Finals 2026",
      date: "2026-09-17",
      startTime: "2026-09-17T20:10:00Z",
      session: "19:00 CEST",
      round: "Round One",
      playerOne: "Rob Cross",
      playerTwo: "Ryan Searle",
      sourceUrl: "https://pdpa.co.uk/event/world-series/",
      evidenceUrls: [
        "https://pdpa.co.uk/event/world-series/",
        "https://www.darts-nerd.com/en/matches/preview",
      ],
    }],
    players: [
      { requestedName: "Rob Cross", stats: stats("Rob Cross", 96, "Ryan Searle"), failureCode: null },
      { requestedName: "Ryan Searle", stats: stats("Ryan Searle", 91, "Rob Cross"), failureCode: null },
    ],
  };
}

describe("PDC matchup card formatter", () => {
  it("renders the official PDC pairing as a side-by-side analysis card", () => {
    const messages = formatPdcMatchupMessages(report());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🎯 PDC MATCHUPS · 2026-09-17");
    expect(messages[0]).toContain("1. 22:10 · Rob Cross vs Ryan Searle");
    expect(messages[0]).toContain("World Series of Darts Finals 2026 · Round One");
    expect(messages[0]).toContain("Rob Cross: 96.00 avg · 5W–5L · 1.00 180/m · 50.00% CO");
    expect(messages[0]).toContain("H2H in form window: Rob Cross 5–5 Ryan Searle");
    expect(messages[0]).toContain("Signal: Rob Cross recent-form advantage (+5.00 avg)");
    expect(messages[0]).toContain("Confidence: HIGH · Avg coverage 20/20");
    expect(messages[0]).toContain("https://pdpa.co.uk/event/world-series/");
  });

  it("keeps the fixture card when one player's research is unavailable", () => {
    const value = report();
    const messages = formatPdcMatchupMessages({
      ...value,
      players: [value.players[0] ?? { requestedName: "Rob Cross", stats: null, failureCode: "unavailable" }],
    });

    expect(messages[0]).toContain("Ryan Searle: form unavailable");
    expect(messages[0]).toContain("Signal: Insufficient form coverage for a reliable comparison");
    expect(messages[0]).toContain("Confidence: LOW");
  });
});

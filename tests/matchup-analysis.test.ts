import { describe, expect, it } from "vitest";

import type { ModusFixture } from "../src/modus/schemas.js";
import type { Match } from "../src/schemas/match.js";
import { analyzeMatchup, type MatchupPlayerHistory } from "../src/services/matchup-analysis.js";

const fixture: ModusFixture = {
  id: "match-1",
  event: "MODUS Super Series",
  date: "2026-09-15",
  startTime: "2026-09-15T18:30:00Z",
  playerOne: "Alpha Player",
  playerTwo: "Beta Player",
  source: "https://example.test/match-1",
};

function match(average: number, opponent: string, result: string, index: number): Match {
  return {
    date: `2026-09-${String(14 - index).padStart(2, "0")}`,
    tournament: "MODUS Super Series",
    round: null,
    result,
    opponent,
    score: result === "Won" ? "4 V 2" : "2 V 4",
    average,
    oneEighties: 1,
    checkoutPercentage: 50,
    checkoutHits: 2,
    checkoutAttempts: 4,
  };
}

function history(playerName: string, averages: readonly number[], opponent = "Other Player"): MatchupPlayerHistory {
  return {
    playerName,
    requestedCount: 10,
    matches: averages.map((average, index) => match(average, opponent, index % 2 === 0 ? "Won" : "Lost", index)),
  };
}

describe("matchup analysis", () => {
  it("calculates form, trend, H2H and a transparent form signal", () => {
    const alpha = history("Alpha Player", [98, 97, 96, 95, 94, 90, 89, 88, 87, 86], "Beta Player");
    const beta = history("Beta Player", [91, 92, 91, 92, 91, 92, 91, 92, 91, 92]);

    const analysis = analyzeMatchup(fixture, alpha, beta, 10);

    expect(analysis.playerOne.summary?.average).toBe(92);
    expect(analysis.playerOne.trend).toEqual({
      windowSize: 5,
      recentAverage: 96,
      previousAverage: 88,
      delta: 8,
    });
    expect(analysis.playerOne.oneEightiesPerMatch).toBe(1);
    expect(analysis.headToHead).toEqual({ meetings: 10, playerOneWins: 5, playerTwoWins: 5, draws: 0 });
    expect(analysis.confidence).toBe("high");
    expect(analysis.signal).toMatchObject({ code: "momentum-advantage", favoredPlayer: "Alpha Player" });
    expect(analysis.availableAverageCount).toBe(20);
    expect(analysis.expectedAverageCount).toBe(20);
  });

  it("identifies a material average advantage without presenting low-coverage data as reliable", () => {
    const strong = history("Alpha Player", Array.from({ length: 10 }, (): number => 96));
    const weak = history("Beta Player", Array.from({ length: 10 }, (): number => 91));
    const highCoverage = analyzeMatchup(fixture, strong, weak, 10);
    const lowCoverage = analyzeMatchup(fixture, {
      playerName: "Alpha Player",
      requestedCount: 10,
      matches: strong.matches.slice(0, 2),
    }, weak, 10);

    expect(highCoverage.signal).toEqual({
      code: "form-advantage",
      favoredPlayer: "Alpha Player",
      description: "Alpha Player recent-form advantage (+5.00 avg)",
    });
    expect(lowCoverage.confidence).toBe("low");
    expect(lowCoverage.signal.code).toBe("insufficient-data");
  });

  it("uses the second player's history when only that side contains recent H2H rows", () => {
    const beta = history("Beta Player", [91, 92, 91, 92, 91, 92], "Alpha Player");
    const analysis = analyzeMatchup(fixture, undefined, beta, 10);

    expect(analysis.headToHead).toEqual({ meetings: 6, playerOneWins: 3, playerTwoWins: 3, draws: 0 });
    expect(analysis.playerOne.available).toBe(false);
    expect(analysis.signal.code).toBe("insufficient-data");
  });
});

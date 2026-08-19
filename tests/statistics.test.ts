import { describe, expect, it } from "vitest";

import { calculateMatchAverage, calculateMatchSummary } from "../src/services/statistics.js";
import type { Match } from "../src/schemas/match.js";

function match(average: number | null): Match {
  return { date: "2026-01-01", tournament: "Example", round: null, result: "Won", opponent: "Opponent", score: "6 V 1", average };
}

describe("calculateMatchAverage", () => {
  it("calculates the arithmetic mean of available averages", () => {
    expect(calculateMatchAverage([match(91.2), match(94.4), match(88.7), match(null)])).toBe(91.43);
  });

  it("returns null when no average is available", () => {
    expect(calculateMatchAverage([match(null)])).toBeNull();
  });
});

describe("calculateMatchSummary", () => {
  it("derives record and average evidence from already validated matches", () => {
    const matches: Match[] = [
      { ...match(91.2), result: "Won" },
      { ...match(null), result: "Lost" },
      { ...match(98.4), result: "Draw" },
      { ...match(88), result: "Abandoned" },
    ];

    expect(calculateMatchSummary(matches)).toEqual({
      matchCount: 4,
      wins: 1,
      losses: 1,
      draws: 1,
      unclassifiedResults: 1,
      average: 92.53,
      availableAverageCount: 3,
      bestAverage: 98.4,
      totalOneEighties: null,
      availableOneEightiesCount: 0,
      checkoutPercentage: null,
      checkoutHits: 0,
      checkoutAttempts: 0,
      availableCheckoutCount: 0,
    });
  });

  it("sums complete 180 coverage and weights checkout by raw attempts", () => {
    const matches: Match[] = [
      { ...match(91.2), oneEighties: 0, checkoutPercentage: 0, checkoutHits: 0, checkoutAttempts: 1 },
      { ...match(94.4), oneEighties: 1, checkoutPercentage: 50, checkoutHits: 2, checkoutAttempts: 4 },
      { ...match(88.7), oneEighties: 2, checkoutPercentage: 60, checkoutHits: 3, checkoutAttempts: 5 },
    ];

    expect(calculateMatchSummary(matches)).toMatchObject({
      totalOneEighties: 3,
      availableOneEightiesCount: 3,
      checkoutPercentage: 50,
      checkoutHits: 5,
      checkoutAttempts: 10,
      availableCheckoutCount: 3,
    });
  });

  it("does not claim a complete 180 total or checkout rate from zero attempts", () => {
    const matches: Match[] = [
      { ...match(91.2), oneEighties: 1, checkoutPercentage: null, checkoutHits: 0, checkoutAttempts: 0 },
      { ...match(94.4), oneEighties: null, checkoutPercentage: null, checkoutHits: null, checkoutAttempts: null },
    ];

    expect(calculateMatchSummary(matches)).toMatchObject({
      totalOneEighties: null,
      availableOneEightiesCount: 1,
      checkoutPercentage: null,
      checkoutHits: 0,
      checkoutAttempts: 0,
      availableCheckoutCount: 0,
    });
  });

  it("rounds a 26/66 weighted checkout conversion once to 39.39%", () => {
    const matches: Match[] = [
      { ...match(78), oneEighties: 3, checkoutPercentage: 50, checkoutHits: 10, checkoutAttempts: 20 },
      { ...match(80), oneEighties: 3, checkoutPercentage: 34.78, checkoutHits: 16, checkoutAttempts: 46 },
    ];

    expect(calculateMatchSummary(matches)).toMatchObject({
      totalOneEighties: 6,
      checkoutPercentage: 39.39,
      checkoutHits: 26,
      checkoutAttempts: 66,
    });
  });
});

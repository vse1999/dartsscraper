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
    });
  });
});

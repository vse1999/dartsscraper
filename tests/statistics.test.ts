import { describe, expect, it } from "vitest";

import { calculateMatchAverage } from "../src/services/statistics.js";
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

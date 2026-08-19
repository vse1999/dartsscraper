import { describe, expect, it } from "vitest";

import { formatPlayerCliJson, formatPlayerCliText } from "../src/formatters/player-cli.js";
import type { MatchResult } from "../src/schemas/match.js";

const result: MatchResult = {
  player: { id: 73, name: "Robert Thornton", slug: "robert-thornton" },
  matches: [
    {
      date: "2026-07-03",
      tournament: "Example",
      round: "Final",
      result: "Won",
      opponent: "Opponent One",
      score: "4 V 2",
      average: 80,
      oneEighties: 2,
      checkoutPercentage: 50,
      checkoutHits: 10,
      checkoutAttempts: 20,
    },
    {
      date: "2026-07-02",
      tournament: "Example",
      round: "Semi Final",
      result: "Lost",
      opponent: "Opponent Two",
      score: "3 V 4",
      average: 77.94,
      oneEighties: 4,
      checkoutPercentage: 34.78,
      checkoutHits: 16,
      checkoutAttempts: 46,
    },
  ],
};

describe("player CLI formatting", () => {
  it("includes all per-match and aggregate statistics in text mode", () => {
    const text = formatPlayerCliText(result, 2);

    expect(text).toContain("Avg 80.00 · 180s 2 · Checkout 50.00%");
    expect(text).toContain("Mean match average: 78.97");
    expect(text).toContain("Total 180s: 6");
    expect(text).toContain("Checkout: 39.39% (26/66)");
    expect(text).toContain("Coverage (average/180s/checkout): 2/2 · 2/2 · 2/2");
  });

  it("includes the same deterministic summary in JSON mode", () => {
    const parsed: unknown = JSON.parse(formatPlayerCliJson(result));

    expect(parsed).toMatchObject({
      player: { name: "Robert Thornton" },
      matches: [
        { oneEighties: 2, checkoutPercentage: 50 },
        { oneEighties: 4, checkoutPercentage: 34.78 },
      ],
      summary: {
        average: 78.97,
        totalOneEighties: 6,
        checkoutPercentage: 39.39,
        checkoutHits: 26,
        checkoutAttempts: 66,
        availableOneEightiesCount: 2,
        availableCheckoutCount: 2,
      },
    });
  });
});

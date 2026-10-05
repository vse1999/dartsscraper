import { describe, expect, it } from "vitest";
import type { Match } from "../src/schemas/match.js";
import { summarizeResearchHistory, summarizeResearchWindow } from "../src/research/statistics.js";

function match(average: number | null, overrides: Partial<Match> = {}): Match {
  return { date: "2026-09-30", tournament: "Test", round: null, result: "Won", opponent: "Other", score: "6 V 3", average, ...overrides };
}

describe("comparable research statistics", () => {
  it("uses disjoint latest and preceding windows without reordering tied dates", () => {
    const rows = Array.from({ length: 20 }, (_: unknown, index: number): Match => match(index < 10 ? 100 : 80));
    const result = summarizeResearchHistory(rows);
    expect(result.latest10.summary.average).toBe(100);
    expect(result.previous10.summary.average).toBe(80);
    expect(result.averageDelta).toBe(20);
    expect(result.warnings.join(" ")).toContain("same-day ordering");
    expect(rows[0]?.average).toBe(100);
  });

  it("keeps missing data missing and does not call a short preceding sample a complete comparison", () => {
    const result = summarizeResearchHistory([match(null), match(90)]);
    expect(result.latest10.summary.average).toBe(90);
    expect(result.latest10.summary.availableAverageCount).toBe(1);
    expect(result.previous10.summary.average).toBeNull();
    expect(result.averageDelta).toBeNull();
    expect(result.latest10.sampleStandardDeviation).toBeNull();
    expect(result.warnings.join(" ")).toContain("not replaced with zero");
  });

  it("reports median, sample spread, leave-extreme sensitivity and elapsed date span", () => {
    const result = summarizeResearchWindow([match(80, { date: "2026-09-28" }), match(90), match(130)]);
    expect(result.summary.average).toBe(100);
    expect(result.medianAverage).toBe(90);
    expect(result.sampleStandardDeviation).toBe(26.46);
    expect(result.meanWithoutHighest).toBe(85);
    expect(result.meanWithoutLowest).toBe(110);
    expect(result.dateSpan).toEqual({ oldest: "2026-09-28", newest: "2026-09-30", days: 2 });
  });

  it("uses only paired explicit legs/180 evidence and never derives legs from scores", () => {
    const result = summarizeResearchWindow([
      match(90, { oneEighties: 4, legsPlayed: 10 }),
      match(90, { oneEighties: 2, legsPlayed: 5 }),
      match(90, { oneEighties: 10, score: "6 V 5" }),
      match(90, { legsPlayed: 20 }),
    ]);
    expect(result.oneEightiesPerLeg).toBe(0.4);
    expect(result.pairedLegs).toBe(15);
    expect(result.pairedOneEighties).toBe(6);
    expect(result.pairedLegMatchCount).toBe(2);
    expect(summarizeResearchWindow([match(90, { oneEighties: 4 })]).oneEightiesPerLeg).toBeNull();
  });

  it("weights checkout by attempts and excludes zero attempts", () => {
    const result = summarizeResearchWindow([
      match(90, { checkoutHits: 1, checkoutAttempts: 2, checkoutPercentage: 50 }),
      match(90, { checkoutHits: 2, checkoutAttempts: 10, checkoutPercentage: 20 }),
      match(90, { checkoutHits: 0, checkoutAttempts: 0, checkoutPercentage: null }),
    ]);
    expect(result.summary.checkoutPercentage).toBe(25);
    expect(result.summary.checkoutHits).toBe(3);
    expect(result.summary.checkoutAttempts).toBe(12);
    expect(result.summary.availableCheckoutCount).toBe(2);
  });

  it("warns about inconsistent source ordering instead of silently sorting", () => {
    const result = summarizeResearchHistory([match(80, { date: "2026-09-20" }), match(100, { date: "2026-09-30" })]);
    expect(result.warnings.join(" ")).toContain("inconsistent");
    expect(result.latest10.summary.average).toBe(90);
  });
});

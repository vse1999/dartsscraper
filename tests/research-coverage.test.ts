import { describe, expect, it } from "vitest";
import type { Match } from "../src/schemas/match.js";
import { diagnoseResearchCoverage, diagnoseResearchCoverageScopes } from "../src/research/coverage.js";

function match(index: number, overrides: Partial<Match> = {}): Match {
  return {
    date: "2026-10-01",
    tournament: "Test event",
    round: null,
    result: "Won",
    opponent: `Opponent ${index}`,
    score: "6 V 3",
    average: 0,
    oneEighties: 0,
    checkoutHits: 0,
    checkoutAttempts: 1,
    checkoutPercentage: 0,
    legsPlayed: 1,
    ...overrides,
  };
}

describe("research coverage diagnostics", () => {
  it("keeps displayed rows separate from the disjoint acquired windows", () => {
    const rows = Array.from({ length: 20 }, (_, index: number): Match => match(index, { average: index < 10 ? 90 : 80 }));
    const scopes = diagnoseResearchCoverageScopes(rows, 5, rows.slice(0, 5));
    expect(scopes.displayed.observedRowCount).toBe(5);
    expect(scopes.latest10.average.mean).toBe(90);
    expect(scopes.previous10.average.mean).toBe(80);
    expect(scopes.previous10.observedRowCount).toBe(10);
    expect(diagnoseResearchCoverageScopes(rows, 5).displayed.observedRowCount).toBe(20);
    expect(diagnoseResearchCoverageScopes(rows, 5).displayed.scopeCountMatches).toBe(false);
    expect(() => diagnoseResearchCoverageScopes(rows, -1)).toThrow("non-negative safe integer");
  });
  it.each([0, 1, 9, 10, 19, 20])("reconciles observed rows for a %i-row scope", (count: number) => {
    const rows = Array.from({ length: count }, (_unused: unknown, index: number): Match => match(index));
    const diagnostics = diagnoseResearchCoverage(rows, { requestedRowCount: count });
    expect(diagnostics.observedRowCount).toBe(count);
    expect(diagnostics.requestedRowCount).toBe(count);
    expect(diagnostics.scopeCountMatches).toBe(true);
    expect(diagnostics.average.availableRows).toBe(count);
    expect(diagnostics.oneEighties.availableRows).toBe(count);
    expect(diagnostics.average.mean).toBe(count === 0 ? null : 0);
    expect(diagnostics.oneEighties.completeTotal).toBe(count === 0 ? null : 0);
    expect(diagnostics.average.proportion).toBe(count === 0 ? null : 1);
    expect(diagnostics.oneEighties.proportion).toBe(count === 0 ? null : 1);
    expect(diagnostics.scopeProportion).toBe(count === 0 ? null : 1);
    if (count === 0) expect(diagnostics.gaps).toContain("empty-scope");
    else expect(diagnostics.gaps).not.toContain("empty-scope");
  });

  it("keeps zero values, missing denominators, and zero-attempt rows distinct", () => {
    const diagnostics = diagnoseResearchCoverage([
      match(0, { average: 0, oneEighties: 0, checkoutHits: 2, checkoutAttempts: 4, checkoutPercentage: 50 }),
      match(1, { checkoutHits: 0, checkoutAttempts: 0, checkoutPercentage: null }),
      match(2, { checkoutHits: undefined, checkoutAttempts: undefined, checkoutPercentage: undefined }),
    ]);
    expect(diagnostics.average).toMatchObject({ availableRows: 3, missingRows: 0, mean: 0, proportion: 1 });
    expect(diagnostics.oneEighties).toMatchObject({ availableRows: 3, missingRows: 0, completeTotal: 0 });
    expect(diagnostics.checkout).toMatchObject({
      positiveAttemptRows: 1,
      zeroAttemptRows: 1,
      missingDenominatorRows: 1,
      totalHits: 2,
      totalAttempts: 4,
      percentage: 50,
    });
    expect(diagnostics.gaps).toContain("checkout-zero-attempts");
    expect(diagnostics.gaps).toContain("checkout-missing-denominator");
    expect(diagnostics.gaps).not.toContain("checkout-no-positive-attempts");
  });

  it("pairs explicit legs only with their row's explicit 180 count and never derives legs from scores", () => {
    const diagnostics = diagnoseResearchCoverage([
      match(0, { score: "6 V 5", legsPlayed: 12, oneEighties: 0 }),
      match(1, { score: "6 V 0", legsPlayed: 4, oneEighties: null }),
      match(2, { score: "6 V 4", legsPlayed: undefined, oneEighties: 8 }),
      match(3, { score: "6 V 1", legsPlayed: undefined, oneEighties: undefined }),
    ]);
    expect(diagnostics.explicitLegs).toEqual({
      rowsWithLegs: 2,
      rowsWithLegsButMissingOneEighties: 1,
      pairedRows: 1,
      pairedRowProportion: 0.25,
      pairedLegs: 12,
      pairedOneEighties: 0,
    });
    expect(diagnostics.gaps).toContain("paired-one-eighties-unavailable");
  });

  it("reports missing metrics, all-empty scope, and requested-versus-observed shortfall", () => {
    const rows = Array.from({ length: 19 }, (_unused: unknown, index: number): Match => match(index, {
      average: null,
      oneEighties: null,
      checkoutHits: undefined,
      checkoutAttempts: undefined,
      checkoutPercentage: undefined,
      legsPlayed: undefined,
    }));
    const partial = diagnoseResearchCoverage(rows, { requestedRowCount: 20 });
    expect(partial.scopeProportion).toBe(0.95);
    expect(partial.scopeCountMatches).toBe(false);
    expect(partial.gaps).toContain("requested-observed-count-mismatch");
    expect(partial.gaps).toContain("missing-averages");
    expect(partial.gaps).toContain("missing-one-eighties");
    expect(partial.gaps).toContain("checkout-no-positive-attempts");
    expect(partial.gaps).toContain("paired-legs-unavailable");
    expect(partial.average.proportion).toBe(0);
    expect(partial.oneEighties.proportion).toBe(0);

    const empty = diagnoseResearchCoverage([]);
    expect(empty.average.proportion).toBeNull();
    expect(empty.oneEighties.proportion).toBeNull();
    expect(empty.checkout.positiveAttemptProportion).toBeNull();
    expect(empty.explicitLegs.pairedRowProportion).toBeNull();
    expect(empty.gaps).toContain("empty-scope");
  });

  it("rejects an invalid expected scope instead of emitting a misleading proportion", () => {
    expect(() => diagnoseResearchCoverage([], { requestedRowCount: -1 })).toThrow("non-negative safe integer");
    expect(() => diagnoseResearchCoverage([], { requestedRowCount: 1.5 })).toThrow("non-negative safe integer");
  });
});

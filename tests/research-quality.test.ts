import { describe, expect, it } from "vitest";
import type { Match, MatchResult } from "../src/schemas/match.js";
import { createEvidenceSnapshot, type EvidenceSnapshot } from "../src/research/evidence.js";
import { assessResearchQuality, inspectResearchOrdering } from "../src/research/quality.js";

const now = new Date("2026-10-06T10:00:00.000Z");
const player = { id: 42, name: "Test Player", slug: "test-player" };
const sourceUrl = `https://dartsorakel.com/player/details/${player.id}/${player.slug}`;

function match(index: number, overrides: Partial<Match> = {}): Match {
  const date = new Date(Date.UTC(2026, 8, 30 - index)).toISOString().slice(0, 10);
  return {
    date,
    tournament: "Test event",
    round: null,
    result: "Won",
    opponent: `Opponent ${index}`,
    score: "6 V 3",
    average: 95,
    oneEighties: 1,
    legsPlayed: 10,
    checkoutHits: 1,
    checkoutAttempts: 2,
    checkoutPercentage: 50,
    provenance: {
      provider: "dartsorakel",
      compositeId: `test-${index}`,
      tournamentId: 1,
      eventId: 1,
      opponentId: 100 + index,
      sourceUrl,
      datePrecision: "date-only",
      completedAt: null,
    },
    ...overrides,
  };
}

function history(count: number = 20): Match[] {
  return Array.from({ length: count }, (_unused: unknown, index: number): Match => match(index));
}

function snapshot(rows: readonly Match[], observedAt: string = "2026-10-06T10:00:00.000Z"): EvidenceSnapshot {
  const matches = rows.map((row: Match, index: number): Match => ({
    ...row,
    date: new Date(Date.UTC(2026, 9, 6 - index)).toISOString().slice(0, 10),
  }));
  const result: MatchResult = { player, matches };
  return createEvidenceSnapshot(result, observedAt, "2026-10-07", Math.max(1, rows.length));
}

describe("research quality assessment", () => {
  it("rejects impossible calendar dates even without a persisted receipt", () => {
    const result = assessResearchQuality([match(0, { date: "2026-02-30" })], { now });
    expect(result.validity.status).toBe("rejected");
    expect(result.validity.reasons).toContain("invalid-match-records");
    expect(result.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
  });
  it("treats absent legacy evidence metadata as unknown rather than canonical or invalid", () => {
    const assessment = assessResearchQuality(history());
    expect(assessment.validity).toEqual({ status: "valid", reasons: [] });
    expect(assessment.dimensions.identity).toBe("unknown");
    expect(assessment.dimensions.observationAge).toBe("unknown");
    expect(assessment.dimensions.providerFreshness).toBe("unknown");
    expect(assessment.validity.reasons).not.toContain("identity-conflict");
    expect(assessment.eligibility.scoringComparison.reasons).toContain("identity-unknown");
  });

  it("hash-validates full snapshots, rejects corruption, and compares expected canonical identity", () => {
    const rows = history();
    const evidence = snapshot(rows);
    const valid = assessResearchQuality(evidence.matches, { evidence, expectedPlayerId: player.id, now });
    expect(valid.validity.status).toBe("valid");
    expect(valid.dimensions.identity).toBe("canonical");

    const corrupted = { ...evidence, matches: evidence.matches.map((row, index) => index === 0 ? { ...row, average: 101 } : row) };
    const rejected = assessResearchQuality(rows, { evidence: corrupted, now });
    expect(rejected.validity.status).toBe("rejected");
    expect(rejected.validity.reasons).toContain("evidence-invalid");
    expect(rejected.eligibility.scoringComparison.status).toBe("unavailable");

    const conflict = assessResearchQuality(rows, { evidence, expectedPlayerId: player.id + 1, now });
    expect(conflict.validity.status).toBe("rejected");
    expect(conflict.validity.reasons).toContain("identity-conflict");
    expect(conflict.dimensions.identity).toBe("conflict");
  });

  it("rejects future observations and invalid injected clocks without producing eligible comparisons", () => {
    const evidence = snapshot(history(), "2026-10-08T10:00:00.000Z");
    const future = assessResearchQuality(history(), { evidence, now });
    expect(future.validity.status).toBe("rejected");
    expect(future.validity.reasons).toContain("future-evidence");
    expect(future.eligibility.chronologicalTrendComparison.status).toBe("unavailable");

    const invalidClock = assessResearchQuality(history(), { now: (): Date => new Date(Number.NaN) });
    expect(invalidClock.validity.status).toBe("rejected");
    expect(invalidClock.validity.reasons).toContain("invalid-clock");
  });

  it("reports empty history explicitly and marks expired observations stale, not invalid", () => {
    const empty = assessResearchQuality([]);
    expect(empty.validity.status).toBe("valid");
    expect(empty.dimensions.historyScope).toBe("empty");
    expect(empty.eligibility.scoringComparison.status).toBe("unavailable");
    expect(empty.eligibility.scoringComparison.reasons).toContain("history-empty");

    const metadata = {
      id: "legacy-reference",
      observedAt: "2026-10-06T09:58:00.000Z",
      sourceUpdatedAt: null,
      persistence: "memory" as const,
      stale: false,
      playerId: player.id,
      quality: { identity: "canonical" as const, comparability: "known-format" as const },
    };
    const stale = assessResearchQuality(history(), { evidence: metadata, expectedPlayerId: player.id, now, freshTtlMs: 60_000 });
    expect(stale.validity.status).toBe("valid");
    expect(stale.dimensions.observationAge).toBe("stale");
    expect(stale.eligibility.scoringComparison.status).toBe("limited");
    expect(stale.eligibility.scoringComparison.reasons).toContain("observation-stale");
  });

  it("detects source-order inconsistency and duplicate composite identities without sorting rows", () => {
    const inconsistent = history();
    inconsistent[3] = match(3, { date: "2026-09-29" });
    const orderFailure = assessResearchQuality(inconsistent);
    expect(orderFailure.dimensions.ordering).toBe("inconsistent");
    expect(orderFailure.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
    expect(orderFailure.eligibility.chronologicalTrendComparison.reasons).toContain("date-order-inconsistent");
    expect(inconsistent[0]?.date).toBe("2026-09-30");

    const duplicate = history();
    duplicate[1] = { ...duplicate[1]!, provenance: duplicate[0]!.provenance };
    const duplicateResult = assessResearchQuality(duplicate);
    expect(duplicateResult.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
    expect(duplicateResult.eligibility.chronologicalTrendComparison.reasons).toContain("duplicate-composite-id");
  });

  it("discloses ties within windows but suppresses trends when a tie crosses the ten-row boundary", () => {
    const withinWindow = history();
    withinWindow[1] = { ...withinWindow[1]!, date: withinWindow[0]!.date };
    const within = assessResearchQuality(withinWindow);
    expect(within.eligibility.chronologicalTrendComparison.status).toBe("limited");
    expect(within.eligibility.chronologicalTrendComparison.reasons).toContain("date-tie-within-window");
    expect(within.eligibility.scoringComparison.status).toBe("limited");

    const crossing = history();
    crossing[10] = { ...crossing[10]!, date: crossing[9]!.date };
    const boundary = assessResearchQuality(crossing);
    expect(boundary.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
    expect(boundary.eligibility.chronologicalTrendComparison.reasons).toContain("date-tie-crosses-window-boundary");
    expect(boundary.eligibility.scoringComparison.status).toBe("limited");
  });

  it("allows alternate five-row chronology windows and exposes a fully supported path", () => {
    const fiveWindowRows = history(10);
    expect(inspectResearchOrdering(fiveWindowRows, 5).status).toBe("available");
    fiveWindowRows[5] = { ...fiveWindowRows[5]!, date: fiveWindowRows[4]!.date };
    const crossing = inspectResearchOrdering(fiveWindowRows, 5);
    expect(crossing.chronological).toBe(false);
    expect(crossing.reasons).toContain("date-tie-crosses-window-boundary");

    const metadata = {
      id: "quality-reference",
      observedAt: now.toISOString(),
      sourceUpdatedAt: "2026-10-06T09:59:30.000Z",
      persistence: "local" as const,
      playerId: player.id,
      quality: { identity: "canonical" as const, comparability: "known-format" as const },
    };
    const supported = assessResearchQuality(history(), { evidence: metadata, expectedPlayerId: player.id, now, persistence: "local" });
    expect(supported.validity.status).toBe("valid");
    expect(supported.eligibility.scoringComparison.status).toBe("available");
    expect(supported.eligibility.weightedCheckoutComparison.status).toBe("available");
    expect(supported.eligibility.chronologicalTrendComparison.status).toBe("available");
  });

  it("rejects different rows attached to a valid receipt and future completed rows", () => {
    const evidence = snapshot(history());
    const changed = evidence.matches.map((row, index) => index === 0 ? { ...row, average: 1 } : row);
    expect(assessResearchQuality(changed, { evidence, now }).validity.reasons).toContain("evidence-row-mismatch");
    expect(assessResearchQuality([match(0, { date: "2026-10-07" })], { now }).validity.reasons).toContain("future-match");
  });

  it("keeps valid scoring usable when finishing is absent and no prior window exists", () => {
    const result = assessResearchQuality([match(0, { checkoutHits: null, checkoutAttempts: null, checkoutPercentage: null })], { now });
    expect(result.validity.status).toBe("valid");
    expect(result.eligibility.scoringComparison.status).toBe("limited");
    expect(result.eligibility.weightedCheckoutComparison.status).toBe("unavailable");
    expect(result.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
  });
});

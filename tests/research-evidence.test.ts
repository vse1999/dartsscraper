import { describe, expect, it } from "vitest";
import { createEvidenceSnapshot, validateEvidenceSnapshot } from "../src/research/evidence.js";
import { parseDartsOrakelMatches } from "../src/dartsorakel/parser.js";
import type { MatchResult } from "../src/schemas/match.js";
import { readMatchFixture } from "./helpers.js";

const result: MatchResult = { player: { id: 13, name: "Damon Heta", slug: "damon-heta" }, matches: [
  { date: "2026-01-01", tournament: "Example", round: null, result: "Won", opponent: "Opponent", score: "6 V 2", average: 90 },
] };
const now = new Date("2026-01-03T00:00:00.000Z");
describe("research evidence", () => {
  it("preserves normalized observation scope without inventing source freshness", () => {
    const snapshot = createEvidenceSnapshot(result, "2026-01-02T00:00:00.000Z", "2026-01-01", 20);
    expect(validateEvidenceSnapshot(snapshot, now)).toEqual(snapshot);
    expect(snapshot).toMatchObject({ acquiredCount: 1, requestedCount: 20, sourceUpdatedAt: null, source: { queryCompleteness: "unknown" } });
  });
  it("content-addresses observations and preserves corrections", () => {
    const first = createEvidenceSnapshot(result, "2026-01-02T00:00:00.000Z", "2026-01-01", 20);
    const correction = createEvidenceSnapshot({ ...result, matches: result.matches.map((match) => ({ ...match, average: 91 })) }, first.observedAt, first.dateTo, 20);
    expect(correction.id).not.toBe(first.id);
    expect(createEvidenceSnapshot(result, first.observedAt, first.dateTo, 20).id).toBe(first.id);
    expect(() => validateEvidenceSnapshot({ ...first, matches: correction.matches }, now)).toThrow("integrity");
  });
  it("rejects impossible counts, dates, future observations and altered source", () => {
    expect(() => createEvidenceSnapshot(result, now.toISOString(), "2026-02-30", 20)).toThrow();
    expect(() => createEvidenceSnapshot(result, now.toISOString(), "2025-12-31", 20)).toThrow();
    expect(() => createEvidenceSnapshot({ ...result, matches: [...result.matches, ...result.matches] }, now.toISOString(), "2026-01-01", 1)).toThrow();
    const future = createEvidenceSnapshot(result, "2026-01-04T00:00:00.000Z", "2026-01-01", 20);
    expect(() => validateEvidenceSnapshot(future, now)).toThrow("future");
    expect(() => validateEvidenceSnapshot({ ...future, source: { ...future.source, url: "https://evil.example" } }, now)).toThrow();
  });
  it("retains provider identity while explicitly marking date-only precision", () => {
    const matches = parseDartsOrakelMatches(result.player, readMatchFixture("damon-heta-matches.json"));
    expect(matches[0]?.provenance).toMatchObject({ provider: "dartsorakel", datePrecision: "date-only", completedAt: null, sourceUrl: "https://dartsorakel.com/player/details/13/damon-heta" });
    expect(matches[0]?.provenance?.compositeId).toBeTruthy();
    expect(matches[0]?.legsPlayed).toBeUndefined();
    expect(matches[0]?.dartsThrown).toBeUndefined();
  });
  it("allows next-day query bounds but not future results at Budapest midnight and DST", () => {
    for (const observedAt of ["2026-01-01T23:30:00.000Z", "2026-03-29T22:30:00.000Z"]) {
      const localDate = observedAt.startsWith("2026-01") ? "2026-01-02" : "2026-03-30";
      const cutoff = observedAt.startsWith("2026-01") ? "2026-01-03" : "2026-03-31";
      const scoped = { ...result, matches: result.matches.map((match) => ({ ...match, date: localDate })) };
      const evidence = createEvidenceSnapshot(scoped, observedAt, cutoff, 20);
      expect(validateEvidenceSnapshot(evidence, new Date(observedAt))).toEqual(evidence);
      const future = createEvidenceSnapshot({ ...scoped, matches: scoped.matches.map((match) => ({ ...match, date: cutoff })) }, observedAt, cutoff, 20);
      expect(() => validateEvidenceSnapshot(future, new Date(observedAt))).toThrow("future completed");
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  parseAndCanonicalizeIdentity,
  sameCanonicalMatchup,
} from "../src/watchlist/identity.js";
import {
  screenWatchlistCandidate,
} from "../src/watchlist/screening.js";
import type { WatchlistScreenInput } from "../src/watchlist/contracts.js";
import { createSyntheticWatchlistInput, SYNTHETIC_NOW } from "./fixtures/watchlist-screening.js";

function cloneInput(): WatchlistScreenInput {
  return structuredClone(createSyntheticWatchlistInput());
}

describe("watchlist identity", () => {
  it("is stable when provider player columns are reversed", () => {
    const original = cloneInput().price.quote;
    const reversed = cloneInput().price.quote;
    reversed.players = [reversed.players[1], reversed.players[0]];
    const first = parseAndCanonicalizeIdentity(original);
    const second = parseAndCanonicalizeIdentity(reversed);
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    expect(first.identity).not.toBeNull();
    expect(second.identity).not.toBeNull();
    if (first.identity !== null && second.identity !== null) {
      expect(sameCanonicalMatchup(first.identity, second.identity)).toBe(true);
      expect(first.identity.selectedPlayerId).toBe("p1");
    }
  });

  it("keeps event occurrences and replacements distinct while round enrichment stays stable", () => {
    const base = cloneInput().price.quote;
    const otherRound = structuredClone(base);
    otherRound.round = "quarter-final";
    const replacement = structuredClone(base);
    replacement.players = [replacement.players[0], { id: "p3", name: "Gamma" }];
    const otherOccurrence = structuredClone(base);
    otherOccurrence.competitionOccurrenceId = "competition-2-2026-01-21";
    const first = parseAndCanonicalizeIdentity(base).identity;
    const round = parseAndCanonicalizeIdentity(otherRound).identity;
    const replaced = parseAndCanonicalizeIdentity(replacement).identity;
    const occurrence = parseAndCanonicalizeIdentity(otherOccurrence).identity;
    expect(first).not.toBeNull();
    expect(round?.key).toBe(first?.key);
    expect(replaced?.key).not.toBe(first?.key);
    expect(occurrence?.key).not.toBe(first?.key);
  });

  it("rejects a missing selected player and duplicate stable IDs", () => {
    const missing = cloneInput().price.quote;
    missing.selectedPlayerId = "not-an-event-player";
    expect(parseAndCanonicalizeIdentity(missing).reason).toBe("selected_player_not_in_event");
    const duplicate = cloneInput().price.quote;
    duplicate.players = [duplicate.players[0], duplicate.players[0]];
    expect(parseAndCanonicalizeIdentity(duplicate).reason).toBe("ambiguous_player_pair");
  });
});

describe("offline deterministic watchlist screening", () => {
  it("qualifies only when all three metrics are superior in both windows", () => {
    const result = screenWatchlistCandidate(cloneInput(), SYNTHETIC_NOW);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.ruleVersion).toBe("synthetic-v1");
    expect(result.comparisons).toHaveLength(2);
    expect(result.coverage?.selected[10].oneEightyPerLeg.value).toBe(0.3);
    expect(result.coverage?.selected[20].checkoutRate.value).toBe(0.4);
  });

  it("uses weighted checkout and 180-per-leg denominators without zero filling", () => {
    const input = cloneInput();
    for (const match of input.selectedHistory.matches.slice(0, 2)) {
      match.stats.checkoutHits = null;
      match.stats.checkoutAttempts = null;
      match.stats.oneEighties = null;
    }
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(result.coverage?.selected[10].checkoutRate.numerator).toBe(32);
    expect(result.coverage?.selected[10].checkoutRate.denominator).toBe(80);
    expect(result.coverage?.selected[10].oneEightyPerLeg.numerator).toBe(24);
    expect(result.coverage?.selected[10].oneEightyPerLeg.denominator).toBe(80);
    expect(result.reasons.map((item) => item.code)).toContain("MISSING_METRIC_DATA");
  });

  it("suppresses missing or contradictory windows with typed reasons", () => {
    const input = cloneInput();
    for (const match of input.selectedHistory.matches.slice(0, 10)) {
      match.stats.average = 80;
    }
    for (const match of input.selectedHistory.matches.slice(10)) {
      match.stats.average = 110;
    }
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons.map((item) => item.code)).toContain("WINDOW_CONTRADICTION");
    expect(result.reasons.map((item) => item.code)).toContain("SELECTED_PLAYER_NOT_SUPERIOR");

    const missing = cloneInput();
    for (const match of missing.selectedHistory.matches) {
      match.stats.oneEighties = null;
    }
    const missingResult = screenWatchlistCandidate(missing, SYNTHETIC_NOW);
    expect(missingResult.reasons.map((item) => item.code)).toContain("MISSING_METRIC_DATA");
  });

  it("rejects unsupported markets, promotions, stale source data, and starts inside two minutes", () => {
    const input = cloneInput();
    input.price.quote.marketType = "total_legs";
    input.price.quote.isPromotion = true;
    input.price.quote.sourceUpdatedAt = "2026-01-20T11:56:00.000Z";
    input.price.quote.scheduledStart = "2026-01-20T12:01:59.000Z";
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    const codes = result.reasons.map((item) => item.code);
    expect(codes).toContain("UNSUPPORTED_MARKET");
    expect(codes).toContain("PROMOTIONAL_MARKET");
    expect(codes).toContain("STALE_SOURCE");
    expect(codes).toContain("START_TOO_SOON");
  });

  it("enforces the exact two-minute quote freshness and start boundaries", () => {
    const exact = cloneInput();
    exact.price.quote.observedAt = "2026-01-20T11:58:00.000Z";
    exact.price.quote.sourceUpdatedAt = "2026-01-20T11:58:00.000Z";
    exact.price.quote.source.observedAt = "2026-01-20T11:58:00.000Z";
    exact.price.quote.eventContext!.evidence!.observedAt = "2026-01-20T11:58:00.000Z";
    exact.price.quote.scheduledStart = "2026-01-20T12:02:00.000Z";
    const exactCodes = screenWatchlistCandidate(exact, SYNTHETIC_NOW).reasons.map((item) => item.code);
    expect(exactCodes).not.toContain("STALE_QUOTE");
    expect(exactCodes).toContain("START_TOO_SOON");

    const oneMillisecondStale = cloneInput();
    oneMillisecondStale.price.quote.observedAt = "2026-01-20T11:57:59.999Z";
    expect(screenWatchlistCandidate(oneMillisecondStale, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("STALE_QUOTE");

    const oneMillisecondSoon = cloneInput();
    oneMillisecondSoon.price.quote.scheduledStart = "2026-01-20T12:01:59.999Z";
    expect(screenWatchlistCandidate(oneMillisecondSoon, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("START_TOO_SOON");
  });

  it("rejects stale source observation, illogical evidence ordering, and zero-threshold ties", () => {
    const staleSource = cloneInput();
    staleSource.price.quote.source.observedAt = "2026-01-20T11:57:59.999Z";
    expect(screenWatchlistCandidate(staleSource, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("STALE_SOURCE");

    const illogical = cloneInput();
    illogical.price.quote.sourceUpdatedAt = "2026-01-20T11:59:30.000Z";
    illogical.price.quote.source.observedAt = "2026-01-20T11:59:00.000Z";
    illogical.price.quote.eventContext!.evidence!.observedAt = "2026-01-20T11:59:30.000Z";
    const illogicalCodes = screenWatchlistCandidate(illogical, SYNTHETIC_NOW).reasons.map((item) => item.code);
    expect(illogicalCodes).toContain("TIMESTAMP_ORDER_INVALID");

    const tie = cloneInput();
    for (const [index, match] of tie.selectedHistory.matches.entries()) {
      const opponentMatch = tie.opponentHistory.matches[index];
      if (opponentMatch !== undefined) {
        match.stats.average = opponentMatch.stats.average;
        match.stats.checkoutHits = opponentMatch.stats.checkoutHits;
        match.stats.checkoutAttempts = opponentMatch.stats.checkoutAttempts;
        match.stats.oneEighties = opponentMatch.stats.oneEighties;
        match.stats.legs = opponentMatch.stats.legs;
      }
    }
    tie.rules.superiority = { average: 0, checkoutRate: 0, oneEightyPerLeg: 0 };
    const tieResult = screenWatchlistCandidate(tie, SYNTHETIC_NOW);
    expect(tieResult.eligible).toBe(false);
    expect(tieResult.reasons.map((item) => item.code)).toContain("SELECTED_PLAYER_NOT_SUPERIOR");
  });

  it("requires hard rule guards and preserves opaque ID case", () => {
    const tooFresh = cloneInput();
    tooFresh.rules.quoteMaxAgeMs = 120_001;
    expect(screenWatchlistCandidate(tooFresh, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");
    const tooSoon = cloneInput();
    tooSoon.rules.minimumStartLeadMs = 119_999;
    expect(screenWatchlistCandidate(tooSoon, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");

    const caseChanged = cloneInput();
    caseChanged.price.quote.players = [
      { id: "P1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ];
    caseChanged.price.quote.selectedPlayerId = "P1";
    const baselineIdentity = parseAndCanonicalizeIdentity(cloneInput().price.quote).identity;
    const caseIdentity = parseAndCanonicalizeIdentity(caseChanged.price.quote).identity;
    expect(baselineIdentity).not.toBeNull();
    expect(caseIdentity).not.toBeNull();
    expect(caseIdentity?.key).not.toBe(baselineIdentity?.key);

    const duplicateRequiredMetrics = cloneInput() as unknown as Record<string, unknown>;
    const duplicateRules = duplicateRequiredMetrics.rules as Record<string, unknown>;
    duplicateRules.requiredMetrics = ["average", "average"];
    expect(screenWatchlistCandidate(duplicateRequiredMetrics, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");

  });

  it("rejects unknown context, future timestamps, bad ordering, duplicate IDs, and cutoff violations", () => {
    const input = cloneInput();
    input.price.quote.eventContext!.stage = "unknown";
    input.price.quote.observedAt = "2026-01-20T12:00:01.000Z";
    const firstSelected = input.selectedHistory.matches[0];
    const secondSelected = input.selectedHistory.matches[1];
    const thirdSelected = input.selectedHistory.matches[2];
    const firstOpponent = input.opponentHistory.matches[0];
    if (firstSelected !== undefined && secondSelected !== undefined && thirdSelected !== undefined && firstOpponent !== undefined) {
      secondSelected.completedAt = firstSelected.completedAt;
      thirdSelected.matchId = firstSelected.matchId;
      firstOpponent.completedAt = "2026-01-20T12:00:02.000Z";
    }
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    const codes = result.reasons.map((item) => item.code);
    expect(codes).toContain("UNKNOWN_EVENT_CONTEXT");
    expect(codes).toContain("FUTURE_TIMESTAMP");
    expect(codes).toContain("HISTORY_NOT_ORDERED");
    expect(codes).toContain("HISTORY_DUPLICATE_ID");
    expect(codes).toContain("HISTORY_FUTURE_TIMESTAMP");
  });

  it("fails closed on malformed untrusted input and unknown statuses", () => {
    const malformed = cloneInput() as unknown as Record<string, unknown>;
    delete malformed.rules;
    const malformedResult = screenWatchlistCandidate(malformed, SYNTHETIC_NOW);
    expect(malformedResult.eligible).toBe(false);
    expect(malformedResult.reasons[0]?.code).toBe("INVALID_INPUT");

    const unknownStatus = cloneInput();
    unknownStatus.price.quote.marketStatus = "maybe";
    const statusResult = screenWatchlistCandidate(unknownStatus, SYNTHETIC_NOW);
    expect(statusResult.reasons.map((item) => item.code)).toContain("UNKNOWN_MARKET_STATUS");

    const oversized = cloneInput();
    oversized.selectedHistory.matches = Array.from({ length: 21 }, () => oversized.selectedHistory.matches[0]).filter(
      (match): match is NonNullable<typeof match> => match !== undefined,
    );
    expect(screenWatchlistCandidate(oversized, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");
  });

  it("suppresses less than the configured last-20 sample and malformed metric counters", () => {
    const shortHistory = cloneInput();
    shortHistory.selectedHistory.matches = shortHistory.selectedHistory.matches.slice(0, 10);
    shortHistory.opponentHistory.matches = shortHistory.opponentHistory.matches.slice(0, 10);
    shortHistory.rules.minimumMatchesByWindow = { 10: 10, 20: 20 };
    expect(screenWatchlistCandidate(shortHistory, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("HISTORY_WINDOW_UNAVAILABLE");
    expect(screenWatchlistCandidate(shortHistory, SYNTHETIC_NOW).eligible).toBe(true);

    const mismatch = cloneInput();
    mismatch.selectedHistory.playerId = "wrong-player";
    expect(screenWatchlistCandidate(mismatch, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("HISTORY_PLAYER_MISMATCH");

    const zeroAttempts = cloneInput();
    for (const match of zeroAttempts.selectedHistory.matches) {
      match.stats.checkoutHits = 0;
      match.stats.checkoutAttempts = 0;
    }
    expect(screenWatchlistCandidate(zeroAttempts, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("MISSING_METRIC_DATA");

    const malformed = cloneInput() as unknown as Record<string, unknown>;
    const selectedHistory = malformed.selectedHistory as Record<string, unknown>;
    const matches = selectedHistory.matches as Array<Record<string, unknown>>;
    const first = matches[0];
    if (first !== undefined) {
      const stats = first.stats as Record<string, unknown>;
      stats.checkoutHits = 11;
      stats.checkoutAttempts = 10;
      stats.legs = 10;
      stats.average = "not-a-number";
    }
    expect(screenWatchlistCandidate(malformed, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");

    const evidenceAfterSnapshot = cloneInput();
    evidenceAfterSnapshot.selectedHistory.source.observedAt = "2026-01-20T11:56:00.000Z";
    expect(screenWatchlistCandidate(evidenceAfterSnapshot, SYNTHETIC_NOW).reasons.map((item) => item.code)).toContain("HISTORY_AFTER_SNAPSHOT");
  });




  it("allows missing optional context, source update, legs, and 180s while retaining warnings", () => {
    const input = cloneInput() as unknown as Record<string, unknown>;
    const quote = (input.price as Record<string, unknown>).quote as Record<string, unknown>;
    delete quote.sourceUpdatedAt;
    delete quote.eventContext;
    const selectedHistory = input.selectedHistory as Record<string, unknown>;
    const opponentHistory = input.opponentHistory as Record<string, unknown>;
    for (const snapshot of [selectedHistory, opponentHistory]) {
      const matches = snapshot.matches as Array<Record<string, unknown>>;
      for (const match of matches) {
        const stats = match.stats as Record<string, unknown>;
        delete stats.oneEighties;
        delete stats.legs;
        delete match.context;
      }
    }
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(result.eligible).toBe(true);
    expect(result.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["SOURCE_UPDATE_UNAVAILABLE", "UNKNOWN_EVENT_CONTEXT", "MISSING_METRIC_DATA"]));
    expect(result.warnings.every((item) => item.severity === "warning")).toBe(true);
  });

  it("requires ten matches but treats an unavailable last-20 window as a warning", () => {
    const input = cloneInput();
    input.selectedHistory.matches = input.selectedHistory.matches.slice(0, 10);
    input.opponentHistory.matches = input.opponentHistory.matches.slice(0, 10);
    const result = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(result.eligible).toBe(true);
    expect(result.reasons.some((item) => item.code === "HISTORY_WINDOW_UNAVAILABLE" && item.severity === "warning")).toBe(true);

    input.selectedHistory.matches = input.selectedHistory.matches.slice(0, 9);
    const insufficient = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(insufficient.eligible).toBe(false);
    expect(insufficient.reasons.some((item) => item.code === "INSUFFICIENT_HISTORY" && item.severity === "blocking")).toBe(true);
  });

  it("excludes BoaBet and validates timestamp provenance when source update is present", () => {
    const input = cloneInput();
    input.price.quote.bookmakerId = "BoaBet";
    const excluded = screenWatchlistCandidate(input, SYNTHETIC_NOW);
    expect(excluded.reasons.map((item) => item.code)).toContain("BOABET_EXCLUDED");

    const invalidOrder = cloneInput();
    invalidOrder.price.quote.sourceUpdatedAt = "2026-01-20T12:00:00.000Z";
    invalidOrder.price.quote.source.observedAt = "2026-01-20T11:59:00.000Z";
    const result = screenWatchlistCandidate(invalidOrder, SYNTHETIC_NOW);
    expect(result.reasons.map((item) => item.code)).toContain("TIMESTAMP_ORDER_INVALID");
  });

  it("accepts unambiguous older date-only history and suppresses ambiguous cutoff dates", () => {
    const input = cloneInput();
    for (const snapshot of [input.selectedHistory, input.opponentHistory]) {
      for (const [index, match] of snapshot.matches.entries()) {
        const date = index >= 10 ? "2026-01-17" : "2026-01-18";
        match.playedAt = date;
        match.completedAt = date;
      }
    }
    expect(screenWatchlistCandidate(input, SYNTHETIC_NOW).eligible).toBe(true);

    const ambiguous = cloneInput();
    for (const snapshot of [ambiguous.selectedHistory, ambiguous.opponentHistory]) {
      const boundary = snapshot.matches[9];
      if (boundary !== undefined) {
        boundary.playedAt = "2026-01-20";
        boundary.completedAt = "2026-01-20";
      }
    }
    const result = screenWatchlistCandidate(ambiguous, SYNTHETIC_NOW);
    expect(result.reasons.map((item) => item.code)).toContain("HISTORY_DATE_ONLY_AMBIGUOUS");

    const invalidCalendarDate = cloneInput();
    const invalidMatch = invalidCalendarDate.selectedHistory.matches[0];
    if (invalidMatch === undefined) throw new Error("Synthetic history is missing its first match.");
    invalidMatch.playedAt = "2026-02-29";
    invalidMatch.completedAt = "2026-02-29";
    expect(screenWatchlistCandidate(invalidCalendarDate, SYNTHETIC_NOW).reasons[0]?.code).toBe("INVALID_INPUT");
  });



  it("allows history fetched after the quote when every included result completed earlier", () => {
    const input = cloneInput();
    const quoteObservedAt = "2026-01-20T12:04:00.000Z";
    input.price.quote.observedAt = quoteObservedAt;
    input.price.quote.source.observedAt = quoteObservedAt;
    input.price.quote.sourceUpdatedAt = quoteObservedAt;
    input.price.quote.eventContext!.evidence!.observedAt = quoteObservedAt;
    input.selectedHistory.observedAt = "2026-01-20T12:04:30.000Z";
    input.selectedHistory.source.observedAt = "2026-01-20T12:04:30.000Z";
    input.opponentHistory.observedAt = "2026-01-20T12:04:30.000Z";
    input.opponentHistory.source.observedAt = "2026-01-20T12:04:30.000Z";
    const result = screenWatchlistCandidate(input, new Date("2026-01-20T12:05:00.000Z"));
    expect(result.eligible).toBe(true);
    expect(result.reasons.map((item) => item.code)).not.toContain("HISTORY_AFTER_QUOTE_CUTOFF");
  });

  it("allows a result completed after quote observation when it precedes evaluation cutoff", () => {
    const input = cloneInput();
    const quoteObservedAt = "2026-01-20T12:04:00.000Z";
    const historyObservedAt = "2026-01-20T12:04:45.000Z";
    input.price.quote.observedAt = quoteObservedAt;
    input.price.quote.sourceUpdatedAt = quoteObservedAt;
    input.price.quote.source.observedAt = quoteObservedAt;
    input.price.quote.eventContext!.evidence!.observedAt = quoteObservedAt;
    const firstSelected = input.selectedHistory.matches[0];
    const firstOpponent = input.opponentHistory.matches[0];
    if (firstSelected === undefined || firstOpponent === undefined) throw new Error("Synthetic history is missing its first match.");
    for (const match of [firstSelected, firstOpponent]) {
      match.playedAt = "2026-01-20T12:04:30.000Z";
      match.completedAt = "2026-01-20T12:04:30.000Z";
      match.evidence.observedAt = historyObservedAt;
    }
    input.selectedHistory.observedAt = historyObservedAt;
    input.selectedHistory.source.observedAt = historyObservedAt;
    input.opponentHistory.observedAt = historyObservedAt;
    input.opponentHistory.source.observedAt = historyObservedAt;

    const result = screenWatchlistCandidate(input, new Date("2026-01-20T12:05:00.000Z"));
    expect(result.eligible).toBe(true);
    expect(result.reasons.map((item) => item.code)).not.toContain("HISTORY_AFTER_QUOTE_CUTOFF");
  });
});

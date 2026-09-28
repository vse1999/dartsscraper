import { describe, expect, it } from "vitest";

import {
  beginPageSending,
  markPageSent,
  type CandidateRevalidation,
} from "../src/watchlist/batching.js";
import {
  runOfflineWatchlistTick,
  type OfflineWatchlistTickSuccess,
} from "../src/watchlist/offline-runner.js";
import type { WatchlistScreenInput } from "../src/watchlist/contracts.js";
import { createSyntheticWatchlistInput, SYNTHETIC_NOW } from "./fixtures/watchlist-screening.js";

function cloneInput(): WatchlistScreenInput {
  return structuredClone(createSyntheticWatchlistInput());
}

function freshInput(eventId: string, at: Date): WatchlistScreenInput {
  const input = cloneInput();
  const timestamp = at.toISOString();
  input.price.quote.eventId = eventId;
  input.price.quote.observedAt = timestamp;
  input.price.quote.sourceUpdatedAt = timestamp;
  input.price.quote.source.observedAt = timestamp;
  input.price.quote.eventContext!.evidence!.observedAt = timestamp;
  return input;
}

function success(result: ReturnType<typeof runOfflineWatchlistTick>): OfflineWatchlistTickSuccess {
  if (!result.ok) throw new Error(result.error);
  return result;
}

function revalidation(candidateId: string, at: Date): CandidateRevalidation {
  const timestamp = at.getTime();
  return { candidateId, status: "valid", revalidatedAt: timestamp, validUntil: timestamp + 60_000 };
}

describe("offline watchlist runner", () => {
  it("screens candidates on tick one and proposes only revalidated pages on tick two", () => {
    const initial = SYNTHETIC_NOW;
    const deadline = new Date(initial.getTime() + 120_000);
    const first = runOfflineWatchlistTick({
      now: initial.toISOString(),
      candidates: [
        { candidateId: "candidate-a", ownerId: "owner-1", roundKind: "opening", input: cloneInput() },
        { candidateId: "candidate-b", ownerId: "owner-1", roundKind: "opening", input: freshInput("event-2", initial) },
      ],
      pageSize: 1,
    });
    const firstSuccess = success(first);
    expect(firstSuccess.evaluations.every((evaluation) => evaluation.eligible && evaluation.enqueued)).toBe(true);
    expect(firstSuccess.proposedPages).toHaveLength(0);
    expect(firstSuccess.state.batches[0]?.openedAt).toBe(initial.getTime());

    const second = runOfflineWatchlistTick({
      now: deadline.toISOString(),
      candidates: [],
      batchingState: firstSuccess.state,
      pageSize: 1,
      revalidations: [
        { candidateId: "candidate-a", ownerId: "owner-1", input: freshInput("event-1", deadline) },
        { candidateId: "candidate-b", ownerId: "owner-1", input: freshInput("event-2", deadline) },
      ],
    });
    const secondSuccess = success(second);
    expect(secondSuccess.proposedPages).toHaveLength(2);
    expect(secondSuccess.proposedPages.flatMap((page) => page.entries)).toHaveLength(2);
    expect(secondSuccess.state.pages.every((page) => page.deliveryState === "ready")).toBe(true);
    expect(firstSuccess.quotaDecision).toBeNull();
  });

  it("emits eligible research-only HTML while keeping paused quota advisory", () => {
    const quota = {
      session: { startAt: "2026-01-20T11:00:00.000Z", endAt: "2026-01-20T12:30:00.000Z" },
      requestedCadenceMinutes: 5,
      safetyFraction: 0.8,
      zeroSpendEntitlementProven: false,
      resources: [{
        resourceId: "fixture-cpu",
        tickUpperBound: { collectionUnits: 1, recheckUnits: 1, historyUnits: 1, retryUnits: 1 },
        windows: [{
          startAt: "2026-01-20T11:00:00.000Z",
          endAt: "2026-01-20T12:30:00.000Z",
          allowanceUnits: 1_000,
          usedUnits: 0,
          outstandingReservationUnits: 0,
        }],
      }],
    };
    const result = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [{ candidateId: "research-a", ownerId: "owner-1", roundKind: "opening", input: cloneInput() }],
      quota,
    }));
    const preview = result.researchPreviews[0];
    expect(preview?.ownerId).toBe("owner-1");
    expect(preview?.candidateId).toBe("research-a");
    expect(preview?.label).toBe("research-only");
    expect(preview?.researchOnly).toBe(true);
    expect(preview?.deliveryAuthorized).toBe(false);
    expect(preview?.pages.join("\n")).toContain("WATCHLIST RESEARCH PREVIEW");
    expect(result.quotaDecision?.paused).toBe(true);
    expect(result.quotaDecision?.pausedReason).toBe("ZERO_SPEND_UNVERIFIED");
    expect(result.proposedPages).toHaveLength(0);
  });

  it("does not treat an allowed quota proposal as a committed reservation", () => {
    const quota = {
      session: { startAt: "2026-01-20T11:00:00.000Z", endAt: "2026-01-20T12:30:00.000Z" },
      requestedCadenceMinutes: 5,
      safetyFraction: 0.8,
      zeroSpendEntitlementProven: true,
      resources: [{
        resourceId: "fixture-cpu",
        tickUpperBound: { collectionUnits: 1, recheckUnits: 1, historyUnits: 1, retryUnits: 1 },
        windows: [{
          startAt: "2026-01-20T11:00:00.000Z",
          endAt: "2026-01-20T12:30:00.000Z",
          allowanceUnits: 1_000,
          usedUnits: 0,
          outstandingReservationUnits: 0,
        }],
      }],
    };
    const result = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [],
      quota,
    }));
    expect(result.quotaDecision?.allowed).toBe(true);
    expect(result.quotaDecision?.reservation).not.toBeNull();
    expect(result.state.batches).toHaveLength(0);
    expect(result.state.candidates).toHaveLength(0);
  });

  it("does not format invalid candidates or stale state without fresh input", () => {
    const invalid = cloneInput();
    invalid.price.quote.marketType = "total_legs";
    const first = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [{ candidateId: "invalid", ownerId: "owner-1", roundKind: "opening", input: invalid }],
    }));
    expect(first.researchPreviews).toHaveLength(0);

    const valid = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [{ candidateId: "prior", ownerId: "owner-1", roundKind: "opening", input: cloneInput() }],
    }));
    const restart = success(runOfflineWatchlistTick({
      now: new Date(SYNTHETIC_NOW.getTime() + 1_000).toISOString(),
      candidates: [],
      batchingState: valid.state,
    }));
    expect(restart.researchPreviews).toHaveLength(0);
  });

  it("removes an initial preview when revalidation is stale or changes identity", () => {
    const initial = SYNTHETIC_NOW;
    const first = success(runOfflineWatchlistTick({
      now: initial.toISOString(),
      candidates: [{ candidateId: "preview-refresh", ownerId: "owner-1", roundKind: "opening", input: cloneInput() }],
    }));
    expect(first.researchPreviews).toHaveLength(1);
    const deadline = new Date(initial.getTime() + 120_000);

    const staleInput = freshInput("event-1", deadline);
    staleInput.price.quote.marketType = "total_legs";
    const stale = success(runOfflineWatchlistTick({
      now: deadline.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "preview-refresh", ownerId: "owner-1", input: staleInput }],
    }));
    expect(stale.researchPreviews).toHaveLength(0);

    const changedIdentity = success(runOfflineWatchlistTick({
      now: deadline.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "preview-refresh", ownerId: "owner-1", input: freshInput("event-2", deadline) }],
    }));
    expect(changedIdentity.researchPreviews).toHaveLength(0);
    expect(changedIdentity.state.candidates[0]?.deliveryState).toBe("suppressed");
  });

  it("preserves owner-scoped deduplication across bookmaker/rule changes and suppresses stale revalidation", () => {
    const initial = SYNTHETIC_NOW;
    const deadline = new Date(initial.getTime() + 120_000);
    const first = success(runOfflineWatchlistTick({
      now: initial.toISOString(),
      candidates: [{ candidateId: "candidate-a", ownerId: "owner-1", roundKind: "opening", input: cloneInput() }],
    }));
    const prepared = success(runOfflineWatchlistTick({
      now: deadline.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "candidate-a", ownerId: "owner-1", input: freshInput("event-1", deadline) }],
    }));
    const page = prepared.proposedPages[0];
    if (page === undefined) throw new Error("Expected a proposed page.");
    let sentState = beginPageSending(prepared.state, page.pageId, deadline.getTime(), [revalidation("candidate-a", deadline)]);
    sentState = markPageSent(sentState, page.pageId);

    const changed = freshInput("event-1", new Date(deadline.getTime() + 1_000));
    changed.price.quote.bookmakerId = "priority-bookmaker";
    changed.rules.allowedBookmakers = ["tippmixpro", "priority-bookmaker"];
    changed.rules.version = "synthetic-v2";
    const deduplicated = success(runOfflineWatchlistTick({
      now: new Date(deadline.getTime() + 1_000).toISOString(),
      candidates: [{ candidateId: "candidate-a", ownerId: "owner-1", roundKind: "opening", input: changed }],
      batchingState: sentState,
      revalidations: [{ candidateId: "candidate-a", ownerId: "owner-1", input: changed }],
    }));
    expect(deduplicated.state.candidates).toHaveLength(1);
    expect(deduplicated.state.candidates[0]?.deliveryState).toBe("sent");
    expect(deduplicated.proposedPages).toHaveLength(0);

    const staleInput = cloneInput();
    const stale = success(runOfflineWatchlistTick({
      now: deadline.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "candidate-a", ownerId: "owner-1", input: staleInput }],
    }));
    expect(stale.proposedPages).toHaveLength(0);
    expect(stale.state.candidates[0]?.deliveryState).toBe("suppressed");
    expect(stale.suppressed.some((item) => item.reason === "stale-revalidation")).toBe(true);
  });

  it("suppresses an exact freshness-boundary revalidation without failing the tick", () => {
    const initial = new Date("2026-01-20T11:58:00.000Z");
    const boundary = new Date(initial.getTime() + 120_000);
    const firstInput = freshInput("event-1", initial);
    const first = success(runOfflineWatchlistTick({
      now: initial.toISOString(),
      candidates: [{ candidateId: "candidate-boundary", ownerId: "owner-1", roundKind: "opening", input: firstInput }],
    }));
    expect(first.state.batches[0]?.openedAt).toBe(initial.getTime());

    const second = success(runOfflineWatchlistTick({
      now: boundary.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{
        candidateId: "candidate-boundary",
        ownerId: "owner-1",
        input: freshInput("event-1", initial),
      }],
    }));

    expect(second.proposedPages).toHaveLength(0);
    expect(second.state.candidates[0]?.deliveryState).toBe("suppressed");
    expect(second.suppressed).toHaveLength(1);
    expect(second.suppressed[0]?.reason).toBe("stale-revalidation");
  });

  it("does not expire an otherwise fresh revalidation because optional context is old", () => {
    const initial = SYNTHETIC_NOW;
    const initialInput = cloneInput();
    initialInput.price.quote.eventContext!.evidence!.observedAt = "2026-01-20T11:40:00.000Z";
    const first = success(runOfflineWatchlistTick({
      now: initial.toISOString(),
      candidates: [{ candidateId: "context-age", ownerId: "owner-1", roundKind: "opening", input: initialInput }],
    }));
    expect(first.evaluations[0]?.eligible).toBe(true);
    const revalidationInput = freshInput("event-1", new Date(initial.getTime() + 120_000));
    revalidationInput.price.quote.eventContext!.evidence!.observedAt = "2026-01-20T11:40:00.000Z";
    const second = success(runOfflineWatchlistTick({
      now: new Date(initial.getTime() + 120_000).toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "context-age", ownerId: "owner-1", input: revalidationInput }],
    }));
    expect(second.proposedPages.flatMap((page) => page.entries)).toHaveLength(1);
  });

  it("fails closed with JSON-safe errors and groups unknown rounds generically", () => {
    const malformed = runOfflineWatchlistTick({ now: "not-a-timestamp", candidates: [] });
    expect(malformed).toEqual({ ok: false, error: "Replay input failed strict schema validation." });

    const unknownRound = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [{ candidateId: "unknown-round", ownerId: "owner-1", roundKind: "unknown", input: cloneInput() }],
    }));
    expect(unknownRound.evaluations[0]?.eligible).toBe(true);
    expect(unknownRound.evaluations[0]?.enqueued).toBe(true);
    expect(unknownRound.state.batches).toHaveLength(1);
    expect(unknownRound.state.batches[0]?.roundKind).toBe("unknown");
    expect(unknownRound.state.batches[0]?.groupingKey).toBe("unknown-round");
  });

  it("rejects duplicate revalidations and cross-owner replay attempts", () => {
    const first = success(runOfflineWatchlistTick({
      now: SYNTHETIC_NOW.toISOString(),
      candidates: [{ candidateId: "candidate-a", ownerId: "owner-1", roundKind: "opening", input: cloneInput() }],
    }));
    const later = new Date(SYNTHETIC_NOW.getTime() + 120_000);
    const duplicate = runOfflineWatchlistTick({
      now: later.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [
        { candidateId: "candidate-a", ownerId: "owner-1", input: freshInput("event-1", later) },
        { candidateId: "candidate-a", ownerId: "owner-1", input: freshInput("event-1", later) },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toContain("Duplicate revalidation");

    const wrongOwner = runOfflineWatchlistTick({
      now: later.toISOString(),
      candidates: [],
      batchingState: first.state,
      revalidations: [{ candidateId: "candidate-a", ownerId: "owner-2", input: freshInput("event-1", later) }],
    });
    expect(wrongOwner.ok).toBe(false);
    if (!wrongOwner.ok) expect(wrongOwner.error).toContain("owner");
  });
});

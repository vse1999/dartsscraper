import { describe, expect, it } from "vitest";

import {
  addCandidate,
  beginPageSending,
  createWatchlistBatchingState,
  markPageSent,
  markPageUncertain,
  parseBatchingState,
  prepareDuePages,
  serializeBatchingState,
  type CandidateRevalidation,
  type WatchlistBatchingState,
  type WatchlistCandidateEnvelope,
} from "../src/watchlist/batching.js";
import type { WatchlistScreenInput } from "../src/watchlist/contracts.js";
import { parseAndCanonicalizeIdentity } from "../src/watchlist/identity.js";
import { screenWatchlistCandidate } from "../src/watchlist/screening.js";
import { createSyntheticWatchlistInput, SYNTHETIC_NOW } from "./fixtures/watchlist-screening.js";

function cloneInput(): WatchlistScreenInput {
  return structuredClone(createSyntheticWatchlistInput());
}

function freshInput(eventId: string, now: Date): WatchlistScreenInput {
  const input = cloneInput();
  const timestamp = now.toISOString();
  input.price.quote.eventId = eventId;
  input.price.quote.observedAt = timestamp;
  input.price.quote.sourceUpdatedAt = timestamp;
  input.price.quote.source.observedAt = timestamp;
  input.price.quote.eventContext!.evidence!.observedAt = timestamp;
  return input;
}

function envelopeFor(
  input: WatchlistScreenInput,
  candidateId: string,
  observedAt: number,
): WatchlistCandidateEnvelope {
  const identity = parseAndCanonicalizeIdentity(input.price.quote).identity;
  if (identity === null) throw new Error("Synthetic quote did not produce an identity.");
  return {
    ownerId: "offline-owner",
    canonicalMatchupKey: identity.key,
    competition: input.price.quote.competitionOccurrenceId,
    groupingKey: input.price.quote.round ?? "unknown-round",
    roundKind: "opening",
    candidateId,
    observedAt,
  };
}

function validRevalidation(candidateId: string, at: number): CandidateRevalidation {
  return {
    candidateId,
    status: "valid",
    revalidatedAt: at,
    validUntil: at + 60_000,
  };
}

function addSyntheticCandidate(
  state: WatchlistBatchingState,
  input: WatchlistScreenInput,
  candidateId: string,
  observedAt: number,
): WatchlistBatchingState {
  const screen = screenWatchlistCandidate(input, new Date(observedAt));
  if (!screen.eligible) throw new Error(`Synthetic candidate was suppressed: ${screen.reasons.map((item) => item.code).join(",")}`);
  return addCandidate(state, envelopeFor(input, candidateId, observedAt));
}

describe("offline synthetic watchlist screening and batching replay", () => {
  it("screens, batches, paginates, revalidates, persists, and suppresses stale evidence", () => {
    const initialAt = SYNTHETIC_NOW.getTime();
    const deliveryAt = initialAt + 120_000;
    const initialInput = cloneInput();
    expect(screenWatchlistCandidate(initialInput, SYNTHETIC_NOW).eligible).toBe(true);

    let state = createWatchlistBatchingState();
    const inputs = ["event-1", "event-2", "event-3"].map((eventId) => freshInput(eventId, SYNTHETIC_NOW));
    for (const [index, input] of inputs.entries()) {
      state = addSyntheticCandidate(state, input, `synthetic-${index}`, initialAt);
    }
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0]?.deadlineAt).toBe(deliveryAt);

    const deliveryInputs = inputs.map((input) => freshInput(input.price.quote.eventId, new Date(deliveryAt)));
    const revalidations = deliveryInputs.map((input, index): CandidateRevalidation => {
      const screen = screenWatchlistCandidate(input, new Date(deliveryAt));
      expect(screen.eligible).toBe(true);
      return validRevalidation(`synthetic-${index}`, deliveryAt);
    });
    const prepared = prepareDuePages(state, deliveryAt, revalidations, 2);
    expect(prepared.pages).toHaveLength(2);
    expect(prepared.pages.flatMap((page) => page.entries)).toHaveLength(3);

    const firstPage = prepared.pages[0];
    const secondPage = prepared.pages[1];
    if (firstPage === undefined || secondPage === undefined) throw new Error("Expected paginated synthetic pages.");
    state = beginPageSending(prepared.state, firstPage.pageId, deliveryAt, revalidations);
    state = markPageSent(state, firstPage.pageId);
    state = beginPageSending(state, secondPage.pageId, deliveryAt, revalidations);
    state = markPageUncertain(state, secondPage.pageId);

    const sentCount = state.candidates.filter((candidate) => candidate.deliveryState === "sent").length;
    const uncertainCount = state.candidates.filter((candidate) => candidate.deliveryState === "uncertain").length;
    expect(sentCount).toBe(2);
    expect(uncertainCount).toBe(1);

    const ruleAndBookmakerChange = freshInput("event-1", new Date(deliveryAt));
    ruleAndBookmakerChange.price.quote.bookmakerId = "priority-bookmaker";
    ruleAndBookmakerChange.rules.allowedBookmakers = ["tippmixpro", "priority-bookmaker"];
    ruleAndBookmakerChange.rules.version = "synthetic-v2";
    expect(screenWatchlistCandidate(ruleAndBookmakerChange, new Date(deliveryAt)).eligible).toBe(true);
    const beforeDeduplication = state.candidates.length;
    state = addSyntheticCandidate(state, ruleAndBookmakerChange, "same-matchup-new-evidence", deliveryAt + 1);
    expect(state.candidates).toHaveLength(beforeDeduplication);

    const restored = parseBatchingState(serializeBatchingState(state));
    expect(restored.candidates.map((candidate) => candidate.deliveryState)).toEqual(
      state.candidates.map((candidate) => candidate.deliveryState),
    );

    const staleInput = freshInput("event-stale", new Date(deliveryAt));
    const staleEnvelope = envelopeFor(staleInput, "stale-evidence", initialAt);
    const staleState = addCandidate(restored, staleEnvelope);
    const stalePrepared = prepareDuePages(staleState, deliveryAt, [{
      candidateId: "stale-evidence",
      status: "stale",
      revalidatedAt: deliveryAt,
      validUntil: deliveryAt + 60_000,
    }]);
    expect(stalePrepared.pages.flatMap((page) => page.entries).some((entry) => entry.candidateId === "stale-evidence")).toBe(false);
    expect(stalePrepared.suppressed.some((record) => record.candidateId === "stale-evidence" && record.reason === "stale-revalidation")).toBe(true);
  });
});

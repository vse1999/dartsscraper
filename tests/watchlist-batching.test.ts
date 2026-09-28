import { describe, expect, it } from "vitest";

import {
  addCandidate,
  addCandidates,
  beginPageSending,
  createWatchlistBatchingState,
  markPageSent,
  markPageUncertain,
  parseBatchingState,
  prepareDuePages,
  recoverSendingPages,
  serializeBatchingState,
  type CandidateRevalidation,
  type WatchlistBatchingState,
  type WatchlistCandidateEnvelope,
} from "../src/watchlist/batching.js";

function candidate(
  candidateId: string,
  observedAt: number,
  overrides: Partial<WatchlistCandidateEnvelope> = {},
): WatchlistCandidateEnvelope {
  return {
    ownerId: "owner-1",
    canonicalMatchupKey: "event-1:player-a/player-b",
    competition: "competition-1",
    groupingKey: "round-1",
    roundKind: "opening",
    candidateId,
    observedAt,
    ...overrides,
  };
}

function valid(candidateId: string): CandidateRevalidation {
  return { candidateId, status: "valid", revalidatedAt: 120_000, validUntil: 240_000 };
}

function dueState(candidates: readonly WatchlistCandidateEnvelope[]): WatchlistBatchingState {
  return addCandidates(createWatchlistBatchingState(), candidates);
}

describe("offline watchlist batching", () => {
  it("anchors opening and later windows to the first candidate and does not extend them", () => {
    let state = createWatchlistBatchingState();
    state = addCandidate(state, candidate("a", 0));
    state = addCandidate(state, candidate("b", 119_999, { canonicalMatchupKey: "event-1:c/d" }));
    state = addCandidate(state, candidate("c", 120_000, { canonicalMatchupKey: "event-1:e/f" }));

    expect(state.batches.map((batch) => [batch.openedAt, batch.deadlineAt])).toEqual([
      [0, 120_000],
      [120_000, 240_000],
    ]);
  });

  it("groups by owner, competition and round and retains unknown rounds in a generic batch", () => {
    let state = createWatchlistBatchingState();
    state = addCandidate(state, candidate("opening", 1));
    state = addCandidate(state, candidate("later", 2, { roundKind: "later", groupingKey: "round-2", canonicalMatchupKey: "event-1:c/d" }));
    state = addCandidate(state, candidate("unknown", 3, { roundKind: "unknown", groupingKey: "unknown-round", canonicalMatchupKey: "event-1:e/f" }));

    expect(state.batches).toHaveLength(3);
    expect(state.suppressions).toHaveLength(0);
  });

  it("replaces pending evidence without moving the batch deadline and deduplicates book/rule variants", () => {
    let state = addCandidate(createWatchlistBatchingState(), candidate("first", 10));
    const originalDeadline = state.batches[0]?.deadlineAt;
    state = addCandidate(state, candidate("new-evidence", 20));
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]?.envelope.candidateId).toBe("new-evidence");
    expect(state.batches[0]?.deadlineAt).toBe(originalDeadline);
  });

  it("requires explicit revalidation and paginates without truncating entries", () => {
    const inputs = Array.from({ length: 5 }, (_value: undefined, index: number): WatchlistCandidateEnvelope =>
      candidate(`candidate-${index}`, 0, { canonicalMatchupKey: `event-1:p${index}/q${index}` }),
    );
    const state = dueState(inputs);
    const prepared = prepareDuePages(
      state,
      120_000,
      inputs.map((item): CandidateRevalidation => valid(item.candidateId)),
      2,
    );
    expect(prepared.pages).toHaveLength(3);
    expect(prepared.pages.flatMap((page) => page.entries)).toHaveLength(5);
    const missing = prepareDuePages(dueState([inputs[0]!]), 120_000, [], 2);
    expect(missing.pages).toHaveLength(0);
    expect(missing.suppressed[0]?.reason).toBe("missing-revalidation");
  });

  it("suppresses expired and stale candidates without counting them as delivered", () => {
    const expiring = candidate("expired", 0, { expiresAt: 100 });
    const stale = candidate("stale", 0, { canonicalMatchupKey: "event-1:x/y" });
    const prepared = prepareDuePages(dueState([expiring, stale]), 120_000, [
      valid("expired"),
      { candidateId: "stale", status: "stale", revalidatedAt: 120_000, validUntil: 240_000 },
    ]);
    expect(prepared.pages).toHaveLength(0);
    expect(prepared.suppressed.map((item) => item.reason)).toEqual(["candidate-expired", "stale-revalidation"]);
    expect(prepared.state.candidates.every((item) => item.deliveryState !== "sent")).toBe(true);
  });

  it("models partial delivery and never retries sent or uncertain entries", () => {
    const first = candidate("first", 0);
    const second = candidate("second", 0, { canonicalMatchupKey: "event-1:c/d" });
    let state = dueState([first, second]);
    const prepared = prepareDuePages(state, 120_000, [valid("first"), valid("second")], 2);
    const page = prepared.pages[0];
    if (page === undefined) throw new Error("Expected a page.");
    state = beginPageSending(prepared.state, page.pageId, 120_000, [valid("first"), valid("second")]);
    state = markPageSent(state, page.pageId);
    expect(state.pages[0]?.deliveryState).toBe("sent");
    const third = candidate("second-page", 0, { canonicalMatchupKey: "event-1:e/f" });
    state = addCandidate(state, third);
    const replay = prepareDuePages(state, 120_000, [valid("second-page")], 1);
    const secondPage = replay.pages.find((item) => item.entries.some((entry) => entry.candidateId === "second-page"));
    if (secondPage === undefined) throw new Error("Expected a second page.");
    state = beginPageSending(replay.state, secondPage.pageId, 120_000, [valid("second-page")]);
    state = markPageUncertain(state, secondPage.pageId);
    expect(state.candidates.find((item) => item.envelope.candidateId === "second-page")?.deliveryState).toBe("uncertain");
    expect(() => beginPageSending(state, secondPage.pageId, 120_000, [valid("second-page")])).toThrow();
  });

  it("does not reopen sent/uncertain matchups across evidence changes and survives JSON restart", () => {
    let state = dueState([candidate("first", 0)]);
    const prepared = prepareDuePages(state, 120_000, [valid("first")]);
    const page = prepared.pages[0];
    if (page === undefined) throw new Error("Expected a page.");
    state = beginPageSending(prepared.state, page.pageId, 120_000, [valid("first")]);
    state = markPageSent(state, page.pageId);
    state = addCandidate(state, candidate("replacement", 200));
    expect(state.candidates[0]?.envelope.candidateId).toBe("first");
    const restored = parseBatchingState(serializeBatchingState(state));
    const replay = prepareDuePages(restored, 240_000, [valid("replacement")]);
    expect(replay.pages).toHaveLength(0);
    expect(replay.state.candidates[0]?.deliveryState).toBe("sent");
  });

  it("revalidates again at the send boundary and marks ambiguous sending pages uncertain on restart", () => {
    let state = dueState([candidate("first", 0)]);
    const prepared = prepareDuePages(state, 120_000, [valid("first")]);
    const page = prepared.pages[0];
    if (page === undefined) throw new Error("Expected a page.");
    const stale = { candidateId: "first", status: "valid" as const, revalidatedAt: 120_000, validUntil: 240_000 };
    const staleState = beginPageSending(prepared.state, page.pageId, 240_000, [stale]);
    expect(staleState.candidates[0]?.deliveryState).toBe("suppressed");
    state = beginPageSending(prepared.state, page.pageId, 120_000, [valid("first")]);
    const restored = parseBatchingState(serializeBatchingState(state));
    const recovered = recoverSendingPages(restored);
    expect(recovered.pages[0]?.deliveryState).toBe("uncertain");
    expect(recovered.candidates[0]?.deliveryState).toBe("uncertain");
    expect(() => beginPageSending(recovered, page.pageId, 120_000, [valid("first")])).toThrow();
  });

  it("keeps an empty suppressed page serializable and bounds revalidation validity", () => {
    const state = dueState([candidate("first", 0)]);
    const prepared = prepareDuePages(state, 120_000, [valid("first")]);
    const page = prepared.pages[0];
    if (page === undefined) throw new Error("Expected a page.");
    const staleAtSend = beginPageSending(prepared.state, page.pageId, 240_000, [valid("first")]);
    expect(staleAtSend.pages[0]?.entries).toHaveLength(0);
    expect(() => parseBatchingState(serializeBatchingState(staleAtSend))).not.toThrow();
    const tooLong = { candidateId: "first", status: "valid" as const, revalidatedAt: 120_000, validUntil: 240_001 };
    expect(() => prepareDuePages(state, 120_000, [tooLong])).toThrow(/120 seconds/);
  });

  it("rejects duplicate candidate IDs even when matchup keys differ", () => {
    const state = addCandidate(createWatchlistBatchingState(), candidate("duplicate", 0));
    expect(() => addCandidate(state, candidate("duplicate", 1, { canonicalMatchupKey: "event-1:other/a" }))).toThrow(/already used/);
  });

  it("rejects malformed snapshots and prevents out-of-order future-batch attachment", () => {
    expect(() => parseBatchingState("{\"version\":1,\"nextBatchSequence\":1,\"batches\":[],\"candidates\":[],\"pages\":[],\"suppressions\":[]}")).toThrow(/legacy/i);
    expect(() => parseBatchingState("{\"version\":1,\"nextBatchSequence\":1,\"batches\":[{\"batchId\":\"batch-1\"}],\"candidates\":[],\"pages\":[],\"suppressions\":[]}")).toThrow();
    expect(() => parseBatchingState("{\"version\":2,\"nextBatchSequence\":2,\"batches\":[{\"batchId\":\"batch-1\",\"ownerId\":\"o\",\"competition\":\"c\",\"groupingKey\":\"r\",\"roundKind\":\"opening\",\"openedAt\":0,\"deadlineAt\":120000,\"candidateKeys\":[\"dangling\"]}],\"candidates\":[],\"pages\":[],\"suppressions\":[]}")).toThrow(/missing candidate/);
    let validState = addCandidate(createWatchlistBatchingState(), candidate("sequence", 0));
    const validSnapshot = serializeBatchingState(validState).replace("\"nextBatchSequence\":2", "\"nextBatchSequence\":1");
    expect(() => parseBatchingState(validSnapshot)).toThrow(/nextBatchSequence/);
    const futureState = addCandidate(createWatchlistBatchingState(), candidate("future", 100));
    expect(() => addCandidate(futureState, candidate("past", 99, { canonicalMatchupKey: "event-1:past/a" }))).toThrow();
  });
});

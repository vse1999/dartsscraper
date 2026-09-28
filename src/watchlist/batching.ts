/**
 * Pure, offline watchlist batching state.
 *
 * This module deliberately does not provide persistence, locking, a clock, or
 * a sender. A caller owns those concerns and must pass this state through a
 * durable/serialized boundary if restart recovery is required.
 */

import {
  BATCHING_SNAPSHOT_VERSION,
  LATER_BATCH_WINDOW_MS,
  OPENING_BATCH_WINDOW_MS,
  type CandidateDeliveryState,
  type CandidateRecord,
  type CandidateRevalidation,
  type DeliveryPage,
  type DeliveryPageEntry,
  type PreparedDeliveryEntry,
  type PreparedDeliveryPage,
  type PreparedDuePages,
  type RoundKind,
  type SuppressionReason,
  type SuppressionRecord,
  type WatchlistBatch,
  type WatchlistBatchingState,
  type WatchlistCandidateEnvelope,
} from "./batching-model.js";
import { assertValidBatchingState, parseBatchingState, serializeBatchingState } from "./batching-snapshot.js";

export * from "./batching-model.js";
export { parseBatchingState, serializeBatchingState } from "./batching-snapshot.js";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertSafeTimestamp(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer timestamp.`);
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${fieldName} must be a non-empty string of at most 512 characters.`);
  }
}

function assertPositiveInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer.`);
  }
}

function deduplicationKey(ownerId: string, matchupKey: string): string {
  return JSON.stringify([ownerId, matchupKey]);
}

function groupKey(candidate: WatchlistCandidateEnvelope): string {
  // A round-kind change is a classification conflict, not a mutable update to
  // an existing batch. Keeping it in the group key prevents a later caller
  // from mutating an opening batch into a later/unknown batch and producing a
  // snapshot whose candidate metadata disagrees with its batch.
  return JSON.stringify([candidate.ownerId, candidate.competition, candidate.groupingKey, candidate.roundKind]);
}

function batchGroupKey(batch: Pick<WatchlistBatch, "ownerId" | "competition" | "groupingKey" | "roundKind">): string {
  return JSON.stringify([batch.ownerId, batch.competition, batch.groupingKey, batch.roundKind]);
}

function batchWindow(roundKind: RoundKind): number {
  return roundKind === "opening" ? OPENING_BATCH_WINDOW_MS : LATER_BATCH_WINDOW_MS;
}

function validateCandidate(candidate: WatchlistCandidateEnvelope): void {
  assertNonEmptyString(candidate.ownerId, "candidate.ownerId");
  assertNonEmptyString(candidate.canonicalMatchupKey, "candidate.canonicalMatchupKey");
  assertNonEmptyString(candidate.competition, "candidate.competition");
  assertNonEmptyString(candidate.groupingKey, "candidate.groupingKey");
  assertNonEmptyString(candidate.candidateId, "candidate.candidateId");
  assertSafeTimestamp(candidate.observedAt, "candidate.observedAt");
  if (candidate.expiresAt !== undefined) {
    assertSafeTimestamp(candidate.expiresAt, "candidate.expiresAt");
    if (candidate.expiresAt < candidate.observedAt) {
      throw new Error("candidate.expiresAt cannot precede candidate.observedAt.");
    }
  }
  if (candidate.roundKind !== "opening" && candidate.roundKind !== "later" && candidate.roundKind !== "unknown") {
    throw new Error("candidate.roundKind must be opening, later, or unknown.");
  }
}

function suppressionFor(
  candidate: WatchlistCandidateEnvelope,
  reason: SuppressionReason,
  at: number,
): SuppressionRecord {
  return {
    ownerId: candidate.ownerId,
    canonicalMatchupKey: candidate.canonicalMatchupKey,
    candidateId: candidate.candidateId,
    reason,
    at,
  };
}

function withSuppression(
  state: WatchlistBatchingState,
  candidate: WatchlistCandidateEnvelope,
  reason: SuppressionReason,
  at: number,
): WatchlistBatchingState {
  return { ...state, suppressions: [...state.suppressions, suppressionFor(candidate, reason, at)] };
}

export function createWatchlistBatchingState(): WatchlistBatchingState {
  return {
    version: BATCHING_SNAPSHOT_VERSION,
    nextBatchSequence: 1,
    batches: [],
    candidates: [],
    pages: [],
    suppressions: [],
  };
}

/**
 * Adds an envelope without mutating the input. Unknown rounds are retained in
 * a generic digest group; they are never classified as opening or later.
 */
export function addCandidate(
  state: WatchlistBatchingState,
  candidate: WatchlistCandidateEnvelope,
): WatchlistBatchingState {
  assertValidBatchingState(state);
  validateCandidate(candidate);

  const key = deduplicationKey(candidate.ownerId, candidate.canonicalMatchupKey);
  const existingIndex = state.candidates.findIndex((item): boolean => item.deduplicationKey === key);
  const duplicateCandidateId = state.candidates.find((item): boolean => item.envelope.candidateId === candidate.candidateId && item.deduplicationKey !== key);
  if (duplicateCandidateId !== undefined) throw new Error(`candidateId '${candidate.candidateId}' is already used by another matchup.`);
  if (existingIndex >= 0) {
    const existing = state.candidates[existingIndex];
    if (existing === undefined) throw new Error("Candidate index became invalid.");
    const sameGroup = groupKey(existing.envelope) === groupKey(candidate);
    if (!sameGroup) return withSuppression(state, candidate, "identity-group-conflict", candidate.observedAt);
    if (candidate.observedAt < existing.envelope.observedAt) return state;

    // Only pending evidence is replaceable. Sent, uncertain, suppressed and
    // expired records are tombstones and must not be reopened or rewritten.
    if (existing.deliveryState !== "pending") return state;
    const replacement: CandidateRecord = { ...existing, envelope: { ...candidate } };
    const candidates = [...state.candidates];
    candidates[existingIndex] = replacement;
    return { ...state, candidates };
  }

  const sequence = state.nextBatchSequence;
  const batchId = `batch-${sequence}`;
  const group = groupKey(candidate);
  const futureBatch = state.batches.find((batch): boolean =>
    batchGroupKey(batch) === group && candidate.observedAt < batch.openedAt,
  );
  if (futureBatch !== undefined) throw new Error("candidate.observedAt precedes an existing batch opening; reject out-of-order clock input.");
  const previousBatch = [...state.batches]
    .reverse()
    .find((batch): boolean =>
      batchGroupKey(batch) === group &&
      candidate.observedAt < batch.deadlineAt,
    );
  if (previousBatch !== undefined) {
    const batches = state.batches.map((batch): WatchlistBatch =>
      batch.batchId === previousBatch.batchId
        ? { ...batch, candidateKeys: [...batch.candidateKeys, key] }
        : batch,
    );
    return {
      ...state,
      batches,
      candidates: [
        ...state.candidates,
        { deduplicationKey: key, envelope: { ...candidate }, batchId: previousBatch.batchId, deliveryState: "pending" },
      ],
    };
  }

  const batch: WatchlistBatch = {
    batchId,
    ownerId: candidate.ownerId,
    competition: candidate.competition,
    groupingKey: candidate.groupingKey,
    roundKind: candidate.roundKind,
    openedAt: candidate.observedAt,
    deadlineAt: (() => {
      const windowMs = batchWindow(candidate.roundKind);
      if (candidate.observedAt > Number.MAX_SAFE_INTEGER - windowMs) {
        throw new Error("candidate.observedAt is too close to the safe timestamp limit.");
      }
      return candidate.observedAt + windowMs;
    })(),
    candidateKeys: [key],
  };
  return {
    ...state,
    nextBatchSequence: sequence + 1,
    batches: [...state.batches, batch],
    candidates: [
      ...state.candidates,
      { deduplicationKey: key, envelope: { ...candidate }, batchId, deliveryState: "pending" },
    ],
  };
}

export function addCandidates(
  state: WatchlistBatchingState,
  candidates: readonly WatchlistCandidateEnvelope[],
): WatchlistBatchingState {
  return candidates.reduce((current, candidate): WatchlistBatchingState => addCandidate(current, candidate), state);
}

function revalidationByCandidate(
  revalidations: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>,
): ReadonlyMap<string, CandidateRevalidation> {
  if (isReadonlyMap(revalidations)) return revalidations;
  return new Map(revalidations.map((item: CandidateRevalidation): readonly [string, CandidateRevalidation] => [item.candidateId, item]));
}

function isReadonlyMap(value: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>): value is ReadonlyMap<string, CandidateRevalidation> {
  return typeof (value as { readonly get?: unknown }).get === "function";
}

function suppressionReasonForRevalidation(
  result: CandidateRevalidation | undefined,
): SuppressionReason {
  if (result === undefined) return "missing-revalidation";
  if (result.status === "stale") return "stale-revalidation";
  if (result.status === "expired") return "expired-revalidation";
  if (result.status === "invalid") return "invalid-revalidation";
  return "revalidation-mismatch";
}

function validateRevalidation(result: CandidateRevalidation, now: number, minimumObservedAt = 0): SuppressionReason | undefined {
  assertNonEmptyString(result.candidateId, "revalidation.candidateId");
  if (result.status !== "valid" && result.status !== "stale" && result.status !== "expired" && result.status !== "invalid") {
    throw new Error("revalidation.status must be valid, stale, expired, or invalid.");
  }
  assertSafeTimestamp(result.revalidatedAt, "revalidation.revalidatedAt");
  assertSafeTimestamp(result.validUntil, "revalidation.validUntil");
  if (result.validUntil <= result.revalidatedAt || result.validUntil - result.revalidatedAt > OPENING_BATCH_WINDOW_MS || result.revalidatedAt < minimumObservedAt || result.revalidatedAt > now) return "stale-revalidation";
  if (now >= result.validUntil) return "stale-revalidation";
  if (result.status !== "valid") return suppressionReasonForRevalidation(result);
  return undefined;
}

function validateRevalidationCollection(
  revalidations: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>,
): void {
  const values = isReadonlyMap(revalidations) ? [...revalidations.values()] : revalidations;
  const candidateIds = new Set<string>();
  for (const result of values as readonly unknown[]) {
    if (!isRecord(result)) throw new Error("Invalid revalidation result: expected an object.");
    assertNonEmptyString(result.candidateId, "revalidation.candidateId");
    if (candidateIds.has(result.candidateId)) throw new Error(`Duplicate revalidation for candidate '${result.candidateId}'.`);
    candidateIds.add(result.candidateId);
    if (result.status !== "valid" && result.status !== "stale" && result.status !== "expired" && result.status !== "invalid") {
      throw new Error("revalidation.status must be valid, stale, expired, or invalid.");
    }
    assertSafeTimestamp(result.revalidatedAt, "revalidation.revalidatedAt");
    assertSafeTimestamp(result.validUntil, "revalidation.validUntil");
    if (result.validUntil <= result.revalidatedAt || result.validUntil - result.revalidatedAt > OPENING_BATCH_WINDOW_MS) throw new Error("revalidation validity must be positive and no longer than 120 seconds.");
  }
}

function preparePageView(
  page: DeliveryPage,
  candidates: readonly CandidateRecord[],
): PreparedDeliveryPage | undefined {
  const entries: PreparedDeliveryEntry[] = [];
  for (const entry of page.entries) {
    if (entry.deliveryState !== "pending") continue;
    const candidate = candidates.find((item): boolean => item.deduplicationKey === entry.candidateKey);
    if (candidate?.deliveryState !== "pending") continue;
    entries.push({ candidateId: candidate.envelope.candidateId, envelope: { ...candidate.envelope } });
  }
  if (entries.length === 0) return undefined;
  return { pageId: page.pageId, batchId: page.batchId, pageNumber: page.pageNumber, entries };
}

/**
 * Closes due windows and prepares bounded pages. Every pending candidate mus
 * have a matching current revalidation result; missing results are suppressed
 * rather than optimistically delivered.
 */
export function prepareDuePages(
  state: WatchlistBatchingState,
  now: number,
  revalidations: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>,
  pageSize = 10,
): PreparedDuePages {
  assertValidBatchingState(state);
  assertSafeTimestamp(now, "now");
  assertPositiveInteger(pageSize, "pageSize");
  validateRevalidationCollection(revalidations);
  const validation = revalidationByCandidate(revalidations);
  let nextState: WatchlistBatchingState = { ...state };
  const newSuppressions: SuppressionRecord[] = [];
  const dueBatches = state.batches.filter((batch): boolean => batch.deadlineAt <= now);

  for (const batch of dueBatches) {
    for (const candidateKey of batch.candidateKeys) {
      const index = nextState.candidates.findIndex((item): boolean => item.deduplicationKey === candidateKey);
      const candidate = nextState.candidates[index];
      if (candidate === undefined || candidate.deliveryState !== "pending") continue;
      const result = validation.get(candidate.envelope.candidateId);
      let reason: SuppressionReason | undefined;
      if (candidate.envelope.expiresAt !== undefined && now >= candidate.envelope.expiresAt) {
        reason = "candidate-expired";
      } else if (result === undefined || result.candidateId !== candidate.envelope.candidateId) {
        reason = suppressionReasonForRevalidation(result);
      } else {
        reason = validateRevalidation(result, now, candidate.envelope.observedAt);
      }
      if (reason === undefined) continue;
      const deliveryState: CandidateDeliveryState = reason === "candidate-expired" ? "expired" : "suppressed";
      const updated: CandidateRecord = { ...candidate, deliveryState, suppressionReason: reason };
      const candidates = [...nextState.candidates];
      candidates[index] = updated;
      const suppression = suppressionFor(candidate.envelope, reason, now);
      nextState = { ...nextState, candidates, suppressions: [...nextState.suppressions, suppression] };
      newSuppressions.push(suppression);
    }
  }

  // A candidate can expire or fail revalidation after a page was firs
  // prepared. Remove it from every not-yet-sent page; otherwise a later send
  // transition could accidentally revive a terminal candidate.
  const terminalKeys = new Set(
    nextState.candidates
      .filter((candidate): boolean => candidate.deliveryState === "suppressed" || candidate.deliveryState === "expired")
      .map((candidate): string => candidate.deduplicationKey),
  );
  const pagesWithoutTerminalEntries = nextState.pages.map((page): DeliveryPage => {
    if (page.deliveryState !== "ready") return page;
    const entries = page.entries.filter((entry): boolean => !terminalKeys.has(entry.candidateKey));
    return entries.length === page.entries.length ? page : { ...page, entries };
  });

  const pages = [...pagesWithoutTerminalEntries];
  for (const batch of dueBatches) {
    const pendingKeys = batch.candidateKeys.filter((key): boolean => {
      const candidate = nextState.candidates.find((item): boolean => item.deduplicationKey === key);
      return candidate?.deliveryState === "pending";
    });
    const existingKeys = new Set(
      pages.filter((page): boolean => page.batchId === batch.batchId)
        .flatMap((page): readonly string[] => page.entries.map((entry): string => entry.candidateKey)),
    );
    const unpagedKeys = pendingKeys.filter((key): boolean => !existingKeys.has(key));
    let pageNumber = pages
      .filter((page): boolean => page.batchId === batch.batchId)
      .reduce((max, page): number => Math.max(max, page.pageNumber), 0) + 1;
    for (let offset = 0; offset < unpagedKeys.length; offset += pageSize) {
      const keys = unpagedKeys.slice(offset, offset + pageSize);
      const page: DeliveryPage = {
        pageId: `${batch.batchId}-page-${pageNumber}`,
        batchId: batch.batchId,
        pageNumber,
        entries: keys.map((candidateKey): DeliveryPageEntry => ({ candidateKey, deliveryState: "pending" })),
        deliveryState: "ready",
      };
      pages.push(page);
      pageNumber += 1;
    }
  }
  nextState = { ...nextState, pages };
  const preparedPages = nextState.pages
    .map((page): PreparedDeliveryPage | undefined => preparePageView(page, nextState.candidates))
    .filter((page): page is PreparedDeliveryPage => page !== undefined);
  return { state: nextState, pages: preparedPages, suppressed: newSuppressions };
}

function findPage(state: WatchlistBatchingState, pageId: string): DeliveryPage {
  const page = state.pages.find((item): boolean => item.pageId === pageId);
  if (page === undefined) throw new Error(`Delivery page '${pageId}' was not found.`);
  return page;
}

function pageRevalidationReason(
  state: WatchlistBatchingState,
  page: DeliveryPage,
  now: number,
  revalidations: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>,
): ReadonlyMap<string, SuppressionReason> {
  const byId = revalidationByCandidate(revalidations);
  const reasons = new Map<string, SuppressionReason>();
  for (const entry of page.entries) {
    const candidate = state.candidates.find((item): boolean => item.deduplicationKey === entry.candidateKey);
    if (candidate === undefined) throw new Error(`Page '${page.pageId}' references a missing candidate.`);
    const result = byId.get(candidate.envelope.candidateId);
    let reason: SuppressionReason | undefined;
    if (candidate.envelope.expiresAt !== undefined && now >= candidate.envelope.expiresAt) reason = "candidate-expired";
    else if (result === undefined || result.candidateId !== candidate.envelope.candidateId) reason = suppressionReasonForRevalidation(result);
    else reason = validateRevalidation(result, now, candidate.envelope.observedAt);
    if (reason !== undefined) reasons.set(entry.candidateKey, reason);
  }
  return reasons;
}

/** Rechecks every entry at the send boundary before transitioning to sending. */
export function beginPageSending(
  state: WatchlistBatchingState,
  pageId: string,
  now: number,
  revalidations: readonly CandidateRevalidation[] | ReadonlyMap<string, CandidateRevalidation>,
): WatchlistBatchingState {
  assertValidBatchingState(state);
  assertSafeTimestamp(now, "now");
  validateRevalidationCollection(revalidations);
  const page = findPage(state, pageId);
  if (page.deliveryState !== "ready") throw new Error(`Page '${pageId}' cannot enter sending from '${page.deliveryState}'.`);
  if (page.entries.length === 0) throw new Error(`Page '${pageId}' has no deliverable entries.`);
  const reasons = pageRevalidationReason(state, page, now, revalidations);
  let nextState: WatchlistBatchingState = state;
  const suppressions: SuppressionRecord[] = [];
  if (reasons.size > 0) {
    const candidates = nextState.candidates.map((candidate): CandidateRecord => {
      const reason = reasons.get(candidate.deduplicationKey);
      if (reason === undefined) return candidate;
      const updated: CandidateRecord = {
        ...candidate,
        deliveryState: reason === "candidate-expired" ? "expired" : "suppressed",
        suppressionReason: reason,
      };
      const suppression = suppressionFor(candidate.envelope, reason, now);
      suppressions.push(suppression);
      return updated;
    });
    nextState = { ...nextState, candidates, suppressions: [...nextState.suppressions, ...suppressions] };
  }
  const pages = nextState.pages.map((item): DeliveryPage => {
    if (item.pageId !== pageId) return item;
    const entries = item.entries.filter((entry): boolean => !reasons.has(entry.candidateKey));
    return { ...item, entries, deliveryState: entries.length === 0 ? "ready" : "sending" };
  });
  const sendingKeys = new Set(page.entries.filter((entry): boolean => !reasons.has(entry.candidateKey)).map((entry): string => entry.candidateKey));
  const candidates = nextState.candidates.map((candidate): CandidateRecord =>
    sendingKeys.has(candidate.deduplicationKey) && candidate.deliveryState === "pending"
      ? { ...candidate, deliveryState: "sending" }
      : candidate,
  );
  return { ...nextState, candidates, pages };
}

function markPageTerminal(
  state: WatchlistBatchingState,
  pageId: string,
  deliveryState: "sent" | "uncertain",
): WatchlistBatchingState {
  assertValidBatchingState(state);
  const page = findPage(state, pageId);
  if (page.deliveryState !== "sending") throw new Error(`Page '${pageId}' is not awaiting a delivery outcome.`);
  const candidateKeys = new Set(page.entries.map((entry): string => entry.candidateKey));
  const candidates = state.candidates.map((candidate): CandidateRecord =>
    candidateKeys.has(candidate.deduplicationKey)
      ? { ...candidate, deliveryState }
      : candidate,
  );
  const pages = state.pages.map((item): DeliveryPage =>
    item.pageId === pageId
      ? { ...item, entries: item.entries.map((entry): DeliveryPageEntry => ({ ...entry, deliveryState })), deliveryState }
      : item,
  );
  return { ...state, candidates, pages };
}

export function markPageSent(state: WatchlistBatchingState, pageId: string): WatchlistBatchingState {
  return markPageTerminal(state, pageId, "sent");
}

export function markPageUncertain(state: WatchlistBatchingState, pageId: string): WatchlistBatchingState {
  return markPageTerminal(state, pageId, "uncertain");
}

/** A sending snapshot is ambiguous after restart; never replay it. */
export function recoverSendingPages(state: WatchlistBatchingState): WatchlistBatchingState {
  assertValidBatchingState(state);
  const sendingPages = new Set(state.pages.filter((page): boolean => page.deliveryState === "sending").map((page): string => page.pageId));
  if (sendingPages.size === 0) return state;
  const candidateKeys = new Set(
    state.pages.filter((page): boolean => sendingPages.has(page.pageId)).flatMap((page): readonly DeliveryPageEntry[] => page.entries).map((entry): string => entry.candidateKey),
  );
  return {
    ...state,
    candidates: state.candidates.map((candidate): CandidateRecord => candidateKeys.has(candidate.deduplicationKey) ? { ...candidate, deliveryState: "uncertain" } : candidate),
    pages: state.pages.map((page): DeliveryPage => sendingPages.has(page.pageId) ? { ...page, deliveryState: "uncertain", entries: page.entries.map((entry): DeliveryPageEntry => ({ ...entry, deliveryState: "uncertain" })) } : page),
  };
}

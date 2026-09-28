import {
  BATCHING_SNAPSHOT_VERSION,
  LATER_BATCH_WINDOW_MS,
  OPENING_BATCH_WINDOW_MS,
  type CandidateRecord,
  type RoundKind,
  type SuppressionReason,
  type WatchlistBatch,
  type WatchlistBatchingState,
  type WatchlistCandidateEnvelope,
} from "./batching-model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertSafeTimestamp(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${fieldName} must be a non-negative safe integer timestamp.`);
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error(`${fieldName} must be a non-empty string of at most 512 characters.`);
}

function assertPositiveInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${fieldName} must be a positive safe integer.`);
}

function deduplicationKey(ownerId: string, matchupKey: string): string {
  return JSON.stringify([ownerId, matchupKey]);
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
    if (candidate.expiresAt < candidate.observedAt) throw new Error("candidate.expiresAt cannot precede candidate.observedAt.");
  }
  if (candidate.roundKind !== "opening" && candidate.roundKind !== "later" && candidate.roundKind !== "unknown") throw new Error("candidate.roundKind must be opening, later, or unknown.");
}
export function serializeBatchingState(state: WatchlistBatchingState): string {
  assertValidBatchingState(state);
  return JSON.stringify(state);
}

export function parseBatchingState(serialized: string): WatchlistBatchingState {
  if (typeof serialized !== "string" || serialized.length === 0) throw new Error("Batching snapshot must be a non-empty JSON string.");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Invalid batching snapshot JSON: ${detail}`);
  }
  if (!isRecord(value)) throw new Error("Invalid batching snapshot: expected an object.");
  assertValidBatchingState(value);
  return value as unknown as WatchlistBatchingState;
}

export function assertValidBatchingState(state: unknown): asserts state is WatchlistBatchingState {
  if (!isRecord(state)) throw new Error("Invalid batching state: expected an object.");
  if (state.version !== BATCHING_SNAPSHOT_VERSION) {
    if (state.version === 1) throw new Error("Unsupported legacy batching snapshot version 1; migrate by starting a new v2 replay state.");
    throw new Error(`Unsupported batching snapshot version ${String(state.version)}; expected v${BATCHING_SNAPSHOT_VERSION}.`);
  }
  assertPositiveInteger(state.nextBatchSequence, "state.nextBatchSequence");
  if (!Array.isArray(state.batches) || !Array.isArray(state.candidates) || !Array.isArray(state.pages) || !Array.isArray(state.suppressions)) {
    throw new Error("Invalid batching state: arrays are required.");
  }
  const batchIds = new Set<string>();
  const batchById = new Map<string, WatchlistBatch>();
  for (const rawBatch of state.batches) {
    if (!isRecord(rawBatch)) throw new Error("Invalid batching state batch.");
    assertNonEmptyString(rawBatch.batchId, "batch.batchId");
    const batchSequenceText = rawBatch.batchId.startsWith("batch-") ? rawBatch.batchId.slice("batch-".length) : "";
    const batchSequence = Number(batchSequenceText);
    if (!Number.isSafeInteger(batchSequence) || batchSequence < 1) throw new Error("Invalid batch id sequence.");
    if (batchSequence >= state.nextBatchSequence) throw new Error("nextBatchSequence must exceed every existing batch id.");
    assertNonEmptyString(rawBatch.ownerId, "batch.ownerId");
    assertNonEmptyString(rawBatch.competition, "batch.competition");
    assertNonEmptyString(rawBatch.groupingKey, "batch.groupingKey");
    assertSafeTimestamp(rawBatch.openedAt, "batch.openedAt");
    assertSafeTimestamp(rawBatch.deadlineAt, "batch.deadlineAt");
    if (rawBatch.roundKind !== "opening" && rawBatch.roundKind !== "later" && rawBatch.roundKind !== "unknown") throw new Error("Invalid batch round kind.");
    const expectedDeadline = rawBatch.openedAt + batchWindow(rawBatch.roundKind);
    if (rawBatch.openedAt > Number.MAX_SAFE_INTEGER - batchWindow(rawBatch.roundKind) || rawBatch.deadlineAt !== expectedDeadline) {
      throw new Error("Invalid batch deadline.");
    }
    if (!Array.isArray(rawBatch.candidateKeys) || rawBatch.candidateKeys.length === 0) throw new Error("Invalid batch candidate keys.");
    const keys = new Set<string>();
    for (const rawKey of rawBatch.candidateKeys) {
      assertNonEmptyString(rawKey, "batch.candidateKey");
      if (keys.has(rawKey)) throw new Error("Invalid batch: duplicate candidate key.");
      keys.add(rawKey);
    }
    if (batchIds.has(rawBatch.batchId)) throw new Error("Invalid batching state: duplicate batch id.");
    batchIds.add(rawBatch.batchId);
    const batch: WatchlistBatch = {
      batchId: rawBatch.batchId,
      ownerId: rawBatch.ownerId,
      competition: rawBatch.competition,
      groupingKey: rawBatch.groupingKey,
      roundKind: rawBatch.roundKind,
      openedAt: rawBatch.openedAt,
      deadlineAt: rawBatch.deadlineAt,
      candidateKeys: rawBatch.candidateKeys,
    };
    batchById.set(batch.batchId, batch);
  }

  const candidateKeys = new Set<string>();
  const candidateIds = new Set<string>();
  const candidateByKey = new Map<string, CandidateRecord>();
  for (const rawCandidate of state.candidates) {
    if (!isRecord(rawCandidate)) throw new Error("Invalid batching state candidate.");
    const deduplicationKeyValue = rawCandidate.deduplicationKey;
    assertNonEmptyString(deduplicationKeyValue, "candidate.deduplicationKey");
    if (!isRecord(rawCandidate.envelope)) throw new Error("Invalid batching state candidate envelope.");
    const envelope = rawCandidate.envelope as unknown as WatchlistCandidateEnvelope;
    validateCandidate(envelope);
    const batchId = rawCandidate.batchId;
    assertNonEmptyString(batchId, "candidate.batchId");
    const expectedKey = deduplicationKey(envelope.ownerId, envelope.canonicalMatchupKey);
    if (deduplicationKeyValue !== expectedKey) throw new Error("Candidate deduplication key does not match its envelope.");
    if (candidateIds.has(envelope.candidateId)) throw new Error("Invalid batching state: duplicate candidate id.");
    const batch = batchById.get(batchId);
    if (batch === undefined || !batch.candidateKeys.includes(deduplicationKeyValue)) throw new Error("Candidate is not referenced by its batch.");
    if (candidateKeys.has(deduplicationKeyValue)) throw new Error("Invalid batching state: duplicate candidate key.");
    const deliveryState = rawCandidate.deliveryState;
    if (deliveryState !== "pending" && deliveryState !== "sending" && deliveryState !== "sent" && deliveryState !== "uncertain" && deliveryState !== "suppressed" && deliveryState !== "expired") {
      throw new Error("Invalid batching state candidate delivery state.");
    }
    const suppressionReason = rawCandidate.suppressionReason;
    if ((deliveryState === "suppressed" || deliveryState === "expired") && !isSuppressionReason(suppressionReason)) throw new Error("Terminal suppression requires a reason.");
    if (deliveryState !== "suppressed" && deliveryState !== "expired" && suppressionReason !== undefined) throw new Error("Only suppressed candidates may have a suppression reason.");
    const candidate: CandidateRecord = {
      deduplicationKey: deduplicationKeyValue,
      envelope,
      batchId,
      deliveryState,
      ...(isSuppressionReason(suppressionReason) ? { suppressionReason } : {}),
    };
    candidateKeys.add(candidate.deduplicationKey);
    candidateIds.add(candidate.envelope.candidateId);
    candidateByKey.set(candidate.deduplicationKey, candidate);
  }

  for (const batch of batchById.values()) {
    for (const key of batch.candidateKeys) {
      const candidate = candidateByKey.get(key);
      if (candidate === undefined) throw new Error("Batch references a missing candidate.");
      if (candidate.batchId !== batch.batchId || candidate.envelope.ownerId !== batch.ownerId || candidate.envelope.competition !== batch.competition || candidate.envelope.groupingKey !== batch.groupingKey || candidate.envelope.roundKind !== batch.roundKind) {
        throw new Error("Candidate and batch grouping metadata do not match.");
      }
    }
  }

  const pageIds = new Set<string>();
  const pagedCandidateKeys = new Set<string>();
  for (const rawPage of state.pages) {
    if (!isRecord(rawPage)) throw new Error("Invalid batching state page.");
    assertNonEmptyString(rawPage.pageId, "page.pageId");
    assertNonEmptyString(rawPage.batchId, "page.batchId");
    assertPositiveInteger(rawPage.pageNumber, "page.pageNumber");
    if (rawPage.pageId !== `${rawPage.batchId}-page-${rawPage.pageNumber}`) throw new Error("Page id does not match its batch and page number.");
    if (rawPage.deliveryState !== "ready" && rawPage.deliveryState !== "sending" && rawPage.deliveryState !== "sent" && rawPage.deliveryState !== "uncertain") throw new Error("Invalid page delivery state.");
    const batch = batchById.get(rawPage.batchId);
    if (batch === undefined) throw new Error("Page references a missing batch.");
    if (!Array.isArray(rawPage.entries) || (rawPage.entries.length === 0 && rawPage.deliveryState !== "ready")) throw new Error("Invalid page entries.");
    if (pageIds.has(rawPage.pageId)) throw new Error("Invalid batching state: duplicate page id.");
    pageIds.add(rawPage.pageId);
    const pageEntryKeys = new Set<string>();
    for (const rawEntry of rawPage.entries) {
      if (!isRecord(rawEntry)) throw new Error("Invalid page entry.");
      assertNonEmptyString(rawEntry.candidateKey, "page.entry.candidateKey");
      if (rawEntry.deliveryState !== "pending" && rawEntry.deliveryState !== "sent" && rawEntry.deliveryState !== "uncertain") throw new Error("Invalid page entry delivery state.");
      const candidate = candidateByKey.get(rawEntry.candidateKey);
      if (candidate === undefined || candidate.batchId !== batch.batchId) throw new Error("Page entry references a candidate outside its batch.");
      if (pageEntryKeys.has(rawEntry.candidateKey) || pagedCandidateKeys.has(rawEntry.candidateKey)) throw new Error("Candidate appears in multiple delivery pages.");
      pageEntryKeys.add(rawEntry.candidateKey);
      pagedCandidateKeys.add(rawEntry.candidateKey);
      if (rawPage.deliveryState === "ready" && rawEntry.deliveryState !== "pending") throw new Error("Ready page contains a terminal entry.");
      if (rawPage.deliveryState === "ready" && candidate.deliveryState !== "pending") throw new Error("Ready page candidate is not pending.");
      if (rawPage.deliveryState === "sending" && candidate.deliveryState !== "sending") throw new Error("Sending page candidate is not sending.");
      if (rawPage.deliveryState === "sent" && rawEntry.deliveryState !== "sent") throw new Error("Sent page contains a non-sent entry.");
      if (rawPage.deliveryState === "sent" && candidate.deliveryState !== "sent") throw new Error("Sent page candidate is not sent.");
      if (rawPage.deliveryState === "uncertain" && rawEntry.deliveryState !== "uncertain") throw new Error("Uncertain page contains a non-uncertain entry.");
      if (rawPage.deliveryState === "uncertain" && candidate.deliveryState !== "uncertain") throw new Error("Uncertain page candidate is not uncertain.");
    }
  }

  for (const candidate of candidateByKey.values()) {
    if ((candidate.deliveryState === "sending" || candidate.deliveryState === "sent" || candidate.deliveryState === "uncertain") && !pagedCandidateKeys.has(candidate.deduplicationKey)) {
      throw new Error("Sending or terminal candidate is not represented by a delivery page.");
    }
  }

  for (const rawSuppression of state.suppressions) {
    if (!isRecord(rawSuppression)) throw new Error("Invalid suppression record.");
    assertNonEmptyString(rawSuppression.ownerId, "suppression.ownerId");
    assertNonEmptyString(rawSuppression.canonicalMatchupKey, "suppression.canonicalMatchupKey");
    assertNonEmptyString(rawSuppression.candidateId, "suppression.candidateId");
    assertSafeTimestamp(rawSuppression.at, "suppression.at");
    if (!isSuppressionReason(rawSuppression.reason)) throw new Error("Invalid suppression reason.");
  }
}

function isSuppressionReason(value: unknown): value is SuppressionReason {
  return value === "unknown-round" || value === "missing-revalidation" || value === "revalidation-mismatch" || value === "invalid-revalidation" || value === "stale-revalidation" || value === "expired-revalidation" || value === "candidate-expired" || value === "identity-group-conflict";
}

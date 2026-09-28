import { z } from "zod";

import {
  WatchlistScreenInputSchema,
  WatchlistTimestampSchema,
  type ScreeningResult,
  type WatchlistScreenInput,
} from "./contracts.js";
import {
  addCandidate,
  createWatchlistBatchingState,
  parseBatchingState,
  prepareDuePages,
  serializeBatchingState,
  type CandidateRevalidation,
  type PreparedDeliveryPage,
  type SuppressionRecord,
  type WatchlistBatchingState,
} from "./batching.js";
import { parseAndCanonicalizeIdentity } from "./identity.js";
import { screenWatchlistCandidate } from "./screening.js";
import { evaluateWatchlistQuotaPolicy, type WatchlistQuotaPolicyDecision } from "./quota-policy.js";
import { formatWatchlistPreviewPages } from "./preview-formatter.js";

export const MAX_OFFLINE_REPLAY_INPUT_BYTES = 1_000_000;
export const MAX_OFFLINE_REPLAY_CANDIDATES = 100;
export const OFFLINE_REVALIDATION_VALID_FOR_MS = 60_000;

const OfflineCandidateSchema = z.object({
  candidateId: z.string().trim().min(1).max(512),
  ownerId: z.string().trim().min(1).max(512),
  roundKind: z.enum(["opening", "later", "unknown"]),
  input: WatchlistScreenInputSchema,
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const OfflineRevalidationSchema = z.object({
  candidateId: z.string().trim().min(1).max(512),
  ownerId: z.string().trim().min(1).max(512),
  input: WatchlistScreenInputSchema,
}).strict();

const OfflineReplayInputSchema = z.object({
  now: WatchlistTimestampSchema,
  candidates: z.array(OfflineCandidateSchema).max(MAX_OFFLINE_REPLAY_CANDIDATES),
  revalidations: z.array(OfflineRevalidationSchema).max(MAX_OFFLINE_REPLAY_CANDIDATES).optional(),
  batchingState: z.unknown().optional(),
  /** Advisory only; it never reserves quota or gates local research. */
  quota: z.unknown().optional(),
  pageSize: z.number().int().positive().max(50).optional(),
}).strict();

type OfflineCandidate = z.infer<typeof OfflineCandidateSchema>;
type OfflineRevalidation = z.infer<typeof OfflineRevalidationSchema>;
type OfflineReplayInput = z.infer<typeof OfflineReplayInputSchema>;

export interface OfflineCandidateEvaluation {
  readonly candidateId: string;
  readonly ownerId: string;
  readonly eligible: boolean;
  readonly enqueued: boolean;
  readonly identityKey: string | null;
  readonly reasons: ScreeningResult["reasons"];
  readonly ruleVersion: string | null;
}

export interface OfflineResearchPreview {
  readonly ownerId: string;
  readonly candidateId: string;
  readonly label: "research-only";
  readonly researchOnly: true;
  readonly deliveryAuthorized: false;
  readonly pages: readonly string[];
}

export interface OfflineWatchlistTickSuccess {
  readonly ok: true;
  readonly now: string;
  readonly evaluations: readonly OfflineCandidateEvaluation[];
  /**
   * Purely local, owner-scoped HTML research output. This is never a delivery
   * authorization and does not imply that a quota reservation was committed.
   */
  readonly researchPreviews: readonly OfflineResearchPreview[];
  readonly proposedPages: readonly PreparedDeliveryPage[];
  readonly suppressed: readonly SuppressionRecord[];
  /** Null means no quota input was supplied; a proposal is advisory only. */
  readonly quotaDecision: WatchlistQuotaPolicyDecision | null;
  readonly state: WatchlistBatchingState;
  readonly serializedState: string;
}

export interface OfflineWatchlistTickFailure {
  readonly ok: false;
  readonly error: string;
}

export type OfflineWatchlistTickResult = OfflineWatchlistTickSuccess | OfflineWatchlistTickFailure;

function safeJsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function parseClock(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseInitialState(value: unknown): WatchlistBatchingState {
  if (value === undefined) return createWatchlistBatchingState();
  if (typeof value === "string") return parseBatchingState(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("batchingState must be JSON-serializable.");
  return parseBatchingState(serialized);
}

function ensureCandidateIdsAreUnique(candidates: readonly OfflineCandidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.candidateId)) throw new Error(`Duplicate candidateId '${candidate.candidateId}'.`);
    ids.add(candidate.candidateId);
  }
}

function candidateEvaluation(
  candidate: OfflineCandidate,
  screen: ScreeningResult,
  enqueued: boolean,
): OfflineCandidateEvaluation {
  return {
    candidateId: candidate.candidateId,
    ownerId: candidate.ownerId,
    eligible: screen.eligible,
    enqueued,
    identityKey: screen.identityKey,
    reasons: screen.reasons,
    ruleVersion: screen.ruleVersion,
  };
}

function previewKey(ownerId: string, candidateId: string): string {
  return JSON.stringify([ownerId, candidateId]);
}

function buildResearchPreview(
  ownerId: string,
  candidateId: string,
  input: WatchlistScreenInput,
  now: Date,
): OfflineResearchPreview | null {
  const pages = formatWatchlistPreviewPages(input, now);
  if (pages.length === 0) return null;
  return {
    ownerId,
    candidateId,
    label: "research-only",
    researchOnly: true,
    deliveryAuthorized: false,
    pages,
  };
}

function revalidationValidUntil(input: WatchlistScreenInput, nowMs: number): number {
  const quote = input.price.quote;
  const quoteMaxAge = input.rules.quoteMaxAgeMs;
  const historyMaxAge = input.rules.historyMaxAgeMs;
  const expirations = [
    nowMs + OFFLINE_REVALIDATION_VALID_FOR_MS,
    Date.parse(quote.observedAt) + quoteMaxAge,
    ...(quote.sourceUpdatedAt === undefined ? [] : [Date.parse(quote.sourceUpdatedAt) + quoteMaxAge]),
    Date.parse(quote.source.observedAt) + quoteMaxAge,
    Date.parse(quote.scheduledStart) - input.rules.minimumStartLeadMs,
    Date.parse(input.selectedHistory.observedAt) + historyMaxAge,
    Date.parse(input.selectedHistory.source.observedAt) + historyMaxAge,
    Date.parse(input.opponentHistory.observedAt) + historyMaxAge,
    Date.parse(input.opponentHistory.source.observedAt) + historyMaxAge,
  ];
  return Math.min(...expirations);
}

function upsertEligibleCandidate(
  state: WatchlistBatchingState,
  candidate: OfflineCandidate,
  screen: ScreeningResult,
  now: Date,
): { readonly state: WatchlistBatchingState; readonly enqueued: boolean } {
  if (!screen.eligible || screen.identityKey === null) return { state, enqueued: false };
  const identity = parseAndCanonicalizeIdentity(candidate.input.price.quote).identity;
  if (identity === null || identity.key !== screen.identityKey) {
    throw new Error(`Candidate '${candidate.candidateId}' produced inconsistent canonical identity.`);
  }
  const envelope = {
    ownerId: candidate.ownerId,
    canonicalMatchupKey: screen.identityKey,
    competition: candidate.input.price.quote.competitionOccurrenceId,
    // Unknown classification is grouped under a stable generic digest even
    // when a provider exposes an unverified round label. Round text is never
    // used as canonical identity (event occurrence + event ID are).
    groupingKey: candidate.roundKind === "unknown"
      ? "unknown-round"
      : candidate.input.price.quote.round ?? "unknown-round",
    roundKind: candidate.roundKind,
    candidateId: candidate.candidateId,
    // The quote observation proves freshness; the batch opens when this tick
    // detects eligibility, not at an older provider observation timestamp.
    observedAt: now.getTime(),
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
  };
  const nextState = addCandidate(state, envelope);
  const present = nextState.candidates.some((item) => item.envelope.candidateId === candidate.candidateId && item.envelope.ownerId === candidate.ownerId);
  return { state: nextState, enqueued: present };
}

function revalidateCandidate(
  state: WatchlistBatchingState,
  item: OfflineRevalidation,
  now: Date,
): CandidateRevalidation {
  const current = state.candidates.find((candidate) => candidate.envelope.candidateId === item.candidateId);
  if (current === undefined || current.envelope.ownerId !== item.ownerId) {
    if (current !== undefined) throw new Error(`Revalidation owner does not match candidate '${item.candidateId}'.`);
    return {
      candidateId: item.candidateId,
      status: "invalid",
      revalidatedAt: now.getTime(),
      validUntil: now.getTime() + OFFLINE_REVALIDATION_VALID_FOR_MS,
      reason: "candidate is not owned by the supplied owner",
    };
  }
  const screen = screenWatchlistCandidate(item.input, now);
  if (!screen.eligible || screen.identityKey !== current.envelope.canonicalMatchupKey) {
    const isFreshFailure = screen.reasons.some((reason): boolean => (
      reason.code === "STALE_QUOTE"
      || reason.code === "STALE_SOURCE"
      || reason.code === "FUTURE_TIMESTAMP"
      || reason.code === "START_TOO_SOON"
    ));
    return {
      candidateId: item.candidateId,
      status: isFreshFailure ? "stale" : "invalid",
      revalidatedAt: now.getTime(),
      validUntil: now.getTime() + OFFLINE_REVALIDATION_VALID_FOR_MS,
      reason: screen.reasons[0]?.message ?? "candidate no longer qualifies",
    };
  }
  const validUntil = revalidationValidUntil(item.input, now.getTime());
  if (validUntil <= now.getTime()) {
    return {
      candidateId: item.candidateId,
      status: "stale",
      revalidatedAt: now.getTime(),
      // Batching requires a positive interval even for an already-expired
      // evidence result; the stale status is the authoritative decision.
      validUntil: now.getTime() + 1,
      reason: "candidate freshness expires at the revalidation boundary",
    };
  }
  return {
    candidateId: item.candidateId,
    status: "valid",
    revalidatedAt: now.getTime(),
    validUntil,
  };
}

function ensureRevalidationsAreUniqueAndOwnerScoped(
  state: WatchlistBatchingState,
  items: readonly OfflineRevalidation[],
): void {
  const candidateIds = new Set<string>();
  for (const item of items) {
    if (candidateIds.has(item.candidateId)) throw new Error(`Duplicate revalidation candidateId '${item.candidateId}'.`);
    candidateIds.add(item.candidateId);
    const current = state.candidates.find((candidate) => candidate.envelope.candidateId === item.candidateId);
    if (current !== undefined && current.envelope.ownerId !== item.ownerId) {
      throw new Error(`Revalidation owner does not match candidate '${item.candidateId}'.`);
    }
  }
}

/**
 * Runs one deterministic local replay tick. It never performs network, DB,
 * Telegram, scheduler, or runtime imports; proposed pages are not sent.
 */
export function runOfflineWatchlistTick(input: unknown): OfflineWatchlistTickResult {
  const byteLength = safeJsonByteLength(input);
  if (byteLength === null || byteLength > MAX_OFFLINE_REPLAY_INPUT_BYTES) {
    return { ok: false, error: "Replay input must be JSON-serializable and no larger than 1,000,000 bytes." };
  }
  const parsed = OfflineReplayInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Replay input failed strict schema validation." };
  const replay: OfflineReplayInput = parsed.data;
  const now = parseClock(replay.now);
  if (now === null) return { ok: false, error: "Replay clock must be a valid ISO timestamp." };

  try {
    ensureCandidateIdsAreUnique(replay.candidates);
    const initialState = parseInitialState(replay.batchingState);
    if (initialState.candidates.length > MAX_OFFLINE_REPLAY_CANDIDATES) {
      return { ok: false, error: "Batching state contains too many candidates for offline replay." };
    }
    ensureRevalidationsAreUniqueAndOwnerScoped(initialState, replay.revalidations ?? []);
    let state = initialState;
    const evaluations: OfflineCandidateEvaluation[] = [];
    const previewByKey = new Map<string, OfflineResearchPreview>();
    for (const candidate of replay.candidates) {
      const screen = screenWatchlistCandidate(candidate.input, now);
      const upserted = upsertEligibleCandidate(state, candidate, screen, now);
      state = upserted.state;
      if (state.candidates.length > MAX_OFFLINE_REPLAY_CANDIDATES) {
        return { ok: false, error: "Offline replay cannot contain more than 100 candidates." };
      }
      evaluations.push(candidateEvaluation(candidate, screen, upserted.enqueued));
      if (screen.eligible) {
        const preview = buildResearchPreview(candidate.ownerId, candidate.candidateId, candidate.input, now);
        if (preview !== null) previewByKey.set(previewKey(candidate.ownerId, candidate.candidateId), preview);
      }
    }

    const revalidationResults = (replay.revalidations ?? []).map((item): CandidateRevalidation => revalidateCandidate(state, item, now));
    for (const [index, item] of (replay.revalidations ?? []).entries()) {
      const current = state.candidates.find((candidate) => candidate.envelope.candidateId === item.candidateId);
      if (current === undefined || current.envelope.ownerId !== item.ownerId) continue;
      const revalidation = revalidationResults[index];
      const screen = screenWatchlistCandidate(item.input, now);
      const key = previewKey(item.ownerId, item.candidateId);
      if (revalidation === undefined
        || revalidation.status !== "valid"
        || !screen.eligible
        || screen.identityKey !== current.envelope.canonicalMatchupKey) {
        // The initial candidate may have been eligible earlier in this tick.
        // A fresh invalid/stale/mismatched revalidation supersedes tha
        // evidence; never leave an older HTML preview looking current.
        previewByKey.delete(key);
        continue;
      }
      const preview = buildResearchPreview(item.ownerId, item.candidateId, item.input, now);
      if (preview !== null) previewByKey.set(key, preview);
      else previewByKey.delete(key);
    }
    const prepared = prepareDuePages(state, now.getTime(), revalidationResults, replay.pageSize ?? 10);
    state = prepared.state;
    const quotaDecision = replay.quota === undefined
      ? null
      : evaluateWatchlistQuotaPolicy(replay.quota, now);
    return {
      ok: true,
      now: now.toISOString(),
      evaluations,
      researchPreviews: [...previewByKey.values()],
      proposedPages: prepared.pages,
      suppressed: prepared.suppressed,
      quotaDecision,
      state,
      serializedState: serializeBatchingState(state),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Offline replay failed validation.",
    };
  }
}

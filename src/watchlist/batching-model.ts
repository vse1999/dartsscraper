/** Shared serializable model for the offline watchlist batch state machine. */

export const OPENING_BATCH_WINDOW_MS = 120_000;
export const LATER_BATCH_WINDOW_MS = 60_000;
export const BATCHING_SNAPSHOT_VERSION = 2;

export type RoundKind = "opening" | "later" | "unknown";
export type KnownRoundKind = Exclude<RoundKind, "unknown">;
export type CandidateDeliveryState = "pending" | "sending" | "sent" | "uncertain" | "suppressed" | "expired";
export type PageDeliveryState = "ready" | "sending" | "sent" | "uncertain";
export type SuppressionReason =
  | "unknown-round"
  | "missing-revalidation"
  | "revalidation-mismatch"
  | "invalid-revalidation"
  | "stale-revalidation"
  | "expired-revalidation"
  | "candidate-expired"
  | "identity-group-conflict";

export interface WatchlistCandidateEnvelope {
  readonly ownerId: string;
  readonly canonicalMatchupKey: string;
  readonly competition: string;
  readonly groupingKey: string;
  readonly roundKind: RoundKind;
  readonly candidateId: string;
  readonly observedAt: number;
  readonly expiresAt?: number;
}

export interface CandidateRecord {
  readonly deduplicationKey: string;
  readonly envelope: WatchlistCandidateEnvelope;
  readonly batchId: string;
  readonly deliveryState: CandidateDeliveryState;
  readonly suppressionReason?: SuppressionReason;
}

export interface WatchlistBatch {
  readonly batchId: string;
  readonly ownerId: string;
  readonly competition: string;
  readonly groupingKey: string;
  readonly roundKind: RoundKind;
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly candidateKeys: readonly string[];
}

export interface DeliveryPageEntry {
  readonly candidateKey: string;
  readonly deliveryState: "pending" | "sent" | "uncertain";
}

export interface DeliveryPage {
  readonly pageId: string;
  readonly batchId: string;
  readonly pageNumber: number;
  readonly entries: readonly DeliveryPageEntry[];
  readonly deliveryState: PageDeliveryState;
}

export interface SuppressionRecord {
  readonly ownerId: string;
  readonly canonicalMatchupKey: string;
  readonly candidateId: string;
  readonly reason: SuppressionReason;
  readonly at: number;
}

export interface WatchlistBatchingState {
  readonly version: typeof BATCHING_SNAPSHOT_VERSION;
  readonly nextBatchSequence: number;
  readonly batches: readonly WatchlistBatch[];
  readonly candidates: readonly CandidateRecord[];
  readonly pages: readonly DeliveryPage[];
  readonly suppressions: readonly SuppressionRecord[];
}

export interface CandidateRevalidation {
  readonly candidateId: string;
  readonly status: "valid" | "stale" | "expired" | "invalid";
  readonly revalidatedAt: number;
  readonly validUntil: number;
  readonly reason?: string;
}

export interface PreparedDuePages {
  readonly state: WatchlistBatchingState;
  readonly pages: readonly PreparedDeliveryPage[];
  readonly suppressed: readonly SuppressionRecord[];
}

export interface PreparedDeliveryPage {
  readonly pageId: string;
  readonly batchId: string;
  readonly pageNumber: number;
  readonly entries: readonly PreparedDeliveryEntry[];
}

export interface PreparedDeliveryEntry {
  readonly candidateId: string;
  readonly envelope: WatchlistCandidateEnvelope;
}

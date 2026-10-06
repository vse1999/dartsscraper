import { validateEvidenceSnapshot, type EvidenceSnapshot } from "./evidence.js";
import { MatchSchema, type Match } from "../schemas/match.js";
import { z } from "zod";
import { IsoDateSchema } from "../agent/date.js";

export type QualityEligibilityStatus = "available" | "limited" | "unavailable";

export type QualityReasonCode =
  | "evidence-invalid"
  | "future-evidence"
  | "invalid-clock"
  | "invalid-policy"
  | "identity-conflict"
  | "identity-unknown"
  | "observation-age-unknown"
  | "observation-stale"
  | "provider-freshness-unknown"
  | "format-unknown"
  | "persistence-unknown"
  | "persistence-failed"
  | "history-empty"
  | "history-short"
  | "scope-count-mismatch"
  | "evidence-row-mismatch"
  | "invalid-match-records"
  | "future-match"
  | "collection-completeness-unknown"
  | "missing-averages"
  | "missing-checkout-denominators"
  | "zero-checkout-attempts"
  | "no-checkout-attempts"
  | "missing-one-eighties"
  | "missing-explicit-legs"
  | "date-order-inconsistent"
  | "duplicate-composite-id"
  | "date-tie-within-window"
  | "date-tie-crosses-window-boundary";

export interface QualityEligibility {
  readonly status: QualityEligibilityStatus;
  readonly reasons: readonly QualityReasonCode[];
}

export interface QualityEvidenceMetadata {
  readonly id?: string;
  readonly observedAt?: string;
  readonly sourceUpdatedAt?: string | null;
  readonly persistence?: "memory" | "local" | "failed";
  readonly stale?: boolean;
  readonly playerId?: number;
  readonly quality?: {
    readonly identity?: "canonical" | "unknown";
    readonly sourceFreshness?: "unknown";
    readonly completeness?: "unknown";
    readonly ordering?: "date-only-ambiguous" | "date-ordered" | "source-order-inconsistent";
    readonly comparability?: "known-format" | "unknown-format";
  };
}

export interface ResearchQualityOptions {
  /** A full persisted snapshot is hash/schema checked; a history-reader reference is metadata only. */
  readonly evidence?: unknown;
  /** Canonical ID supplied by the caller, when known. */
  readonly expectedPlayerId?: number;
  /** Fixed instant or injected clock. Defaults to the current wall clock. */
  readonly now?: Date | (() => Date);
  /** Observation reuse policy; defaults to the repository's 60-second policy. */
  readonly freshTtlMs?: number;
  /** Trusted persistence result from the owning service; kept outside the snapshot hash. */
  readonly persistence?: "memory" | "local" | "failed";
}

export interface QualityAssessment {
  readonly version: 1;
  readonly validity: {
    readonly status: "valid" | "rejected";
    readonly reasons: readonly QualityReasonCode[];
  };
  readonly dimensions: {
    readonly identity: "canonical" | "unknown" | "conflict";
    readonly observationAge: "fresh" | "stale" | "unknown" | "invalid";
    /** Timestamp presence only; this does not assert that the provider data is fresh. */
    readonly providerFreshness: "timestamp-known" | "unknown";
    /** Sufficient refers to the two 10-row analytical windows, not provider query completeness. */
    readonly historyScope: "sufficient" | "partial" | "empty";
    readonly ordering: "ordered" | "date-ties" | "inconsistent";
    readonly format: "known" | "unknown";
    readonly persistence: "memory" | "local" | "failed" | "unknown";
  };
  readonly eligibility: {
    readonly scoringComparison: QualityEligibility;
    readonly weightedCheckoutComparison: QualityEligibility;
    readonly chronologicalTrendComparison: QualityEligibility;
  };
}

export interface ResearchOrderingAssessment {
  /** False means source order cannot support a chronological comparison. */
  readonly chronological: boolean;
  readonly status: QualityEligibilityStatus;
  readonly reasons: readonly QualityReasonCode[];
  readonly duplicateCompositeId: boolean;
  readonly dateTieCrossesWindowBoundary: boolean;
}

interface EvidenceFacts {
  readonly present: boolean;
  readonly snapshot: EvidenceSnapshot | null;
  readonly playerId: number | null;
  readonly observedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly persistence: "memory" | "local" | "failed" | "unknown";
  readonly stale: boolean;
  readonly identityClaim: "canonical" | "unknown";
  readonly formatKnown: boolean;
  readonly queryScopeMismatch: boolean;
  readonly queryCompletenessUnknown: boolean;
  readonly malformed: boolean;
  readonly future: boolean;
}

const EMPTY_EVIDENCE: EvidenceFacts = {
  present: false,
  snapshot: null,
  playerId: null,
  observedAt: null,
  sourceUpdatedAt: null,
  persistence: "unknown",
  stale: false,
  identityClaim: "unknown",
  formatKnown: false,
  queryScopeMismatch: false,
  queryCompletenessUnknown: false,
  malformed: false,
  future: false,
};

/**
 * Purely assesses whether validated rows support the requested comparisons.
 * It neither sorts rows nor calculates or changes match statistics.
 */
export function assessResearchQuality(
  rows: readonly Match[],
  options: ResearchQualityOptions = {},
): QualityAssessment {
  const invalidReasons: QualityReasonCode[] = [];
  const ttl = options.freshTtlMs ?? 60_000;
  if (!Number.isSafeInteger(ttl) || ttl < 0
    || (options.expectedPlayerId !== undefined
      && (!Number.isSafeInteger(options.expectedPlayerId) || options.expectedPlayerId <= 0))
    || (options.persistence !== undefined
      && options.persistence !== "memory" && options.persistence !== "local" && options.persistence !== "failed")) {
    invalidReasons.push("invalid-policy");
  }

  const currentTime = readNow(options.now);
  if (currentTime === null) invalidReasons.push("invalid-clock");
  const nowMs = currentTime?.getTime() ?? 0;
  const evidence = currentTime === null || invalidReasons.includes("invalid-policy")
    ? (options.evidence === undefined ? EMPTY_EVIDENCE : malformedEvidenceFacts())
    : inspectEvidence(options.evidence, currentTime, nowMs);
  if (evidence.malformed) invalidReasons.push("evidence-invalid");
  if (evidence.future) invalidReasons.push("future-evidence");
  const parsedRows = MatchSchema.array().max(1000).safeParse(rows);
  if (!parsedRows.success || parsedRows.data.some((row: Match): boolean => !IsoDateSchema.safeParse(row.date).success)) {
    const reasons = unique([...invalidReasons, "invalid-match-records"]);
    return { version: 1, validity: { status: "rejected", reasons },
      dimensions: { identity: "unknown", observationAge: "unknown", providerFreshness: "unknown", historyScope: "empty", ordering: "ordered", format: "unknown", persistence: "unknown" },
      eligibility: { scoringComparison: unavailable(reasons), weightedCheckoutComparison: unavailable(reasons), chronologicalTrendComparison: unavailable(reasons) } };
  }
  if (currentTime !== null) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(currentTime);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item: Intl.DateTimeFormatPart): boolean => item.type === type)?.value ?? "";
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    if (rows.some((row: Match): boolean => row.date > today)) invalidReasons.push("future-match");
  }
  if (evidence.snapshot !== null) {
    const expectedRows = evidence.snapshot.matches.slice(0, rows.length);
    if (rows.length > evidence.snapshot.matches.length || JSON.stringify(parsedRows.data) !== JSON.stringify(expectedRows)) invalidReasons.push("evidence-row-mismatch");
  }

  let identity: QualityAssessment["dimensions"]["identity"] = evidence.identityClaim;
  if (evidence.playerId !== null) {
    if (options.expectedPlayerId !== undefined && evidence.playerId !== options.expectedPlayerId) {
      identity = "conflict";
      invalidReasons.push("identity-conflict");
    } else {
      identity = "canonical";
    }
  } else if (options.expectedPlayerId !== undefined && identity === "canonical") {
    // A metadata claim without an ID cannot be compared to the caller's expected identity.
    identity = "unknown";
  }

  const age = getAge(evidence, nowMs, ttl);
  if (age.invalid) invalidReasons.push("future-evidence");
  const selected = rows.slice(0, 20);
  const order = inspectResearchOrdering(rows, 10);
  const inconsistentOrder = order.reasons.includes("date-order-inconsistent");
  const duplicateCompositeId = order.duplicateCompositeId;
  const boundaryDateTie = order.dateTieCrossesWindowBoundary;
  const withinWindowDateTie = order.reasons.includes("date-tie-within-window");
  const hasDateTies = withinWindowDateTie || boundaryDateTie;
  const ordering: QualityAssessment["dimensions"]["ordering"] = inconsistentOrder
    ? "inconsistent" : hasDateTies ? "date-ties" : "ordered";
  const empty = rows.length === 0;
  const shortScope = rows.length < 20 || evidence.queryScopeMismatch;
  const historyScope: QualityAssessment["dimensions"]["historyScope"] = empty ? "empty" : shortScope ? "partial" : "sufficient";
  const persistence = options.persistence ?? evidence.persistence;
  const providerFreshness: QualityAssessment["dimensions"]["providerFreshness"] = evidence.sourceUpdatedAt === null
    ? "unknown" : "timestamp-known";
  const dimensions: QualityAssessment["dimensions"] = {
    identity,
    observationAge: age.state,
    providerFreshness,
    historyScope,
    ordering,
    format: evidence.formatKnown ? "known" : "unknown",
    persistence,
  };

  const commonLimits: QualityReasonCode[] = [];
  if (identity === "unknown") commonLimits.push("identity-unknown");
  if (age.state === "unknown") commonLimits.push("observation-age-unknown");
  if (age.state === "stale") commonLimits.push("observation-stale");
  if (providerFreshness === "unknown") commonLimits.push("provider-freshness-unknown");
  if (dimensions.format === "unknown") commonLimits.push("format-unknown");
  if (persistence === "unknown") commonLimits.push("persistence-unknown");
  if (persistence === "failed") commonLimits.push("persistence-failed");
  if (evidence.queryScopeMismatch) commonLimits.push("scope-count-mismatch");
  if (evidence.queryCompletenessUnknown) commonLimits.push("collection-completeness-unknown");
  if (inconsistentOrder) commonLimits.push("date-order-inconsistent");
  if (duplicateCompositeId) commonLimits.push("duplicate-composite-id");
  if (withinWindowDateTie) commonLimits.push("date-tie-within-window");
  if (boundaryDateTie) commonLimits.push("date-tie-crosses-window-boundary");
  if (empty) commonLimits.push("history-empty");
  else if (shortScope) commonLimits.push("history-short");

  const rejected = invalidReasons.length > 0;
  const eligibility = {
    scoringComparison: scoreEligibility(selected, rejected, invalidReasons, commonLimits),
    weightedCheckoutComparison: checkoutEligibility(selected, rejected, invalidReasons, commonLimits),
    chronologicalTrendComparison: chronologyEligibility(order, rejected, invalidReasons, commonLimits),
  };

  return {
    version: 1,
    validity: { status: rejected ? "rejected" : "valid", reasons: unique(invalidReasons) },
    dimensions,
    eligibility,
  };
}

/** Inspects newest-first ordering without sorting or changing source order. */
export function inspectResearchOrdering(rows: readonly Match[], windowSize: number = 10): ResearchOrderingAssessment {
  if (!Number.isSafeInteger(windowSize) || windowSize <= 0) {
    return {
      chronological: false,
      status: "unavailable",
      reasons: ["invalid-policy"],
      duplicateCompositeId: false,
      dateTieCrossesWindowBoundary: false,
    };
  }
  const selected = rows.slice(0, windowSize * 2);
  const dates = selected.map((match: Match): string => match.date);
  const inconsistentOrder = dates.some((date: string, index: number): boolean => index > 0 && date > (dates[index - 1] ?? date));
  const duplicateCompositeId = hasDuplicateCompositeIds(selected);
  const dateTieCrossesWindowBoundary = selected.length > windowSize
    && selected[windowSize - 1]?.date === selected[windowSize]?.date;
  const hasDateTies = new Set(dates).size < dates.length;
  const reasons: QualityReasonCode[] = [];
  if (inconsistentOrder) reasons.push("date-order-inconsistent");
  if (duplicateCompositeId) reasons.push("duplicate-composite-id");
  if (dateTieCrossesWindowBoundary) reasons.push("date-tie-crosses-window-boundary");
  else if (hasDateTies) reasons.push("date-tie-within-window");
  if (selected.length === 0) reasons.push("history-empty");
  else if (selected.length < windowSize * 2) reasons.push("history-short");

  const chronological = !inconsistentOrder && !duplicateCompositeId && !dateTieCrossesWindowBoundary;
  const hasBothWindows = selected.length > windowSize;
  const hasHardBlock = inconsistentOrder || duplicateCompositeId || dateTieCrossesWindowBoundary;
  const status: QualityEligibilityStatus = !hasBothWindows || hasHardBlock
    ? "unavailable" : reasons.length === 0 ? "available" : "limited";
  return { chronological, status, reasons: unique(reasons), duplicateCompositeId, dateTieCrossesWindowBoundary };
}

function readNow(now: Date | (() => Date) | undefined): Date | null {
  try {
    const value = now === undefined ? new Date() : now instanceof Date ? now : now();
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  } catch (_error: unknown) {
    return null;
  }
}

function inspectEvidence(value: unknown, now: Date, nowMs: number): EvidenceFacts {
  if (value === undefined || value === null) return EMPTY_EVIDENCE;
  const record = asRecord(value);
  if (record === null) return malformedEvidenceFacts();

  if (looksLikeSnapshot(record)) {
    try {
      const snapshot = validateEvidenceSnapshot(value, now);
      return {
        present: true,
        snapshot,
        playerId: snapshot.player.id,
        observedAt: snapshot.observedAt,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
        persistence: "unknown",
        stale: false,
        identityClaim: "canonical",
        formatKnown: false,
        queryScopeMismatch: snapshot.acquiredCount !== snapshot.requestedCount,
        queryCompletenessUnknown: snapshot.source.queryCompleteness === "unknown",
        malformed: false,
        future: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      return {
        ...malformedEvidenceFacts(),
        present: true,
        future: message.includes("future") || message.includes("collector clock"),
      };
    }
  }

  const observedAt = readOptionalTimestamp(record, "observedAt");
  const sourceUpdatedAt = readOptionalNullableTimestamp(record, "sourceUpdatedAt");
  const id = record["id"];
  const hasMetadata = observedAt.present || sourceUpdatedAt.present || id !== undefined
    || record["persistence"] !== undefined || record["stale"] !== undefined || record["quality"] !== undefined;
  if (!hasMetadata) return malformedEvidenceFacts();
  if (observedAt.invalid || sourceUpdatedAt.invalid || (id !== undefined && (typeof id !== "string" || id.length === 0))) {
    return malformedEvidenceFacts();
  }

  const observedTime = observedAt.value === null ? null : Date.parse(observedAt.value);
  const sourceTime = sourceUpdatedAt.value === null ? null : Date.parse(sourceUpdatedAt.value);
  const future = observedTime !== null && observedTime > nowMs || sourceTime !== null && sourceTime > nowMs;
  const quality = asRecord(record["quality"]);
  const identityClaim = quality?.["identity"] === "canonical" ? "canonical" : "unknown";
  const formatKnown = quality?.["comparability"] === "known-format";
  const playerIdValue = record["playerId"];
  const playerId = typeof playerIdValue === "number" && Number.isSafeInteger(playerIdValue) && playerIdValue > 0
    ? playerIdValue : null;
  const persistenceValue = record["persistence"];
  const persistence = persistenceValue === "memory" || persistenceValue === "local" || persistenceValue === "failed"
    ? persistenceValue : "unknown";
  const stale = record["stale"] === true;
  const malformed = playerIdValue !== undefined && playerId === null
    || (persistenceValue !== undefined && persistence === "unknown")
    || (record["stale"] !== undefined && typeof record["stale"] !== "boolean");

  return {
    present: true,
    snapshot: null,
    playerId,
    observedAt: observedAt.value,
    sourceUpdatedAt: sourceUpdatedAt.value,
    persistence,
    stale,
    identityClaim,
    formatKnown,
    queryScopeMismatch: false,
    queryCompletenessUnknown: quality?.["completeness"] === "unknown",
    malformed,
    future,
  };
}

function getAge(
  evidence: EvidenceFacts,
  nowMs: number,
  freshTtlMs: number,
): { readonly state: "fresh" | "stale" | "unknown" | "invalid"; readonly invalid: boolean } {
  if (!evidence.present || evidence.observedAt === null) return { state: "unknown", invalid: false };
  const observedMs = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs) return { state: "invalid", invalid: true };
  return { state: evidence.stale || nowMs - observedMs > freshTtlMs ? "stale" : "fresh", invalid: false };
}

function looksLikeSnapshot(value: Record<string, unknown>): boolean {
  return "version" in value || "player" in value || "matches" in value || "source" in value
    || "requestedCount" in value || "acquiredCount" in value;
}

function malformedEvidenceFacts(): EvidenceFacts {
  return { ...EMPTY_EVIDENCE, present: true, malformed: true };
}

function readOptionalTimestamp(record: Record<string, unknown>, key: string): {
  readonly present: boolean; readonly value: string | null; readonly invalid: boolean;
} {
  const value = record[key];
  if (value === undefined) return { present: false, value: null, invalid: false };
  if (!z.string().datetime({ offset: true }).safeParse(value).success || typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return { present: true, value: null, invalid: true };
  }
  return { present: true, value, invalid: false };
}

function readOptionalNullableTimestamp(record: Record<string, unknown>, key: string): {
  readonly present: boolean; readonly value: string | null; readonly invalid: boolean;
} {
  const value = record[key];
  if (value === undefined || value === null) return { present: value !== undefined, value: null, invalid: false };
  if (!z.string().datetime({ offset: true }).safeParse(value).success || typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return { present: true, value: null, invalid: true };
  }
  return { present: true, value, invalid: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasDuplicateCompositeIds(rows: readonly Match[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.provenance?.compositeId;
    if (id === undefined) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

function scoreEligibility(
  rows: readonly Match[],
  rejected: boolean,
  invalidReasons: readonly QualityReasonCode[],
  commonLimits: readonly QualityReasonCode[],
): QualityEligibility {
  if (rejected) return unavailable(invalidReasons);
  const available = rows.filter((row: Match): boolean => row.average !== null && Number.isFinite(row.average)).length;
  if (rows.length === 0 || available === 0) {
    return unavailable([...commonLimits, "missing-averages"]);
  }
  const reasons = [...commonLimits];
  if (available < rows.length) reasons.push("missing-averages");
  return { status: reasons.length === 0 ? "available" : "limited", reasons: unique(reasons) };
}

function checkoutEligibility(
  rows: readonly Match[],
  rejected: boolean,
  invalidReasons: readonly QualityReasonCode[],
  commonLimits: readonly QualityReasonCode[],
): QualityEligibility {
  if (rejected) return unavailable(invalidReasons);
  const window = checkoutWindow(rows);
  if (window.positiveRows === 0) {
    const reason = window.rows === 0 ? "history-empty" : "no-checkout-attempts";
    return unavailable([...commonLimits, reason]);
  }
  const reasons = [...commonLimits];
  if (window.missingRows > 0) reasons.push("missing-checkout-denominators");
  if (window.zeroAttemptRows > 0) reasons.push("zero-checkout-attempts");
  return { status: reasons.length === 0 ? "available" : "limited", reasons: unique(reasons) };
}

function chronologyEligibility(
  order: ResearchOrderingAssessment,
  rejected: boolean,
  invalidReasons: readonly QualityReasonCode[],
  commonLimits: readonly QualityReasonCode[],
): QualityEligibility {
  if (rejected) return unavailable(invalidReasons);
  if (order.status === "unavailable") return unavailable([...commonLimits, ...order.reasons]);
  return {
    status: commonLimits.length === 0 && order.status === "available" ? "available" : "limited",
    reasons: unique([...commonLimits, ...order.reasons]),
  };
}

function checkoutWindow(rows: readonly Match[]): {
  readonly rows: number; readonly positiveRows: number; readonly zeroAttemptRows: number; readonly missingRows: number;
} {
  let positiveRows = 0;
  let zeroAttemptRows = 0;
  let missingRows = 0;
  for (const row of rows) {
    if (row.checkoutHits === null || row.checkoutHits === undefined
      || row.checkoutAttempts === null || row.checkoutAttempts === undefined) {
      missingRows += 1;
    } else if (row.checkoutAttempts === 0) {
      zeroAttemptRows += 1;
    } else if (row.checkoutAttempts > 0) {
      positiveRows += 1;
    }
  }
  return { rows: rows.length, positiveRows, zeroAttemptRows, missingRows };
}

function unavailable(reasons: readonly QualityReasonCode[]): QualityEligibility {
  return { status: "unavailable", reasons: unique(reasons) };
}

function unique(reasons: readonly QualityReasonCode[]): QualityReasonCode[] {
  return [...new Set(reasons)];
}

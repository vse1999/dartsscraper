import {
  CompletedHistoryMatchSchema,
  HistorySnapshotSchema,
  WATCHLIST_MARKET_TYPE,
  WATCHLIST_OPEN_MARKET_STATUS,
  WATCHLIST_PREMATCH_EVENT_STATUS,
  WATCHLIST_WINDOW_SIZES,
  WatchlistScreenInputSchema,
  type CompletedHistoryMatch,
  type HistorySnapshot,
  type MetricName,
  type ScreeningReason,
  type ScreeningReasonCode,
  type ScreeningResult,
  type WatchlistPriceBand,
  type WatchlistRuleConfig,
  type WatchlistScreenInput,
  type WatchlistWindowSize,
} from "./contracts.js";
import { validateWatchlistIdentity, type CanonicalMatchIdentity } from "./identity.js";
import { buildCoverageReport, compareWindowMetrics, metricCoverageReasons } from "./screening-metrics.js";
export { calculateWindowMetrics, compareWindowMetrics } from "./screening-metrics.js";

const UNKNOWN_CONTEXT_VALUES = new Set(["", "unknown", "unresolved", "n/a", "na", "?"]);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function reason(code: ScreeningReasonCode, message: string, severity: ScreeningReason["severity"] = "blocking"): ScreeningReason {
  return { code, severity, message };
}

function addReason(reasons: ScreeningReason[], next: ScreeningReason): void {
  if (!reasons.some((existing): boolean => existing.code === next.code && existing.severity === next.severity)) reasons.push(next);
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined || DATE_ONLY_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: string | undefined): string | null {
  return value !== undefined && DATE_ONLY_PATTERN.test(value) ? value : null;
}

function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function isUnknownContext(value: string | undefined): boolean {
  return value === undefined || UNKNOWN_CONTEXT_VALUES.has(value.trim().toLocaleLowerCase("en-US"));
}

function findPriceBand(price: number, rules: WatchlistRuleConfig): WatchlistPriceBand | undefined {
  return rules.priceBands.find((band): boolean => (
    price >= band.minInclusive && (band.maxExclusive === null || price < band.maxExclusive)
  ));
}

function validateHistoryOrdering(
  snapshot: HistorySnapshot,
  evaluationCutoffMs: number,
  nowMs: number,
  rules: WatchlistRuleConfig,
  reasons: ScreeningReason[],
): void {
  const snapshotObservedAt = parseTimestamp(snapshot.observedAt);
  const sourceObservedAt = parseTimestamp(snapshot.source.observedAt);
  if (snapshotObservedAt === null || sourceObservedAt === null) {
    addReason(reasons, reason("INVALID_INPUT", "History observation evidence must be an exact timestamp."));
    return;
  }
  if (snapshotObservedAt > nowMs || sourceObservedAt > nowMs) {
    addReason(reasons, reason("HISTORY_FUTURE_TIMESTAMP", "History observation evidence is in the future."));
  }
  if (nowMs - snapshotObservedAt > rules.historyMaxAgeMs || nowMs - sourceObservedAt > rules.historyMaxAgeMs) {
    addReason(reasons, reason("HISTORY_STALE", "The history snapshot or its source observation is stale."));
  }
  if (sourceObservedAt > snapshotObservedAt) {
    addReason(reasons, reason("HISTORY_AFTER_SNAPSHOT", "History source evidence is newer than the snapshot observation."));
  }
  // A history request may complete after the odds observation. Eligibility is
  // governed by each included match's completion time, not fetch completion.

  const seenMatchIds = new Set<string>();
  let previousCompletedAt: number | null = null;
  let previousCalendarDate: string | null = null;
  for (const [index, match] of snapshot.matches.entries()) {
    if (seenMatchIds.has(match.matchId)) addReason(reasons, reason("HISTORY_DUPLICATE_ID", `History match ${match.matchId} occurs more than once.`));
    seenMatchIds.add(match.matchId);

    const completedAt = parseTimestamp(match.completedAt);
    const playedAt = parseTimestamp(match.playedAt);
    const completionDateOnly = dateOnly(match.completedAt);
    const playedDateOnly = dateOnly(match.playedAt);
    const evidenceAt = parseTimestamp(match.evidence.observedAt);
    if (completedAt !== null && completedAt > nowMs || playedAt !== null && playedAt > nowMs || evidenceAt !== null && evidenceAt > nowMs) {
      addReason(reasons, reason("HISTORY_FUTURE_TIMESTAMP", `History match ${match.matchId} has future evidence.`));
    }
    if (playedDateOnly !== null && playedDateOnly > utcDate(nowMs)) addReason(reasons, reason("HISTORY_FUTURE_TIMESTAMP", `History match ${match.matchId} has a future played date.`));
    if (completionDateOnly !== null) {
      if (completionDateOnly > utcDate(nowMs)) addReason(reasons, reason("HISTORY_FUTURE_TIMESTAMP", `History match ${match.matchId} has a future completion date.`));
      // A date-only completion on the quote/snapshot date cannot prove the result existed before the quote.
      if (completionDateOnly >= utcDate(snapshotObservedAt)) {
        addReason(reasons, reason("HISTORY_DATE_ONLY_AMBIGUOUS", `Date-only completion for ${match.matchId} cannot be ordered before the quote observation.`));
      }
    }
    const calendarDate = completionDateOnly ?? (completedAt === null ? null : utcDate(completedAt));
    if (calendarDate !== null && previousCalendarDate !== null && calendarDate > previousCalendarDate) {
      addReason(reasons, reason("HISTORY_NOT_ORDERED", "History must be ordered newest completed date first."));
    }
    const previousMatch = snapshot.matches[index - 1];
    const previousCompletionDateOnly = dateOnly(previousMatch?.completedAt);
    if (index === 10 && calendarDate !== null && previousCalendarDate === calendarDate
      && (completionDateOnly !== null || previousCompletionDateOnly !== null)) {
      addReason(reasons, reason("HISTORY_DATE_ONLY_AMBIGUOUS", "Date-only history is ambiguous at the last-10 cutoff."));
    }
    previousCalendarDate = calendarDate;
    // A history request may finish after the quote was observed. Match
    // completion is compared with the evaluation cutoff, not fetch time or
    // quote observation time, so a result completed before evaluation is no
    // look-ahead merely because its statistics were fetched later.
    if (completedAt !== null && completedAt > evaluationCutoffMs) addReason(reasons, reason("HISTORY_AFTER_QUOTE_CUTOFF", `History match ${match.matchId} completed after the evaluation cutoff.`));
    if (completedAt !== null && completedAt > snapshotObservedAt) addReason(reasons, reason("HISTORY_AFTER_SNAPSHOT", `History match ${match.matchId} completed after the snapshot observation.`));
    if (completedAt !== null && evidenceAt !== null && completedAt > evidenceAt) addReason(reasons, reason("HISTORY_AFTER_SNAPSHOT", `History evidence for ${match.matchId} predates its completed result.`));
    if (evidenceAt !== null && evidenceAt > snapshotObservedAt) addReason(reasons, reason("HISTORY_AFTER_SNAPSHOT", `History evidence for ${match.matchId} was observed after the snapshot.`));
    if (previousCompletedAt !== null && completedAt !== null && completedAt >= previousCompletedAt) addReason(reasons, reason("HISTORY_NOT_ORDERED", "History must be ordered newest completed match first."));
    if (completedAt !== null) previousCompletedAt = completedAt;
    if (match.playerId !== snapshot.playerId) addReason(reasons, reason("HISTORY_PLAYER_MISMATCH", `History match ${match.matchId} belongs to another player.`));
    const context = match.context;
    if (context === undefined || [context.competitionId, context.eventId, context.round, context.stage, context.floor, context.format].some(isUnknownContext)) {
      addReason(reasons, reason("HISTORY_CONTEXT_UNKNOWN", `History match ${match.matchId} has incomplete optional context.`, "warning"));
    }
  }
}

function evaluateParsedInput(input: WatchlistScreenInput, now: Date): ScreeningResult {
  const reasons: ScreeningReason[] = [];
  const nowMs = now.getTime();
  const quote = input.price.quote;
  const identityValidation = validateWatchlistIdentity(quote);
  const identity: CanonicalMatchIdentity | null = identityValidation.identity;
  if (!identityValidation.valid) {
    if (identityValidation.reason === "selected_player_not_in_event") addReason(reasons, reason("SELECTED_PLAYER_NOT_IN_EVENT", "The selected player is not one of the event participants."));
    else if (identityValidation.reason === "ambiguous_player_pair") addReason(reasons, reason("AMBIGUOUS_PLAYER_PAIR", "The event does not contain two distinct stable player IDs."));
    else addReason(reasons, reason("INVALID_INPUT", "The quote identity could not be validated."));
  }
  if (input.price.decimalPrice <= 1 || !Number.isFinite(input.price.decimalPrice)) addReason(reasons, reason("INVALID_PRICE", "Decimal price must be finite and greater than one."));
  if (quote.marketType.toLocaleLowerCase("en-US") !== WATCHLIST_MARKET_TYPE) addReason(reasons, reason("UNSUPPORTED_MARKET", "Only plain prematch match-winner markets are supported."));
  if (quote.isPromotion) addReason(reasons, reason("PROMOTIONAL_MARKET", "Promotional or boosted prices are not eligible."));
  if (quote.marketStatus.toLocaleLowerCase("en-US") !== WATCHLIST_OPEN_MARKET_STATUS || quote.eventStatus.toLocaleLowerCase("en-US") !== WATCHLIST_PREMATCH_EVENT_STATUS) addReason(reasons, reason("UNKNOWN_MARKET_STATUS", "The market and event must be explicitly open and prematch."));
  if (quote.bookmakerId.trim().toLocaleLowerCase("en-US") === "boabet") addReason(reasons, reason("BOABET_EXCLUDED", "BoaBet is explicitly excluded from reference prices."));
  const context = quote.eventContext;
  if (context === undefined || [context.stage, context.floor, context.format, context.evidence].some((value): boolean => value === undefined || (typeof value === "string" && isUnknownContext(value)))) addReason(reasons, reason("UNKNOWN_EVENT_CONTEXT", "Stage, floor, format, or context provenance is optional and unavailable; match-winner screening continues.", "warning"));
  if (!input.rules.allowedBookmakers.includes(quote.bookmakerId)) addReason(reasons, reason("BOOKMAKER_NOT_ALLOWLISTED", "The bookmaker is not in the explicit allowlist."));
  if (!input.rules.allowedSourceIds.includes(quote.source.sourceId)) addReason(reasons, reason("SOURCE_NOT_ALLOWLISTED", "The collection source is not in the explicit allowlist."));

  const scheduledStartMs = parseTimestamp(quote.scheduledStart);
  const quoteObservedMs = parseTimestamp(quote.observedAt);
  const sourceUpdatedMs = parseTimestamp(quote.sourceUpdatedAt);
  const sourceObservedMs = parseTimestamp(quote.source.observedAt);
  const contextEvidenceMs = parseTimestamp(context?.evidence?.observedAt);
  if (quoteObservedMs === null || sourceObservedMs === null) addReason(reasons, reason("INVALID_INPUT", "Quote and source observation times must be exact timestamps."));
  if (quoteObservedMs !== null && quoteObservedMs > nowMs || sourceObservedMs !== null && sourceObservedMs > nowMs || sourceUpdatedMs !== null && sourceUpdatedMs > nowMs) addReason(reasons, reason("FUTURE_TIMESTAMP", "Quote or source evidence is in the future."));
  if (contextEvidenceMs !== null && contextEvidenceMs > nowMs) addReason(reasons, reason("FUTURE_TIMESTAMP", "Optional context evidence is in the future; context is quarantined.", "warning"));
  if (quoteObservedMs !== null && nowMs - quoteObservedMs > input.rules.quoteMaxAgeMs) addReason(reasons, reason("STALE_QUOTE", "The quote observation is stale."));
  if (sourceUpdatedMs === null) addReason(reasons, reason("SOURCE_UPDATE_UNAVAILABLE", "No upstream source update timestamp was supplied; freshness is based on observedAt only.", "warning"));
  else if (nowMs - sourceUpdatedMs > input.rules.quoteMaxAgeMs) addReason(reasons, reason("STALE_SOURCE", "The supplied source update timestamp is stale."));
  if (sourceObservedMs !== null && nowMs - sourceObservedMs > input.rules.quoteMaxAgeMs) addReason(reasons, reason("STALE_SOURCE", "The source observation is stale."));
  if (contextEvidenceMs !== null && nowMs - contextEvidenceMs > input.rules.quoteMaxAgeMs) addReason(reasons, reason("STALE_CONTEXT", "The optional event context evidence is stale.", "warning"));
  if (sourceUpdatedMs !== null && sourceObservedMs !== null && sourceUpdatedMs > sourceObservedMs) addReason(reasons, reason("TIMESTAMP_ORDER_INVALID", "The source update cannot be newer than the source observation."));
  if (sourceObservedMs !== null && quoteObservedMs !== null && sourceObservedMs > quoteObservedMs) addReason(reasons, reason("TIMESTAMP_ORDER_INVALID", "The source observation cannot be newer than quote observation."));
  if (contextEvidenceMs !== null && quoteObservedMs !== null && contextEvidenceMs > quoteObservedMs) addReason(reasons, reason("TIMESTAMP_ORDER_INVALID", "Event context evidence cannot be newer than quote observation.", "warning"));
  if (scheduledStartMs !== null && scheduledStartMs - nowMs <= input.rules.minimumStartLeadMs) addReason(reasons, reason("START_TOO_SOON", "The match starts inside the safety lead time."));

  const band = findPriceBand(input.price.decimalPrice, input.rules);
  if (band === undefined) addReason(reasons, reason("PRICE_OUTSIDE_BANDS", "The decimal price is not covered by a configured validated price band."));

  if (input.selectedHistory.playerId !== quote.selectedPlayerId) addReason(reasons, reason("HISTORY_PLAYER_MISMATCH", "Selected-player history does not match the selected quote player."));
  const opponent = quote.players.find((player): boolean => player.id !== quote.selectedPlayerId);
  if (opponent === undefined || input.opponentHistory.playerId !== opponent.id) addReason(reasons, reason("HISTORY_PLAYER_MISMATCH", "Opponent history does not match the event opponent."));
  if (quoteObservedMs !== null) {
    validateHistoryOrdering(input.selectedHistory, nowMs, nowMs, input.rules, reasons);
    validateHistoryOrdering(input.opponentHistory, nowMs, nowMs, input.rules, reasons);
  }

  const coverage = buildCoverageReport(input.selectedHistory, input.opponentHistory);
  for (const coverageReason of metricCoverageReasons(coverage, input.rules)) addReason(reasons, coverageReason);
  const comparisons = WATCHLIST_WINDOW_SIZES.map((window): ReturnType<typeof compareWindowMetrics> => compareWindowMetrics(coverage.selected[window], coverage.opponent[window], input.rules, band));
  const required: readonly MetricName[] = input.rules.requiredMetrics ?? ["average", "checkoutRate"];
  const firstComparison = comparisons[0];
  const secondComparison = comparisons[1];
  if (firstComparison !== undefined) {
    const hasRequiredTen = coverage.selected[10].sampleSize >= 10 && coverage.opponent[10].sampleSize >= 10 && required.every((name): boolean => coverage.selected[10][name].value !== null && coverage.opponent[10][name].value !== null);
    if (hasRequiredTen && !firstComparison.allMetricsSuperior) addReason(reasons, reason("SELECTED_PLAYER_NOT_SUPERIOR", "The selected player does not clear every required metric threshold in the last-10 window."));
  }
  const hasTwenty = coverage.selected[20].sampleSize >= 20 && coverage.opponent[20].sampleSize >= 20;
  if (hasTwenty && secondComparison !== undefined) {
    const hasRequiredTwenty = required.every((name): boolean => {
      const selectedMetric = coverage.selected[20][name];
      const opponentMetric = coverage.opponent[20][name];
      const minimumCoverage = input.rules.minimumMetricCoverage[name];
      return selectedMetric.value !== null
        && opponentMetric.value !== null
        && selectedMetric.coverage >= minimumCoverage
        && opponentMetric.coverage >= minimumCoverage;
    });
    if (hasRequiredTwenty && firstComparison !== undefined) {
      const directionChanges = required.some((name): boolean => {
        const firstDelta = firstComparison.deltas[name];
        const secondDelta = secondComparison.deltas[name];
        if (firstDelta === null || secondDelta === null) return false;
        return (firstDelta > 0) !== (secondDelta > 0);
      });
      if (directionChanges) addReason(reasons, reason("WINDOW_CONTRADICTION", "Required metric direction changes between last-10 and last-20."));
    }
  }

  const warnings = reasons.filter((item): boolean => item.severity === "warning");
  return {
    eligible: !reasons.some((item): boolean => item.severity === "blocking"),
    identityKey: identity?.key ?? null,
    reasons,
    warnings,
    coverage,
    comparisons,
    ruleVersion: input.rules.version,
  };
}

/** Deterministic screening entry point. `now` is always injected for replayable tests. */
export function screenWatchlistCandidate(input: unknown, now: Date): ScreeningResult {
  if (!isValidDate(now)) return { eligible: false, identityKey: null, reasons: [reason("INVALID_INPUT", "The injected clock value is invalid.")], warnings: [], coverage: null, comparisons: [], ruleVersion: null };
  const parsed = WatchlistScreenInputSchema.safeParse(input);
  if (!parsed.success) return { eligible: false, identityKey: null, reasons: [reason("INVALID_INPUT", "Watchlist input failed strict schema validation.")], warnings: [], coverage: null, comparisons: [], ruleVersion: null };
  return evaluateParsedInput(parsed.data, now);
}

export function evaluateWatchlistCandidate(input: WatchlistScreenInput, now: Date): ScreeningResult {
  return screenWatchlistCandidate(input, now);
}

export function deriveLastWindowMatches(snapshot: HistorySnapshot, window: WatchlistWindowSize): readonly CompletedHistoryMatch[] {
  return snapshot.matches.slice(0, window);
}

export function validateHistorySnapshot(input: unknown): HistorySnapshot | null {
  const parsed = HistorySnapshotSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function validateCompletedHistoryMatch(input: unknown): CompletedHistoryMatch | null {
  const parsed = CompletedHistoryMatchSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

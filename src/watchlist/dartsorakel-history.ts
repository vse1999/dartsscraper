import {
  DartsOrakelMatchesResponseSchema,
  parseDartsOrakelMatchRow,
  parseDartsOrakelMatchesWithStatistics,
  type DartsOrakelMatchRow,
  type DartsOrakelMatchesResponse,
} from "../dartsorakel/parser.js";
import { PlayerIdentitySchema, type PlayerIdentity } from "../schemas/player.js";
import type { Match } from "../schemas/match.js";
import {
  HistorySnapshotSchema,
  WatchlistSourceSchema,
  WatchlistTimestampSchema,
  type CompletedHistoryMatch,
  type HistorySnapshot,
} from "./contracts.js";

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:\s|T|$)/u;
const INCOMPLETE_RESULTS = new Set(["", "pending", "scheduled", "upcoming", "live", "cancelled", "abandoned"]);
const MAX_RAW_RESPONSE_ROWS = 1_000;
const MAX_RAW_RESPONSE_BYTES = 2_000_000;
const DATE_ONLY_COMPLETION_GUARD_MS = 48 * 60 * 60 * 1_000;
const UTF8_ENCODER = new TextEncoder();

export interface DartsOrakelHistoryNormalizationInput {
  readonly player: unknown;
  readonly responses: unknown;
  readonly sourceObservedAt: unknown;
  readonly sourceUrl: unknown;
}

export type DartsOrakelHistoryReasonCode =
  | "INVALID_INPUT"
  | "INVALID_PLAYER"
  | "INVALID_SOURCE"
  | "INCOMPLETE_RESPONSE"
  | "RECORDS_FILTERED_INCONSISTENT"
  | "NOT_NEWEST_FIRST"
  | "FUTURE_DATE"
  | "DATE_ONLY_CLOSE_TO_OBSERVATION"
  | "LAST_TEN_CUTOFF_AMBIGUOUS"
  | "INSUFFICIENT_HISTORY"
  | "DUPLICATE_MATCH"
  | "RAW_PLAYER_ABSENT"
  | "RAW_OPPONENT_SELF"
  | "STATISTICS_PARSE_FAILED"
  | "AMBIGUOUS_MATCH_MAPPING"
  | "OUTPUT_VALIDATION_FAILED";

export interface DartsOrakelHistoryReason {
  readonly code: DartsOrakelHistoryReasonCode;
  readonly message: string;
}

export type DartsOrakelHistoryWarningCode =
  | "LAST_TWENTY_UNAVAILABLE"
  | "LAST_TWENTY_CUTOFF_AMBIGUOUS"
  | "OPTIONAL_STATISTIC_UNAVAILABLE"
  | "LEGS_UNAVAILABLE";

export interface DartsOrakelHistoryWarning {
  readonly code: DartsOrakelHistoryWarningCode;
  readonly message: string;
}

export interface DartsOrakelHistoryMetadata {
  readonly provider: "DartsOrakel";
  readonly evidenceScope: "historical_statistics_only";
  readonly collectionPermissionVerified: false;
  readonly usableAsLiveQuote: false;
  readonly sourceUrl: string | null;
  readonly sourceObservedAt: string | null;
  readonly completeResponsesVerified: boolean;
  readonly newestFirstVerified: boolean;
  readonly oneEightyResponseVerified: boolean;
}

export interface DartsOrakelHistoryReady {
  readonly status: "ready";
  readonly snapshot: HistorySnapshot;
  readonly warnings: readonly DartsOrakelHistoryWarning[];
  readonly metadata: DartsOrakelHistoryMetadata;
}

export interface DartsOrakelHistoryBlocked {
  readonly status: "blocked";
  readonly reasons: readonly DartsOrakelHistoryReason[];
  readonly metadata: DartsOrakelHistoryMetadata;
}

export type DartsOrakelHistoryNormalizationResult = DartsOrakelHistoryReady | DartsOrakelHistoryBlocked;

/**
 * Convert already-captured DartsOrakel responses into the watchlist history
 * contract. This adapter never fetches data and never treats history as a live
 * quote or proof that collection permission has been granted.
 */
export function normalizeDartsOrakelHistory(input: unknown): DartsOrakelHistoryNormalizationResult {
  if (!isRecord(input)) return blocked("INVALID_INPUT", "History normalizer input must be an object.", baseMetadata());

  const playerResult = PlayerIdentitySchema.safeParse(input["player"]);
  if (!playerResult.success) return blocked("INVALID_PLAYER", "The supplied player identity failed strict validation.", baseMetadata());

  const provenance = parseProvenance(input["sourceObservedAt"], input["sourceUrl"]);
  if (provenance === null) return blocked("INVALID_SOURCE", "A valid HTTPS source URL and exact observedAt timestamp are required.", baseMetadata());
  const metadataBase = createMetadata(provenance.sourceObservedAt, provenance.sourceUrl, false, false, false);

  const responsesResult = parseResponses(input["responses"]);
  if (!responsesResult.success) return blocked(responsesResult.code, responsesResult.message, metadataBase);
  const responses = responsesResult.value;
  const completeMetadata = createMetadata(provenance.sourceObservedAt, provenance.sourceUrl, responsesResult.completeResponsesVerified, false, responsesResult.oneEightyResponseVerified);

  const averageRows = completedRows(responses.average.data);
  const structuralReason = validateRawRows(averageRows, playerResult.data, provenance.sourceObservedAt);
  if (structuralReason !== null) return blocked(structuralReason.code, structuralReason.message, completeMetadata);

  const ordering = validateNewestFirst(averageRows);
  if (ordering !== null) return blocked(ordering.code, ordering.message, completeMetadata);
  const newestMetadata = createMetadata(provenance.sourceObservedAt, provenance.sourceUrl, responsesResult.completeResponsesVerified, true, responsesResult.oneEightyResponseVerified);

  const cutoffReason = validateTenCutoff(averageRows);
  if (cutoffReason !== null) return blocked(cutoffReason.code, cutoffReason.message, newestMetadata);
  const twentyCutoffAmbiguous = averageRows.length > 20
    && dateOnly(averageRows[19]?.match_date) === dateOnly(averageRows[20]?.match_date);
  const selectedRows = averageRows.slice(0, twentyCutoffAmbiguous ? 10 : 20);
  if (selectedRows.length < 10) return blocked("INSUFFICIENT_HISTORY", "At least ten completed matches are required.", newestMetadata);

  let parsedMatches: Match[];
  try {
    parsedMatches = parseDartsOrakelMatchesWithStatistics(playerResult.data, responses);
  } catch (error: unknown) {
    return blocked("STATISTICS_PARSE_FAILED", errorMessage(error), newestMetadata);
  }

  const mapping = mapParsedMatches(parsedMatches, playerResult.data);
  if (mapping === null) return blocked("AMBIGUOUS_MATCH_MAPPING", "A parsed match could not be mapped to one occurrence-level raw row.", newestMetadata);

  const warnings = historyWarnings(averageRows, responses, parsedMatches, twentyCutoffAmbiguous);
  const matches: CompletedHistoryMatch[] = [];
  for (const row of selectedRows) {
    const base = mapping.get(domainKeyFromRow(row, playerResult.data));
    if (base === undefined) return blocked("AMBIGUOUS_MATCH_MAPPING", "A selected raw row has no unique parsed statistical counterpart.", newestMetadata);
    const completed = toCompletedHistoryMatch(row, base, playerResult.data, provenance.sourceObservedAt, provenance.sourceUrl);
    const parsedCompleted = validateCompletedMatch(completed);
    if (parsedCompleted === null) return blocked("OUTPUT_VALIDATION_FAILED", "A normalized completed match failed the watchlist contract.", newestMetadata);
    matches.push(parsedCompleted);
  }

  const snapshotCandidate: HistorySnapshot = {
    playerId: String(playerResult.data.id),
    observedAt: provenance.sourceObservedAt,
    source: {
      kind: "aggregator",
      sourceId: "dartsorakel",
      sourceUrl: provenance.sourceUrl,
      observedAt: provenance.sourceObservedAt,
    },
    matches,
  };
  const snapshot = HistorySnapshotSchema.safeParse(snapshotCandidate);
  if (!snapshot.success) return blocked("OUTPUT_VALIDATION_FAILED", "The normalized history failed the watchlist snapshot contract.", newestMetadata);

  return {
    status: "ready",
    snapshot: snapshot.data,
    warnings,
    metadata: newestMetadata,
  };
}

/** Stable positional wrapper for callers that already hold the four inputs. */
export function buildDartsOrakelHistorySnapshot(
  player: unknown,
  responses: unknown,
  sourceObservedAt: unknown,
  sourceUrl: unknown,
): DartsOrakelHistoryNormalizationResult {
  return normalizeDartsOrakelHistory({ player, responses, sourceObservedAt, sourceUrl });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function parseProvenance(observedAt: unknown, sourceUrl: unknown): { readonly sourceObservedAt: string; readonly sourceUrl: string } | null {
  if (!WatchlistTimestampSchema.safeParse(observedAt).success || typeof observedAt !== "string") return null;
  if (typeof sourceUrl !== "string") return null;
  try {
    const parsedUrl = new URL(sourceUrl);
    const host = parsedUrl.hostname.toLocaleLowerCase("en-US");
    if (parsedUrl.protocol !== "https:"
      || (host !== "dartsorakel.com" && host !== "www.dartsorakel.com")
      || parsedUrl.username !== ""
      || parsedUrl.password !== ""
      || parsedUrl.port !== "") return null;
  } catch (error: unknown) {
    return null;
  }
  const source = WatchlistSourceSchema.safeParse({ kind: "aggregator", sourceId: "dartsorakel", sourceUrl, observedAt });
  return source.success ? { sourceObservedAt: observedAt, sourceUrl } : null;
}

function parseResponses(value: unknown):
  | { readonly success: true; readonly value: {
    readonly average: DartsOrakelMatchesResponse;
    readonly oneEighties: DartsOrakelMatchesResponse;
    readonly checkoutPercentage: DartsOrakelMatchesResponse;
  }; readonly completeResponsesVerified: boolean; readonly oneEightyResponseVerified: boolean }
  | { readonly success: false; readonly code: "INCOMPLETE_RESPONSE" | "RECORDS_FILTERED_INCONSISTENT"; readonly message: string } {
  if (!isRecord(value)) return { success: false, code: "INCOMPLETE_RESPONSE", message: "Average and checkout DartsOrakel responses are required." };
  const bounded = validateRawResponseBounds(value);
  if (bounded !== null) return { success: false, code: "INCOMPLETE_RESPONSE", message: bounded };
  const averageResult = parseRequiredResponse(value["average"]);
  const checkoutResult = parseRequiredResponse(value["checkoutPercentage"]);
  if (averageResult.kind === "invalid" || checkoutResult.kind === "invalid") {
    return { success: false, code: "INCOMPLETE_RESPONSE", message: "A required DartsOrakel statistic response failed strict schema validation." };
  }
  if (averageResult.kind === "inconsistent" || checkoutResult.kind === "inconsistent") {
    return { success: false, code: "RECORDS_FILTERED_INCONSISTENT", message: "recordsFiltered must equal the captured raw row count before history selection." };
  }
  const oneEightiesResult = parseOptionalResponse(value["oneEighties"], averageResult.value);
  if (oneEightiesResult.kind === "inconsistent") {
    return {
      success: true,
      value: {
        average: averageResult.value,
        oneEighties: emptyResponse(),
        checkoutPercentage: checkoutResult.value,
      },
      completeResponsesVerified: true,
      oneEightyResponseVerified: false,
    };
  }
  return {
    success: true,
    value: {
      average: averageResult.value,
      oneEighties: oneEightiesResult.value,
      checkoutPercentage: checkoutResult.value,
    },
    completeResponsesVerified: true,
    oneEightyResponseVerified: oneEightiesResult.verified,
  };
}

type ResponseParseResult =
  | { readonly kind: "valid"; readonly value: DartsOrakelMatchesResponse }
  | { readonly kind: "inconsistent" }
  | { readonly kind: "invalid" };

function parseRequiredResponse(value: unknown): ResponseParseResult {
  const parsed = parseResponseSchema(value);
  if (parsed === null) return { kind: "invalid" };
  if (parsed.recordsFiltered !== parsed.data.length) return { kind: "inconsistent" };
  if (parsed.recordsTotal < parsed.recordsFiltered) return { kind: "invalid" };
  return { kind: "valid", value: parsed };
}

type OptionalResponseParseResult =
  | { readonly kind: "valid"; readonly value: DartsOrakelMatchesResponse; readonly verified: boolean }
  | { readonly kind: "inconsistent" };

function parseOptionalResponse(value: unknown, average: DartsOrakelMatchesResponse): OptionalResponseParseResult {
  if (value === undefined) return { kind: "valid", value: emptyResponse(), verified: false };
  const parsed = parseResponseSchema(value);
  if (parsed === null) return { kind: "valid", value: emptyResponse(), verified: false };
  if (parsed.recordsFiltered !== parsed.data.length) return { kind: "inconsistent" };
  const averageKeys = new Set(average.data.map(rawKey));
  const metricKeys = new Set(parsed.data.map(rawKey));
  if (averageKeys.size !== metricKeys.size || [...averageKeys].some((key): boolean => !metricKeys.has(key))) {
    return { kind: "valid", value: emptyResponse(), verified: false };
  }
  return { kind: "valid", value: parsed, verified: true };
}

function parseResponseSchema(value: unknown): DartsOrakelMatchesResponse | null {
  const parsed = DartsOrakelMatchesResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

function emptyResponse(): DartsOrakelMatchesResponse {
  return { draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] };
}

function validateRawResponseBounds(value: Readonly<Record<string, unknown>>): string | null {
  let totalBytes = 0;
  for (const key of ["average", "oneEighties", "checkoutPercentage"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (!isRecord(candidate) || !Array.isArray(candidate["data"])) return "A captured DartsOrakel response must contain a bounded data array.";
    if (candidate["data"].length > MAX_RAW_RESPONSE_ROWS) return "A captured DartsOrakel response exceeds the bounded row limit.";
    try {
      const serialized = JSON.stringify(candidate);
      if (serialized === undefined) return "A captured DartsOrakel response could not be bounded safely.";
      totalBytes += UTF8_ENCODER.encode(serialized).byteLength;
    } catch (error: unknown) {
      return "A captured DartsOrakel response could not be bounded safely.";
    }
    if (totalBytes > MAX_RAW_RESPONSE_BYTES) return "Captured DartsOrakel responses exceed the bounded payload size.";
  }
  return null;
}

function completedRows(rows: readonly DartsOrakelMatchRow[]): readonly DartsOrakelMatchRow[] {
  return rows.filter((row): boolean => !isBye(row) && !INCOMPLETE_RESULTS.has(row.result.trim().toLocaleLowerCase("en-US")));
}

function validateRawRows(
  rows: readonly DartsOrakelMatchRow[],
  player: PlayerIdentity,
  sourceObservedAt: string,
): DartsOrakelHistoryReason | null {
  const sourceDate = sourceObservedAt.slice(0, 10);
  const sourceObservedMs = Date.parse(sourceObservedAt);
  if (!Number.isFinite(sourceObservedMs)) return { code: "INVALID_SOURCE", message: "Source observation timestamp is not a finite instant." };
  const seen = new Set<string>();
  for (const row of rows) {
    const key = rawKey(row);
    if (seen.has(key)) return { code: "DUPLICATE_MATCH", message: "Duplicate occurrence-level raw match identity was returned." };
    seen.add(key);
    const opponentId = opponentIdFor(row, player.id);
    if (opponentId === null) return { code: "RAW_PLAYER_ABSENT", message: "A completed raw row does not contain the requested player ID." };
    if (opponentId === player.id) return { code: "RAW_OPPONENT_SELF", message: "A raw row maps the requested player to themself as opponent." };
    const date = dateOnly(row.match_date);
    if (date === null) return { code: "INCOMPLETE_RESPONSE", message: "A completed raw row has no valid calendar date." };
    if (date > sourceDate) return { code: "FUTURE_DATE", message: "A completed raw match date is later than source observation date." };
    const latestPossibleCompletion = Date.parse(`${date}T23:59:59.999Z`) + DATE_ONLY_COMPLETION_GUARD_MS;
    if (!Number.isFinite(latestPossibleCompletion) || sourceObservedMs < latestPossibleCompletion) {
      return { code: "DATE_ONLY_CLOSE_TO_OBSERVATION", message: "Date-only match history is too close to source observation to prove completion ordering across unknown timezone semantics." };
    }
  }
  return null;
}

function validateNewestFirst(rows: readonly DartsOrakelMatchRow[]): DartsOrakelHistoryReason | null {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = dateOnly(rows[index - 1]?.match_date);
    const current = dateOnly(rows[index]?.match_date);
    if (previous === null || current === null || current > previous) {
      return { code: "NOT_NEWEST_FIRST", message: "The complete response is not verified newest-first by raw match date." };
    }
  }
  return null;
}

function validateTenCutoff(rows: readonly DartsOrakelMatchRow[]): DartsOrakelHistoryReason | null {
  if (rows.length > 10 && dateOnly(rows[9]?.match_date) === dateOnly(rows[10]?.match_date)) {
    return { code: "LAST_TEN_CUTOFF_AMBIGUOUS", message: "The tenth/eleventh date-only boundary is ambiguous; automatic last-10 history is blocked." };
  }
  return null;
}

function mapParsedMatches(matches: readonly Match[], player: PlayerIdentity): ReadonlyMap<string, Match> | null {
  const mapped = new Map<string, Match>();
  for (const match of matches) {
    const key = domainKeyFromMatch(match);
    if (mapped.has(key)) return null;
    mapped.set(key, match);
  }
  // The map is checked against raw rows by the caller; this function only
  // rejects duplicate normalized identities, never joins by array position.
  return mapped;
}

function domainKeyFromRow(row: DartsOrakelMatchRow, player: PlayerIdentity): string {
  const base = parseDartsOrakelMatchRow(player, row);
  return domainKeyFromMatch(base);
}

function domainKeyFromMatch(match: Match): string {
  return JSON.stringify([match.date, match.tournament, match.round ?? "", match.result.trim(), match.opponent, match.score.trim()]);
}

function toCompletedHistoryMatch(
  row: DartsOrakelMatchRow,
  parsed: Match,
  player: PlayerIdentity,
  observedAt: string,
  sourceUrl: string,
): CompletedHistoryMatch {
  const date = dateOnly(row.match_date) ?? parsed.date;
  const opponentId = opponentIdFor(row, player.id) ?? 0;
  const context = {
    competitionId: String(row.tournament_key),
    eventId: String(row.event_key),
    ...(row.round?.trim() === undefined || row.round.trim() === "" ? {} : { round: row.round.trim() }),
  };
  return {
    matchId: `dartsorakel-composite:${rawKey(row)}`,
    playerId: String(player.id),
    opponent: { id: String(opponentId), name: parsed.opponent },
    status: "completed",
    result: row.winner_key === player.id ? "win" : "loss",
    playedAt: date,
    completedAt: date,
    stats: {
      average: parsed.average,
      checkoutHits: parsed.checkoutHits ?? null,
      checkoutAttempts: parsed.checkoutAttempts ?? null,
      oneEighties: parsed.oneEighties ?? null,
    },
    context,
    evidence: {
      kind: "aggregator",
      sourceId: "dartsorakel",
      sourceUrl,
      observedAt,
    },
  };
}

function validateCompletedMatch(value: CompletedHistoryMatch): CompletedHistoryMatch | null {
  const parsed = HistorySnapshotSchema.shape.matches.element.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function historyWarnings(
  rows: readonly DartsOrakelMatchRow[],
  responses: { readonly oneEighties: DartsOrakelMatchesResponse; readonly checkoutPercentage: DartsOrakelMatchesResponse },
  matches: readonly Match[],
  twentyCutoffAmbiguous: boolean,
): readonly DartsOrakelHistoryWarning[] {
  const warnings: DartsOrakelHistoryWarning[] = [];
  const oneEightyCounts = metricRowCounts(responses.oneEighties);
  const checkoutCounts = metricRowCounts(responses.checkoutPercentage);
  if (rows.length < 20) warnings.push({ code: "LAST_TWENTY_UNAVAILABLE", message: "Fewer than twenty completed matches are available; last-20 evidence is unavailable." });
  if (twentyCutoffAmbiguous) warnings.push({ code: "LAST_TWENTY_CUTOFF_AMBIGUOUS", message: "The twentieth/twenty-first date-only boundary is ambiguous; only last-10 evidence is returned." });
  if (matches.some((match): boolean => match.oneEighties === undefined || match.oneEighties === null)) warnings.push({ code: "OPTIONAL_STATISTIC_UNAVAILABLE", message: "Some 180-count evidence is unavailable; average and checkout evidence are preserved." });
  if (matches.some((match): boolean => match.checkoutAttempts === undefined || match.checkoutAttempts === null)) warnings.push({ code: "OPTIONAL_STATISTIC_UNAVAILABLE", message: "Some checkout-count evidence is unavailable; missing values are not treated as zero." });
  if (rows.some((row): boolean => (oneEightyCounts.get(rawKey(row)) ?? 0) !== 1 || (checkoutCounts.get(rawKey(row)) ?? 0) !== 1)) warnings.push({ code: "OPTIONAL_STATISTIC_UNAVAILABLE", message: "Some metric rows were missing or ambiguous; no row-position join was used." });
  warnings.push({ code: "LEGS_UNAVAILABLE", message: "Completed legs are not supplied by this source and are not inferred from scores." });
  return deduplicateWarnings(warnings);
}

function metricRowCounts(response: DartsOrakelMatchesResponse): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of completedRows(response.data)) {
    const key = rawKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function deduplicateWarnings(warnings: readonly DartsOrakelHistoryWarning[]): readonly DartsOrakelHistoryWarning[] {
  const seen = new Set<DartsOrakelHistoryWarningCode>();
  return warnings.filter((warning): boolean => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}

function opponentIdFor(row: DartsOrakelMatchRow, playerId: number): number | null {
  if (row.winner_key === playerId) return row.loser_key;
  if (row.loser_key === playerId) return row.winner_key;
  return null;
}

function rawKey(row: DartsOrakelMatchRow): string {
  return JSON.stringify([row.tournament_key, row.event_key, row.match_date, row.round?.trim() ?? "", row.winner_key, row.loser_key, row.score.trim()]);
}

function dateOnly(value: string | undefined): string | null {
  const date = value === undefined ? undefined : DATE_PREFIX.exec(value.trim())?.[1];
  if (date === undefined) return null;
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? date
    : null;
}

function isBye(row: DartsOrakelMatchRow): boolean {
  return row.is_bye === 1 || row.is_bye === "1";
}

function createMetadata(
  sourceObservedAt: string | null,
  sourceUrl: string | null,
  completeResponsesVerified: boolean,
  newestFirstVerified: boolean,
  oneEightyResponseVerified: boolean,
): DartsOrakelHistoryMetadata {
  return {
    provider: "DartsOrakel",
    evidenceScope: "historical_statistics_only",
    collectionPermissionVerified: false,
    usableAsLiveQuote: false,
    sourceUrl,
    sourceObservedAt,
    completeResponsesVerified,
    newestFirstVerified,
    oneEightyResponseVerified,
  };
}

function baseMetadata(): DartsOrakelHistoryMetadata {
  return createMetadata(null, null, false, false, false);
}

function blocked(code: DartsOrakelHistoryReasonCode, message: string, metadata: DartsOrakelHistoryMetadata): DartsOrakelHistoryBlocked {
  return { status: "blocked", reasons: [{ code, message }], metadata };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `DartsOrakel statistics could not be normalized: ${error.message}` : "DartsOrakel statistics could not be normalized.";
}

import { InsufficientMatchDataError, ModusHistoryUnavailableError, PlayerAmbiguousError } from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { MatchSchema, type Match } from "../schemas/match.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import {
  MODUS_RESULTS_URL,
  ModusResultsIndexSchema,
  type ModusHistoricalMatch,
  type ModusMatchReference,
  type ModusResultsIndex,
} from "./history-schemas.js";
import type { OfficialModusHistoryReader } from "./history-source.js";
import {
  modusAbbreviationMatches,
  modusCountryQualifiers,
  modusNameBaseKey,
  modusNameKey,
  modusNamesEquivalent,
  parseModusAbbreviatedName,
} from "./identity.js";

const DEFAULT_LIVE_TTL_MS = 30_000;
const DEFAULT_FAILURE_TTL_MS = 15_000;
const DEFAULT_DETAILS_TTL_MS = 5 * 60_000;
const MAX_DETAILS_CACHE_ENTRIES = 1_000;
const MATCH_DETAILS_CONCURRENCY = 4;

export interface ModusPlayerHistoryResult {
  readonly playerName: string;
  readonly matches: readonly Match[];
  readonly evidenceUrls: readonly string[];
  readonly sourceUrl: string;
}

export interface ModusPlayerHistoryReader {
  findPlayerHistory(
    playerName: string,
    limit: number,
    options?: ModusPlayerHistoryReadOptions,
  ): Promise<ModusPlayerHistoryResult | null>;
}

export interface ModusPlayerHistoryReadOptions {
  readonly forceLiveLookup?: boolean;
  readonly signal?: AbortSignal;
}

export interface ModusPlayerHistoryServiceOptions {
  readonly source: OfficialModusHistoryReader;
  readonly index: unknown;
  readonly liveTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly detailsTtlMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

interface CatalogueRead {
  readonly references: readonly ModusMatchReference[];
  readonly liveRefreshSucceeded: boolean;
}

interface CachedMatchDetails {
  readonly promise: Promise<ModusHistoricalMatch>;
  expiresAt: number;
}

interface VerifiedHistoricalMatch {
  readonly details: ModusHistoricalMatch;
  readonly reference: ModusMatchReference;
}

export class ModusPlayerHistoryService implements ModusPlayerHistoryReader {
  private readonly source: OfficialModusHistoryReader;
  private readonly index: ModusResultsIndex;
  private readonly liveTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly detailsTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly currentSeriesPlayerNames: ReadonlySet<string>;
  private cataloguePromise: Promise<CatalogueRead> | undefined;
  private catalogueExpiresAt = 0;
  private readonly detailsCache = new Map<string, CachedMatchDetails>();

  public constructor(options: ModusPlayerHistoryServiceOptions) {
    this.source = options.source;
    this.index = ModusResultsIndexSchema.parse(options.index);
    this.liveTtlMs = positiveFinite(options.liveTtlMs ?? DEFAULT_LIVE_TTL_MS, "liveTtlMs");
    this.failureTtlMs = positiveFinite(options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS, "failureTtlMs");
    this.detailsTtlMs = positiveFinite(options.detailsTtlMs ?? DEFAULT_DETAILS_TTL_MS, "detailsTtlMs");
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
    this.currentSeriesPlayerNames = buildCurrentSeriesPlayerNames(this.index);
  }

  public async findPlayerHistory(
    playerName: string,
    limit: number,
    options: ModusPlayerHistoryReadOptions = {},
  ): Promise<ModusPlayerHistoryResult | null> {
    validatePlayerRequest(playerName, limit);
    const signal = options.signal;
    throwIfAborted(signal);
    // Source selection must be local: PDC lookups should not pay for four
    // official MODUS page requests before reaching DartsOrakel. An explicit
    // MODUS request bypasses this optimization so today's new player catalogue
    // can be checked before the bundled index is refreshed.
    if (!this.isCurrentModusPlayer(playerName) && options.forceLiveLookup !== true) return null;
    const catalogue = await this.readCatalogue(signal);
    throwIfAborted(signal);
    const resolvedIdentity = resolveCatalogueIdentity(catalogue.references, playerName);
    const candidates = resolvedIdentity === undefined
      ? []
      : referencesForPlayer(catalogue.references, resolvedIdentity);
    if (candidates.length === 0) {
      if (!catalogue.liveRefreshSucceeded) {
        throw new ModusHistoryUnavailableError("The current official MODUS catalogue could not be verified.");
      }
      return null;
    }

    const weekGroups = groupReferencesByWeek(candidates);
    const historicalMatches: VerifiedHistoricalMatch[] = [];
    for (const references of weekGroups) {
      const details = await mapWithConcurrency(
        references,
        MATCH_DETAILS_CONCURRENCY,
        async (reference: ModusMatchReference): Promise<VerifiedHistoricalMatch | undefined> => {
          throwIfAborted(signal);
          const match = await waitWithSignal(this.getMatchDetails(reference.matchId), signal);
          throwIfAborted(signal);
          assertReferenceMatchesDetails(reference, match, catalogue.references);
          return referenceContainsPlayer(reference, resolvedIdentity ?? "")
            ? { details: match, reference }
            : undefined;
        },
      );
      historicalMatches.push(...details.filter((match): match is VerifiedHistoricalMatch => match !== undefined));
      if (historicalMatches.length >= limit) break;
    }
    if (historicalMatches.length === 0) throw new InsufficientMatchDataError(limit, 0);

    historicalMatches.sort((left, right) => {
      return right.details.playedAtLocal.localeCompare(left.details.playedAtLocal)
        || Number(right.details.matchId) - Number(left.details.matchId);
    });
    const selected = historicalMatches.slice(0, limit);
    const converted = selected.map(({ details, reference }) => convertMatch(
      details,
      resolvedIdentity ?? "",
      reference,
      catalogue.references,
    ));
    const newestPlayerName = converted[0]?.playerName;
    if (newestPlayerName === undefined) throw new InsufficientMatchDataError(limit, 0);
    this.logger.info("Official MODUS player history selected.", {
      provider: "modus-official",
      requestedCount: limit,
      returnedCount: converted.length,
    });
    return {
      playerName: newestPlayerName,
      matches: converted.map((item) => item.match),
      evidenceUrls: selected.map(({ details }) => details.sourceUrl),
      sourceUrl: MODUS_RESULTS_URL,
    };
  }

  private isCurrentModusPlayer(playerName: string): boolean {
    const requestedKey = identityKey(playerName);
    if ([...this.currentSeriesPlayerNames].some((name: string): boolean => identityKey(name) === requestedKey)) return true;
    const directMatches = [...this.currentSeriesPlayerNames].filter((candidate: string): boolean => {
      if (modusAbbreviationMatches(playerName, candidate)) return true;
      return modusCountryQualifiers(playerName).length === 0
        && modusCountryQualifiers(candidate).length > 0
        && modusNameBaseKey(playerName) === modusNameBaseKey(candidate);
    });
    return directMatches.length > 0;
  }

  private async readCatalogue(signal?: AbortSignal): Promise<CatalogueRead> {
    throwIfAborted(signal);
    if (this.cataloguePromise !== undefined && this.now() < this.catalogueExpiresAt) {
      return waitWithSignal(this.cataloguePromise, signal);
    }
    const request = this.source.getLiveReferences(this.index).then((liveReferences): CatalogueRead => {
      this.catalogueExpiresAt = this.now() + this.liveTtlMs;
      return { references: mergeReferences(this.index.matches, liveReferences), liveRefreshSucceeded: true };
    }).catch((error: unknown): CatalogueRead => {
      this.catalogueExpiresAt = this.now() + this.failureTtlMs;
      this.logger.warn("Official MODUS live catalogue refresh failed; using the bundled official index.", {
        code: "MODUS_CATALOGUE_REFRESH_FAILED",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return { references: this.index.matches, liveRefreshSucceeded: false };
    });
    this.catalogueExpiresAt = Number.POSITIVE_INFINITY;
    this.cataloguePromise = request;
    return waitWithSignal(request, signal);
  }

  private getMatchDetails(matchId: string): Promise<ModusHistoricalMatch> {
    const cached = this.detailsCache.get(matchId);
    if (cached !== undefined && this.now() < cached.expiresAt) {
      this.detailsCache.delete(matchId);
      this.detailsCache.set(matchId, cached);
      return cached.promise;
    }
    if (cached !== undefined) this.detailsCache.delete(matchId);
    const request = this.source.getMatchDetails(matchId).catch((error: unknown) => {
      this.detailsCache.delete(matchId);
      throw new ModusHistoryUnavailableError(`Official MODUS match ${matchId} could not be verified.`, error);
    });
    const entry: CachedMatchDetails = { promise: request, expiresAt: Number.POSITIVE_INFINITY };
    this.detailsCache.set(matchId, entry);
    void request.then((): void => {
      if (this.detailsCache.get(matchId) === entry) entry.expiresAt = this.now() + this.detailsTtlMs;
    }, (): void => {
      if (this.detailsCache.get(matchId) === entry) this.detailsCache.delete(matchId);
    });
    while (this.detailsCache.size > MAX_DETAILS_CACHE_ENTRIES) {
      const oldest = this.detailsCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.detailsCache.delete(oldest);
    }
    return request;
  }
}

/**
 * Resolve a request against the complete official catalogue before fetching
 * detail pages. Abbreviations are accepted only when exactly one full ordered
 * catalogue name matches; short catalogue labels cannot authorize a full-name
 * request on their own.
 */
function resolveCatalogueIdentity(
  references: readonly ModusMatchReference[],
  requestedName: string,
): string | undefined {
  const fullNames = uniqueCatalogueFullNames(references);
  const requestedKey = identityKey(requestedName);
  if (requestedKey === "") return undefined;
  if (parseModusAbbreviatedName(requestedName) === undefined) {
    // An unqualified request can map to one qualified official identity only
    // when the catalogue contains no competing person with the same base name.
    // Even an old unqualified row cannot prove it is a distinct third person
    // when qualified variants are also present, so surface that collision.
    if (modusCountryQualifiers(requestedName).length > 0) {
      return fullNames.some((name: string): boolean => identityKey(name) === requestedKey)
        ? requestedKey
        : undefined;
    }
    const candidates = fullNames.filter((name: string): boolean => {
      return modusNameBaseKey(name) === modusNameBaseKey(requestedName);
    });
    const candidateKeys = [...new Set(candidates.map((name: string): string => identityKey(name)))];
    if (candidateKeys.length > 1) throw new PlayerAmbiguousError(requestedName, candidates);
    return candidateKeys[0];
  }

  const candidates = fullNames.filter((name: string): boolean => modusAbbreviationMatches(requestedName, name));
  const candidateKeys = [...new Set(candidates.map((name: string): string => identityKey(name)))];
  if (candidateKeys.length > 1) throw new PlayerAmbiguousError(requestedName, candidates);
  return candidateKeys[0];
}

function uniqueCatalogueFullNames(references: readonly ModusMatchReference[]): readonly string[] {
  const names = new Map<string, string>();
  for (const reference of references) {
    for (const name of [reference.homeName, reference.awayName]) {
      if (parseModusAbbreviatedName(name) !== undefined) continue;
      const key = identityKey(name);
      if (key !== "" && !names.has(key)) names.set(key, name);
    }
  }
  return [...names.values()];
}

function referencesForPlayer(
  references: readonly ModusMatchReference[],
  canonicalKey: string,
): ModusMatchReference[] {
  return deduplicateReferences(references.filter((reference) => {
    return identityKey(reference.homeName) === canonicalKey
      || identityKey(reference.awayName) === canonicalKey;
  }));
}

function groupReferencesByWeek(references: readonly ModusMatchReference[]): ModusMatchReference[][] {
  const byWeek = new Map<string, ModusMatchReference[]>();
  for (const reference of references) {
    const key = `${reference.seriesOrder}:${reference.weekOrder}:${reference.seriesId}:${reference.weekId}`;
    byWeek.set(key, [...(byWeek.get(key) ?? []), reference]);
  }
  return [...byWeek.entries()]
    .sort(([left], [right]) => compareWeekKeys(right, left))
    .map(([, matches]) => matches);
}

function compareWeekKeys(left: string, right: string): number {
  const [leftSeries = 0, leftWeek = 0] = left.split(":").map(Number);
  const [rightSeries = 0, rightWeek = 0] = right.split(":").map(Number);
  return leftSeries - rightSeries || leftWeek - rightWeek;
}

function referenceContainsPlayer(reference: ModusMatchReference, canonicalKey: string): boolean {
  return identityKey(reference.homeName) === canonicalKey || identityKey(reference.awayName) === canonicalKey;
}

function assertReferenceMatchesDetails(
  reference: ModusMatchReference,
  details: ModusHistoricalMatch,
  knownReferences: readonly ModusMatchReference[],
): void {
  // This is source-bound verification for one match id, not a reusable player
  // alias. A catalogue row never authorizes reversing names across matches.
  const knownNames = catalogueNames(knownReferences);
  const sameOrder = sourceNamesMatch(reference.homeName, details.home.name, knownNames)
    && sourceNamesMatch(reference.awayName, details.away.name, knownNames);
  const reversedOrder = sourceNamesMatch(reference.homeName, details.away.name, knownNames)
    && sourceNamesMatch(reference.awayName, details.home.name, knownNames);
  // The official "Final" tab contains Group 1/2, semi-finals and the final,
  // so its detail-page phase label intentionally differs from the tab name.
  const groupMatches = reference.group === "Final"
    || identityKey(details.group) === identityKey(reference.group)
    || identityKey(details.group).startsWith(`${identityKey(reference.group)} `);
  if (
    details.matchId !== reference.matchId
    || (!sameOrder && !reversedOrder)
    || identityKey(details.seriesName) !== identityKey(reference.seriesName)
    || identityKey(details.weekName) !== identityKey(reference.weekName)
    || !groupMatches
  ) {
    throw new ModusHistoryUnavailableError(`Official MODUS match ${reference.matchId} did not match its results-page reference.`);
  }
}

function convertMatch(
  historical: ModusHistoricalMatch,
  canonicalKey: string,
  reference: ModusMatchReference,
  knownReferences: readonly ModusMatchReference[],
): { readonly playerName: string; readonly match: Match } {
  const knownNames = catalogueNames(knownReferences);
  const homeMatches = identityKey(reference.homeName) === canonicalKey
    && sourceNamesMatch(reference.homeName, historical.home.name, knownNames)
    || identityKey(reference.awayName) === canonicalKey
      && sourceNamesMatch(reference.awayName, historical.home.name, knownNames);
  const awayMatches = identityKey(reference.homeName) === canonicalKey
    && sourceNamesMatch(reference.homeName, historical.away.name, knownNames)
    || identityKey(reference.awayName) === canonicalKey
      && sourceNamesMatch(reference.awayName, historical.away.name, knownNames);
  if (homeMatches === awayMatches) {
    throw new ModusHistoryUnavailableError(`Official MODUS match ${historical.matchId} has an ambiguous player identity.`);
  }
  const player = homeMatches ? historical.home : historical.away;
  const opponent = homeMatches ? historical.away : historical.home;
  const playerReferenceName = homeMatches
    ? (sourceNamesMatch(reference.homeName, historical.home.name, knownNames) ? reference.homeName : reference.awayName)
    : (sourceNamesMatch(reference.homeName, historical.away.name, knownNames) ? reference.homeName : reference.awayName);
  const opponentReferenceName = homeMatches
    ? (sourceNamesMatch(reference.homeName, historical.away.name, knownNames) ? reference.homeName : reference.awayName)
    : (sourceNamesMatch(reference.homeName, historical.home.name, knownNames) ? reference.homeName : reference.awayName);
  const playerName = canonicalDisplayName(player.name, playerReferenceName, knownNames);
  const opponentName = canonicalDisplayName(opponent.name, opponentReferenceName, knownNames);
  const result = player.score > opponent.score ? "Won" : player.score < opponent.score ? "Lost" : "Draw";
  return {
    playerName,
    match: MatchSchema.parse({
      date: historical.date,
      tournament: `MODUS Super Series – ${historical.seriesName} – ${historical.weekName}`,
      round: historical.group,
      result,
      opponent: opponentName,
      score: `${player.score} V ${opponent.score}`,
      average: player.average,
    }),
  };
}

function canonicalDisplayName(detailName: string, referenceName: string, knownNames: readonly string[]): string {
  return modusCountryQualifiers(detailName).length === 0
    && modusCountryQualifiers(referenceName).length > 0
    && sourceNamesMatch(referenceName, detailName, knownNames)
    ? referenceName
    : detailName;
}

export function identityKey(value: string): string {
  return modusNameKey(value);
}

export function tokenIdentityKey(value: string): string {
  // Kept as a compatibility export; token sorting is intentionally forbidden
  // because it can conflate people whose given and family names are swapped.
  return identityKey(value);
}

function buildCurrentSeriesPlayerNames(index: ModusResultsIndex): ReadonlySet<string> {
  const currentSeries = index.series.reduce<ModusResultsIndex["series"][number] | undefined>((latest, series) => {
    return latest === undefined || series.order > latest.order ? series : latest;
  }, undefined);
  if (currentSeries === undefined) throw new Error("The bundled official MODUS index contains no series.");
  const keys = new Set<string>();
  for (const match of index.matches) {
    if (match.seriesId !== currentSeries.id) continue;
    for (const name of [match.homeName, match.awayName]) {
      keys.add(name);
    }
  }
  if (keys.size === 0) throw new Error("The bundled official MODUS current series contains no players.");
  return keys;
}

function namesMatch(requested: string, candidate: string): boolean {
  return modusNamesEquivalent(requested, candidate)
    || modusAbbreviationMatches(requested, candidate)
    || modusAbbreviationMatches(candidate, requested);
}

function sourceNamesMatch(left: string, right: string, knownNames: readonly string[]): boolean {
  const leftQualifiers = modusCountryQualifiers(left);
  const rightQualifiers = modusCountryQualifiers(right);
  if (leftQualifiers.length > 0 && rightQualifiers.length > 0 && leftQualifiers.join(",") !== rightQualifiers.join(",")) {
    return false;
  }
  const baseMatch = namesMatch(left, right)
    || modusNameBaseKey(left) === modusNameBaseKey(right)
    || sourceSurnameFirstVariant(left, right);
  if (!baseMatch) return false;
  if (leftQualifiers.length === 0 || rightQualifiers.length === 0) {
    const qualifiedName = leftQualifiers.length > 0 ? left : right;
    const unqualifiedName = leftQualifiers.length === 0 ? left : right;
    if (modusCountryQualifiers(qualifiedName).length === 0) return true;
    const sameBaseIdentities = uniqueByIdentity(knownNames.filter((name: string): boolean => {
      return modusNameBaseKey(name) === modusNameBaseKey(qualifiedName)
        || (parseModusAbbreviatedName(name) !== undefined
          && (modusAbbreviationMatches(name, qualifiedName) || modusAbbreviationMatches(qualifiedName, name)));
    }));
    return sameBaseIdentities.length === 1
      && identityKey(sameBaseIdentities[0] ?? "") === identityKey(qualifiedName)
      && (modusNameBaseKey(unqualifiedName) === modusNameBaseKey(qualifiedName)
        || modusAbbreviationMatches(unqualifiedName, qualifiedName)
        || modusAbbreviationMatches(qualifiedName, unqualifiedName));
  }
  return true;
}

function sourceSurnameFirstVariant(left: string, right: string): boolean {
  const leftParts = modusNameBaseKey(left).split(" ").filter((part: string): boolean => part !== "");
  const rightParts = modusNameBaseKey(right).split(" ").filter((part: string): boolean => part !== "");
  return leftParts.length === 2
    && rightParts.length === 2
    && leftParts[0] === rightParts[1]
    && leftParts[1] === rightParts[0];
}

function catalogueNames(references: readonly ModusMatchReference[]): string[] {
  return references.flatMap((reference) => [reference.homeName, reference.awayName]);
}

function uniqueByIdentity(names: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = identityKey(name);
    if (key !== "" && !byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()];
}

function mergeReferences(
  bundled: readonly ModusMatchReference[],
  live: readonly ModusMatchReference[],
): ModusMatchReference[] {
  const byId = new Map<string, ModusMatchReference>();
  for (const reference of bundled) byId.set(reference.matchId, reference);
  for (const reference of live) byId.set(reference.matchId, reference);
  return [...byId.values()];
}

function deduplicateReferences(references: readonly ModusMatchReference[]): ModusMatchReference[] {
  return mergeReferences([], references);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function validatePlayerRequest(playerName: string, limit: number): void {
  if (identityKey(playerName) === "") throw new Error("playerName must not be empty.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("MODUS history limit must be between 1 and 20.");
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

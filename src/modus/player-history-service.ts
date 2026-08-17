import { InsufficientMatchDataError, ModusHistoryUnavailableError } from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { MatchSchema, type Match } from "../schemas/match.js";
import {
  MODUS_RESULTS_URL,
  ModusResultsIndexSchema,
  type ModusHistoricalMatch,
  type ModusMatchReference,
  type ModusResultsIndex,
} from "./history-schemas.js";
import type { OfficialModusHistoryReader } from "./history-source.js";

const DEFAULT_LIVE_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 15_000;
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
}

export interface ModusPlayerHistoryServiceOptions {
  readonly source: OfficialModusHistoryReader;
  readonly index: unknown;
  readonly liveTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

interface CatalogueRead {
  readonly references: readonly ModusMatchReference[];
  readonly liveRefreshSucceeded: boolean;
}

export class ModusPlayerHistoryService implements ModusPlayerHistoryReader {
  private readonly source: OfficialModusHistoryReader;
  private readonly index: ModusResultsIndex;
  private readonly liveTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly currentSeriesPlayerKeys: ReadonlySet<string>;
  private cataloguePromise: Promise<CatalogueRead> | undefined;
  private catalogueExpiresAt = 0;
  private readonly detailsCache = new Map<string, Promise<ModusHistoricalMatch>>();

  public constructor(options: ModusPlayerHistoryServiceOptions) {
    this.source = options.source;
    this.index = ModusResultsIndexSchema.parse(options.index);
    this.liveTtlMs = positiveFinite(options.liveTtlMs ?? DEFAULT_LIVE_TTL_MS, "liveTtlMs");
    this.failureTtlMs = positiveFinite(options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS, "failureTtlMs");
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
    this.currentSeriesPlayerKeys = buildCurrentSeriesPlayerKeys(this.index);
  }

  public async findPlayerHistory(
    playerName: string,
    limit: number,
    options: ModusPlayerHistoryReadOptions = {},
  ): Promise<ModusPlayerHistoryResult | null> {
    validatePlayerRequest(playerName, limit);
    // Source selection must be local: PDC lookups should not pay for four
    // official MODUS page requests before reaching DartsOrakel. An explicit
    // MODUS request bypasses this optimization so today's new player catalogue
    // can be checked before the bundled index is refreshed.
    if (!this.isCurrentModusPlayer(playerName) && options.forceLiveLookup !== true) return null;
    const catalogue = await this.readCatalogue();
    const candidates = referencesForPlayer(catalogue.references, playerName);
    if (candidates.length === 0) {
      if (!catalogue.liveRefreshSucceeded) {
        throw new ModusHistoryUnavailableError("The current official MODUS catalogue could not be verified.");
      }
      return null;
    }

    const weekGroups = groupReferencesByWeek(candidates);
    const historicalMatches: ModusHistoricalMatch[] = [];
    for (const references of weekGroups) {
      const details = await mapWithConcurrency(
        references,
        MATCH_DETAILS_CONCURRENCY,
        async (reference: ModusMatchReference): Promise<ModusHistoricalMatch> => {
          const match = await this.getMatchDetails(reference.matchId);
          assertReferenceMatchesDetails(reference, match);
          return match;
        },
      );
      historicalMatches.push(...details.filter((match) => matchContainsPlayer(match, playerName)));
      if (historicalMatches.length >= limit) break;
    }
    if (historicalMatches.length === 0) throw new InsufficientMatchDataError(limit, 0);

    historicalMatches.sort((left, right) => {
      return right.playedAtLocal.localeCompare(left.playedAtLocal) || Number(right.matchId) - Number(left.matchId);
    });
    const selected = historicalMatches.slice(0, limit);
    const converted = selected.map((historical) => convertMatch(historical, playerName));
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
      evidenceUrls: selected.map((item) => item.sourceUrl),
      sourceUrl: MODUS_RESULTS_URL,
    };
  }

  private isCurrentModusPlayer(playerName: string): boolean {
    return this.currentSeriesPlayerKeys.has(`exact:${identityKey(playerName)}`)
      || this.currentSeriesPlayerKeys.has(`tokens:${tokenIdentityKey(playerName)}`);
  }

  private async readCatalogue(): Promise<CatalogueRead> {
    if (this.cataloguePromise !== undefined && this.now() < this.catalogueExpiresAt) return this.cataloguePromise;
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
    this.cataloguePromise = request;
    return request;
  }

  private getMatchDetails(matchId: string): Promise<ModusHistoricalMatch> {
    const cached = this.detailsCache.get(matchId);
    if (cached !== undefined) {
      this.detailsCache.delete(matchId);
      this.detailsCache.set(matchId, cached);
      return cached;
    }
    const request = this.source.getMatchDetails(matchId).catch((error: unknown) => {
      this.detailsCache.delete(matchId);
      throw new ModusHistoryUnavailableError(`Official MODUS match ${matchId} could not be verified.`, error);
    });
    this.detailsCache.set(matchId, request);
    while (this.detailsCache.size > MAX_DETAILS_CACHE_ENTRIES) {
      const oldest = this.detailsCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.detailsCache.delete(oldest);
    }
    return request;
  }
}

function referencesForPlayer(references: readonly ModusMatchReference[], playerName: string): ModusMatchReference[] {
  const exact = identityKey(playerName);
  const token = tokenIdentityKey(playerName);
  return deduplicateReferences(references.filter((reference) => {
    return identityKey(reference.homeName) === exact
      || identityKey(reference.awayName) === exact
      || tokenIdentityKey(reference.homeName) === token
      || tokenIdentityKey(reference.awayName) === token;
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

function matchContainsPlayer(match: ModusHistoricalMatch, playerName: string): boolean {
  const exact = identityKey(playerName);
  if (identityKey(match.home.name) === exact || identityKey(match.away.name) === exact) return true;
  const token = tokenIdentityKey(playerName);
  return tokenIdentityKey(match.home.name) === token || tokenIdentityKey(match.away.name) === token;
}

function assertReferenceMatchesDetails(reference: ModusMatchReference, details: ModusHistoricalMatch): void {
  const listedPlayers = [tokenIdentityKey(reference.homeName), tokenIdentityKey(reference.awayName)].sort().join("|");
  const detailedPlayers = [tokenIdentityKey(details.home.name), tokenIdentityKey(details.away.name)].sort().join("|");
  // The official "Final" tab contains Group 1/2, semi-finals and the final,
  // so its detail-page phase label intentionally differs from the tab name.
  const groupMatches = reference.group === "Final"
    || identityKey(details.group) === identityKey(reference.group)
    || identityKey(details.group).startsWith(`${identityKey(reference.group)} `);
  if (
    details.matchId !== reference.matchId
    || listedPlayers !== detailedPlayers
    || identityKey(details.seriesName) !== identityKey(reference.seriesName)
    || identityKey(details.weekName) !== identityKey(reference.weekName)
    || !groupMatches
  ) {
    throw new ModusHistoryUnavailableError(`Official MODUS match ${reference.matchId} did not match its results-page reference.`);
  }
}

function convertMatch(historical: ModusHistoricalMatch, playerName: string): { readonly playerName: string; readonly match: Match } {
  const exact = identityKey(playerName);
  const token = tokenIdentityKey(playerName);
  const homeMatches = identityKey(historical.home.name) === exact || tokenIdentityKey(historical.home.name) === token;
  const awayMatches = identityKey(historical.away.name) === exact || tokenIdentityKey(historical.away.name) === token;
  if (homeMatches === awayMatches) {
    throw new ModusHistoryUnavailableError(`Official MODUS match ${historical.matchId} has an ambiguous player identity.`);
  }
  const player = homeMatches ? historical.home : historical.away;
  const opponent = homeMatches ? historical.away : historical.home;
  const result = player.score > opponent.score ? "Won" : player.score < opponent.score ? "Lost" : "Draw";
  return {
    playerName: player.name,
    match: MatchSchema.parse({
      date: historical.date,
      tournament: `MODUS Super Series – ${historical.seriesName} – ${historical.weekName}`,
      round: historical.group,
      result,
      opponent: opponent.name,
      score: `${player.score} V ${opponent.score}`,
      average: player.average,
    }),
  };
}

export function identityKey(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\([A-Z]{2,3}\)/gu, " ")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function tokenIdentityKey(value: string): string {
  return identityKey(value).split(" ").filter((token) => token !== "").sort().join(" ");
}

function buildCurrentSeriesPlayerKeys(index: ModusResultsIndex): ReadonlySet<string> {
  const currentSeries = index.series.reduce<ModusResultsIndex["series"][number] | undefined>((latest, series) => {
    return latest === undefined || series.order > latest.order ? series : latest;
  }, undefined);
  if (currentSeries === undefined) throw new Error("The bundled official MODUS index contains no series.");
  const keys = new Set<string>();
  for (const match of index.matches) {
    if (match.seriesId !== currentSeries.id) continue;
    for (const name of [match.homeName, match.awayName]) {
      keys.add(`exact:${identityKey(name)}`);
      keys.add(`tokens:${tokenIdentityKey(name)}`);
    }
  }
  if (keys.size === 0) throw new Error("The bundled official MODUS current series contains no players.");
  return keys;
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

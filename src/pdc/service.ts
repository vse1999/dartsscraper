import { IsoDateSchema } from "../agent/date.js";
import type { CacheStore } from "../cache.js";
import { isReportDeadlineExceeded, raceWithReportDeadline } from "../daily/report-budget.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import { throwIfAborted } from "../services/cancellation.js";
import type { Match } from "../schemas/match.js";
import {
  PDC_CALENDAR_CATEGORIES,
  PdcFixtureSchema,
  PdcTournamentEventSchema,
  PdcTournamentResultSchema,
  type PdcCalendarCategory,
  type PdcFixture,
  type PdcFixtureSource,
  type PdcTournamentEvent,
  type PdcTournamentResult,
  type PdcTournamentSource,
} from "./schemas.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_FIXTURE_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_PLAYER_MATCH_COUNT = 10;
const DEFAULT_PLAYER_CONCURRENCY = 4;

export interface PdcPlayerStats {
  readonly playerName: string;
  readonly requestedCount: number;
  readonly matches: readonly Match[];
  readonly meanAverage: number | null;
  readonly availableAverageCount: number;
  readonly sourceUrl: string;
  readonly sourceLabel: string;
  readonly provider: "dartsorakel" | "modus-official";
  readonly evidenceUrls: readonly string[];
}

export interface PdcPlayerStatsReader {
  getPlayerStats(playerName: string, matchCount: number, source?: "auto" | "dartsorakel" | "modus", signal?: AbortSignal): Promise<PdcPlayerStats>;
}

export interface PdcPlayerResearch {
  readonly requestedName: string;
  readonly stats: PdcPlayerStats | null;
  readonly failureCode: "unavailable" | "timeout" | "unstarted" | null;
}

export interface PdcUpcomingReport {
  readonly date: string;
  readonly fixtures: readonly PdcFixture[];
  readonly players: readonly PdcPlayerResearch[];
}

export interface PdcTournamentServiceOptions {
  readonly source: PdcTournamentSource;
  readonly cache?: CacheStore;
  readonly cacheTtlMs?: number;
  readonly fixtureCacheTtlMs?: number;
  readonly categories?: readonly PdcCalendarCategory[];
  readonly fixtureSource?: PdcFixtureSource;
  readonly playerStats?: PdcPlayerStatsReader;
  readonly playerMatchCount?: number;
  readonly playerConcurrency?: number;
  readonly logger?: Logger;
}

export class PdcTournamentService {
  private readonly source: PdcTournamentSource;
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlMs: number;
  private readonly fixtureCacheTtlMs: number;
  private readonly categories: readonly PdcCalendarCategory[];
  private readonly fixtureSource: PdcFixtureSource | undefined;
  private readonly playerStats: PdcPlayerStatsReader | undefined;
  private readonly playerMatchCount: number;
  private readonly playerConcurrency: number;
  private readonly logger: Logger;
  private readonly calendarPromises = new Map<number, Promise<readonly PdcTournamentEvent[]>>();
  private readonly fixturePromises = new Map<string, Promise<readonly PdcFixture[]>>();

  public constructor(options: PdcTournamentServiceOptions) {
    this.source = options.source;
    this.cache = options.cache;
    this.cacheTtlMs = positiveFinite(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
    this.fixtureCacheTtlMs = positiveFinite(options.fixtureCacheTtlMs ?? DEFAULT_FIXTURE_CACHE_TTL_MS, "fixtureCacheTtlMs");
    this.categories = deduplicateCategories(options.categories ?? PDC_CALENDAR_CATEGORIES);
    this.fixtureSource = options.fixtureSource;
    this.playerStats = options.playerStats;
    this.playerMatchCount = positiveInteger(options.playerMatchCount ?? DEFAULT_PLAYER_MATCH_COUNT, "playerMatchCount");
    this.playerConcurrency = positiveInteger(options.playerConcurrency ?? DEFAULT_PLAYER_CONCURRENCY, "playerConcurrency");
    this.logger = options.logger ?? noopLogger;
    if (this.categories.length === 0) throw new Error("At least one PDC calendar category is required.");
  }

  public async getEventsForDate(date: string, signal?: AbortSignal): Promise<readonly PdcTournamentEvent[]> {
    throwIfAborted(signal);
    const validatedDate = IsoDateSchema.parse(date);
    const events = await this.getCalendar(Number(validatedDate.slice(0, 4)), signal);
    return events.filter((event) => (
      event.winnerName !== null
      && validatedDate >= event.startDate
      && validatedDate <= event.endDate
    ));
  }

  public async getLatestEvents(date: string, signal?: AbortSignal): Promise<readonly PdcTournamentEvent[]> {
    throwIfAborted(signal);
    const validatedDate = IsoDateSchema.parse(date);
    const events = await this.getCalendar(Number(validatedDate.slice(0, 4)), signal);
    const eligible = events.filter((event) => event.winnerName !== null && event.eventDate <= validatedDate);
    const latestDate = eligible.reduce<string | undefined>((latest, event) => latest === undefined || event.eventDate > latest ? event.eventDate : latest, undefined);
    return latestDate === undefined ? [] : eligible.filter((event) => event.eventDate === latestDate);
  }

  public async getResultsForDate(date: string, signal?: AbortSignal): Promise<readonly PdcTournamentResult[]> {
    throwIfAborted(signal);
    const events = await this.getEventsForDate(date, signal);
    return this.getResults(events, signal);
  }

  public async getLatestResults(date: string, signal?: AbortSignal): Promise<readonly PdcTournamentResult[]> {
    throwIfAborted(signal);
    const events = await this.getLatestEvents(date, signal);
    return this.getResults(events, signal);
  }

  public async getUpcomingReportForDate(
    date: string,
    signal?: AbortSignal,
    onPartial?: (report: PdcUpcomingReport) => void,
  ): Promise<PdcUpcomingReport> {
    throwIfAborted(signal);
    const validatedDate = IsoDateSchema.parse(date);
    if (this.fixtureSource === undefined || this.playerStats === undefined) {
      throw new Error("Upcoming PDC research requires both a fixture source and a player statistics reader.");
    }
    const fixtures = await withOptionalDeadline(this.getFixtures(validatedDate, signal), signal);
    const names = deduplicatePlayerNames(fixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]));
    const partialPlayers: Array<PdcPlayerResearch> = names.map((requestedName) => ({
      requestedName,
      stats: null,
      failureCode: "unstarted",
    }));
    const publishPartial = (): void => {
      onPartial?.({ date: validatedDate, fixtures, players: partialPlayers.map((player) => ({ ...player })) });
    };
    publishPartial();
    const players = await mapWithConcurrency(names, this.playerConcurrency, async (requestedName): Promise<PdcPlayerResearch> => {
      try {
        const operation = this.playerStats?.getPlayerStats(requestedName, this.playerMatchCount, "dartsorakel", signal);
        const stats = await withOptionalDeadline(operation ?? Promise.reject(new Error("Player statistics reader was unavailable.")), signal);
        if (stats === undefined) throw new Error("Player statistics reader was unavailable.");
        return { requestedName, stats, failureCode: null };
      } catch (error: unknown) {
        this.logger.warn("Upcoming PDC player research failed.", {
          date: validatedDate,
          player: requestedName,
          source: this.fixtureSource?.name,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return {
          requestedName,
          stats: null,
          failureCode: isReportDeadlineExceeded(error) ? "timeout" : "unavailable",
        };
      }
    }, signal, (requestedName: string): PdcPlayerResearch => ({
      requestedName,
      stats: null,
      failureCode: "unstarted",
    }), (index: number, player: PdcPlayerResearch): void => {
      partialPlayers[index] = player;
      publishPartial();
    }, (index: number, requestedName: string): void => {
      partialPlayers[index] = { requestedName, stats: null, failureCode: "timeout" };
      publishPartial();
    });
    this.logger.info("Upcoming PDC research completed.", {
      date: validatedDate,
      fixtureSource: this.fixtureSource.name,
      fixtures: fixtures.length,
      players: players.length,
      successfulPlayers: players.filter((player) => player.stats !== null).length,
      timedOutPlayers: players.filter((player) => player.failureCode === "timeout").length,
      unstartedPlayers: players.filter((player) => player.failureCode === "unstarted").length,
      requestedMatchesPerPlayer: this.playerMatchCount,
    });
    return { date: validatedDate, fixtures, players };
  }

  private async getResults(events: readonly PdcTournamentEvent[], signal?: AbortSignal): Promise<readonly PdcTournamentResult[]> {
    const results = await Promise.all(events.map((event) => signal === undefined
      ? this.source.getResults(event)
      : this.source.getResults(event, signal)));
    return results.map((result) => PdcTournamentResultSchema.parse(result));
  }

  private async getCalendar(year: number, signal?: AbortSignal): Promise<readonly PdcTournamentEvent[]> {
    const cached = PdcTournamentEventSchema.array().safeParse(await withOptionalDeadline(this.cache?.get(`pdc-calendar-v1-${year}`) ?? Promise.resolve(undefined), signal));
    if (cached.success) return cached.data;
    // A caller-owned signal must never reuse or poison an unscoped shared
    // promise: its cancellation is specific to that report invocation.
    const existing = signal === undefined ? this.calendarPromises.get(year) : undefined;
    if (existing !== undefined) return existing;

    const request = Promise.all(this.categories.map((category) => signal === undefined
      ? this.source.getCalendar(year, category)
      : this.source.getCalendar(year, category, signal)))
      .then((categoryEvents) => {
        const byEventKey = new Map<number, PdcTournamentEvent>();
        for (const events of categoryEvents) for (const event of events) byEventKey.set(event.eventKey, PdcTournamentEventSchema.parse(event));
        const merged = [...byEventKey.values()].sort((left, right) => left.eventDate.localeCompare(right.eventDate) || left.eventKey - right.eventKey);
        this.logger.debug("PDC calendar categories merged.", { year, categories: this.categories, events: merged.length });
        return this.cache?.set(`pdc-calendar-v1-${year}`, merged, this.cacheTtlMs).then(() => merged) ?? merged;
      })
        .finally(() => {
          if (signal === undefined) this.calendarPromises.delete(year);
        });
    if (signal === undefined) this.calendarPromises.set(year, request);
    return request;
  }

  private async getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    const cacheKey = `pdc-fixtures-v4-${date}`;
    const cached = PdcFixtureSchema.array().safeParse(await withOptionalDeadline(this.cache?.get(cacheKey) ?? Promise.resolve(undefined), signal));
    if (cached.success) return cached.data;
    const existing = signal === undefined ? this.fixturePromises.get(date) : undefined;
    if (existing !== undefined) return existing;
    const source = this.fixtureSource;
    if (source === undefined) throw new Error("PDC fixture source is not configured.");
    const request = (signal === undefined ? source.getFixtures(date) : source.getFixtures(date, signal))
      .then((fixtures) => PdcFixtureSchema.array().parse(fixtures))
      .then((fixtures) => this.cache?.set(cacheKey, fixtures, this.fixtureCacheTtlMs).then(() => fixtures) ?? fixtures)
      .finally(() => {
        if (signal === undefined) this.fixturePromises.delete(date);
      });
    if (signal === undefined) this.fixturePromises.set(date, request);
    return request;
  }

  public clearInMemoryCache(): void {
    this.calendarPromises.clear();
    this.fixturePromises.clear();
  }
}

function deduplicateCategories(categories: readonly PdcCalendarCategory[]): readonly PdcCalendarCategory[] {
  return [...new Set(categories)];
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function deduplicatePlayerNames(names: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const name of names) {
    const key = normalizePlayerName(name);
    if (key !== "" && !unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()];
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput) => Promise<TOutput>,
  signal: AbortSignal | undefined,
  skipped: (value: TInput) => TOutput,
  onResult?: (index: number, result: TOutput) => void,
  onStart?: (index: number, value: TInput) => void,
): Promise<readonly TOutput[]> {
  const results: Array<TOutput | undefined> = new Array<TOutput | undefined>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      if (signal?.aborted === true) {
        results[index] = skipped(value);
        onResult?.(index, results[index]);
        continue;
      }
      onStart?.(index, value);
      try {
        // The mapper owns the dependency deadline so it can classify a running
        // player as timed out before the worker sees the shared abort signal.
        results[index] = await mapper(value);
        onResult?.(index, results[index]);
      } catch (error: unknown) {
        if (!isReportDeadlineExceeded(error)) throw error;
        results[index] = skipped(value);
        onResult?.(index, results[index]);
      }
    }
  });
  await Promise.all(workers);
  return results.map((result, index) => result ?? skipped(values[index] as TInput));
}

async function withOptionalDeadline<T>(operation: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  return signal === undefined ? operation : raceWithReportDeadline(operation, signal, "research");
}

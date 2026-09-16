import { IsoDateSchema } from "../agent/date.js";
import type { CacheStore } from "../cache.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
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
  getPlayerStats(playerName: string, matchCount: number, source?: "auto" | "dartsorakel" | "modus"): Promise<PdcPlayerStats>;
}

export interface PdcPlayerResearch {
  readonly requestedName: string;
  readonly stats: PdcPlayerStats | null;
  readonly failureCode: "unavailable" | null;
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

  public async getEventsForDate(date: string): Promise<readonly PdcTournamentEvent[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const events = await this.getCalendar(Number(validatedDate.slice(0, 4)));
    return events.filter((event) => (
      event.winnerName !== null
      && validatedDate >= event.startDate
      && validatedDate <= event.endDate
    ));
  }

  public async getLatestEvents(date: string): Promise<readonly PdcTournamentEvent[]> {
    const validatedDate = IsoDateSchema.parse(date);
    const events = await this.getCalendar(Number(validatedDate.slice(0, 4)));
    const eligible = events.filter((event) => event.winnerName !== null && event.eventDate <= validatedDate);
    const latestDate = eligible.reduce<string | undefined>((latest, event) => latest === undefined || event.eventDate > latest ? event.eventDate : latest, undefined);
    return latestDate === undefined ? [] : eligible.filter((event) => event.eventDate === latestDate);
  }

  public async getResultsForDate(date: string): Promise<readonly PdcTournamentResult[]> {
    const events = await this.getEventsForDate(date);
    return this.getResults(events);
  }

  public async getLatestResults(date: string): Promise<readonly PdcTournamentResult[]> {
    const events = await this.getLatestEvents(date);
    return this.getResults(events);
  }

  public async getUpcomingReportForDate(date: string): Promise<PdcUpcomingReport> {
    const validatedDate = IsoDateSchema.parse(date);
    if (this.fixtureSource === undefined || this.playerStats === undefined) {
      throw new Error("Upcoming PDC research requires both a fixture source and a player statistics reader.");
    }
    const fixtures = await this.getFixtures(validatedDate);
    const names = deduplicatePlayerNames(fixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]));
    const players = await mapWithConcurrency(names, this.playerConcurrency, async (requestedName): Promise<PdcPlayerResearch> => {
      try {
        const stats = await this.playerStats?.getPlayerStats(requestedName, this.playerMatchCount, "dartsorakel");
        if (stats === undefined) throw new Error("Player statistics reader was unavailable.");
        return { requestedName, stats, failureCode: null };
      } catch (error: unknown) {
        this.logger.warn("Upcoming PDC player research failed.", {
          date: validatedDate,
          player: requestedName,
          source: this.fixtureSource?.name,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return { requestedName, stats: null, failureCode: "unavailable" };
      }
    });
    this.logger.info("Upcoming PDC research completed.", {
      date: validatedDate,
      fixtureSource: this.fixtureSource.name,
      fixtures: fixtures.length,
      players: players.length,
      successfulPlayers: players.filter((player) => player.stats !== null).length,
      requestedMatchesPerPlayer: this.playerMatchCount,
    });
    return { date: validatedDate, fixtures, players };
  }

  private async getResults(events: readonly PdcTournamentEvent[]): Promise<readonly PdcTournamentResult[]> {
    const results = await Promise.all(events.map((event) => this.source.getResults(event)));
    return results.map((result) => PdcTournamentResultSchema.parse(result));
  }

  private async getCalendar(year: number): Promise<readonly PdcTournamentEvent[]> {
    const cached = PdcTournamentEventSchema.array().safeParse(await this.cache?.get(`pdc-calendar-v1-${year}`));
    if (cached.success) return cached.data;
    const existing = this.calendarPromises.get(year);
    if (existing !== undefined) return existing;

    const request = Promise.all(this.categories.map((category) => this.source.getCalendar(year, category)))
      .then((categoryEvents) => {
        const byEventKey = new Map<number, PdcTournamentEvent>();
        for (const events of categoryEvents) for (const event of events) byEventKey.set(event.eventKey, PdcTournamentEventSchema.parse(event));
        const merged = [...byEventKey.values()].sort((left, right) => left.eventDate.localeCompare(right.eventDate) || left.eventKey - right.eventKey);
        this.logger.debug("PDC calendar categories merged.", { year, categories: this.categories, events: merged.length });
        return this.cache?.set(`pdc-calendar-v1-${year}`, merged, this.cacheTtlMs).then(() => merged) ?? merged;
      })
      .finally(() => { this.calendarPromises.delete(year); });
    this.calendarPromises.set(year, request);
    return request;
  }

  private async getFixtures(date: string): Promise<readonly PdcFixture[]> {
    const cacheKey = `pdc-fixtures-v1-${date}`;
    const cached = PdcFixtureSchema.array().safeParse(await this.cache?.get(cacheKey));
    if (cached.success) return cached.data;
    const existing = this.fixturePromises.get(date);
    if (existing !== undefined) return existing;
    const source = this.fixtureSource;
    if (source === undefined) throw new Error("PDC fixture source is not configured.");
    const request = source.getFixtures(date)
      .then((fixtures) => PdcFixtureSchema.array().parse(fixtures))
      .then((fixtures) => this.cache?.set(cacheKey, fixtures, this.fixtureCacheTtlMs).then(() => fixtures) ?? fixtures)
      .finally(() => { this.fixturePromises.delete(date); });
    this.fixturePromises.set(date, request);
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
): Promise<readonly TOutput[]> {
  const results = new Array<TOutput>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}

import { IsoDateSchema } from "../agent/date.js";
import type { CacheStore } from "../cache.js";
import { noopLogger, type Logger } from "../logger.js";
import {
  PDC_CALENDAR_CATEGORIES,
  PdcTournamentEventSchema,
  PdcTournamentResultSchema,
  type PdcCalendarCategory,
  type PdcTournamentEvent,
  type PdcTournamentResult,
  type PdcTournamentSource,
} from "./schemas.js";

const DEFAULT_CACHE_TTL_MS = 30_000;

export interface PdcTournamentServiceOptions {
  readonly source: PdcTournamentSource;
  readonly cache?: CacheStore;
  readonly cacheTtlMs?: number;
  readonly categories?: readonly PdcCalendarCategory[];
  readonly logger?: Logger;
}

export class PdcTournamentService {
  private readonly source: PdcTournamentSource;
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlMs: number;
  private readonly categories: readonly PdcCalendarCategory[];
  private readonly logger: Logger;
  private readonly calendarPromises = new Map<number, Promise<readonly PdcTournamentEvent[]>>();

  public constructor(options: PdcTournamentServiceOptions) {
    this.source = options.source;
    this.cache = options.cache;
    this.cacheTtlMs = positiveFinite(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
    this.categories = deduplicateCategories(options.categories ?? PDC_CALENDAR_CATEGORIES);
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

  public clearInMemoryCache(): void {
    this.calendarPromises.clear();
  }
}

function deduplicateCategories(categories: readonly PdcCalendarCategory[]): readonly PdcCalendarCategory[] {
  return [...new Set(categories)];
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

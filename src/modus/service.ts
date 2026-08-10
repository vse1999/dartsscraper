import type { CacheStore } from "../cache.js";
import { ModusSourceUnavailableError } from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import { IsoDateSchema } from "../agent/date.js";
import { ModusPlayersResultSchema, type ModusFixtureSource, type ModusPlayersResult } from "./schemas.js";

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CURRENT_DATE_CACHE_TTL_MS = 30_000;
export interface ModusPlayersServiceOptions {
  sources: readonly ModusFixtureSource[];
  cache?: CacheStore;
  cacheTtlMs?: number;
  currentDateCacheTtlMs?: number;
  now?: () => Date;
  timeZone?: string;
  logger?: Logger;
}
export class ModusPlayersService {
  private readonly sources: readonly ModusFixtureSource[];
  private readonly cache: CacheStore | undefined;
  private readonly cacheTtlMs: number;
  private readonly currentDateCacheTtlMs: number;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly logger: Logger;
  public constructor(options: ModusPlayersServiceOptions) {
    if (options.sources.length === 0) throw new Error("At least one MODUS fixture source is required.");
    this.sources = options.sources;
    this.cache = options.cache;
    this.cacheTtlMs = positiveFinite(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
    this.currentDateCacheTtlMs = positiveFinite(options.currentDateCacheTtlMs ?? DEFAULT_CURRENT_DATE_CACHE_TTL_MS, "currentDateCacheTtlMs");
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Europe/Budapest";
    this.logger = options.logger ?? noopLogger;
  }
  public async getModusPlayers(date: string): Promise<ModusPlayersResult> {
    const validatedDate = IsoDateSchema.parse(date);
    const cacheKey = `modus-players-v2-${validatedDate}`;
    const cachedResult = ModusPlayersResultSchema.safeParse(await this.cache?.get(cacheKey));
    if (cachedResult.success) return cachedResult.data;
    const failures: string[] = [];
    for (const source of this.sources) {
      try {
        const names = deduplicate(await source.getPlayers(validatedDate));
        if (names.length === 0) { failures.push(`${source.name}: no fixtures for that date.`); continue; }
        const result = ModusPlayersResultSchema.parse({
          event: "MODUS Super Series", date: validatedDate,
          players: names.map((name) => ({ name, source: source.sourceUrl(validatedDate), confidence: 1 })),
        });
        const cacheTtlMs = validatedDate === localIsoDate(this.now(), this.timeZone) ? this.currentDateCacheTtlMs : this.cacheTtlMs;
        await this.cache?.set(cacheKey, result, cacheTtlMs);
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "unknown error";
        failures.push(`${source.name}: ${message}`);
        this.logger.warn("MODUS fixture source failed.", { source: source.name, date: validatedDate, error: message });
      }
    }
    throw new ModusSourceUnavailableError(validatedDate, failures);
  }
}
function localIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return IsoDateSchema.parse(`${read("year")}-${read("month")}-${read("day")}`);
}
function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}
function deduplicate(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const normalized = normalizePlayerName(name);
    if (normalized === "" || seen.has(normalized)) return false;
    seen.add(normalized); return true;
  });
}

import { InsufficientMatchDataError } from "../errors.js";
import { IsoDateSchema } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import type { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import type { PlayerResolver } from "../player/resolver.js";
import { MatchResultSchema, type MatchResult } from "../schemas/match.js";
import { SnapshotStore, type SnapshotRead } from "./snapshot-store.js";

const DEFAULT_FRESH_TTL_MS = 15_000;
const DEFAULT_MAX_STALE_MS = 5 * 60_000;
const DEFAULT_MAX_STORE_ENTRIES = 500;

export interface PlayerMatchesServiceDependencies {
  resolver: Pick<PlayerResolver, "resolvePlayer">;
  scraper: Pick<DartsOrakelScraper, "getPlayerMatches">;
  freshTtlMs?: number;
  maxStaleMs?: number;
  logger?: Logger;
  now?: () => Date;
  timeZone?: string;
  maxStoreEntries?: number;
}

export class PlayerMatchesService {
  private readonly resolver: PlayerMatchesServiceDependencies["resolver"];
  private readonly scraper: PlayerMatchesServiceDependencies["scraper"];
  private readonly freshTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly maxStoreEntries: number;
  private readonly stores = new Map<string, SnapshotStore<MatchResult>>();

  public constructor(dependencies: PlayerMatchesServiceDependencies) {
    this.resolver = dependencies.resolver;
    this.scraper = dependencies.scraper;
    this.freshTtlMs = positiveFinite(dependencies.freshTtlMs ?? DEFAULT_FRESH_TTL_MS, "freshTtlMs");
    this.maxStaleMs = positiveFinite(dependencies.maxStaleMs ?? DEFAULT_MAX_STALE_MS, "maxStaleMs");
    this.logger = dependencies.logger ?? noopLogger;
    this.now = dependencies.now ?? (() => new Date());
    this.timeZone = dependencies.timeZone ?? "Europe/Budapest";
    this.maxStoreEntries = positiveInteger(dependencies.maxStoreEntries ?? DEFAULT_MAX_STORE_ENTRIES, "maxStoreEntries");
  }

  public async getLastMatches(playerName: string, limit: number): Promise<MatchResult> {
    return (await this.getLastMatchesSnapshot(playerName, limit)).value;
  }

  public async getLastMatchesSnapshot(playerName: string, limit: number, signal?: AbortSignal): Promise<SnapshotRead<MatchResult>> {
    validateLimit(limit);
    const dateTo = addDays(localIsoDate(this.now(), this.timeZone), 1);
    const key = `${normalizePlayerName(playerName)}:${limit}:${dateTo}`;
    let store = this.stores.get(key);
    if (store === undefined) {
      store = new SnapshotStore<MatchResult>({
        loader: async () => this.loadMatches(playerName, limit, dateTo),
        freshTtlMs: this.freshTtlMs,
        maxStaleMs: this.maxStaleMs,
        onBackgroundError: (error: unknown) => this.logger.warn("DartsOrakel background refresh failed; keeping recent player data.", {
          player: playerName,
          limit,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      });
      this.stores.set(key, store);
      this.evictOldStores();
    } else {
      this.stores.delete(key);
      this.stores.set(key, store);
    }
    return store.get(signal);
  }

  private async loadMatches(playerName: string, limit: number, dateTo: string): Promise<MatchResult> {
    const player = await this.resolver.resolvePlayer(playerName);
    const matches = await this.scraper.getPlayerMatches(player, limit, dateTo);
    if (matches.length === 0) {
      throw new InsufficientMatchDataError(limit, 0);
    }

    const result = {
      player,
      matches: matches.slice(0, limit),
    };
    const parsed = MatchResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error("Internal match result validation failed.");
    }
    return parsed.data;
  }

  private evictOldStores(): void {
    while (this.stores.size > this.maxStoreEntries) {
      const oldestKey = this.stores.keys().next().value;
      if (typeof oldestKey !== "string") return;
      this.stores.delete(oldestKey);
    }
  }
}

export function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("limit must be a positive integer no greater than 1000.");
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("The configured player-cache clock returned an invalid date.");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return IsoDateSchema.parse(`${value("year")}-${value("month")}-${value("day")}`);
}

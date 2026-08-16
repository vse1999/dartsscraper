import { DartsOrakelRequestError, DartsOrakelStructureChangedError } from "../errors.js";
import type { CacheStore } from "../cache.js";
import { noopLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import {
  PlayerStatsResponseSchema,
  type PlayerStatsResponse,
} from "../schemas/player.js";
import {
  DartsOrakelApiPath,
  DartsOrakelMatchDefaults,
  DartsOrakelMatchQuery,
} from "./selectors.js";
import {
  DartsOrakelMatchesResponseSchema,
  type DartsOrakelMatchesResponse,
} from "./parser.js";

const DEFAULT_BASE_URL = "https://dartsorakel.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 300;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;
const DEFAULT_PLAYER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MATCH_CACHE_TTL_MS = 10_000;
const HISTORICAL_START_DATE = "1900-01-01";

export interface DartsOrakelClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  minRequestIntervalMs?: number;
  userAgent?: string;
  cache?: CacheStore;
  playerCacheTtlMs?: number;
  matchCacheTtlMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface DartsOrakelMatchRequestOptions {
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export class DartsOrakelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly userAgent: string;
  private readonly cache: CacheStore | undefined;
  private readonly playerCacheTtlMs: number;
  private readonly matchCacheTtlMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  public constructor(options: DartsOrakelClientOptions = {}) {
    this.baseUrl = this.normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = this.positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxRetries = this.nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, "maxRetries");
    this.backoffMs = this.nonNegativeInteger(options.backoffMs ?? DEFAULT_BACKOFF_MS, "backoffMs");
    this.minRequestIntervalMs = this.nonNegativeInteger(
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
      "minRequestIntervalMs",
    );
    this.userAgent = options.userAgent ?? "DartsOrakelPlayerScraper/0.1 (+https://dartsorakel.com)";
    this.cache = options.cache;
    this.playerCacheTtlMs = this.positiveInteger(
      options.playerCacheTtlMs ?? DEFAULT_PLAYER_CACHE_TTL_MS,
      "playerCacheTtlMs",
    );
    this.matchCacheTtlMs = this.positiveInteger(
      options.matchCacheTtlMs ?? DEFAULT_MATCH_CACHE_TTL_MS,
      "matchCacheTtlMs",
    );
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  public async getPlayerStats(): Promise<PlayerStatsResponse> {
    const url = this.urlFor(DartsOrakelApiPath.playerStats);
    return this.getJson(
      url,
      "player-stats",
      PlayerStatsResponseSchema,
      this.playerCacheTtlMs,
    );
  }

  public async getPlayerMatches(playerId: number, options: DartsOrakelMatchRequestOptions = {}): Promise<DartsOrakelMatchesResponse> {
    if (!Number.isInteger(playerId) || playerId <= 0) {
      throw new Error("playerId must be a positive integer.");
    }

    const dateFrom = this.isoCalendarDate(options.dateFrom ?? HISTORICAL_START_DATE, "dateFrom");
    const dateTo = this.isoCalendarDate(options.dateTo ?? this.isoDate(this.now() + 24 * 60 * 60 * 1000), "dateTo");
    const limit = options.limit === undefined ? undefined : this.positiveInteger(options.limit, "limit");
    if (limit !== undefined && limit > 1_000) throw new Error("limit must not exceed 1000.");
    if (dateFrom > dateTo) throw new Error("dateFrom must not be later than dateTo.");
    const url = this.urlFor(DartsOrakelApiPath.playerMatches(playerId), {
      [DartsOrakelMatchQuery.dateFrom]: dateFrom,
      [DartsOrakelMatchQuery.dateTo]: dateTo,
      [DartsOrakelMatchQuery.rankKey]: DartsOrakelMatchDefaults.rankKey,
      [DartsOrakelMatchQuery.organStat]: DartsOrakelMatchDefaults.organStat,
      [DartsOrakelMatchQuery.tournaments]: DartsOrakelMatchDefaults.tournaments,
      ...(limit === undefined ? {} : { start: "0", length: String(limit) }),
    });
    return this.getJson(
      url,
      [
        "player-matches-v3",
        playerId,
        dateFrom,
        dateTo,
        DartsOrakelMatchDefaults.rankKey,
        DartsOrakelMatchDefaults.organStat,
        DartsOrakelMatchDefaults.tournaments || "all-tournaments",
        limit ?? "all-rows",
      ].join("-"),
      DartsOrakelMatchesResponseSchema,
      this.matchCacheTtlMs,
    );
  }

  private async getJson<T>(
    url: string,
    cacheKey: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } },
    ttlMs: number,
  ): Promise<T> {
    const cached = await this.cache?.get(cacheKey);
    if (cached !== null && cached !== undefined) {
      const cachedResult = schema.safeParse(cached);
      if (cachedResult.success) {
        this.logger.debug("Using cached DartsOrakel response.", { cacheKey });
        return cachedResult.data;
      }
      this.logger.warn("Ignoring cached response that no longer matches the schema.", { cacheKey });
    }

    const payload = await this.requestJson(url);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DartsOrakelStructureChangedError(
        `DartsOrakel response at ${url} failed schema validation${issue === undefined ? "." : ` at ${this.formatPath(issue.path)}: ${issue.message}.`}`,
      );
    }
    await this.cache?.set(cacheKey, parsed.data, ttlMs);
    return parsed.data;
  }

  private async requestJson(url: string): Promise<unknown> {
    let lastError: DartsOrakelRequestError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.rateLimitedFetch(url);
        if (response.ok) {
          try {
            const payload: unknown = await response.json();
            return payload;
          } catch (error: unknown) {
            throw new DartsOrakelStructureChangedError(
              `DartsOrakel returned invalid JSON from ${url}.`,
              error,
            );
          }
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        lastError = new DartsOrakelRequestError(
          `DartsOrakel request failed with HTTP ${response.status}.`,
          { url, status: response.status, retryable },
        );
        if (!retryable || attempt === this.maxRetries) {
          throw lastError;
        }
      } catch (error: unknown) {
        if (error instanceof DartsOrakelStructureChangedError) {
          throw error;
        }
        if (error instanceof DartsOrakelRequestError && !error.retryable) {
          throw error;
        }
        if (error instanceof DartsOrakelRequestError) {
          lastError = error;
        } else {
          lastError = new DartsOrakelRequestError(
            `DartsOrakel request failed: ${this.errorMessage(error)}.`,
            { url, retryable: true, cause: error },
          );
        }
        if (attempt === this.maxRetries) {
          throw lastError;
        }
      }

      const delay = this.backoffMs * (attempt + 1);
      this.logger.warn("Retrying DartsOrakel request.", { url, attempt: attempt + 1, delay });
      await this.sleep(delay);
    }

    throw lastError ?? new DartsOrakelRequestError("DartsOrakel request failed.", { url, retryable: false });
  }

  private async rateLimitedFetch(url: string): Promise<Response> {
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) {
        await this.sleep(delay);
      }
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          signal: controller.signal,
        });
      } catch (error: unknown) {
        throw new DartsOrakelRequestError(
          `DartsOrakel request failed: ${this.errorMessage(error)}.`,
          { url, retryable: true, cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      release();
    }
  }

  private urlFor(pathname: string, query?: Readonly<Record<string, string>>): string {
    const url = new URL(pathname, this.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private normalizeBaseUrl(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error("baseUrl must use HTTPS unless it points to localhost.");
    }
    return parsed.toString().replace(/\/$/, "");
  }

  private isoDate(milliseconds: number): string {
    return new Date(milliseconds).toISOString().slice(0, 10);
  }

  private isoCalendarDate(value: string, name: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`${name} must be an ISO date (YYYY-MM-DD).`);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`${name} must be a valid calendar date.`);
    }
    return value;
  }

  private positiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return value;
  }

  private nonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer.`);
    }
    return value;
  }

  private formatPath(path: readonly PropertyKey[]): string {
    return path.length === 0 ? "response" : path.map((part) => String(part)).join(".");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}

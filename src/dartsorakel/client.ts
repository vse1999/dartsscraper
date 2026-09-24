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
  DartsOrakelMatchRankKey,
  type DartsOrakelMatchStatistic,
} from "./selectors.js";
import {
  DartsOrakelMatchesResponseSchema,
  type DartsOrakelMatchesResponse,
} from "./parser.js";
import { abortError, throwIfAborted, waitWithSignal } from "../services/cancellation.js";

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
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface DartsOrakelMatchRequestOptions {
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  statistic?: DartsOrakelMatchStatistic;
}

interface ActiveFetchAttempt {
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
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
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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
    this.sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal === undefined ? new Error("Operation was cancelled.") : abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    }));
    this.now = options.now ?? Date.now;
  }

  public async getPlayerStats(signal?: AbortSignal): Promise<PlayerStatsResponse> {
    const url = this.urlFor(DartsOrakelApiPath.playerStats);
    return this.getJson(
      url,
      "player-stats",
      PlayerStatsResponseSchema,
      this.playerCacheTtlMs,
      signal,
    );
  }

  public async getPlayerMatches(
    playerId: number,
    options: DartsOrakelMatchRequestOptions = {},
    signal?: AbortSignal,
  ): Promise<DartsOrakelMatchesResponse> {
    throwIfAborted(signal);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      throw new Error("playerId must be a positive integer.");
    }

    const dateFrom = this.isoCalendarDate(options.dateFrom ?? HISTORICAL_START_DATE, "dateFrom");
    const dateTo = this.isoCalendarDate(options.dateTo ?? this.isoDate(this.now() + 24 * 60 * 60 * 1000), "dateTo");
    const limit = options.limit === undefined ? undefined : this.positiveInteger(options.limit, "limit");
    const statistic = options.statistic ?? "average";
    const rankKey = DartsOrakelMatchRankKey[statistic];
    if (rankKey === undefined) {
      throw new Error(`Unsupported DartsOrakel match statistic ${JSON.stringify(statistic)}.`);
    }
    if (limit !== undefined && limit > 1_000) throw new Error("limit must not exceed 1000.");
    if (dateFrom > dateTo) throw new Error("dateFrom must not be later than dateTo.");
    const url = this.urlFor(DartsOrakelApiPath.playerMatches(playerId), {
      [DartsOrakelMatchQuery.dateFrom]: dateFrom,
      [DartsOrakelMatchQuery.dateTo]: dateTo,
      [DartsOrakelMatchQuery.rankKey]: rankKey,
      [DartsOrakelMatchQuery.organStat]: DartsOrakelMatchDefaults.organStat,
      [DartsOrakelMatchQuery.tournaments]: DartsOrakelMatchDefaults.tournaments,
      ...(limit === undefined ? {} : { start: "0", length: String(limit) }),
    });
    return this.getJson(
      url,
      [
        "player-matches-v4",
        playerId,
        dateFrom,
        dateTo,
        rankKey,
        DartsOrakelMatchDefaults.organStat,
        DartsOrakelMatchDefaults.tournaments || "all-tournaments",
        limit ?? "all-rows",
      ].join("-"),
      DartsOrakelMatchesResponseSchema,
      this.matchCacheTtlMs,
      signal,
    );
  }

  private async getJson<T>(
    url: string,
    cacheKey: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } },
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const cached = await waitWithSignal(this.cache?.get(cacheKey) ?? Promise.resolve(null), signal);
    if (cached !== null && cached !== undefined) {
      const cachedResult = schema.safeParse(cached);
      if (cachedResult.success) {
        this.logger.debug("Using cached DartsOrakel response.", { cacheKey });
        throwIfAborted(signal);
        return cachedResult.data;
      }
      this.logger.warn("Ignoring cached response that no longer matches the schema.", { cacheKey });
    }

    const payload = await this.requestJson(url, signal);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DartsOrakelStructureChangedError(
        `DartsOrakel response at ${url} failed schema validation${issue === undefined ? "." : ` at ${this.formatPath(issue.path)}: ${issue.message}.`}`,
      );
    }
    throwIfAborted(signal);
    await waitWithSignal(this.cache?.set(cacheKey, parsed.data, ttlMs) ?? Promise.resolve(), signal);
    throwIfAborted(signal);
    return parsed.data;
  }

  private async requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
    let lastError: DartsOrakelRequestError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let retryAfterMs: number | undefined;
      let activeAttempt: ActiveFetchAttempt | undefined;
      try {
        throwIfAborted(signal);
        activeAttempt = await this.rateLimitedFetch(url, signal);
        const response = activeAttempt.response;
        if (response.ok) {
          try {
            // Keep the attempt timeout and external abort linked through body
            // parsing. Some fetch implementations resolve headers before a
            // large body has finished arriving.
            const payload: unknown = await waitWithSignal(
              Promise.resolve().then(() => response.json()),
              activeAttempt.signal,
            );
            if (activeAttempt.timedOut()) {
              throw new DartsOrakelRequestError(
                `DartsOrakel response body timed out after ${this.timeoutMs} ms.`,
                { url, retryable: true },
              );
            }
            return payload;
          } catch (error: unknown) {
            if (signal?.aborted === true) {
              cancelResponseBody(response);
              throw abortError(signal);
            }
            if (activeAttempt.timedOut()) {
              cancelResponseBody(response);
              throw new DartsOrakelRequestError(
                `DartsOrakel response body timed out after ${this.timeoutMs} ms.`,
                { url, retryable: true, cause: error },
              );
            }
            throw new DartsOrakelStructureChangedError(
              `DartsOrakel returned invalid JSON from ${url}.`,
              error,
            );
          }
        }

        // Release a failed response body before retrying. Leaving an
        // unconsumed stream open can prevent the underlying HTTP client from
        // reusing the connection and gradually exhaust its socket pool.
        cancelResponseBody(response);
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        retryAfterMs = retryable ? this.retryAfterMilliseconds(response.headers.get("retry-after")) : undefined;
        lastError = new DartsOrakelRequestError(
          `DartsOrakel request failed with HTTP ${response.status}.`,
          { url, status: response.status, retryable },
        );
        if (!retryable || attempt === this.maxRetries) {
          throw lastError;
        }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw abortError(signal);
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
      } finally {
        activeAttempt?.cleanup();
      }

      const delay = Math.max(this.backoffMs * (attempt + 1), retryAfterMs ?? 0);
      this.logger.warn("Retrying DartsOrakel request.", {
        url,
        attempt: attempt + 1,
        delay,
        ...(lastError?.status === undefined ? {} : { status: lastError.status }),
      });
      await waitWithSignal(this.sleepFor(delay, signal), signal);
    }

    throw lastError ?? new DartsOrakelRequestError("DartsOrakel request failed.", { url, retryable: false });
  }

  private async rateLimitedFetch(url: string, signal?: AbortSignal): Promise<ActiveFetchAttempt> {
    throwIfAborted(signal);
    const previous = this.requestQueue;
    let release: () => void = () => undefined;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let previousSettled = false;
    let releasePending = false;
    let released = false;
    const releaseSlot = (): void => {
      if (released) return;
      released = true;
      release();
    };
    void previous.then(
      (): void => {
        previousSettled = true;
        if (releasePending) releaseSlot();
      },
      (): void => {
        previousSettled = true;
        if (releasePending) releaseSlot();
      },
    );
    try {
      await waitWithSignal(previous, signal);
      throwIfAborted(signal);
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) {
        await waitWithSignal(this.sleepFor(delay, signal), signal);
      }
      throwIfAborted(signal);
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
    } finally {
      releasePending = true;
      if (previousSettled) releaseSlot();
    }

    // Only request starts need serialization. Keeping the queue locked for the
    // full network round-trip made independent player lookups run sequentially.
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    try {
      throwIfAborted(signal);
      const response = await waitWithSignal(
        this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          signal: controller.signal,
        }),
        controller.signal,
      );
      return { response, signal: controller.signal, timedOut: () => timedOut, cleanup };
    } catch (error: unknown) {
      cleanup();
      if (signal?.aborted === true) throw abortError(signal);
      if (timedOut) {
        throw new DartsOrakelRequestError(
          `DartsOrakel request timed out after ${this.timeoutMs} ms.`,
          { url, retryable: true, cause: error },
        );
      }
      throw new DartsOrakelRequestError(
        `DartsOrakel request failed: ${this.errorMessage(error)}.`,
        { url, retryable: true, cause: error },
      );
    }
  }

  private sleepFor(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    return signal === undefined ? this.sleep(milliseconds) : this.sleep(milliseconds, signal);
  }

  private retryAfterMilliseconds(value: string | null): number | undefined {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt)) return undefined;
    return Math.max(0, retryAt - this.now());
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

function cancelResponseBody(response: Response): void {
  if (response.body === null) return;
  try {
    void response.body.cancel().catch((): void => undefined);
  } catch {
    // The original HTTP or parsing error is more actionable than a cleanup
    // failure (for example, a body that is already locked or closed).
  }
}

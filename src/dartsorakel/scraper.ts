import type { DartsOrakelClient, DartsOrakelMatchRequestOptions } from "./client.js";
import {
  parseDartsOrakelMatches,
  parseDartsOrakelMatchesWithStatistics,
  type DartsOrakelMatchesResponse,
} from "./parser.js";
import type { Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { throwIfAborted } from "../services/cancellation.js";
import { DartsOrakelRequestError } from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";

const RECENT_LOOKBACK_DAYS = [90, 180, 365, 730] as const;
const MINIMUM_REQUEST_ROWS = 50;

export interface RecentPlayerMatchesOptions {
  limit: number;
  dateTo?: string;
}

export interface DartsOrakelScraperOptions {
  readonly requireStatistics?: boolean;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly enrichStatistics?: boolean;
}

export class DartsOrakelScraper {
  private readonly client: Pick<DartsOrakelClient, "getPlayerMatches">;
  private readonly now: () => Date;
  private readonly enrichStatistics: boolean;
  private readonly logger: Logger;
  private readonly requireStatistics: boolean;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerMatches">, options: DartsOrakelScraperOptions = {}) {
    this.client = client;
    this.now = options.now ?? (() => new Date());
    this.enrichStatistics = options.enrichStatistics ?? true;
    this.logger = options.logger ?? noopLogger;
    this.requireStatistics = options.requireStatistics ?? false;
  }

  public async getPlayerMatches(
    player: PlayerIdentity,
    limit?: number,
    dateTo?: string,
    signal?: AbortSignal,
  ): Promise<Match[]> {
    throwIfAborted(signal);
    if (limit === undefined) {
      const average = signal === undefined
        ? await this.client.getPlayerMatches(player.id)
        : await this.client.getPlayerMatches(player.id, {}, signal);
      throwIfAborted(signal);
      return this.enrichMatches(player, {}, average, signal);
    }
    return this.getRecentPlayerMatches(
      player,
      { limit, ...(dateTo === undefined ? {} : { dateTo }) },
      signal,
    );
  }

  public async getRecentPlayerMatches(
    player: PlayerIdentity,
    options: RecentPlayerMatchesOptions,
    signal?: AbortSignal,
  ): Promise<Match[]> {
    validateLimit(options.limit);
    throwIfAborted(signal);
    const dateTo = options.dateTo ?? addDays(this.now().toISOString().slice(0, 10), 1);
    const requestRows = Math.min(1_000, Math.max(MINIMUM_REQUEST_ROWS, options.limit * 5));
    for (const lookbackDays of RECENT_LOOKBACK_DAYS) {
      const request: DartsOrakelMatchRequestOptions = {
        dateFrom: addDays(dateTo, -lookbackDays),
        dateTo,
        limit: requestRows,
      };
      const response = signal === undefined
        ? await this.client.getPlayerMatches(player.id, request)
        : await this.client.getPlayerMatches(player.id, request, signal);
      throwIfAborted(signal);
      const matches = parseDartsOrakelMatches(player, response);
      if (matches.length >= options.limit) {
        return this.enrichMatches(player, {
          dateFrom: addDays(dateTo, -lookbackDays),
          dateTo,
          limit: requestRows,
        }, response, signal);
      }
    }
    const request: DartsOrakelMatchRequestOptions = {
      dateFrom: "1900-01-01",
      dateTo,
      limit: requestRows,
    };
    const response = signal === undefined
      ? await this.client.getPlayerMatches(player.id, request)
      : await this.client.getPlayerMatches(player.id, request, signal);
    throwIfAborted(signal);
    return this.enrichMatches(player, {
      dateFrom: "1900-01-01",
      dateTo,
      limit: requestRows,
    }, response, signal);
  }

  private async enrichMatches(
    player: PlayerIdentity,
    request: Omit<DartsOrakelMatchRequestOptions, "statistic">,
    average: DartsOrakelMatchesResponse,
    signal?: AbortSignal,
  ): Promise<Match[]> {
    throwIfAborted(signal);
    if (!this.enrichStatistics) return parseDartsOrakelMatches(player, average);
    const oneEightiesRequest: DartsOrakelMatchRequestOptions = { ...request, statistic: "oneEighties" };
    const checkoutRequest: DartsOrakelMatchRequestOptions = { ...request, statistic: "checkoutPercentage" };
    const [oneEighties, checkoutPercentage] = await Promise.all([
      this.readOptionalStatistic(player.id, oneEightiesRequest, signal),
      this.readOptionalStatistic(player.id, checkoutRequest, signal),
    ]);
    throwIfAborted(signal);
    return parseDartsOrakelMatchesWithStatistics(player, { average, oneEighties, checkoutPercentage });
  }

  private async readOptionalStatistic(playerId: number, request: DartsOrakelMatchRequestOptions, signal?: AbortSignal): Promise<DartsOrakelMatchesResponse> {
    try {
      return signal === undefined ? await this.client.getPlayerMatches(playerId, request) : await this.client.getPlayerMatches(playerId, request, signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      // A transport failure of an optional metric cannot erase valid average
      // rows. Invalid schema/correlation evidence still fails closed.
      if (this.requireStatistics || !(error instanceof DartsOrakelRequestError)) throw error;
      this.logger.warn("Optional DartsOrakel statistic unavailable; retaining valid history.", { statistic: request.statistic, status: error.status ?? null });
      return { draw: 0, recordsTotal: 0, recordsFiltered: 0, data: [] };
    }
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("limit must be a positive integer no greater than 1000.");
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date ${JSON.stringify(isoDate)}.`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

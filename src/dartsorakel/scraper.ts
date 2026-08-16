import type { DartsOrakelClient } from "./client.js";
import { parseDartsOrakelMatches } from "./parser.js";
import type { Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";

const RECENT_LOOKBACK_DAYS = [90, 180, 365, 730] as const;
const MINIMUM_REQUEST_ROWS = 50;

export interface RecentPlayerMatchesOptions {
  limit: number;
  dateTo?: string;
}

export class DartsOrakelScraper {
  private readonly client: Pick<DartsOrakelClient, "getPlayerMatches">;
  private readonly now: () => Date;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerMatches">, options: { now?: () => Date } = {}) {
    this.client = client;
    this.now = options.now ?? (() => new Date());
  }

  public async getPlayerMatches(player: PlayerIdentity, limit?: number, dateTo?: string): Promise<Match[]> {
    if (limit === undefined) {
      const response = await this.client.getPlayerMatches(player.id);
      return parseDartsOrakelMatches(player, response);
    }
    return this.getRecentPlayerMatches(player, { limit, ...(dateTo === undefined ? {} : { dateTo }) });
  }

  public async getRecentPlayerMatches(player: PlayerIdentity, options: RecentPlayerMatchesOptions): Promise<Match[]> {
    validateLimit(options.limit);
    const dateTo = options.dateTo ?? addDays(this.now().toISOString().slice(0, 10), 1);
    const requestRows = Math.min(1_000, Math.max(MINIMUM_REQUEST_ROWS, options.limit * 5));
    for (const lookbackDays of RECENT_LOOKBACK_DAYS) {
      const response = await this.client.getPlayerMatches(player.id, {
        dateFrom: addDays(dateTo, -lookbackDays),
        dateTo,
        limit: requestRows,
      });
      const matches = parseDartsOrakelMatches(player, response);
      if (matches.length >= options.limit) return matches;
    }
    const response = await this.client.getPlayerMatches(player.id, {
      dateFrom: "1900-01-01",
      dateTo,
      limit: requestRows,
    });
    return parseDartsOrakelMatches(player, response);
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

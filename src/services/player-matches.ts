import { InsufficientMatchDataError } from "../errors.js";
import type { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import type { PlayerResolver } from "../player/resolver.js";
import { MatchResultSchema, type MatchResult } from "../schemas/match.js";

export interface PlayerMatchesServiceDependencies {
  resolver: Pick<PlayerResolver, "resolvePlayer">;
  scraper: Pick<DartsOrakelScraper, "getPlayerMatches">;
}

export class PlayerMatchesService {
  private readonly resolver: PlayerMatchesServiceDependencies["resolver"];
  private readonly scraper: PlayerMatchesServiceDependencies["scraper"];

  public constructor(dependencies: PlayerMatchesServiceDependencies) {
    this.resolver = dependencies.resolver;
    this.scraper = dependencies.scraper;
  }

  public async getLastMatches(playerName: string, limit: number): Promise<MatchResult> {
    validateLimit(limit);
    const player = await this.resolver.resolvePlayer(playerName);
    const matches = await this.scraper.getPlayerMatches(player);
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
}

export function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("limit must be a positive integer no greater than 1000.");
  }
}

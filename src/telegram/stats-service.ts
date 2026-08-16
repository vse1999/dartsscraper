import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import { ConsoleLogger, type Logger } from "../logger.js";
import { PlayerResolver } from "../player/resolver.js";
import type { Match, MatchResult } from "../schemas/match.js";
import { PlayerMatchesService } from "../services/player-matches.js";
import { calculateMatchAverage } from "../services/statistics.js";

const DARTSORAKEL_TIMEOUT_MS = 8_000;

export interface PlayerStatsResult {
  readonly playerName: string;
  readonly requestedCount: number;
  readonly matches: readonly Match[];
  readonly meanAverage: number | null;
  readonly availableAverageCount: number;
  readonly sourceUrl: string;
}

export interface PlayerStatsReader {
  getPlayerStats(playerName: string, matchCount: number): Promise<PlayerStatsResult>;
}

export interface PlayerMatchesReader {
  getLastMatches(playerName: string, limit: number): Promise<MatchResult>;
}

export class DartsPlayerStatsService implements PlayerStatsReader {
  private readonly matchesService: PlayerMatchesReader;

  public constructor(matchesService: PlayerMatchesReader) {
    this.matchesService = matchesService;
  }

  public async getPlayerStats(playerName: string, matchCount: number): Promise<PlayerStatsResult> {
    const result = await this.matchesService.getLastMatches(playerName, matchCount);
    const availableAverageCount = result.matches.reduce(
      (count: number, match: Match): number => count + (match.average === null ? 0 : 1),
      0,
    );

    return {
      playerName: result.player.name,
      requestedCount: matchCount,
      matches: result.matches,
      meanAverage: calculateMatchAverage(result.matches),
      availableAverageCount,
      sourceUrl: `https://dartsorakel.com/player/details/${result.player.id}/${encodeURIComponent(result.player.slug)}`,
    };
  }
}

export function createDefaultPlayerStatsService(logger?: Logger): PlayerStatsReader {
  const serviceLogger = logger ?? new ConsoleLogger({ minimumLevel: "warn" });
  const client = new DartsOrakelClient({
    timeoutMs: DARTSORAKEL_TIMEOUT_MS,
    maxRetries: 0,
    minRequestIntervalMs: 250,
    logger: serviceLogger,
  });
  const matchesService = new PlayerMatchesService({
    resolver: new PlayerResolver(client),
    scraper: new DartsOrakelScraper(client),
    logger: serviceLogger,
  });
  return new DartsPlayerStatsService(matchesService);
}

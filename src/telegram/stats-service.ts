import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import { createJinaReaderFetch } from "../dartsorakel/reader-fetch.js";
import { InsufficientMatchDataError } from "../errors.js";
import { ConsoleLogger, type Logger } from "../logger.js";
import bundledModusIndex from "../../data/modus-results-index.json" with { type: "json" };
import { OfficialModusHistorySource } from "../modus/history-source.js";
import {
  ModusPlayerHistoryService,
  type ModusPlayerHistoryReader,
} from "../modus/player-history-service.js";
import { PlayerResolver } from "../player/resolver.js";
import type { Match, MatchResult } from "../schemas/match.js";
import { PlayerMatchesService } from "../services/player-matches.js";
import { calculateMatchSummary } from "../services/statistics.js";
import type { PlayerStatsSource } from "./query.js";

const DARTSORAKEL_TIMEOUT_MS = 15_000;

export interface PlayerStatsResult {
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

export interface PlayerStatsReader {
  getPlayerStats(playerName: string, matchCount: number, source?: PlayerStatsSource): Promise<PlayerStatsResult>;
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
    const summary = calculateMatchSummary(result.matches);

    return {
      playerName: result.player.name,
      requestedCount: matchCount,
      matches: result.matches,
      meanAverage: summary.average,
      availableAverageCount: summary.availableAverageCount,
      sourceUrl: `https://dartsorakel.com/player/details/${result.player.id}/${encodeURIComponent(result.player.slug)}`,
      sourceLabel: "DartsOrakel",
      provider: "dartsorakel",
      evidenceUrls: [],
    };
  }
}

export class SourceRoutedPlayerStatsService implements PlayerStatsReader {
  private readonly modusHistory: ModusPlayerHistoryReader;
  private readonly dartsStats: PlayerStatsReader;

  public constructor(modusHistory: ModusPlayerHistoryReader, dartsStats: PlayerStatsReader) {
    this.modusHistory = modusHistory;
    this.dartsStats = dartsStats;
  }

  public async getPlayerStats(
    playerName: string,
    matchCount: number,
    source: PlayerStatsSource = "auto",
  ): Promise<PlayerStatsResult> {
    if (source !== "modus") {
      return this.dartsStats.getPlayerStats(playerName, matchCount, source);
    }
    const modus = await this.modusHistory.findPlayerHistory(
      playerName,
      matchCount,
      { forceLiveLookup: source === "modus" },
    );
    if (modus === null) throw new InsufficientMatchDataError(matchCount, 0);
    const summary = calculateMatchSummary(modus.matches);
    return {
      playerName: modus.playerName,
      requestedCount: matchCount,
      matches: modus.matches,
      meanAverage: summary.average,
      availableAverageCount: summary.availableAverageCount,
      sourceUrl: modus.sourceUrl,
      sourceLabel: "Official MODUS Super Series",
      provider: "modus-official",
      evidenceUrls: modus.evidenceUrls,
    };
  }
}

export function createDefaultPlayerStatsService(
  logger?: Logger,
): PlayerStatsReader {
  const serviceLogger = logger ?? new ConsoleLogger({ minimumLevel: "warn" });
  const dartsStats = createDartsPlayerStatsService(serviceLogger, true, 250, 0);
  const modusHistory = new ModusPlayerHistoryService({
    source: new OfficialModusHistorySource({ logger: serviceLogger }),
    index: bundledModusIndex,
    logger: serviceLogger,
  });
  return new SourceRoutedPlayerStatsService(modusHistory, dartsStats);
}

/**
 * Upcoming cards can contain dozens of players. Fetching three optional metric
 * views per player exceeds the public Reader transport's burst allowance, so
 * bulk research deliberately loads the canonical average/result view once per
 * player. The response still contains every latest-match row, score, opponent,
 * tournament, round, and three-dart average; optional 180/checkout fields are
 * rendered as unavailable instead of making the whole card fail.
 */
export function createDefaultBulkPlayerStatsService(
  logger?: Logger,
): PlayerStatsReader {
  const serviceLogger = logger ?? new ConsoleLogger({ minimumLevel: "warn" });
  return createDartsPlayerStatsService(serviceLogger, false, 500, 1);
}

function createDartsPlayerStatsService(
  logger: Logger,
  enrichStatistics: boolean,
  minRequestIntervalMs: number,
  maxRetries: number,
): PlayerStatsReader {
  const client = new DartsOrakelClient({
    timeoutMs: DARTSORAKEL_TIMEOUT_MS,
    maxRetries,
    minRequestIntervalMs,
    logger,
    fetchImpl: createJinaReaderFetch(),
  });
  const matchesService = new PlayerMatchesService({
    resolver: new PlayerResolver(client),
    scraper: new DartsOrakelScraper(client, { enrichStatistics }),
    logger,
  });
  return new DartsPlayerStatsService(matchesService);
}

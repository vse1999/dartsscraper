import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DartsOrakelScraper } from "../dartsorakel/scraper.js";
import { DartsOrakelRequestError, DartsOrakelStructureChangedError, InsufficientMatchDataError, ModusHistoryUnavailableError, PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { ConsoleLogger, noopLogger, type Logger } from "../logger.js";
import bundledModusIndex from "../../data/modus-results-index.json" with { type: "json" };
import { OfficialModusHistorySource } from "../modus/history-source.js";
import {
  ModusPlayerHistoryService,
  type ModusPlayerHistoryReader,
} from "../modus/player-history-service.js";
import { PlayerResolver } from "../player/resolver.js";
import type { Match, MatchResult } from "../schemas/match.js";
import { ResearchHistoryService, type ResearchEvidenceReference, type ResearchHistoryReader } from "../research/history-service.js";
import { createResearchStorage, createResearchReaderFetch } from "../research/config.js";
import type { ResearchHistorySummary } from "../research/statistics.js";
import { calculateMatchSummary } from "../services/statistics.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import type { PlayerStatsSource } from "./query.js";

const DARTSORAKEL_TIMEOUT_MS = 15_000;

export interface PlayerStatsResult {
  readonly evidence?: ResearchEvidenceReference;
  readonly research?: ResearchHistorySummary;
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
  getPlayerStats(
    playerName: string,
    matchCount: number,
    source?: PlayerStatsSource,
    signal?: AbortSignal,
  ): Promise<PlayerStatsResult>;
}

export type PlayerMatchesReader = ResearchHistoryReader;

export class DartsPlayerStatsService implements PlayerStatsReader {
  private readonly matchesService: PlayerMatchesReader;
  private readonly logger: Logger;

  public constructor(matchesService: PlayerMatchesReader, logger: Logger = noopLogger) {
    this.matchesService = matchesService;
    this.logger = logger;
  }

  public async getPlayerStats(
    playerName: string,
    matchCount: number,
    _source?: PlayerStatsSource,
    signal?: AbortSignal,
  ): Promise<PlayerStatsResult> {
    return observePlayerStats((): Promise<PlayerStatsResult> => this.readPlayerStats(playerName, matchCount, signal), this.logger, "dartsorakel", signal);
  }

  private async readPlayerStats(playerName: string, matchCount: number, signal?: AbortSignal): Promise<PlayerStatsResult> {
    const snapshot = this.matchesService.getLastMatchesSnapshot === undefined ? undefined
      : await this.matchesService.getLastMatchesSnapshot(playerName, matchCount, signal);
    const result = snapshot?.value ?? (signal === undefined
      ? await this.matchesService.getLastMatches(playerName, matchCount)
      : await this.matchesService.getLastMatches(playerName, matchCount, signal));
    throwIfAborted(signal);
    const summary = calculateMatchSummary(result.matches);

    return {
      ...(snapshot?.evidence === undefined ? {} : { evidence: snapshot.evidence }),
      ...(snapshot?.research === undefined ? {} : { research: snapshot.research }),
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
  private readonly logger: Logger;

  public constructor(modusHistory: ModusPlayerHistoryReader, dartsStats: PlayerStatsReader, logger: Logger = noopLogger) {
    this.modusHistory = modusHistory;
    this.dartsStats = dartsStats;
    this.logger = logger;
  }

  public async getPlayerStats(
    playerName: string,
    matchCount: number,
    source: PlayerStatsSource = "auto",
    signal?: AbortSignal,
  ): Promise<PlayerStatsResult> {
    if (source !== "modus") {
      return signal === undefined
        ? this.dartsStats.getPlayerStats(playerName, matchCount, source)
        : this.dartsStats.getPlayerStats(playerName, matchCount, source, signal);
    }
    return observePlayerStats((): Promise<PlayerStatsResult> => this.readModusStats(playerName, matchCount, signal), this.logger, "modus-official", signal);
  }

  private async readModusStats(playerName: string, matchCount: number, signal?: AbortSignal): Promise<PlayerStatsResult> {
    throwIfAborted(signal);
    const modus = await waitWithSignal(this.modusHistory.findPlayerHistory(
      playerName,
      matchCount,
      { forceLiveLookup: true, ...(signal === undefined ? {} : { signal }) },
    ), signal);
    throwIfAborted(signal);
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
  const dartsStats = sharedDartsStats(serviceLogger);
  const modusHistory = new ModusPlayerHistoryService({
    source: new OfficialModusHistorySource({ logger: serviceLogger }),
    index: bundledModusIndex,
    logger: serviceLogger,
  });
  return new SourceRoutedPlayerStatsService(modusHistory, dartsStats, serviceLogger);
}

/**
 * Upcoming cards can contain dozens of players. The public Reader transport
 * has a low rolling request allowance, so full average/180/checkout enrichment
 * is deliberately paced below that limit. PDC commands run as Vercel
 * background work, allowing correctness without holding Telegram's webhook
 * acknowledgement open for the whole research job.
 */
export function createDefaultBulkPlayerStatsService(
  logger?: Logger,
): PlayerStatsReader {
  const serviceLogger = logger ?? new ConsoleLogger({ minimumLevel: "warn" });
  return sharedDartsStats(serviceLogger);
}

let sharedResearchStats: PlayerStatsReader | undefined;

/** One paced canonical history reader for interactive, compare, PDC and value commands per process. */
function sharedDartsStats(logger: Logger): PlayerStatsReader {
  sharedResearchStats ??= createDartsPlayerStatsService(logger, true, 3_200, 2);
  return sharedResearchStats;
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
    fetchImpl: createResearchReaderFetch(),
  });
  const storage = createResearchStorage();
  const matchesService = new ResearchHistoryService({
    resolver: new PlayerResolver(client),
    scraper: new DartsOrakelScraper(client, { enrichStatistics }),
    ...storage,
    onPersistenceError: (): void => logger.warn("Research evidence persistence unavailable; valid source research remains non-durable."),
  });
  return new DartsPlayerStatsService(matchesService, logger);
}

async function observePlayerStats(
  read: () => Promise<PlayerStatsResult>,
  logger: Logger,
  provider: PlayerStatsResult["provider"],
  signal?: AbortSignal,
): Promise<PlayerStatsResult> {
  const startedAt = performance.now();
  try {
    const result = await read();
    logger.info("player_research_outcome", {
      provider,
      outcome: "available",
      returnedMatches: result.matches.length,
      requestedMatches: result.requestedCount,
      availableAverages: result.availableAverageCount,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error: unknown) {
    logger.warn("player_research_outcome", {
      provider,
      outcome: playerResearchFailure(error, signal),
      latencyMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

function playerResearchFailure(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) return "cancelled";
  if (error instanceof PlayerAmbiguousError) return "identity_ambiguous";
  if (error instanceof PlayerNotFoundError) return "identity_not_found";
  if (error instanceof InsufficientMatchDataError) return "history_empty";
  if (error instanceof DartsOrakelStructureChangedError) return "source_structure_changed";
  if (error instanceof DartsOrakelRequestError) return error.status === 429 ? "source_rate_limited" : /timed out/iu.test(error.message) ? "source_timeout" : "source_unavailable";
  if (error instanceof ModusHistoryUnavailableError) return "official_history_unavailable";
  return "failed";
}

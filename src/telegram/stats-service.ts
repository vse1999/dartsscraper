import { DartsOrakelClient } from "../dartsorakel/client.js";
import { createDefaultDartsCache } from "../cache.js";
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
import { MemoryEvidenceLedger } from "../research/ledger.js";
import type { ResearchHistorySummary } from "../research/statistics.js";
import { assessResearchQuality, type QualityAssessment } from "../research/quality.js";
import { diagnoseResearchCoverageScopes } from "../research/coverage.js";
import type { ResearchCoverageScopes } from "../research/history-service.js";
import { calculateMatchSummary } from "../services/statistics.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import type { PlayerStatsSource } from "./query.js";

const DARTSORAKEL_TIMEOUT_MS = 15_000;

export interface PlayerStatsResult {
  readonly assessment?: QualityAssessment;
  readonly coverage?: ResearchCoverageScopes;
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
  /** Optional light first pass for large slates; no 180/checkout requests. */
  getPlayerStatsBase?(playerName: string, matchCount: number, signal?: AbortSignal): Promise<PlayerStatsResult>;
  /** Optional 10-row-focused path for a single-player history request. */
  getPlayerStatsRecent?(playerName: string, matchCount: number, source?: PlayerStatsSource, signal?: AbortSignal): Promise<PlayerStatsResult>;
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
    const assessment = snapshot?.assessment ?? assessResearchQuality(result.matches, {
      expectedPlayerId: result.player.id,
      ...(snapshot?.evidence === undefined ? {} : { evidence: snapshot.evidence }),
    });
    if (assessment.validity.status === "rejected") throw new Error("Research evidence rejected; statistics are unavailable.");
    const summary = calculateMatchSummary(result.matches);

    return {
      assessment,
      coverage: snapshot?.coverage ?? diagnoseResearchCoverageScopes(result.matches, matchCount),
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
  private readonly recentDartsStats: PlayerStatsReader | undefined;
  private readonly logger: Logger;

  public constructor(modusHistory: ModusPlayerHistoryReader, dartsStats: PlayerStatsReader, logger: Logger = noopLogger, recentDartsStats?: PlayerStatsReader) {
    this.modusHistory = modusHistory;
    this.dartsStats = dartsStats;
    this.logger = logger;
    this.recentDartsStats = recentDartsStats;
  }

  public async getPlayerStatsRecent(
    playerName: string,
    matchCount: number,
    source: PlayerStatsSource = "auto",
    signal?: AbortSignal,
  ): Promise<PlayerStatsResult> {
    if (source === "modus" || this.recentDartsStats === undefined) {
      return this.getPlayerStats(playerName, matchCount, source, signal);
    }
    return this.recentDartsStats.getPlayerStats(playerName, matchCount, source, signal);
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
    const assessment = assessResearchQuality(modus.matches);
    if (assessment.validity.status === "rejected") throw new Error("Research evidence rejected; statistics are unavailable.");
    const summary = calculateMatchSummary(modus.matches);
    return {
      assessment,
      coverage: diagnoseResearchCoverageScopes(modus.matches, matchCount),
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
  scheduleBackgroundTask?: (task: Promise<void>) => void,
): PlayerStatsReader {
  const serviceLogger = logger ?? new ConsoleLogger({ minimumLevel: "warn" });
  const dartsStats = sharedDartsStats(serviceLogger, scheduleBackgroundTask);
  const modusHistory = new ModusPlayerHistoryService({
    source: new OfficialModusHistorySource({ logger: serviceLogger }),
    index: bundledModusIndex,
    logger: serviceLogger,
  });
  return new SourceRoutedPlayerStatsService(modusHistory, dartsStats.full, serviceLogger, dartsStats.recent);
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
  return sharedDartsStats(serviceLogger).full;
}

interface SharedDartsStats {
  readonly full: PlayerStatsReader;
  readonly recent: PlayerStatsReader;
}

let sharedResearchStats: SharedDartsStats | undefined;

/** A shared paced, enriched snapshot reader for interactive and bulk research. */
export function resolveDartsOrakelRequestIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = 3_200,
): number {
  const minimumSafeIntervalMs = env.DARTSORAKEL_DIRECT_FETCH === "true"
    ? 250
    : env.JINA_API_KEY !== undefined && env.JINA_API_KEY.trim() !== ""
      ? 300
      : Math.max(3_200, fallbackMs);
  const configured = env.DARTSORAKEL_REQUEST_INTERVAL_MS?.trim();
  if (configured !== undefined && configured !== "") {
    const parsed = Number(configured);
    if (Number.isSafeInteger(parsed) && parsed >= minimumSafeIntervalMs) return parsed;
  }
  return minimumSafeIntervalMs;
}

function sharedDartsStats(logger: Logger, scheduleBackgroundTask?: (task: Promise<void>) => void): SharedDartsStats {
  const environment = process.env;
  const intervalMs = resolveDartsOrakelRequestIntervalMs(environment, 3_200);
  if (sharedResearchStats === undefined) {
    const jinaApiKey = environment.JINA_API_KEY?.trim();
    const transportMode = environment.DARTSORAKEL_DIRECT_FETCH === "true"
      ? "direct"
      : jinaApiKey === undefined || jinaApiKey === ""
        ? "reader-anonymous"
        : "reader-authenticated";
    logger.info("dartsorakel_request_pacing_configured", { transportMode, minRequestIntervalMs: intervalMs, maxRetries: 2 });
    sharedResearchStats = createDartsPlayerStatsService(logger, intervalMs, 2, scheduleBackgroundTask);
  }
  return sharedResearchStats;
}

function createDartsPlayerStatsService(
  logger: Logger,
  minRequestIntervalMs: number,
  maxRetries: number,
  scheduleBackgroundTask?: (task: Promise<void>) => void,
): SharedDartsStats {
  const client = new DartsOrakelClient({
    timeoutMs: DARTSORAKEL_TIMEOUT_MS,
    maxRetries,
    minRequestIntervalMs,
    logger,
    fetchImpl: createResearchReaderFetch(),
    cache: createDefaultDartsCache(logger),
  });
  const storage = createResearchStorage();
  const resolver = new PlayerResolver(client);
  const newMatchesService = (minimumAcquisitionCount: number): ResearchHistoryService => new ResearchHistoryService({
    resolver,
    scraper: new DartsOrakelScraper(client, { enrichStatistics: true, requireStatistics: true, logger }),
    ...storage,
    minimumAcquisitionCount,
    maxStaleAgeMs: 5 * 60_000,
    ...(scheduleBackgroundTask === undefined ? {} : { scheduleBackgroundTask }),
    onBackgroundRefreshError: (error: unknown): void => logger.warn("research_history_background_refresh_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
    onPersistenceError: (): void => logger.warn("Research evidence persistence unavailable; valid source research remains non-durable."),
  });
  const fullHistory = newMatchesService(20);
  const full = new DartsPlayerStatsService(fullHistory, logger);
  // Base evidence is separate and ephemeral: never let an average-only
  // snapshot replace the canonical enriched snapshot or durable ledger entry.
  const base = new DartsPlayerStatsService(new ResearchHistoryService({
    resolver,
    scraper: new DartsOrakelScraper(client, { enrichStatistics: false }),
    ledger: new MemoryEvidenceLedger(),
    minimumAcquisitionCount: 10,
  }), logger);
  return {
    full: {
      getPlayerStats: (name: string, count: number, source?: PlayerStatsSource, signal?: AbortSignal): Promise<PlayerStatsResult> => full.getPlayerStats(name, count, source, signal),
      getPlayerStatsBase: async (name: string, count: number, signal?: AbortSignal): Promise<PlayerStatsResult> => {
        const player = await resolver.resolvePlayer(name, signal);
        if (fullHistory.peekFreshSnapshot(player, count) !== null) return full.getPlayerStats(name, count, "dartsorakel", signal);
        return base.getPlayerStats(name, count, "dartsorakel", signal);
      },
    },
    // A 10-row request returns ten rows from the same 20-row enriched snapshot.
    // Sharing one cache prevents an interactive read from causing a second set
    // of provider requests when a later compare/bulk request needs 20 rows.
    recent: {
      getPlayerStats: (name: string, count: number, source?: PlayerStatsSource, signal?: AbortSignal): Promise<PlayerStatsResult> => full.getPlayerStats(name, count, source, signal),
    },
  };
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

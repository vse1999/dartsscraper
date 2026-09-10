import {
  DartsOrakelRequestError,
  DartsOrakelStructureChangedError,
  InsufficientMatchDataError,
  ModusSourceUnavailableError,
  PlayerAmbiguousError,
  PlayerNotFoundError,
} from "../errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizePlayerName } from "../player/resolver.js";
import type { ModusPlayersService } from "../modus/service.js";
import { IsoDateSchema } from "../agent/date.js";
import {
  formatModusOverviewMessages,
  type ModusOverviewPlayer,
} from "../telegram/modus-overview-formatter.js";
import { createModusPlayerKeyboard } from "../telegram/modus-player-callback.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../telegram/stats-service.js";
import type { TelegramMessageSender } from "../telegram/sender.js";

export type ModusReportPlayerStatus = "succeeded" | "failed";

export interface ModusReportPlayerResult {
  readonly player: string;
  readonly status: ModusReportPlayerStatus;
  readonly error?: string;
}

export interface ModusReportDependencies {
  readonly modusPlayersService: Pick<ModusPlayersService, "getModusPlayers">;
  readonly playerStatsService: Pick<PlayerStatsReader, "getPlayerStats">;
  readonly telegram: TelegramMessageSender;
  readonly logger?: Logger;
}

export interface RunModusReportOptions {
  readonly date: string;
  readonly dateLabel?: "today" | "tomorrow";
  readonly matchCount: number;
  readonly chatId: number | string;
  readonly concurrency?: number;
  readonly dependencies: ModusReportDependencies;
}

export interface ModusReportResult {
  readonly date: string;
  readonly players: readonly string[];
  readonly results: readonly ModusReportPlayerResult[];
  readonly discoverySucceeded: boolean;
}

export async function runModusReport(options: RunModusReportOptions): Promise<ModusReportResult> {
  const date = IsoDateSchema.parse(options.date);
  validatePositiveInteger(options.matchCount, "matchCount");
  const concurrency = options.concurrency ?? 3;
  validatePositiveInteger(concurrency, "concurrency");
  const logger = options.dependencies.logger ?? noopLogger;
  const startedAt = Date.now();
  logger.info("MODUS daily report started.", {
    targetDate: date,
    matchCount: options.matchCount,
    concurrency,
  });

  let players: readonly string[] = [];
  let discoverySucceeded = true;
  try {
    const discovered = await options.dependencies.modusPlayersService.getModusPlayers(date);
    players = uniquePlayerNames(discovered.players.map((player) => player.name));
    logger.info("MODUS daily report fixtures discovered.", {
      targetDate: date,
      playersDiscovered: players.length,
    });
  } catch (error: unknown) {
    discoverySucceeded = false;
    logger.warn("MODUS daily report fixture discovery failed.", {
      targetDate: date,
      playersDiscovered: 0,
      failureCode: errorCode(error),
    });
  }

  if (!discoverySucceeded || players.length === 0) {
    await trySend(
      options.dependencies.telegram,
      options.chatId,
      headerMessage(date, players.length, options.dateLabel ?? "tomorrow"),
      logger,
      date,
      "TELEGRAM_HEADER_SEND_FAILED",
    );
    await trySend(
      options.dependencies.telegram,
      options.chatId,
      discoverySucceeded
        ? `⚠️ No MODUS players were found for ${date}. No DartsOrakel lookups were attempted.`
        : `⚠️ MODUS fixtures could not be discovered for ${date}. No DartsOrakel lookups were attempted.`,
      logger,
      date,
      "TELEGRAM_WARNING_SEND_FAILED",
    );
    const results: readonly ModusReportPlayerResult[] = [];
    await trySend(options.dependencies.telegram, options.chatId, summaryMessage(results, discoverySucceeded ? undefined : "fixture discovery"), logger, date, "TELEGRAM_SUMMARY_SEND_FAILED");
    logger.info("MODUS daily report completed.", {
      targetDate: date,
      playersDiscovered: 0,
      totalDurationMs: Date.now() - startedAt,
      success: false,
      failureCode: discoverySucceeded ? "NO_MODUS_FIXTURES" : "MODUS_FIXTURE_DISCOVERY_FAILED",
    });
    return { date, players, results, discoverySucceeded };
  }

  const lookupResults = await mapWithConcurrency(players, concurrency, async (player: string): Promise<ModusOverviewPlayer> => {
    const playerStartedAt = Date.now();
    let lookupDurationMs = 0;
    let stats: PlayerStatsResult;
    try {
      stats = await options.dependencies.playerStatsService.getPlayerStats(player, options.matchCount, "dartsorakel");
      lookupDurationMs = Date.now() - playerStartedAt;
    } catch (error: unknown) {
      const failureCode = errorCode(error);
      logger.warn("MODUS daily report player lookup failed.", {
        targetDate: date,
        player,
        lookupDurationMs: Date.now() - playerStartedAt,
        success: false,
        failureCode,
      });
      return { player, status: "failed", error: failureCode };
    }

    logger.info("MODUS daily report player completed.", {
      targetDate: date,
      player,
      lookupDurationMs,
      success: true,
    });
    return { player, status: "succeeded", stats };
  });

  const overviewMessages = formatModusOverviewMessages({
    date,
    dateLabel: options.dateLabel ?? "tomorrow",
    matchCount: options.matchCount,
    players,
    results: lookupResults,
  });
  const playerKeyboard = createModusPlayerKeyboard(players, options.matchCount);
  const overviewDelivered = await sendOverviewMessages(
    options.dependencies.telegram,
    options.chatId,
    overviewMessages,
    playerKeyboard,
    logger,
    date,
  );
  const results = overviewDelivered
    ? lookupResults.map(toReportResult)
    : lookupResults.map((result): ModusReportPlayerResult => result.status === "failed"
      ? toReportResult(result)
      : { player: result.player, status: "failed", error: "TELEGRAM_SEND_FAILED" });
  logger.info("MODUS daily report completed.", {
    targetDate: date,
    playersDiscovered: players.length,
    totalDurationMs: Date.now() - startedAt,
    success: results.every((result) => result.status === "succeeded"),
    ...(results.some((result) => result.status === "failed") ? { failureCode: "PLAYER_FAILURES" } : {}),
  });
  return { date, players, results, discoverySucceeded };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  validatePositiveInteger(concurrency, "concurrency");
  const results: Array<R | undefined> = new Array<R | undefined>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  };
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, (): Promise<void> => worker()));
  return results.map((result: R | undefined, index: number): R => {
    if (result === undefined) throw new Error(`Concurrency mapper did not produce result ${index}.`);
    return result;
  });
}

function uniquePlayerNames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const normalized = normalizePlayerName(name);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(name.trim());
  }
  return unique;
}

function headerMessage(date: string, playerCount: number, dateLabel: "today" | "tomorrow"): string {
  return `🎯 MODUS ${dateLabel.toUpperCase()} — ${date}\nPlayers found: ${playerCount}`;
}

function summaryMessage(results: readonly ModusReportPlayerResult[], discoveryFailure?: string): string {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const failedPlayers = results.filter((result) => result.status === "failed").map((result) => result.player);
  const failures = discoveryFailure === undefined ? failedPlayers : [...failedPlayers, discoveryFailure];
  return [
    "✅ MODUS research complete",
    `${succeeded}/${results.length} succeeded`,
    `Failed: ${failures.length === 0 ? "none" : failures.join(", ")}`,
  ].join("\n");
}

async function trySend(
  telegram: TelegramMessageSender,
  chatId: number | string,
  message: string,
  logger: Logger,
  date: string,
  failureCode: string,
): Promise<boolean> {
  try {
    await telegram.sendMessage(chatId, message);
    return true;
  } catch {
    logger.error("MODUS daily report Telegram delivery failed.", {
      targetDate: date,
      success: false,
      failureCode,
    });
    return false;
  }
}

async function sendOverviewMessages(
  telegram: TelegramMessageSender,
  chatId: number | string,
  messages: readonly string[],
  replyMarkup: ReturnType<typeof createModusPlayerKeyboard>,
  logger: Logger,
  date: string,
): Promise<boolean> {
  try {
    for (const [index, message] of messages.entries()) {
      if (index === messages.length - 1) await telegram.sendMessage(chatId, message, { replyMarkup });
      else await telegram.sendMessage(chatId, message);
    }
    return true;
  } catch {
    logger.error("MODUS daily report overview delivery failed.", {
      targetDate: date,
      success: false,
      failureCode: "TELEGRAM_OVERVIEW_SEND_FAILED",
    });
    return false;
  }
}

function toReportResult(result: ModusOverviewPlayer): ModusReportPlayerResult {
  if (result.status === "succeeded") return { player: result.player, status: result.status };
  return result.error === undefined
    ? { player: result.player, status: result.status }
    : { player: result.player, status: result.status, error: result.error };
}

function errorCode(error: unknown, fallback = "PLAYER_STATS_FAILED"): string {
  if (error instanceof PlayerNotFoundError) return "PLAYER_NOT_FOUND";
  if (error instanceof PlayerAmbiguousError) return "PLAYER_AMBIGUOUS";
  if (error instanceof InsufficientMatchDataError) return "NO_COMPLETED_MATCHES";
  if (error instanceof DartsOrakelRequestError) return "DARTSORAKEL_REQUEST_FAILED";
  if (error instanceof DartsOrakelStructureChangedError) return "DARTSORAKEL_STRUCTURE_CHANGED";
  if (error instanceof ModusSourceUnavailableError) return "MODUS_SOURCES_UNAVAILABLE";
  return fallback;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

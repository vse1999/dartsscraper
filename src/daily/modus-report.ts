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
import type { ModusFixture, ModusFixturesResult, ModusPlayersResult } from "../modus/schemas.js";
import { IsoDateSchema } from "../agent/date.js";
import { analyzeMatchup } from "../services/matchup-analysis.js";
import {
  formatModusOverviewMessages,
  type ModusOverviewPlayer,
} from "../telegram/modus-overview-formatter.js";
import { formatModusMatchupMessages } from "../telegram/modus-matchup-formatter.js";
import { createModusPlayerKeyboard } from "../telegram/modus-player-callback.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../telegram/stats-service.js";
import type { TelegramMessageSender, TelegramSendMessageOptions } from "../telegram/sender.js";
import {
  createReportBudget,
  isReportDeadlineExceeded,
  raceWithReportDeadline,
} from "./report-budget.js";

export const MODUS_REPORT_TOTAL_BUDGET_MS = 160_000;
export const MODUS_REPORT_RESEARCH_BUDGET_MS = 120_000;

export type ModusReportPlayerStatus = "succeeded" | "failed";

export interface ModusReportPlayerResult {
  readonly player: string;
  readonly status: ModusReportPlayerStatus;
  readonly error?: string;
}

export type ModusReportStatus = "succeeded" | "partial" | "failed";
export type ModusReportDiscoveryStatus = "succeeded" | "partial" | "empty" | "failed";
export type ModusReportDataStatus = "complete" | "partial" | "empty" | "not_attempted" | "failed";
export type ModusReportDeliveryStatus = "complete" | "partial" | "failed";
export type ModusReportDeliveryStage = "header" | "warning" | "summary" | "overview";

export interface ModusReportDiscoveryOutcome {
  readonly status: ModusReportDiscoveryStatus;
  readonly playersDiscovered: number;
  readonly fixturesDiscovered: number;
  readonly warnings: readonly string[];
  readonly failureCode?: string;
}

export interface ModusReportDataOutcome {
  readonly status: ModusReportDataStatus;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unstarted?: number;
  readonly timedOut?: number;
}

export interface ModusReportDeliveryFailure {
  readonly stage: ModusReportDeliveryStage;
  readonly failureCode: string;
}

export interface ModusReportDeliveryOutcome {
  readonly status: ModusReportDeliveryStatus;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped?: number;
  readonly failures: readonly ModusReportDeliveryFailure[];
}

export interface ModusReportOutcome {
  readonly status: ModusReportStatus;
  readonly discovery: ModusReportDiscoveryOutcome;
  readonly data: ModusReportDataOutcome;
  readonly delivery: ModusReportDeliveryOutcome;
}

export interface ModusReportDependencies {
  readonly modusPlayersService: {
    readonly getModusPlayers: (date: string, signal?: AbortSignal) => Promise<ModusPlayersResult>;
    readonly getModusFixtures?: (date: string, signal?: AbortSignal) => Promise<ModusFixturesResult>;
  };
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
  readonly budget?: {
    readonly totalMs?: number;
    readonly researchMs?: number;
    readonly now?: () => number;
  };
  readonly dependencies: ModusReportDependencies;
}

export interface ModusReportResult {
  readonly date: string;
  readonly players: readonly string[];
  readonly results: readonly ModusReportPlayerResult[];
  readonly discoverySucceeded: boolean;
  readonly outcome: ModusReportOutcome;
}

export async function runModusReport(options: RunModusReportOptions): Promise<ModusReportResult> {
  const date = IsoDateSchema.parse(options.date);
  validatePositiveInteger(options.matchCount, "matchCount");
  const concurrency = options.concurrency ?? 3;
  validatePositiveInteger(concurrency, "concurrency");
  const logger = options.dependencies.logger ?? noopLogger;
  const budget = createReportBudget({
    totalMs: options.budget?.totalMs ?? MODUS_REPORT_TOTAL_BUDGET_MS,
    researchMs: options.budget?.researchMs ?? MODUS_REPORT_RESEARCH_BUDGET_MS,
    ...(options.budget?.now === undefined ? {} : { now: options.budget.now }),
  });
  const startedAt = budget.startedAt;
  logger.info("MODUS daily report started.", {
    targetDate: date,
    matchCount: options.matchCount,
    concurrency,
    totalBudgetMs: budget.totalDeadlineAt - budget.startedAt,
    researchBudgetMs: budget.researchDeadlineAt - budget.startedAt,
  });

  try {
    let fixtures: readonly ModusFixture[] = [];
    let players: readonly string[] = [];
    let discoveryStatus: ModusReportDiscoveryStatus = "empty";
    let discoveryFailureCode: string | undefined;
    const discoveryWarnings: string[] = [];
    let researchTimedOut = false;
    const fixtureReader = options.dependencies.modusPlayersService.getModusFixtures;
    if (fixtureReader !== undefined && !budget.researchSignal.aborted) {
      try {
        const discovered = await raceWithReportDeadline(
          fixtureReader.call(options.dependencies.modusPlayersService, date, budget.researchSignal),
          budget.researchSignal,
          "research",
        );
        fixtures = discovered.fixtures;
        players = uniquePlayerNames(fixtures.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]));
        if (fixtures.length === 0) discoveryWarnings.push("MODUS_PAIRED_FIXTURE_DISCOVERY_EMPTY");
        logger.info("MODUS daily report paired fixtures discovered.", {
          targetDate: date,
          fixturesDiscovered: fixtures.length,
          playersDiscovered: players.length,
        });
      } catch (error: unknown) {
        const failureCode = isReportDeadlineExceeded(error)
          ? "MODUS_RESEARCH_DEADLINE_EXCEEDED"
          : errorCode(error, "MODUS_PAIRED_FIXTURE_DISCOVERY_FAILED");
        discoveryWarnings.push(failureCode);
        researchTimedOut = isReportDeadlineExceeded(error);
        logger.warn("MODUS paired fixture discovery failed; falling back to the player roster when time remains.", {
          targetDate: date,
          failureCode,
        });
      }
    }

    if (players.length === 0 && !researchTimedOut && !budget.researchSignal.aborted) {
      try {
        const discovered = await raceWithReportDeadline(
          options.dependencies.modusPlayersService.getModusPlayers(date, budget.researchSignal),
          budget.researchSignal,
          "research",
        );
        players = uniquePlayerNames(discovered.players.map((player) => player.name));
        logger.info("MODUS daily report player roster discovered.", {
          targetDate: date,
          playersDiscovered: players.length,
        });
      } catch (error: unknown) {
        discoveryFailureCode = isReportDeadlineExceeded(error)
          ? "MODUS_RESEARCH_DEADLINE_EXCEEDED"
          : errorCode(error, "MODUS_FIXTURE_DISCOVERY_FAILED");
        researchTimedOut = isReportDeadlineExceeded(error);
        discoveryStatus = "failed";
        logger.warn("MODUS daily report fixture discovery failed.", {
          targetDate: date,
          playersDiscovered: 0,
          failureCode: discoveryFailureCode,
        });
      }
    }

    if (discoveryStatus !== "failed" && players.length > 0) {
      discoveryStatus = discoveryWarnings.length > 0 ? "partial" : "succeeded";
    } else if (discoveryStatus !== "failed") {
      discoveryStatus = researchTimedOut ? "failed" : "empty";
      discoveryFailureCode ??= researchTimedOut ? "MODUS_RESEARCH_DEADLINE_EXCEEDED" : undefined;
    }

    if (discoveryStatus === "failed" || discoveryStatus === "empty") {
      const attempts: ModusReportDeliveryAttempt[] = [];
      attempts.push(await trySend(
        options.dependencies.telegram,
        options.chatId,
        headerMessage(
          date,
          players.length,
          options.dateLabel ?? "tomorrow",
          discoveryStatus === "empty"
            ? "No players were discovered."
            : researchTimedOut
              ? "⚠️ Research deadline reached during fixture discovery."
              : "⚠️ Fixture discovery was incomplete.",
        ),
        logger,
        date,
        "TELEGRAM_HEADER_SEND_FAILED",
        "header",
        budget.totalSignal,
      ));
      attempts.push(await trySend(
        options.dependencies.telegram,
        options.chatId,
        discoveryStatus === "empty"
          ? `⚠️ No MODUS players were found for ${date}. No DartsOrakel lookups were attempted. Try again later.`
          : researchTimedOut
            ? `⚠️ MODUS fixture discovery timed out for ${date}. No DartsOrakel lookups were attempted.`
            : `⚠️ MODUS fixtures could not be discovered for ${date}. No DartsOrakel lookups were attempted. Try again later.`,
        logger,
        date,
        "TELEGRAM_WARNING_SEND_FAILED",
        "warning",
        budget.totalSignal,
      ));
      const results: readonly ModusReportPlayerResult[] = [];
      attempts.push(await trySend(
        options.dependencies.telegram,
        options.chatId,
        summaryMessage(results, discoveryStatus === "empty"
          ? "no players discovered"
          : researchTimedOut ? "fixture discovery timed out" : "fixture discovery"),
        logger,
        date,
        "TELEGRAM_SUMMARY_SEND_FAILED",
        "summary",
        budget.totalSignal,
      ));
      const discovery: ModusReportDiscoveryOutcome = {
        status: discoveryStatus,
        playersDiscovered: players.length,
        fixturesDiscovered: fixtures.length,
        warnings: discoveryWarnings,
        ...(discoveryFailureCode === undefined ? {} : { failureCode: discoveryFailureCode }),
      };
      const data: ModusReportDataOutcome = {
        status: discoveryStatus === "empty" ? "empty" : "not_attempted",
        attempted: 0,
        succeeded: 0,
        failed: 0,
        unstarted: 0,
        timedOut: 0,
      };
      const delivery = summarizeDelivery(attempts);
      const outcome: ModusReportOutcome = { status: "failed", discovery, data, delivery };
      logger.info("MODUS daily report completed.", {
        targetDate: date,
        playersDiscovered: players.length,
        totalDurationMs: Date.now() - startedAt,
        success: false,
        failureCode: failureCodeForOutcome(outcome),
      });
      return { date, players, results, discoverySucceeded: discoveryStatus !== "failed" && discoveryStatus !== "empty", outcome };
    }

    const statsReader = options.dependencies.playerStatsService;
    const lookupResults = await mapReportWithConcurrency(
      players,
      concurrency,
      async (player: string): Promise<ModusOverviewPlayer> => {
        const playerStartedAt = Date.now();
        try {
          const stats = await raceWithReportDeadline(
            statsReader.getPlayerStats(player, options.matchCount, "dartsorakel", budget.researchSignal),
            budget.researchSignal,
            "research",
          );
          logger.info("MODUS daily report player completed.", {
            targetDate: date,
            player,
            lookupDurationMs: Date.now() - playerStartedAt,
            success: true,
          });
          return { player, status: "succeeded", stats };
        } catch (error: unknown) {
          const failureCode = isReportDeadlineExceeded(error)
            ? "MODUS_RESEARCH_DEADLINE_EXCEEDED"
            : errorCode(error);
          logger.warn("MODUS daily report player lookup failed.", {
            targetDate: date,
            player,
            lookupDurationMs: Date.now() - playerStartedAt,
            success: false,
            failureCode,
          });
          return { player, status: "failed", error: failureCode };
        }
      },
      budget.researchSignal,
      (player: string): ModusOverviewPlayer => ({
        player,
        status: "failed",
        error: "MODUS_RESEARCH_NOT_STARTED",
      }),
    );

    const statsByPlayer = new Map<string, PlayerStatsResult>();
    for (const result of lookupResults) {
      if (result.status === "succeeded" && result.stats !== undefined) {
        statsByPlayer.set(normalizePlayerName(result.player), result.stats);
      }
    }
    const incomplete = discoveryStatus !== "succeeded"
      || lookupResults.some((result) => result.status === "failed");
    const overviewMessages = fixtures.length > 0
      ? formatModusMatchupMessages({
        date,
        dateLabel: options.dateLabel ?? "tomorrow",
        matchCount: options.matchCount,
        analyses: fixtures.map((fixture) => analyzeMatchup(
          fixture,
          statsByPlayer.get(normalizePlayerName(fixture.playerOne)),
          statsByPlayer.get(normalizePlayerName(fixture.playerTwo)),
          options.matchCount,
        )),
        ...(incomplete ? { incomplete: true } : {}),
      })
      : formatModusOverviewMessages({
        date,
        dateLabel: options.dateLabel ?? "tomorrow",
        matchCount: options.matchCount,
        players,
        results: lookupResults,
        ...(incomplete ? { incomplete: true } : {}),
      });
    const playerKeyboard = createModusPlayerKeyboard(players, options.matchCount);
    const deliveryAttempts = await sendOverviewMessages(
      options.dependencies.telegram,
      options.chatId,
      overviewMessages,
      playerKeyboard,
      logger,
      date,
      budget.totalSignal,
    );
    const results = lookupResults.map(toReportResult);
    const data = summarizeData(results);
    const delivery = summarizeDelivery(deliveryAttempts);
    const discovery: ModusReportDiscoveryOutcome = {
      status: discoveryStatus,
      playersDiscovered: players.length,
      fixturesDiscovered: fixtures.length,
      warnings: discoveryWarnings,
      ...(discoveryFailureCode === undefined ? {} : { failureCode: discoveryFailureCode }),
    };
    const outcome: ModusReportOutcome = {
      status: overallStatus(discovery.status, data.status, delivery.status),
      discovery,
      data,
      delivery,
    };
    logger.info("MODUS daily report completed.", {
      targetDate: date,
      playersDiscovered: players.length,
      totalDurationMs: Date.now() - startedAt,
      success: outcome.status === "succeeded",
      ...(outcome.status === "succeeded" ? {} : { failureCode: failureCodeForOutcome(outcome) }),
    });
    return { date, players, results, discoverySucceeded: discovery.status !== "failed" && discovery.status !== "empty", outcome };
  } finally {
    budget.close();
  }
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

async function mapReportWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal: AbortSignal,
  skipped: (item: T, index: number) => R,
): Promise<readonly R[]> {
  validatePositiveInteger(concurrency, "concurrency");
  const results: Array<R | undefined> = new Array<R | undefined>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) return;
      if (signal.aborted) {
        results[index] = skipped(item, index);
        continue;
      }
      try {
        results[index] = await mapper(item, index);
      } catch (error: unknown) {
        if (!isReportDeadlineExceeded(error)) throw error;
        results[index] = skipped(item, index);
      }
    }
  };
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, (): Promise<void> => worker()));
  return results.map((result: R | undefined, index: number): R => {
    const item = items[index];
    if (result !== undefined) return result;
    if (item === undefined) throw new Error(`Concurrency mapper did not produce result ${index}.`);
    return skipped(item, index);
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

function headerMessage(
  date: string,
  playerCount: number,
  dateLabel: "today" | "tomorrow",
  notice?: string,
): string {
  return [`🎯 MODUS ${dateLabel.toUpperCase()} — ${date}`, `Players found: ${playerCount}`, ...(notice === undefined ? [] : [notice])].join("\n");
}

function summaryMessage(results: readonly ModusReportPlayerResult[], discoveryFailure?: string): string {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const failedPlayers = results.filter((result) => result.status === "failed").map((result) => result.player);
  const failures = discoveryFailure === undefined ? failedPlayers : [...failedPlayers, discoveryFailure];
  return [
    discoveryFailure === undefined ? "✅ MODUS research complete" : "⚠️ MODUS research incomplete",
    `${succeeded}/${results.length} succeeded`,
    `Failed: ${failures.length === 0 ? "none" : failures.join(", ")}`,
  ].join("\n");
}

interface ModusReportDeliveryAttempt {
  readonly stage: ModusReportDeliveryStage;
  readonly started: boolean;
  readonly delivered: boolean;
  readonly failureCode?: string;
}

async function trySend(
  telegram: TelegramMessageSender,
  chatId: number | string,
  message: string,
  logger: Logger,
  date: string,
  failureCode: string,
  stage: ModusReportDeliveryStage,
  signal: AbortSignal,
): Promise<ModusReportDeliveryAttempt> {
  if (signal.aborted) {
    logger.warn("MODUS daily report Telegram delivery skipped after total deadline.", {
      targetDate: date,
      success: false,
      failureCode,
    });
    return { stage, started: false, delivered: false, failureCode };
  }
  try {
    await raceWithReportDeadline(
      sendMessageWithSignal(telegram, chatId, message, undefined, signal),
      signal,
      "delivery",
    );
    return { stage, started: true, delivered: true };
  } catch {
    logger.error("MODUS daily report Telegram delivery failed.", {
      targetDate: date,
      success: false,
      failureCode,
    });
    return { stage, started: true, delivered: false, failureCode };
  }
}

async function sendOverviewMessages(
  telegram: TelegramMessageSender,
  chatId: number | string,
  messages: readonly string[],
  replyMarkup: ReturnType<typeof createModusPlayerKeyboard>,
  logger: Logger,
  date: string,
  signal: AbortSignal,
): Promise<readonly ModusReportDeliveryAttempt[]> {
  const attempts: ModusReportDeliveryAttempt[] = [];
  for (const [index, message] of messages.entries()) {
    if (signal.aborted) {
      attempts.push({ stage: "overview", started: false, delivered: false, failureCode: "TELEGRAM_OVERVIEW_SEND_FAILED" });
      continue;
    }
    try {
      const options = index === messages.length - 1 ? { replyMarkup } : undefined;
      await raceWithReportDeadline(
        sendMessageWithSignal(telegram, chatId, message, options, signal),
        signal,
        "delivery",
      );
      attempts.push({ stage: "overview", started: true, delivered: true });
    } catch {
      logger.error("MODUS daily report overview delivery failed.", {
        targetDate: date,
        success: false,
        failureCode: "TELEGRAM_OVERVIEW_SEND_FAILED",
        messageIndex: index,
      });
      attempts.push({ stage: "overview", started: true, delivered: false, failureCode: "TELEGRAM_OVERVIEW_SEND_FAILED" });
    }
  }
  return attempts;
}

function sendMessageWithSignal(
  telegram: TelegramMessageSender,
  chatId: number | string,
  message: string,
  options: TelegramSendMessageOptions | undefined,
  signal: AbortSignal,
): Promise<void> {
  const sendOptions: TelegramSendMessageOptions = {
    ...(options === undefined ? {} : options),
    signal,
  };
  return telegram.sendMessage(chatId, message, sendOptions);
}

function summarizeData(results: readonly ModusReportPlayerResult[]): ModusReportDataOutcome {
  const unstarted = results.filter((result) => result.error === "MODUS_RESEARCH_NOT_STARTED").length;
  const timedOut = results.filter((result) => result.error === "MODUS_RESEARCH_DEADLINE_EXCEEDED").length;
  const attempted = results.length - unstarted;
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const failed = attempted - succeeded;
  const status: ModusReportDataStatus = results.length === 0
    ? "empty"
    : attempted === 0
      ? "not_attempted"
    : succeeded === attempted && unstarted === 0
      ? "complete"
      : succeeded === 0
        ? "failed"
        : "partial";
  return { status, attempted, succeeded, failed, unstarted, timedOut };
}

function summarizeDelivery(attempts: readonly ModusReportDeliveryAttempt[]): ModusReportDeliveryOutcome {
  const attempted = attempts.filter((attempt) => attempt.started).length;
  const skipped = attempts.length - attempted;
  const succeeded = attempts.filter((attempt) => attempt.delivered).length;
  const failed = attempted - succeeded;
  const failures: ModusReportDeliveryFailure[] = attempts
    .filter((attempt): attempt is ModusReportDeliveryAttempt & { readonly failureCode: string } => !attempt.delivered && attempt.failureCode !== undefined)
    .map((attempt): ModusReportDeliveryFailure => ({ stage: attempt.stage, failureCode: attempt.failureCode }));
  const status: ModusReportDeliveryStatus = skipped > 0 || failed > 0
    ? succeeded === 0
      ? "failed"
      : "partial"
    : "complete";
  return { status, attempted, succeeded, failed, skipped, failures };
}

function overallStatus(
  discoveryStatus: ModusReportDiscoveryStatus,
  dataStatus: ModusReportDataStatus,
  deliveryStatus: ModusReportDeliveryStatus,
): ModusReportStatus {
  if (discoveryStatus === "failed" || discoveryStatus === "empty" || dataStatus === "empty" || dataStatus === "not_attempted" || dataStatus === "failed" || deliveryStatus === "failed") {
    return "failed";
  }
  if (discoveryStatus === "partial" || dataStatus === "partial" || deliveryStatus === "partial") return "partial";
  return "succeeded";
}

function failureCodeForOutcome(outcome: ModusReportOutcome): string {
  if (outcome.discovery.failureCode !== undefined) return outcome.discovery.failureCode;
  if (outcome.discovery.status === "empty") return "NO_MODUS_FIXTURES";
  if (outcome.data.status === "failed") return "PLAYER_FAILURES";
  if (outcome.delivery.failures.length > 0) return outcome.delivery.failures[0]?.failureCode ?? "TELEGRAM_SEND_FAILED";
  return "MODUS_REPORT_INCOMPLETE";
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

import {
  createReportBudget,
  isReportDeadlineExceeded,
  raceWithReportDeadline,
  type ReportBudget,
} from "../daily/report-budget.js";
import {
  DartsOrakelRequestError,
  DartsOrakelStructureChangedError,
  InsufficientMatchDataError,
  ModusHistoryUnavailableError,
  PlayerAmbiguousError,
  PlayerNotFoundError,
} from "../errors.js";
import {
  analyzePlayerHistories,
  type MatchupPlayerHistory,
  type PlayerHistoryComparison,
} from "../services/matchup-analysis.js";
import { calculateMatchSummary } from "../services/statistics.js";
import { formatCompareMessages } from "./compare-formatter.js";
import { parseCompareCommand, compareQueryUsage, sameComparisonPlayer, type CompareQuery } from "./compare-query.js";
import type { PlayerStatsReader, PlayerStatsResult } from "./stats-service.js";
import type { Logger } from "../logger.js";
import type { BackgroundTaskScheduler } from "./modus-command.js";

export const COMPARE_TOTAL_BUDGET_MS = 150_000;
export const COMPARE_RESEARCH_BUDGET_MS = 120_000;

export interface CompareDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface CompareMessageResponder {
  reply(text: string, options?: CompareDeliveryOptions): Promise<{ readonly messageId: number }>;
  edit(messageId: number, text: string, options?: CompareDeliveryOptions): Promise<void>;
}

export type CompareFailureCode = "not-found" | "ambiguous" | "no-matches" | "timeout" | "unavailable" | "failed" | "unstarted" | "same-player";

export interface ComparePlayerResearch {
  readonly requestedName: string;
  readonly result: PlayerStatsResult | null;
  readonly failureCode: CompareFailureCode | null;
  readonly failureMessage: string;
}

export interface CompareReport {
  readonly requestedCount: CompareQuery["matchCount"];
  readonly players: readonly ComparePlayerResearch[];
  readonly analysis: PlayerHistoryComparison | null;
  readonly generatedAt: string;
}

export type CompareCommandOutcome = "invalid" | "started" | "success" | "partial" | "failed";

export interface CompareBudgetOverrides {
  readonly totalMs?: number;
  readonly researchMs?: number;
  readonly now?: () => number;
}

export type CompareDeliveryStatus = "complete" | "partial" | "failed";

export interface CompareDeliveryOutcome {
  readonly status: CompareDeliveryStatus;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
  readonly uncertain: boolean;
  readonly failureCodes: readonly string[];
}

interface ComparePlayerMetric {
  readonly index: number;
  readonly durationMs: number;
  readonly returnedCount: number;
  readonly availableAverageCount: number;
  readonly availableOneEightiesCount: number;
  readonly availableCheckoutCount: number;
  readonly provider: PlayerStatsResult["provider"] | null;
  readonly failureCode: CompareFailureCode | null;
}

export async function handleCompareCommand(
  text: string,
  statsService: PlayerStatsReader,
  responder: CompareMessageResponder,
  logger: Logger,
  updateId: number,
  scheduleBackgroundTask?: BackgroundTaskScheduler,
  budgetOverrides?: CompareBudgetOverrides,
): Promise<CompareCommandOutcome> {
  const query = parseCompareCommand(text);
  if (query === null) {
    await responder.reply(`Usage: ${compareQueryUsage()}`);
    return "invalid";
  }

  const budget = createReportBudget({
    totalMs: budgetOverrides?.totalMs ?? COMPARE_TOTAL_BUDGET_MS,
    researchMs: budgetOverrides?.researchMs ?? COMPARE_RESEARCH_BUDGET_MS,
    ...(budgetOverrides?.now === undefined ? {} : { now: budgetOverrides.now }),
  });

  let status: { readonly messageId: number };
  const ackStartedAt = Date.now();
  if (!canStartDelivery(budget)) {
    logger.warn("Player comparison acknowledgement skipped at the total deadline.", {
      updateId,
      phase: "ack",
      durationMs: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: 1,
      uncertain: false,
      failureCode: "COMPARE_ACK_TIMEOUT",
    });
    budget.close();
    return "failed";
  }
  try {
    // The acknowledgement is deliberately awaited before research is started
    // or handed to a background scheduler. This keeps a failed Telegram send
    // from creating work the caller cannot observe or retry safely.
    status = await raceWithReportDeadline(
      responder.reply(`🔎 Comparing the latest ${query.matchCount} completed matches…`, { signal: budget.totalSignal }),
      budget.totalSignal,
      "delivery",
    );
    logger.info("Player comparison acknowledgement delivered.", {
      updateId,
      phase: "ack",
      durationMs: Date.now() - ackStartedAt,
      attempted: 1,
      delivered: 1,
      failed: 0,
      skipped: 0,
      uncertain: false,
      failureCode: null,
    });
  } catch (error: unknown) {
    logger.warn("Player comparison acknowledgement failed.", {
      updateId,
      phase: "ack",
      durationMs: Date.now() - ackStartedAt,
      attempted: 1,
      delivered: 0,
      failed: 1,
      skipped: 0,
      uncertain: true,
      failureCode: deliveryFailureCode(error, "ack"),
      errorType: safeErrorType(error),
    });
    budget.close();
    return "failed";
  }

  const task = executeCompareCommand(
    query,
    statsService,
    responder,
    logger,
    updateId,
    budget,
    status.messageId,
  );
  if (scheduleBackgroundTask !== undefined) {
    try {
      scheduleBackgroundTask(task.then((): void => undefined, (error: unknown): void => {
        logger.error("Background player comparison failed.", {
          updateId,
          code: "COMPARE_BACKGROUND_FAILED",
          errorType: safeErrorType(error),
        });
      }));
    } catch (error: unknown) {
      // A scheduler is an application boundary. The task already has a
      // rejection observer above, but close the budget if registration itself
      // fails so its timers cannot outlive the failed request.
      budget.close();
      logger.error("Background player comparison could not be scheduled.", {
        updateId,
        code: "COMPARE_BACKGROUND_SCHEDULE_FAILED",
        errorType: safeErrorType(error),
      });
      return "failed";
    }
    return "started";
  }
  return task;
}

export function buildCompareAnalysis(
  playerOne: ComparePlayerResearch,
  playerTwo: ComparePlayerResearch,
  requestedCount: number,
): PlayerHistoryComparison | null {
  if (playerOne.result === null || playerTwo.result === null) return null;
  if (sameComparisonPlayer(playerOne.result.playerName, playerTwo.result.playerName)) return null;
  const playerOneHistory: MatchupPlayerHistory = {
    playerName: playerOne.result.playerName,
    requestedCount,
    matches: playerOne.result.matches,
  };
  const playerTwoHistory: MatchupPlayerHistory = {
    playerName: playerTwo.result.playerName,
    requestedCount,
    matches: playerTwo.result.matches,
  };
  return analyzePlayerHistories(playerOneHistory, playerTwoHistory, requestedCount);
}

async function executeCompareCommand(
  query: CompareQuery,
  statsService: PlayerStatsReader,
  responder: CompareMessageResponder,
  logger: Logger,
  updateId: number,
  budget: ReportBudget,
  statusMessageId: number,
): Promise<Exclude<CompareCommandOutcome, "invalid" | "started">> {
  const startedAt = Date.now();
  const playerMetrics: ComparePlayerMetric[] = [];

  try {
    const players: ComparePlayerResearch[] = [];
    for (const [index, requestedName] of query.playerNames.entries()) {
      const playerStartedAt = Date.now();
      const player = await researchPlayer(requestedName, query.matchCount, statsService, budget);
      players.push(player);
      const summary = player.result === null ? null : calculateMatchSummary(player.result.matches);
      playerMetrics.push({
        index,
        durationMs: Date.now() - playerStartedAt,
        returnedCount: player.result?.matches.length ?? 0,
        availableAverageCount: summary?.availableAverageCount ?? 0,
        availableOneEightiesCount: summary?.availableOneEightiesCount ?? 0,
        availableCheckoutCount: summary?.availableCheckoutCount ?? 0,
        provider: player.result?.provider ?? null,
        failureCode: player.failureCode,
      });
      logger.info("Player comparison research completed.", {
        updateId,
        phase: "research",
        playerIndex: index,
        durationMs: playerMetrics[playerMetrics.length - 1]?.durationMs ?? 0,
        returnedCount: player.result?.matches.length ?? 0,
        availableAverageCount: summary?.availableAverageCount ?? 0,
        availableOneEightiesCount: summary?.availableOneEightiesCount ?? 0,
        availableCheckoutCount: summary?.availableCheckoutCount ?? 0,
        provider: player.result?.provider ?? null,
        failureCode: player.failureCode,
      });
    }

    const firstPlayer = players[0];
    const secondPlayer = players[1];
    if (firstPlayer === undefined || secondPlayer === undefined) {
      throw new Error("Comparison requires exactly two player results.");
    }
    if (firstPlayer.result !== null && secondPlayer.result !== null
      && sameComparisonPlayer(firstPlayer.result.playerName, secondPlayer.result.playerName)) {
      players[1] = {
        ...secondPlayer,
        result: null,
        failureCode: "same-player",
        failureMessage: "both names resolved to the same player",
      };
      const secondMetric = playerMetrics[1];
      if (secondMetric !== undefined) {
        playerMetrics[1] = { ...secondMetric, failureCode: "same-player" };
      }
    }
    const finalFirstPlayer = players[0];
    const finalSecondPlayer = players[1];
    if (finalFirstPlayer === undefined || finalSecondPlayer === undefined) {
      throw new Error("Comparison requires exactly two player results.");
    }
    const analysis = buildCompareAnalysis(finalFirstPlayer, finalSecondPlayer, query.matchCount);
    const report: CompareReport = {
      requestedCount: query.matchCount,
      players,
      analysis,
      generatedAt: new Date().toISOString(),
    };
    const pages = formatCompareMessages(report);
    const delivery = await deliverPages(pages, statusMessageId, responder, budget, logger, updateId);

    const succeeded = players.filter((player): boolean => player.result !== null).length;
    const researchOutcome: Exclude<CompareCommandOutcome, "invalid" | "started"> = succeeded === 2
      ? "success"
      : succeeded === 1 ? "partial" : "failed";
    const outcome: Exclude<CompareCommandOutcome, "invalid" | "started"> = delivery.status === "complete"
      ? researchOutcome
      : delivery.status === "partial" && researchOutcome === "success"
        ? "partial"
        : delivery.status === "partial"
          ? researchOutcome
          : "failed";
    logger.info("Player comparison completed.", {
      updateId,
      phase: "report",
      durationMs: Date.now() - startedAt,
      requestedCount: query.matchCount,
      succeeded,
      failed: players.length - succeeded,
      pageCount: pages.length,
      playerMetrics,
      delivery,
      outcome,
    });
    return outcome;
  } catch (error: unknown) {
    logger.error("Player comparison failed before report delivery completed.", {
      updateId,
      phase: "report",
      durationMs: Date.now() - startedAt,
      requestedCount: query.matchCount,
      playerMetrics,
      failureCode: "COMPARE_REPORT_FAILED",
      errorType: safeErrorType(error),
      delivery: {
        status: "failed",
        attempted: 0,
        delivered: 0,
        failed: 0,
        skipped: 0,
        uncertain: false,
        failureCodes: ["COMPARE_REPORT_FAILED"],
      } satisfies CompareDeliveryOutcome,
    });
    return "failed";
  } finally {
    budget.close();
  }
}

async function researchPlayer(
  requestedName: string,
  matchCount: CompareQuery["matchCount"],
  statsService: PlayerStatsReader,
  budget: ReportBudget,
): Promise<ComparePlayerResearch> {
  if (budget.researchSignal.aborted || budget.researchRemainingMs() <= 0 || budget.remainingMs() <= 0) {
    return {
      requestedName,
      result: null,
      failureCode: "unstarted",
      failureMessage: "research was skipped because the research deadline was reached",
    };
  }

  try {
    const result = await raceWithReportDeadline(
      statsService.getPlayerStats(requestedName, matchCount, "dartsorakel", budget.researchSignal),
      budget.researchSignal,
      "research",
    );
    return { requestedName, result, failureCode: null, failureMessage: "" };
  } catch (error: unknown) {
    return {
      requestedName,
      result: null,
      failureCode: failureCode(error),
      failureMessage: failureMessage(error),
    };
  }
}

async function deliverPages(
  pages: readonly string[],
  statusMessageId: number,
  responder: CompareMessageResponder,
  budget: ReportBudget,
  logger: Logger,
  updateId: number,
): Promise<CompareDeliveryOutcome> {
  if (pages.length === 0) {
    logger.error("Player comparison report produced no pages.", {
      updateId,
      phase: "report",
      failureCode: "COMPARE_NO_REPORT_PAGES",
    });
    return {
      status: "failed",
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      uncertain: false,
      failureCodes: ["COMPARE_NO_REPORT_PAGES"],
    };
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let uncertain = false;
  const failureCodes: string[] = [];
  const firstPage = pages[0];

  if (firstPage !== undefined) {
    if (!canStartDelivery(budget)) {
      skipped = pages.length;
      failureCodes.push("COMPARE_DELIVERY_TIMEOUT");
      logger.warn("Player comparison report delivery skipped at the total deadline.", {
        updateId,
        phase: "report",
        deliveryStage: "edit",
        attempted,
        delivered,
        failed,
        skipped,
        uncertain,
        failureCode: "COMPARE_DELIVERY_TIMEOUT",
      });
    } else {
      attempted += 1;
      try {
        await raceWithReportDeadline(
          responder.edit(statusMessageId, firstPage, { signal: budget.totalSignal }),
          budget.totalSignal,
          "delivery",
        );
        delivered += 1;
      } catch (error: unknown) {
        failed += 1;
        uncertain = true;
        const code = deliveryFailureCode(error, "edit");
        failureCodes.push(code);
        logger.warn("Player comparison status edit failed; report delivery stopped.", {
          updateId,
          phase: "report",
          deliveryStage: "edit",
          attempted,
          delivered,
          failed,
          skipped: pages.length - attempted,
          uncertain,
          failureCode: code,
          errorType: safeErrorType(error),
        });
        skipped = pages.length - attempted;
      }
    }
  }

  if (failed === 0 && skipped === 0) {
    for (const page of pages.slice(1)) {
      if (!canStartDelivery(budget)) {
        skipped += pages.length - attempted;
        failureCodes.push("COMPARE_DELIVERY_TIMEOUT");
        logger.warn("Player comparison report pages skipped at the total deadline.", {
          updateId,
          phase: "report",
          deliveryStage: "page",
          attempted,
          delivered,
          failed,
          skipped,
          uncertain,
          failureCode: "COMPARE_DELIVERY_TIMEOUT",
        });
        break;
      }
      attempted += 1;
      try {
        await raceWithReportDeadline(
          responder.reply(page, { signal: budget.totalSignal }),
          budget.totalSignal,
          "delivery",
        );
        delivered += 1;
      } catch (error: unknown) {
        failed += 1;
        uncertain = true;
        const code = deliveryFailureCode(error, "reply");
        failureCodes.push(code);
        skipped = pages.length - attempted;
        logger.warn("Player comparison report page delivery failed; later pages skipped.", {
          updateId,
          phase: "report",
          deliveryStage: "page",
          attempted,
          delivered,
          failed,
          skipped,
          uncertain,
          failureCode: code,
          errorType: safeErrorType(error),
        });
        break;
      }
    }
  }

  const status: CompareDeliveryStatus = failed === 0 && skipped === 0
    ? "complete"
    : delivered > 0
      ? "partial"
      : "failed";
  return { status, attempted, delivered, failed, skipped, uncertain, failureCodes };
}

function failureCode(error: unknown): CompareFailureCode {
  if (isReportDeadlineExceeded(error)) return error.phase === "research" ? "timeout" : "failed";
  if (error instanceof PlayerNotFoundError) return "not-found";
  if (error instanceof PlayerAmbiguousError) return "ambiguous";
  if (error instanceof InsufficientMatchDataError) return "no-matches";
  if (error instanceof DartsOrakelRequestError) return error.status === undefined || error.status === 408 ? "timeout" : "unavailable";
  if (error instanceof DartsOrakelStructureChangedError || error instanceof ModusHistoryUnavailableError) return "unavailable";
  return "failed";
}

function failureMessage(error: unknown): string {
  if (isReportDeadlineExceeded(error)) {
    return error.phase === "research"
      ? "research timed out before this player was loaded"
      : "the comparison deadline was reached";
  }
  if (error instanceof PlayerNotFoundError) {
    const suggestions = error.suggestions.length === 0 ? "" : ` Suggestions: ${error.suggestions.join(", ")}.`;
    return `player not found.${suggestions}`;
  }
  if (error instanceof PlayerAmbiguousError) {
    const matches = error.matches.length === 0 ? "" : ` Matches: ${error.matches.join(", ")}.`;
    return `player name is ambiguous.${matches}`;
  }
  if (error instanceof InsufficientMatchDataError) return "no completed matches were found";
  if (error instanceof DartsOrakelRequestError) {
    return error.status === undefined || error.status === 408
      ? "statistics lookup timed out"
      : "statistics source is temporarily unavailable";
  }
  if (error instanceof DartsOrakelStructureChangedError || error instanceof ModusHistoryUnavailableError) {
    return "statistics source returned an unsupported response";
  }
  return "statistics lookup failed";
}

function canStartDelivery(budget: ReportBudget): boolean {
  return !budget.totalSignal.aborted && budget.remainingMs() > 0;
}

function deliveryFailureCode(error: unknown, stage: "ack" | "edit" | "reply"): string {
  if (isReportDeadlineExceeded(error)) {
    return stage === "ack" ? "COMPARE_ACK_TIMEOUT" : "COMPARE_DELIVERY_TIMEOUT";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return stage === "ack" ? "COMPARE_ACK_ABORTED" : "COMPARE_DELIVERY_ABORTED";
  }
  if (stage === "ack") return "COMPARE_ACK_SEND_FAILED";
  if (stage === "edit") return "COMPARE_EDIT_FAILED";
  return "COMPARE_PAGE_SEND_FAILED";
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

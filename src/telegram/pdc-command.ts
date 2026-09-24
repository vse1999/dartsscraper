import type { Logger } from "../logger.js";
import {
  createReportBudget,
  isReportDeadlineExceeded,
  raceWithReportDeadline,
  ReportDeadlineExceededError,
  type ReportBudget,
} from "../daily/report-budget.js";
import type { PdcTournamentResult } from "../pdc/schemas.js";
import type { PdcTournamentService, PdcUpcomingReport } from "../pdc/service.js";
import { formatPdcTournamentMessages, formatPdcUpcomingMessages } from "./pdc-formatter.js";
import type { BackgroundTaskScheduler } from "./modus-command.js";

export type PdcReportDateExpression = "today" | "tomorrow" | "latest";

export const PDC_REPORT_TOTAL_BUDGET_MS = 280_000;
export const PDC_REPORT_RESEARCH_BUDGET_MS = 220_000;

export interface PdcTournamentReader {
  getUpcomingReportForDate(
    date: string,
    signal?: AbortSignal,
    onPartial?: (report: PdcUpcomingReport) => void,
  ): Promise<PdcUpcomingReport>;
  getLatestResults(date: string, signal?: AbortSignal): Promise<readonly PdcTournamentResult[]>;
}

export interface PdcCommandResponder {
  reply(text: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface PdcReportBudgetOverrides {
  readonly totalMs?: number;
  readonly researchMs?: number;
  readonly now?: () => number;
}

export type PdcCommandOutcome = "invalid" | "unavailable" | "success" | "failed";

export function parsePdcReportCommand(text: string): PdcReportDateExpression | null {
  const match = /^\/pdc(?:@[A-Za-z0-9_]+)?(?:\s+(today|tomorrow|latest))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  const requested = match[1]?.toLocaleLowerCase("en-US");
  if (requested === "today" || requested === "latest") return requested;
  return "tomorrow";
}

export async function handlePdcReportCommand(
  text: string,
  reader: PdcTournamentReader | undefined,
  dateResolver: (expression: Exclude<PdcReportDateExpression, "latest">) => string,
  responder: PdcCommandResponder,
  logger: Logger,
  scheduleBackgroundTask?: BackgroundTaskScheduler,
  budgetOverrides?: PdcReportBudgetOverrides,
): Promise<PdcCommandOutcome> {
  const expression = parsePdcReportCommand(text);
  if (expression === null) {
    await responder.reply("Use /pdc today, /pdc tomorrow, or /pdc latest.");
    return "invalid";
  }
  if (reader === undefined) {
    await responder.reply("Automatic PDC tournament reporting is not configured.");
    return "unavailable";
  }

  const budget = createReportBudget({
    totalMs: budgetOverrides?.totalMs ?? PDC_REPORT_TOTAL_BUDGET_MS,
    researchMs: budgetOverrides?.researchMs ?? PDC_REPORT_RESEARCH_BUDGET_MS,
    ...(budgetOverrides?.now === undefined ? {} : { now: budgetOverrides.now }),
  });
  try {
    await raceWithReportDeadline(
      responder.reply(`🎯 Scanning PDC ${expression} tournaments…`, { signal: budget.totalSignal }),
      budget.totalSignal,
      "delivery",
    );
  } catch (error: unknown) {
    logger.warn("PDC tournament report acknowledgement failed.", {
      expression,
      failureCode: isReportDeadlineExceeded(error) ? "PDC_TOTAL_DEADLINE_EXCEEDED" : "PDC_ACK_SEND_FAILED",
    });
    budget.close();
    return "failed";
  }

  const task = runPdcReport(expression, reader, dateResolver, responder, logger, budget);
  if (expression !== "latest" && scheduleBackgroundTask !== undefined) {
    scheduleBackgroundTask(task.then((): void => undefined));
    return "success";
  }
  return task;
}

async function runPdcReport(
  expression: PdcReportDateExpression,
  reader: PdcTournamentReader,
  dateResolver: (expression: Exclude<PdcReportDateExpression, "latest">) => string,
  responder: PdcCommandResponder,
  logger: Logger,
  budget: ReportBudget,
): Promise<Exclude<PdcCommandOutcome, "invalid" | "unavailable">> {
  try {
    const latest = expression === "latest";
      const date = latest ? dateResolver("today") : dateResolver(expression);
    if (latest) {
      if (budget.researchSignal.aborted) throw new ReportDeadlineExceededError("research");
      const results = await raceWithReportDeadline(
        reader.getLatestResults(date, budget.researchSignal),
        budget.researchSignal,
        "research",
      );
      await sendPdcMessages(responder, formatPdcTournamentMessages(date, results, true), budget);
    } else {
      if (budget.researchSignal.aborted) throw new ReportDeadlineExceededError("research");
      let latestPartial: PdcUpcomingReport | undefined;
      let report: PdcUpcomingReport;
      try {
        report = await raceWithReportDeadline(
          reader.getUpcomingReportForDate(date, budget.researchSignal, (partial: PdcUpcomingReport): void => {
            latestPartial = partial;
          }),
          budget.researchSignal,
          "research",
        );
      } catch (error: unknown) {
        if (!isReportDeadlineExceeded(error) || latestPartial === undefined) throw error;
        await sendPdcMessages(responder, formatPdcUpcomingMessages(latestPartial), budget);
        return "failed";
      }
      await sendPdcMessages(responder, formatPdcUpcomingMessages(report), budget);
    }
    return "success";
  } catch (error: unknown) {
    logger.warn("PDC tournament report failed.", {
      expression,
      failureCode: "PDC_REPORT_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      if (!budget.totalSignal.aborted) {
        const message = isReportDeadlineExceeded(error)
          ? "⚠️ The PDC research deadline was reached before a complete report was available."
          : "The PDC tournament scan could not be completed. Please try again later.";
        await raceWithReportDeadline(
          responder.reply(message, { signal: budget.totalSignal }),
          budget.totalSignal,
          "delivery",
        );
      }
    } catch {
      logger.error("PDC tournament report failure message could not be delivered.", {
        expression,
        failureCode: "PDC_REPORT_FAILURE_SEND_FAILED",
      });
    }
    return "failed";
  } finally {
    budget.close();
  }
}

async function sendPdcMessages(
  responder: PdcCommandResponder,
  messages: readonly string[],
  budget: ReportBudget,
): Promise<void> {
  for (const message of messages) {
    if (budget.totalSignal.aborted) throw new Error("PDC report total deadline exceeded.");
    await raceWithReportDeadline(
      responder.reply(message, { signal: budget.totalSignal }),
      budget.totalSignal,
      "delivery",
    );
  }
}

export function asPdcTournamentReader(service: PdcTournamentService): PdcTournamentReader {
  return service;
}

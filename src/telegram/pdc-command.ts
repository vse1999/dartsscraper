import { ReportDeadlineExceededError, isReportDeadlineExceeded } from "../daily/report-budget.js";
import {
  runReportLifecycle,
  type ReportSession,
} from "../daily/report-lifecycle.js";
import type { Logger } from "../logger.js";
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

export interface PdcAcknowledgement {
  readonly messageId: number;
}

export interface PdcDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface PdcCommandResponder {
  /** Reply-only adapters remain valid; production adapters return the message id. */
  reply(text: string, options?: PdcDeliveryOptions): Promise<void | PdcAcknowledgement>;
  edit?(messageId: number, text: string, options?: PdcDeliveryOptions): Promise<void>;
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

  const lifecycle = await runReportLifecycle<PdcAcknowledgement | void, PdcCommandOutcome>({
    budget: {
      totalMs: budgetOverrides?.totalMs ?? PDC_REPORT_TOTAL_BUDGET_MS,
      researchMs: budgetOverrides?.researchMs ?? PDC_REPORT_RESEARCH_BUDGET_MS,
      ...(budgetOverrides?.now === undefined ? {} : { now: budgetOverrides.now }),
    },
    logger,
    safeContext: { command: "pdc", expression },
    acknowledge: (signal: AbortSignal): Promise<void | PdcAcknowledgement> => (
      responder.reply(`🎯 Scanning PDC ${expression} tournaments…`, { signal })
    ),
    report: (session: ReportSession): Promise<PdcCommandOutcome> => (
      runPdcReport(expression, reader, dateResolver, responder, logger, session)
    ),
    ...(expression === "latest" || scheduleBackgroundTask === undefined
      ? {}
      : { scheduleBackgroundTask }),
    ...(responder.edit === undefined
      ? {}
      : {
        schedulingFailureEdit: async (
          acknowledgement: PdcAcknowledgement | void,
          signal: AbortSignal,
        ): Promise<void> => {
          if (!isPdcAcknowledgement(acknowledgement)) return;
          await responder.edit?.(
            acknowledgement.messageId,
            "⚠️ The PDC report could not be scheduled. Please try again later.",
            { signal },
          );
        },
      }),
  });

  if (lifecycle.status === "completed") return lifecycle.result;
  if (lifecycle.status === "started") return "success";
  return "failed";
}

async function runPdcReport(
  expression: PdcReportDateExpression,
  reader: PdcTournamentReader,
  dateResolver: (expression: Exclude<PdcReportDateExpression, "latest">) => string,
  responder: PdcCommandResponder,
  logger: Logger,
  session: ReportSession,
): Promise<Exclude<PdcCommandOutcome, "invalid" | "unavailable">> {
  try {
    const latest = expression === "latest";
    const date = latest ? dateResolver("today") : dateResolver(expression);
    if (latest) {
      const results = await session.research(
        (signal: AbortSignal): Promise<readonly PdcTournamentResult[]> => (
          reader.getLatestResults(date, signal)
        ),
      );
      await sendPdcMessages(responder, formatPdcTournamentMessages(date, results, true), session);
    } else {
      let latestPartial: PdcUpcomingReport | undefined;
      let report: PdcUpcomingReport;
      try {
        report = await session.research(
          (signal: AbortSignal): Promise<PdcUpcomingReport> => reader.getUpcomingReportForDate(
            date,
            signal,
            (partial: PdcUpcomingReport): void => {
              latestPartial = partial;
            },
          ),
        );
      } catch (error: unknown) {
        if (!isReportDeadlineExceeded(error) || error.phase !== "research" || latestPartial === undefined) {
          throw error;
        }
        await sendPdcMessages(responder, formatPdcUpcomingMessages(latestPartial), session);
        return "failed";
      }
      await sendPdcMessages(responder, formatPdcUpcomingMessages(report), session);
    }
    return "success";
  } catch (error: unknown) {
    logger.warn("PDC tournament report failed.", {
      expression,
      failureCode: "PDC_REPORT_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      if (session.canDeliver()) {
        const message = isReportDeadlineExceeded(error)
          ? "⚠️ The PDC research deadline was reached before a complete report was available."
          : "The PDC tournament scan could not be completed. Please try again later.";
        await session.deliver(
          (signal: AbortSignal): Promise<void | PdcAcknowledgement> => responder.reply(message, { signal }),
        );
      }
    } catch {
      logger.error("PDC tournament report failure message could not be delivered.", {
        expression,
        failureCode: "PDC_REPORT_FAILURE_SEND_FAILED",
      });
    }
    return "failed";
  }
}

async function sendPdcMessages(
  responder: PdcCommandResponder,
  messages: readonly string[],
  session: ReportSession,
): Promise<void> {
  for (const message of messages) {
    if (!session.canDeliver()) throw new ReportDeadlineExceededError("delivery");
    await session.deliver(
      (signal: AbortSignal): Promise<void | PdcAcknowledgement> => responder.reply(message, { signal }),
    );
  }
}

function isPdcAcknowledgement(value: PdcAcknowledgement | void): value is PdcAcknowledgement {
  return value !== undefined && Number.isSafeInteger(value.messageId);
}

export function asPdcTournamentReader(service: PdcTournamentService): PdcTournamentReader {
  return service;
}

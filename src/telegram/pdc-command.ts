import { ReportDeadlineExceededError, isReportDeadlineExceeded } from "../daily/report-budget.js";
import {
  runReportLifecycle,
  type ReportSession,
} from "../daily/report-lifecycle.js";
import type { Logger } from "../logger.js";
import type { PdcTournamentResult } from "../pdc/schemas.js";
import type { PdcTournamentService, PdcUpcomingReport } from "../pdc/service.js";
import { formatPdcTournamentMessages, formatPdcUpcomingMessages } from "./pdc-formatter.js";
import type { ImageReport } from "./report-image.js";
import type { InlineKeyboardMarkup } from "grammy/types";
import { pdcImageReports, pdcPlayerKeyboard } from "./pdc-image-reports.js";
import { OfficialPdcScheduleUnavailableError } from "../pdc/official-api-fixture-source.js";
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
  replyReport?(report: ImageReport, options?: { readonly signal?: AbortSignal; readonly replyMarkup?: InlineKeyboardMarkup }): Promise<void>;
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
        await sendPdcUpcoming(responder, latestPartial, session);
        return "failed";
      }
      await sendPdcUpcoming(responder, report, session);
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
          : error instanceof OfficialPdcScheduleUnavailableError
            ? officialScheduleUnavailableMessage(error)
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

function officialScheduleUnavailableMessage(error: OfficialPdcScheduleUnavailableError): string {
  if (error.tournamentNames.length === 0) return "⚠️ The official PDC schedule could not be verified. This does not mean there are no matches. Please retry later.";
  const names = error.tournamentNames.slice(0, 10).map(name => name.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 160)).join(" · ");
  return [
    `🎯 PDC · ${error.date ?? "requested date"}`,
    `Official event found: ${names}`,
    "Named matchups are not yet published or could not be verified from the official draw. This is not a no-matches result.",
    ...(error.availableFixtures.length > 0 ? [`${error.availableFixtures.length} other official pairings were found, but the full slate is incomplete.`] : []),
    "No guessed pairings were used. Please retry later.",
    "Official schedule: https://www.pdc.tv/matches",
  ].join("\n");
}

async function sendPdcUpcoming(responder: PdcCommandResponder, report: PdcUpcomingReport, session: ReportSession): Promise<void> {
  if (responder.replyReport === undefined || report.fixtures.length === 0) {
    await sendPdcMessages(responder, formatPdcUpcomingMessages(report), session); return;
  }
  const reports = pdcImageReports(report);
  for (const [index, image] of reports.entries()) {
    if (!session.canDeliver()) throw new ReportDeadlineExceededError("delivery");
    await session.deliver(async (signal: AbortSignal): Promise<void> => {
      await responder.replyReport?.(image, { signal, ...(index === reports.length - 1 ? { replyMarkup: pdcPlayerKeyboard(report) } : {}) });
    });
  }
  // Schedule evidence remains text and detailed player rows are available through the keyboard instead of noisy automatic duplicates.
  const sources = [...new Set(report.fixtures.flatMap(f => f.evidenceUrls ?? [f.sourceUrl]))];
  const evidence = sources.map(url => `Schedule source: ${url}`);
  let text = "Tap a player for the supporting match rows.";
  for (const line of evidence) {
    if (text.length + line.length + 1 > 3800) { await sendPdcMessages(responder, [text], session); text = "Schedule evidence · continued"; }
    text += `\n${line}`;
  }
  await sendPdcMessages(responder, [text], session);
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

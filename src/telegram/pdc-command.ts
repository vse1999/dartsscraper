import type { Logger } from "../logger.js";
import type { PdcTournamentResult } from "../pdc/schemas.js";
import type { PdcTournamentService, PdcUpcomingReport } from "../pdc/service.js";
import { formatPdcTournamentMessages, formatPdcUpcomingMessages } from "./pdc-formatter.js";
import type { BackgroundTaskScheduler } from "./modus-command.js";

export type PdcReportDateExpression = "today" | "tomorrow" | "latest";

export interface PdcTournamentReader {
  getUpcomingReportForDate(date: string): Promise<PdcUpcomingReport>;
  getLatestResults(date: string): Promise<readonly PdcTournamentResult[]>;
}

export interface PdcCommandResponder {
  reply(text: string): Promise<void>;
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

  await responder.reply(`🎯 Scanning PDC ${expression} tournaments…`);
  const task = runPdcReport(expression, reader, dateResolver, responder, logger);
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
): Promise<Exclude<PdcCommandOutcome, "invalid" | "unavailable">> {
  try {
    const latest = expression === "latest";
    const date = latest ? dateResolver("today") : dateResolver(expression);
    if (latest) {
      const results = await reader.getLatestResults(date);
      for (const message of formatPdcTournamentMessages(date, results, true)) await responder.reply(message);
    } else {
      const report = await reader.getUpcomingReportForDate(date);
      for (const message of formatPdcUpcomingMessages(report)) await responder.reply(message);
    }
    return "success";
  } catch (error: unknown) {
    logger.warn("PDC tournament report failed.", {
      expression,
      failureCode: "PDC_REPORT_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      await responder.reply("The PDC tournament scan could not be completed. Please try again later.");
    } catch {
      logger.error("PDC tournament report failure message could not be delivered.", {
        expression,
        failureCode: "PDC_REPORT_FAILURE_SEND_FAILED",
      });
    }
    return "failed";
  }
}

export function asPdcTournamentReader(service: PdcTournamentService): PdcTournamentReader {
  return service;
}

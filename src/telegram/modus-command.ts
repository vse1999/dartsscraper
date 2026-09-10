import type { Logger } from "../logger.js";

export type ModusReportDateExpression = "today" | "tomorrow";

export interface ModusReportTrigger {
  start(date: ModusReportDateExpression): Promise<void>;
}

export interface ModusCommandResponder {
  reply(text: string): Promise<void>;
}

export type BackgroundTaskScheduler = (task: Promise<void>) => void;

export type ModusCommandOutcome = "invalid" | "unavailable" | "started" | "failed";

export function parseModusReportCommand(text: string): ModusReportDateExpression | null {
  const match = /^\/modus(?:@[A-Za-z0-9_]+)?(?:\s+(today|tomorrow))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  const requestedDate = match[1]?.toLocaleLowerCase("en-US");
  return requestedDate === "today" ? "today" : "tomorrow";
}

export async function handleModusReportCommand(
  text: string,
  trigger: ModusReportTrigger | undefined,
  responder: ModusCommandResponder,
  logger: Logger,
  scheduleBackgroundTask?: BackgroundTaskScheduler,
): Promise<ModusCommandOutcome> {
  const date = parseModusReportCommand(text);
  if (date === null) {
    await responder.reply("Use /modus today or /modus tomorrow.");
    return "invalid";
  }
  if (trigger === undefined) {
    await responder.reply("Automatic MODUS reporting is not configured.");
    return "unavailable";
  }

  await responder.reply(`🎯 Starting MODUS ${date} report…`);
  const task = runTrigger(date, trigger, responder, logger);
  if (scheduleBackgroundTask !== undefined) {
    scheduleBackgroundTask(task.then((): void => undefined));
    return "started";
  }
  return task;
}

async function runTrigger(
  date: ModusReportDateExpression,
  trigger: ModusReportTrigger,
  responder: ModusCommandResponder,
  logger: Logger,
): Promise<Exclude<ModusCommandOutcome, "invalid" | "unavailable">> {
  try {
    await trigger.start(date);
    return "started";
  } catch (error: unknown) {
    logger.warn("Manual MODUS report trigger failed.", {
      requestedDate: date,
      failureCode: "MODUS_REPORT_TRIGGER_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      await responder.reply("The MODUS report could not be completed. Please try again later.");
    } catch {
      logger.error("Manual MODUS report failure message could not be delivered.", {
        requestedDate: date,
        failureCode: "MODUS_REPORT_TRIGGER_FAILURE_SEND_FAILED",
      });
    }
    return "failed";
  }
}

import type { Logger } from "../logger.js";

export type ModusReportDateExpression = "today" | "tomorrow";

export interface ModusReportTrigger {
  start(date: ModusReportDateExpression): Promise<void>;
}

export interface ModusCommandResponder {
  reply(text: string): Promise<void>;
}

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
  try {
    await trigger.start(date);
    return "started";
  } catch (error: unknown) {
    logger.warn("Manual MODUS report trigger failed.", {
      requestedDate: date,
      failureCode: "MODUS_REPORT_TRIGGER_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    await responder.reply("The MODUS report could not be started. Please try again later.");
    return "failed";
  }
}

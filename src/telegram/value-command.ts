import { isReportDeadlineExceeded } from "../daily/report-budget.js";
import { runReportLifecycle, type ReportSession } from "../daily/report-lifecycle.js";
import type { Logger } from "../logger.js";
import type { ValueReader, ValueReaderDay, ValueReport } from "../value/contracts.js";
import { formatValueMessages } from "./value-formatter.js";
import type { BackgroundTaskScheduler } from "./modus-command.js";

/** Keep the webhook inside Vercel's 300 second limit and reserve delivery time. */
export const VALUE_REPORT_TOTAL_BUDGET_MS = 270_000;
export const VALUE_REPORT_RESEARCH_BUDGET_MS = 240_000;
export const VALUE_TOTAL_BUDGET_MS = VALUE_REPORT_TOTAL_BUDGET_MS;
export const VALUE_RESEARCH_BUDGET_MS = VALUE_REPORT_RESEARCH_BUDGET_MS;
export type ValueDay = ValueReaderDay;

export interface ValueAcknowledgement {
  readonly messageId: number;
}

export interface ValueDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface ValueCommandResponder {
  reply(text: string, options?: ValueDeliveryOptions): Promise<void | ValueAcknowledgement>;
  edit?(messageId: number, text: string, options?: ValueDeliveryOptions): Promise<void>;
}

export interface ValueBudgetOverrides {
  readonly totalMs?: number;
  readonly researchMs?: number;
  readonly now?: () => number;
}

export type ValueCommandOutcome = "invalid" | "unavailable" | "started" | "empty" | "success" | "partial" | "failed";

export function parseValueCommand(text: string): ValueReaderDay | null {
  const match = /^\/value(?:@[A-Za-z0-9_]+)?(?:\s+(today|tomorrow))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  return match[1]?.toLocaleLowerCase("en-US") === "tomorrow" ? "tomorrow" : "today";
}

export async function handleValueCommand(
  text: string,
  reader: ValueReader | undefined,
  responder: ValueCommandResponder,
  logger: Logger,
  scheduleBackgroundTask?: BackgroundTaskScheduler,
  budgetOverrides?: ValueBudgetOverrides,
): Promise<ValueCommandOutcome> {
  const day = parseValueCommand(text);
  if (day === null) {
    await responder.reply("Use /value today or /value tomorrow.");
    return "invalid";
  }
  if (reader === undefined) {
    await responder.reply("Value research is disabled. Set ODDS_FETCH_ENABLED=true in the deployment environment, then redeploy.");
    return "unavailable";
  }

  const lifecycle = await runReportLifecycle<ValueAcknowledgement | void, ValueCommandOutcome>({
    budget: {
      totalMs: budgetOverrides?.totalMs ?? VALUE_REPORT_TOTAL_BUDGET_MS,
      researchMs: budgetOverrides?.researchMs ?? VALUE_REPORT_RESEARCH_BUDGET_MS,
      ...(budgetOverrides?.now === undefined ? {} : { now: budgetOverrides.now }),
    },
    logger,
    safeContext: { command: "value", day },
    acknowledge: (signal: AbortSignal): Promise<void | ValueAcknowledgement> => responder.reply(
      `📊 Collecting ${day} odds and recent statistics…`,
      { signal },
    ),
    report: (session: ReportSession, acknowledgement: ValueAcknowledgement | void): Promise<ValueCommandOutcome> => executeValueReport(
      day,
      reader,
      responder,
      logger,
      session,
      acknowledgement,
    ),
    ...(scheduleBackgroundTask === undefined ? {} : { scheduleBackgroundTask }),
    ...(responder.edit === undefined ? {} : {
      schedulingFailureEdit: (acknowledgement: ValueAcknowledgement | void, signal: AbortSignal): Promise<void> => {
        if (!isValueAcknowledgement(acknowledgement)) return Promise.resolve();
        return responder.edit?.(
          acknowledgement.messageId,
          "⚠️ The value report could not be scheduled. Please try again later.",
          { signal },
        ) ?? Promise.resolve();
      },
    }),
  });

  if (lifecycle.status === "completed") return lifecycle.result;
  if (lifecycle.status === "started") return "started";
  return "failed";
}

async function executeValueReport(
  day: ValueReaderDay,
  reader: ValueReader,
  responder: ValueCommandResponder,
  logger: Logger,
  session: ReportSession,
  acknowledgement: ValueAcknowledgement | void,
): Promise<Exclude<ValueCommandOutcome, "invalid" | "unavailable" | "started">> {
  try {
    const report = await session.research((signal: AbortSignal): Promise<ValueReport> => reader.getReport(day, signal));
    const messages = formatValueMessages(report);
    await deliverValueMessages(messages, acknowledgement, responder, session);
    const outcome: Exclude<ValueCommandOutcome, "invalid" | "unavailable" | "started"> = report.cards.length === 0
      ? "empty"
      : report.status === "partial" || report.cards.some((card): boolean => card.status !== "complete")
        ? "partial"
        : "success";
    logger.info("Value research completed.", {
      command: "value",
      day,
      date: report.odds.date,
      returnedCount: report.cards.length,
      status: report.status,
    });
    return outcome;
  } catch (error: unknown) {
    logger.warn("Value research failed.", {
      command: "value",
      day,
      failureCode: isReportDeadlineExceeded(error) ? "VALUE_TIMEOUT" : "VALUE_LOOKUP_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    if (!session.canDeliver()) throw new ValueReportHandledFailure();
    const message = isReportDeadlineExceeded(error)
      ? "⚠️ Value research timed out before a complete result was available."
      : "The value research could not be completed. Please try again later.";
    try {
      await session.deliver((signal: AbortSignal): Promise<void> => deliverFinalMessage(
        message,
        acknowledgement,
        responder,
        signal,
      ));
    } catch (deliveryError: unknown) {
      logger.warn("Value research failure message could not be delivered.", {
        command: "value",
        failureCode: "VALUE_FAILURE_DELIVERY_FAILED",
        errorType: deliveryError instanceof Error ? deliveryError.name : "UnknownError",
      });
    }
    throw new ValueReportHandledFailure();
  }
}

class ValueReportHandledFailure extends Error {
  public constructor() {
    super("The value report failed after a safe user notice was attempted.");
    this.name = "ValueReportHandledFailure";
  }
}

async function deliverValueMessages(
  messages: readonly string[],
  acknowledgement: ValueAcknowledgement | void,
  responder: ValueCommandResponder,
  session: ReportSession,
): Promise<void> {
  const first = messages[0];
  if (first === undefined) return;
  await session.deliver((signal: AbortSignal): Promise<void> => deliverFinalMessage(
    first,
    acknowledgement,
    responder,
    signal,
  ));
  for (const message of messages.slice(1)) {
    if (!session.canDeliver()) throw new Error("Value report delivery deadline exceeded.");
    await session.deliver((signal: AbortSignal): Promise<void | ValueAcknowledgement> => responder.reply(
      message,
      { signal },
    ));
  }
}

function deliverFinalMessage(
  message: string,
  acknowledgement: ValueAcknowledgement | void,
  responder: ValueCommandResponder,
  signal: AbortSignal,
): Promise<void> {
  if (responder.edit !== undefined && isValueAcknowledgement(acknowledgement)) {
    return responder.edit(acknowledgement.messageId, message, { signal });
  }
  return responder.reply(message, { signal }).then((): void => undefined);
}

function isValueAcknowledgement(value: ValueAcknowledgement | void): value is ValueAcknowledgement {
  return value !== undefined && Number.isSafeInteger(value.messageId) && value.messageId > 0;
}

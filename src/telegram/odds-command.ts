import { isReportDeadlineExceeded, ReportDeadlineExceededError } from "../daily/report-budget.js";
import { runReportLifecycle, type ReportSession } from "../daily/report-lifecycle.js";
import type { Logger } from "../logger.js";
import type { OddsDay, OddsReader, OddsReport } from "../odds/contracts.js";
import { formatOddsMessages } from "./odds-formatter.js";
import type { BackgroundTaskScheduler } from "./modus-command.js";

export const ODDS_REPORT_TOTAL_BUDGET_MS = 70_000;
export const ODDS_REPORT_RESEARCH_BUDGET_MS = 45_000;
/** Short aliases for callers that only need the limits. */
export const ODDS_TOTAL_BUDGET_MS = ODDS_REPORT_TOTAL_BUDGET_MS;
export const ODDS_RESEARCH_BUDGET_MS = ODDS_REPORT_RESEARCH_BUDGET_MS;

export interface OddsAcknowledgement {
  readonly messageId: number;
}

export interface OddsDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface OddsCommandResponder {
  reply(text: string, options?: OddsDeliveryOptions): Promise<void | OddsAcknowledgement>;
  edit?(messageId: number, text: string, options?: OddsDeliveryOptions): Promise<void>;
}

export interface OddsBudgetOverrides {
  readonly totalMs?: number;
  readonly researchMs?: number;
  readonly now?: () => number;
}

export type OddsCommandOutcome = "invalid" | "unavailable" | "empty" | "success" | "failed";

export function parseOddsCommand(text: string): OddsDay | null {
  const match = /^\/odds(?:@[A-Za-z0-9_]+)?(?:\s+(today|tomorrow))?\s*$/iu.exec(text.trim());
  if (match === null) return null;
  const requested = match[1]?.toLocaleLowerCase("en-US");
  return requested === "tomorrow" ? "tomorrow" : "today";
}

export async function handleOddsCommand(
  text: string,
  reader: OddsReader | undefined,
  responder: OddsCommandResponder,
  logger: Logger,
  scheduleBackgroundTask?: BackgroundTaskScheduler,
  budgetOverrides?: OddsBudgetOverrides,
): Promise<OddsCommandOutcome> {
  const day = parseOddsCommand(text);
  if (day === null) {
    await responder.reply("Use /odds today or /odds tomorrow.");
    return "invalid";
  }
  if (reader === undefined) {
    await responder.reply("Live odds are disabled. Set ODDS_FETCH_ENABLED=true in the deployment environment, then redeploy.");
    return "unavailable";
  }

  const lifecycle = await runReportLifecycle<OddsAcknowledgement | void, OddsCommandOutcome>({
    budget: {
      totalMs: budgetOverrides?.totalMs ?? ODDS_REPORT_TOTAL_BUDGET_MS,
      researchMs: budgetOverrides?.researchMs ?? ODDS_REPORT_RESEARCH_BUDGET_MS,
      ...(budgetOverrides?.now === undefined ? {} : { now: budgetOverrides.now }),
    },
    logger,
    safeContext: { command: "odds", day },
    acknowledge: (signal: AbortSignal): Promise<void | OddsAcknowledgement> => responder.reply(
      `🎲 Fetching ${day} odds…`,
      { signal },
    ),
    report: (session: ReportSession, acknowledgement: OddsAcknowledgement | void): Promise<OddsCommandOutcome> => (
      executeOddsReport(day, reader, responder, logger, session, acknowledgement)
    ),
    ...(scheduleBackgroundTask === undefined ? {} : { scheduleBackgroundTask }),
    ...(responder.edit === undefined ? {} : {
      schedulingFailureEdit: (acknowledgement: OddsAcknowledgement | void, signal: AbortSignal): Promise<void> => {
        if (!isOddsAcknowledgement(acknowledgement)) return Promise.resolve();
        return responder.edit?.(
          acknowledgement.messageId,
          "⚠️ The odds lookup could not be scheduled. Please try again later.",
          { signal },
        ) ?? Promise.resolve();
      },
    }),
  });

  if (lifecycle.status === "completed") return lifecycle.result;
  if (lifecycle.status === "started") return "success";
  return "failed";
}

async function executeOddsReport(
  day: OddsDay,
  reader: OddsReader,
  responder: OddsCommandResponder,
  logger: Logger,
  session: ReportSession,
  acknowledgement: OddsAcknowledgement | void,
): Promise<Exclude<OddsCommandOutcome, "invalid" | "unavailable">> {
  try {
    const report = await session.research((signal: AbortSignal): Promise<OddsReport> => reader.getOdds(day, signal));
    const messages = formatOddsMessages(report);
    await deliverOddsMessages(messages, acknowledgement, responder, session);
    const outcome: Exclude<OddsCommandOutcome, "invalid" | "unavailable"> = report.matches.length === 0 ? "empty" : "success";
    logger.info("Odds lookup completed.", {
      command: "odds",
      day,
      date: report.date,
      returnedCount: report.matches.length,
      source: report.source,
    });
    return outcome;
  } catch (error: unknown) {
    logger.warn("Odds lookup failed.", {
      command: "odds",
      day,
      failureCode: isReportDeadlineExceeded(error) ? "ODDS_TIMEOUT" : "ODDS_LOOKUP_FAILED",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    if (!session.canDeliver()) throw new OddsReportHandledFailure();
    const message = isReportDeadlineExceeded(error)
      ? "⚠️ The odds lookup timed out before a complete result was available."
      : "The live odds lookup could not be completed. Please try again later.";
    try {
      await session.deliver((signal: AbortSignal): Promise<void> => deliverFinalMessage(
        message,
        acknowledgement,
        responder,
        signal,
      ));
    } catch (deliveryError: unknown) {
      logger.warn("Odds lookup failure message could not be delivered.", {
        command: "odds",
        failureCode: "ODDS_FAILURE_DELIVERY_FAILED",
        errorType: deliveryError instanceof Error ? deliveryError.name : "UnknownError",
      });
    }
    // The user-facing failure notice has been attempted above. Re-throw a
    // safe marker so the shared lifecycle records this run as failed rather
    // than logging a generic successful completion for a handled error.
    throw new OddsReportHandledFailure();
  }
}

class OddsReportHandledFailure extends Error {
  public constructor() {
    super("The odds report failed after a safe user notice was attempted.");
    this.name = "OddsReportHandledFailure";
  }
}

async function deliverOddsMessages(
  messages: readonly string[],
  acknowledgement: OddsAcknowledgement | void,
  responder: OddsCommandResponder,
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
    if (!session.canDeliver()) throw new ReportDeadlineExceededError("delivery");
    await session.deliver((signal: AbortSignal): Promise<void | OddsAcknowledgement> => responder.reply(
      message,
      { signal },
    ));
  }
}

function deliverFinalMessage(
  message: string,
  acknowledgement: OddsAcknowledgement | void,
  responder: OddsCommandResponder,
  signal: AbortSignal,
): Promise<void> {
  if (responder.edit !== undefined && isOddsAcknowledgement(acknowledgement)) {
    return responder.edit(acknowledgement.messageId, message, { signal });
  }
  return responder.reply(message, { signal }).then((): void => undefined);
}

function isOddsAcknowledgement(value: OddsAcknowledgement | void): value is OddsAcknowledgement {
  return value !== undefined && Number.isSafeInteger(value.messageId) && value.messageId > 0;
}

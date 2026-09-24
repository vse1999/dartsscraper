import {
  createReportBudget,
  isReportDeadlineExceeded,
  raceWithReportDeadline,
  ReportDeadlineExceededError,
  type ReportBudget,
  type ReportBudgetOptions,
} from "./report-budget.js";
import type { Logger } from "../logger.js";

export type ReportLifecyclePhase = "acknowledgement" | "scheduling" | "execution";

export type ReportLifecycleResult<TResult> =
  | { readonly status: "completed"; readonly result: TResult }
  | { readonly status: "started" }
  | { readonly status: "failed"; readonly phase: ReportLifecyclePhase };

export interface ReportSession {
  research<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  deliver<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  canResearch(): boolean;
  canDeliver(): boolean;
}

export type ReportBackgroundTaskScheduler = (task: Promise<void>) => void;

export interface ReportLifecycleOptions<TAck, TResult> {
  readonly budget: ReportBudgetOptions;
  readonly logger: Logger;
  readonly safeContext?: Readonly<Record<string, unknown>>;
  readonly acknowledge: (signal: AbortSignal) => Promise<TAck>;
  readonly report: (session: ReportSession, acknowledgement: TAck) => Promise<TResult>;
  readonly scheduleBackgroundTask?: ReportBackgroundTaskScheduler;
  readonly schedulingFailureEdit?: (acknowledgement: TAck, signal: AbortSignal) => Promise<void>;
}

/**
 * Owns the bounded lifecycle shared by report commands. In particular, the
 * scheduler receives a gated task so a rejected registration cannot start
 * research as a foreground fallback. Report callbacks must route every
 * external asynchronous operation through the session methods; those methods
 * are the bounded operation boundary and preserve command delivery accounting.
 */
export async function runReportLifecycle<TAck, TResult>(
  options: ReportLifecycleOptions<TAck, TResult>,
): Promise<ReportLifecycleResult<TResult>> {
  const budget = createReportBudget(options.budget);
  const sessionState = createSession(budget, options.logger, options.safeContext);
  const session = sessionState.session;

  let acknowledgement: TAck;
  try {
    acknowledgement = await session.deliver(options.acknowledge);
    logSafely(options.logger, "info", "Report acknowledgement delivered.", {
      ...(options.safeContext ?? {}),
      phase: "acknowledgement",
    });
  } catch (error: unknown) {
    logSafely(options.logger, "warn", "Report acknowledgement failed.", {
      ...(options.safeContext ?? {}),
      phase: "acknowledgement",
      failureCode: lifecycleFailureCode(error, "acknowledgement"),
      errorType: safeErrorType(error),
      uncertain: sessionState.isDeliveryUncertain(),
    });
    budget.close();
    return { status: "failed", phase: "acknowledgement" };
  }

  if (options.scheduleBackgroundTask !== undefined) {
    const gate = createAcceptanceGate();
    const task = gate.promise.then(
      (): Promise<void> => executeBackgroundReport(options, session, budget, acknowledgement),
      (): void => undefined,
    );
    try {
      options.scheduleBackgroundTask(task);
      gate.accept();
      logSafely(options.logger, "info", "Report background work scheduled.", {
        ...(options.safeContext ?? {}),
        phase: "scheduling",
      });
      return { status: "started" };
    } catch (error: unknown) {
      gate.reject();
      logSafely(options.logger, "error", "Report background work could not be scheduled.", {
        ...(options.safeContext ?? {}),
        phase: "scheduling",
        failureCode: "REPORT_SCHEDULE_FAILED",
        errorType: safeErrorType(error),
      });
      await trySchedulingFailureEdit(options, session, acknowledgement);
      budget.close();
      return { status: "failed", phase: "scheduling" };
    }
  }

  try {
    const result = await executeReport(options, session, acknowledgement);
    logSafely(options.logger, "info", "Report lifecycle completed.", {
      ...(options.safeContext ?? {}),
      phase: "completion",
      status: "completed",
    });
    budget.close();
    return { status: "completed", result };
  } catch (error: unknown) {
    logSafely(options.logger, "error", "Report execution failed.", {
      ...(options.safeContext ?? {}),
      phase: "execution",
      failureCode: "REPORT_EXECUTION_FAILED",
      errorType: safeErrorType(error),
    });
    budget.close();
    return { status: "failed", phase: "execution" };
  }
}

interface SessionState {
  readonly session: ReportSession;
  isDeliveryUncertain(): boolean;
}

function createSession(
  budget: ReportBudget,
  logger: Logger,
  context: Readonly<Record<string, unknown>> | undefined,
): SessionState {
  let deliveryUncertain = false;

  const canResearch = (): boolean => !budget.researchSignal.aborted
    && !budget.totalSignal.aborted
    && budget.researchRemainingMs() > 0
    && budget.remainingMs() > 0;
  const canDeliver = (): boolean => !deliveryUncertain
    && !budget.totalSignal.aborted
    && budget.remainingMs() > 0;

  const research = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!canResearch()) throw new ReportDeadlineExceededError("research");
    let pending: Promise<T>;
    try {
      pending = operation(budget.researchSignal);
    } catch (error: unknown) {
      pending = Promise.reject(error);
    }
    return raceWithReportDeadline(pending, budget.researchSignal, "research");
  };

  const deliver = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!canDeliver()) throw new ReportDeadlineExceededError("delivery");
    let pending: Promise<T>;
    try {
      pending = operation(budget.totalSignal);
    } catch (error: unknown) {
      pending = Promise.reject(error);
    }
    try {
      return await raceWithReportDeadline(pending, budget.totalSignal, "delivery");
    } catch (error: unknown) {
      deliveryUncertain = true;
      logSafely(logger, "warn", "Report delivery failed; later deliveries stopped.", {
        ...(context ?? {}),
        phase: "delivery",
        failureCode: deliveryFailureCode(error),
        errorType: safeErrorType(error),
        uncertain: true,
      });
      throw error;
    }
  };

  return {
    session: {
      research,
      deliver,
      canResearch,
      canDeliver,
    },
    isDeliveryUncertain: (): boolean => deliveryUncertain,
  };
}

async function executeReport<TAck, TResult>(
  options: ReportLifecycleOptions<TAck, TResult>,
  session: ReportSession,
  acknowledgement: TAck,
): Promise<TResult> {
  if (!session.canResearch() && !session.canDeliver()) throw new ReportDeadlineExceededError("total");
  let pending: Promise<TResult>;
  try {
    pending = options.report(session, acknowledgement);
  } catch (error: unknown) {
    pending = Promise.reject(error);
  }
  return pending;
}

async function executeBackgroundReport<TAck, TResult>(
  options: ReportLifecycleOptions<TAck, TResult>,
  session: ReportSession,
  budget: ReportBudget,
  acknowledgement: TAck,
): Promise<void> {
  try {
    await executeReport(options, session, acknowledgement);
    logSafely(options.logger, "info", "Report lifecycle completed.", {
      ...(options.safeContext ?? {}),
      phase: "completion",
      status: "completed",
    });
  } catch (error: unknown) {
    logSafely(options.logger, "error", "Report background work failed.", {
      ...(options.safeContext ?? {}),
      phase: "execution",
      failureCode: "REPORT_EXECUTION_FAILED",
      errorType: safeErrorType(error),
    });
  } finally {
    budget.close();
  }
}

async function trySchedulingFailureEdit<TAck, TResult>(
  options: ReportLifecycleOptions<TAck, TResult>,
  session: ReportSession,
  acknowledgement: TAck,
): Promise<void> {
  if (options.schedulingFailureEdit === undefined || !session.canDeliver()) return;
  try {
    await session.deliver((signal: AbortSignal): Promise<void> => options.schedulingFailureEdit?.(acknowledgement, signal) ?? Promise.resolve());
  } catch (error: unknown) {
    logSafely(options.logger, "warn", "Report scheduling failure acknowledgement edit was not delivered.", {
      ...(options.safeContext ?? {}),
      phase: "scheduling",
      failureCode: "REPORT_SCHEDULE_EDIT_FAILED",
      errorType: safeErrorType(error),
    });
  }
}

interface AcceptanceGate {
  readonly promise: Promise<void>;
  accept(): void;
  reject(): void;
}

function createAcceptanceGate(): AcceptanceGate {
  let resolveGate: (() => void) | undefined;
  let rejectGate: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject): void => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return {
    promise,
    accept: (): void => { resolveGate?.(); },
    reject: (): void => { rejectGate?.(); },
  };
}

function lifecycleFailureCode(error: unknown, phase: ReportLifecyclePhase): string {
  if (isReportDeadlineExceeded(error)) return `REPORT_${phase.toUpperCase()}_TIMEOUT`;
  return `REPORT_${phase.toUpperCase()}_FAILED`;
}

function deliveryFailureCode(error: unknown): string {
  if (isReportDeadlineExceeded(error)) return "REPORT_DELIVERY_TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "REPORT_DELIVERY_ABORTED";
  return "REPORT_DELIVERY_FAILED";
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

type LifecycleLogLevel = "debug" | "info" | "warn" | "error";

function logSafely(
  logger: Logger,
  level: LifecycleLogLevel,
  message: string,
  context: Readonly<Record<string, unknown>>,
): void {
  try {
    if (level === "debug") logger.debug(message, context);
    else if (level === "info") logger.info(message, context);
    else if (level === "warn") logger.warn(message, context);
    else logger.error(message, context);
  } catch {
    // Logging is observability only and must never prevent lifecycle cleanup.
  }
}


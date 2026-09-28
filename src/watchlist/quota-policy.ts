import {
  CADENCE_OPTIONS,
  MAX_WATCHLIST_TICK_UNITS,
  WatchlistQuotaPolicyInputSchema,
  type CandidateFailure,
  type CandidateResult,
  type CandidateSuccess,
  type ParsedContext,
  type SimulatedWindow,
  type WatchlistCadenceMinutes,
  type WatchlistQuotaPausedReason,
  type WatchlistQuotaPolicyDecision,
  type WatchlistQuotaResourceInput,
  type WatchlistQuotaResourceReservation,
  type WatchlistQuotaWindow,
  type WatchlistTickResourceUpperBound,
} from "./quota-policy-model.js";

export {
  DEFAULT_WATCHLIST_SAFETY_FRACTION,
  MAX_WATCHLIST_SAFETY_FRACTION,
  MAX_WATCHLIST_RESOURCES,
  MAX_WATCHLIST_WINDOWS_PER_RESOURCE,
  MAX_WATCHLIST_SESSION_DURATION_MS,
  MAX_WATCHLIST_RESOURCE_UNITS,
  MAX_WATCHLIST_TICK_UNITS,
  WATCHLIST_CADENCE_MINUTES,
  WatchlistQuotaPolicyInputSchema,
} from "./quota-policy-model.js";

export type {
  WatchlistCadenceMinutes,
  WatchlistQuotaPolicyInput,
  WatchlistQuotaWindow,
  WatchlistTickResourceUpperBound,
  WatchlistQuotaResourceInput,
  WatchlistQuotaPausedReason,
  WatchlistQuotaCoverageState,
  WatchlistQuotaCoverage,
  WatchlistQuotaResourceReservation,
  WatchlistQuotaReservationProposal,
  WatchlistQuotaPolicyDecision,
} from "./quota-policy-model.js";

/**
 * Evaluate a bounded, measured quota proposal without mutating quota state.
 *
 * The returned proposal is advisory until a durable compare-and-swap commits
 * it. A caller must commit that reservation before starting external work.
 */
export function evaluateWatchlistQuotaPolicy(
  input: unknown,
  now: Date,
): WatchlistQuotaPolicyDecision {
  const parsed = WatchlistQuotaPolicyInputSchema.safeParse(input);
  const context = parsed.success ? parseContext(parsed.data) : invalidContext(input);

  if (!parsed.success || context.sessionStartAt === null || context.sessionEndAt === null) {
    return pausedDecision(
      "INVALID_INPUT",
      "Quota policy input must contain bounded timestamps, cadence, resources, and allowance windows.",
      context,
    );
  }

  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) {
    return pausedDecision("INVALID_INPUT", "The injected quota-policy clock is invalid.", context);
  }

  if (!parsed.data.zeroSpendEntitlementProven) {
    return pausedDecision(
      "ZERO_SPEND_UNVERIFIED",
      "Zero-spend entitlement is not proven; keep watchlist collection paused.",
      context,
    );
  }
  if (nowMs < context.sessionStartAt) {
    return pausedDecision("SESSION_NOT_STARTED", "The monitored session has not started.", context);
  }
  if (nowMs >= context.sessionEndAt) {
    return pausedDecision("SESSION_ENDED", "The monitored session has ended.", context);
  }

  if (parsed.data.resources.some((resource): boolean => hasUnknownCost(resource.tickUpperBound))) {
    return pausedDecision(
      "UNKNOWN_RESOURCE_COSTS",
      "A complete-tick resource upper bound is unknown; do not spend against an unmeasured quota.",
      context,
    );
  }

  const activeWindowReason = validateCurrentAllowanceWindows(parsed.data.resources, nowMs);
  if (activeWindowReason !== null) {
    return pausedDecision(activeWindowReason, allowanceWindowMessage(activeWindowReason), context);
  }

  // Evaluate through the session boundary. Each tick is assigned to exactly
  // one non-overlapping allowance window, so an adjacent reset is usable
  // without crediting the same tick against both windows.
  const evaluationHorizon = context.sessionEndAt;
  const candidates = CADENCE_OPTIONS[parsed.data.requestedCadenceMinutes];
  const results = candidates.map((cadence): CandidateResult => (
    evaluateCadence(parsed.data, nowMs, cadence, evaluationHorizon)
  ));
  const successful = results.find((result): result is CandidateSuccess => "tickTimes" in result);

  if (successful !== undefined) {
    const degraded = successful.cadence !== parsed.data.requestedCadenceMinutes;
    const tickAt = successful.tickTimes[0];
    if (tickAt === undefined) {
      return pausedDecision(
        "SESSION_WINDOW_TOO_SHORT",
        "No next tick fits inside the monitored session.",
        context,
      );
    }

    const tickAtIso = new Date(tickAt).toISOString();
    return {
      allowed: true,
      paused: false,
      effectiveCadenceMinutes: successful.cadence,
      pausedReason: null,
      nextTickAt: tickAtIso,
      reservation: {
        tickAt: tickAtIso,
        resources: successful.firstReservations,
        requiresDurableCompareAndSwap: true,
      },
      coverage: {
        requestedCadenceMinutes: parsed.data.requestedCadenceMinutes,
        effectiveCadenceMinutes: successful.cadence,
        plannedTickCount: successful.tickTimes.length,
        evaluatedThroughAt: new Date(successful.evaluatedThroughAt).toISOString(),
        degraded,
        state: degraded ? "slower_cadence" : "normal",
      },
      message: degraded
        ? `The requested cadence does not fit the measured safe quota; use ${successful.cadence} minutes after durable reservation.`
        : "The next complete tick fits the measured safe quota after existing usage and reservations.",
    };
  }

  const reason = chooseFailureReason(results);
  return pausedDecision(reason, failureMessage(reason), context);
}

function parseContext(input: {
  readonly session: { readonly startAt: string; readonly endAt: string };
  readonly requestedCadenceMinutes: WatchlistCadenceMinutes;
}): ParsedContext {
  const sessionStartAt = Date.parse(input.session.startAt);
  const sessionEndAt = Date.parse(input.session.endAt);
  return {
    requestedCadenceMinutes: input.requestedCadenceMinutes,
    sessionStartAt: Number.isFinite(sessionStartAt) ? sessionStartAt : null,
    sessionEndAt: Number.isFinite(sessionEndAt) ? sessionEndAt : null,
  };
}

function invalidContext(input: unknown): ParsedContext {
  if (!isRecord(input)) {
    return { requestedCadenceMinutes: null, sessionStartAt: null, sessionEndAt: null };
  }

  const candidate = input["requestedCadenceMinutes"];
  const requestedCadenceMinutes = isCadence(candidate) ? candidate : null;
  return { requestedCadenceMinutes, sessionStartAt: null, sessionEndAt: null };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isCadence(value: unknown): value is WatchlistCadenceMinutes {
  return value === 5 || value === 10 || value === 15;
}

function evaluateCadence(
  input: {
    readonly resources: readonly WatchlistQuotaResourceInput[];
    readonly safetyFraction: number;
  },
  nowMs: number,
  cadence: WatchlistCadenceMinutes,
  evaluationHorizon: number,
): CandidateResult {
  const cadenceMs = cadence * 60_000;
  const firstTick = nowMs + cadenceMs;
  if (!Number.isSafeInteger(firstTick) || firstTick <= nowMs || firstTick >= evaluationHorizon) {
    return { reason: "SESSION_WINDOW_TOO_SHORT" };
  }

  const tickTimes: number[] = [];
  for (let tick = firstTick; tick < evaluationHorizon; tick += cadenceMs) {
    if (!Number.isSafeInteger(tick)) {
      return { reason: "SESSION_WINDOW_TOO_SHORT" };
    }
    tickTimes.push(tick);
    // Guard against an accidentally unbounded horizon even if the schema is
    // changed later. This keeps this pure policy function predictable.
    if (tickTimes.length > 3_000) {
      return { reason: "SESSION_WINDOW_TOO_SHORT" };
    }
  }
  if (tickTimes.length === 0) {
    return { reason: "SESSION_WINDOW_TOO_SHORT" };
  }

  const firstReservations: WatchlistQuotaResourceReservation[] = [];
  for (const resource of input.resources) {
    const cost = completeTickCost(resource.tickUpperBound);
    const windows = resource.windows
      .map((window): SimulatedWindow => ({
        source: window,
        startAt: Date.parse(window.startAt),
        endAt: Date.parse(window.endAt),
        reservedUnits: window.usedUnits + window.outstandingReservationUnits,
      }))
      .sort((left, right): number => left.startAt - right.startAt);

    let firstReservation: WatchlistQuotaResourceReservation | null = null;
    for (const tickAt of tickTimes) {
      const containing = windows.filter((window): boolean => (
        tickAt >= window.startAt && tickAt < window.endAt
      ));
      if (containing.length === 0) {
        return { reason: "ALLOWANCE_WINDOW_NOT_ACTIVE" };
      }

      // Schema validation rejects overlaps, but keep this selection explici
      // so a future schema change cannot double-credit one tick silently.
      const chosen = containing[0];
      if (chosen === undefined) {
        return { reason: "ALLOWANCE_WINDOW_NOT_ACTIVE" };
      }

      const safeAllowance = chosen.source.allowanceUnits * input.safetyFraction;
      if (cost > safeAllowance) {
        return { reason: "TICK_COST_EXCEEDS_SAFE_QUOTA" };
      }
      const remaining = safeAllowance - chosen.reservedUnits;
      if (cost > remaining + quotaTolerance(remaining, cost)) {
        return { reason: "NO_REMAINING_SAFE_QUOTA" };
      }

      chosen.reservedUnits += cost;
      if (firstReservation === null) {
        firstReservation = {
          resourceId: resource.resourceId,
          windowStartAt: new Date(chosen.startAt).toISOString(),
          windowEndAt: new Date(chosen.endAt).toISOString(),
          units: cost,
        };
      }
    }

    if (firstReservation === null) {
      return { reason: "SESSION_WINDOW_TOO_SHORT" };
    }
    firstReservations.push(firstReservation);
  }

  return {
    cadence,
    tickTimes,
    firstReservations,
    evaluatedThroughAt: evaluationHorizon,
  };
}

function quotaTolerance(left: number, right: number): number {
  return Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function completeTickCost(upperBound: WatchlistTickResourceUpperBound): number {
  const values = Object.values(upperBound);
  const total = values.reduce((sum: number, value: number | null): number => sum + (value ?? 0), 0);
  if (!Number.isFinite(total) || total > MAX_WATCHLIST_TICK_UNITS) {
    throw new Error("Complete-tick resource cost exceeds the bounded numeric limit.");
  }
  return total;
}

function hasUnknownCost(upperBound: WatchlistTickResourceUpperBound): boolean {
  return Object.values(upperBound).some((value): boolean => value === null);
}

function validateCurrentAllowanceWindows(
  resources: readonly WatchlistQuotaResourceInput[],
  nowMs: number,
): WatchlistQuotaPausedReason | null {
  const reasons = resources.map((resource): WatchlistQuotaPausedReason | null => {
    if (resource.windows.some((window): boolean => isWithinWindow(window, nowMs))) {
      return null;
    }

    const allExpired = resource.windows.every((window): boolean => nowMs >= Date.parse(window.endAt));
    if (allExpired) {
      return "ALLOWANCE_WINDOW_EXPIRED";
    }

    const allFuture = resource.windows.every((window): boolean => nowMs < Date.parse(window.startAt));
    if (allFuture) {
      return "ALLOWANCE_WINDOW_FUTURE";
    }
    return "ALLOWANCE_WINDOW_NOT_ACTIVE";
  });

  return reasons.find((reason): reason is WatchlistQuotaPausedReason => reason !== null) ?? null;
}

function isWithinWindow(window: WatchlistQuotaWindow, at: number): boolean {
  const startAt = Date.parse(window.startAt);
  const endAt = Date.parse(window.endAt);
  return at >= startAt && at < endAt;
}

function chooseFailureReason(results: readonly CandidateResult[]): WatchlistQuotaPausedReason {
  const reasons = results
    .filter((result): result is CandidateFailure => "reason" in result)
    .map((result): WatchlistQuotaPausedReason => result.reason);
  const priority: readonly WatchlistQuotaPausedReason[] = [
    "TICK_COST_EXCEEDS_SAFE_QUOTA",
    "NO_REMAINING_SAFE_QUOTA",
    "ALLOWANCE_WINDOW_NOT_ACTIVE",
    "SESSION_WINDOW_TOO_SHORT",
  ];
  return priority.find((candidate): boolean => reasons.includes(candidate)) ?? "NO_REMAINING_SAFE_QUOTA";
}

function pausedDecision(
  reason: WatchlistQuotaPausedReason,
  message: string,
  context: ParsedContext,
): WatchlistQuotaPolicyDecision {
  return {
    allowed: false,
    paused: true,
    effectiveCadenceMinutes: null,
    pausedReason: reason,
    nextTickAt: null,
    reservation: null,
    coverage: {
      requestedCadenceMinutes: context.requestedCadenceMinutes,
      effectiveCadenceMinutes: null,
      plannedTickCount: 0,
      evaluatedThroughAt: null,
      degraded: false,
      state: "paused",
    },
    message,
  };
}

function allowanceWindowMessage(reason: WatchlistQuotaPausedReason): string {
  switch (reason) {
    case "ALLOWANCE_WINDOW_FUTURE":
      return "No free allowance window is active yet; keep collection paused.";
    case "ALLOWANCE_WINDOW_EXPIRED":
      return "All supplied free allowance windows have expired; keep collection paused.";
    default:
      return "No free allowance window is active for every measured resource.";
  }
}

function failureMessage(reason: WatchlistQuotaPausedReason): string {
  switch (reason) {
    case "TICK_COST_EXCEEDS_SAFE_QUOTA":
      return "One complete tick exceeds the configured safe quota; reducing cadence cannot make it fit.";
    case "NO_REMAINING_SAFE_QUOTA":
      return "No remaining safe quota fits the complete tick after used units and outstanding reservations.";
    case "ALLOWANCE_WINDOW_NOT_ACTIVE":
      return "A required resource has no allowance window covering a scheduled tick.";
    case "SESSION_WINDOW_TOO_SHORT":
      return "No supported next tick fits inside the monitored session.";
    default:
      return "The watchlist quota policy is paused.";
  }
}

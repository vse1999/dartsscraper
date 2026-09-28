import { z } from "zod";

export const WATCHLIST_CADENCE_MINUTES = [5, 10, 15] as const;
export type WatchlistCadenceMinutes = (typeof WATCHLIST_CADENCE_MINUTES)[number];

export const DEFAULT_WATCHLIST_SAFETY_FRACTION = 0.8;
export const MAX_WATCHLIST_SAFETY_FRACTION = 0.8;
export const MAX_WATCHLIST_RESOURCES = 32;
export const MAX_WATCHLIST_WINDOWS_PER_RESOURCE = 32;
export const MAX_WATCHLIST_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_WATCHLIST_RESOURCE_UNITS = 1_000_000_000_000;
export const MAX_WATCHLIST_TICK_UNITS = 1_000_000_000_000;

const TimestampSchema = z.string().datetime({ offset: true });
const CadenceSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(15),
]);
const ResourceIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const BoundedUnitsSchema = z.number()
  .finite()
  .nonnegative()
  .max(MAX_WATCHLIST_RESOURCE_UNITS)
  .nullable();

const QuotaWindowSchema = z.object({
  startAt: TimestampSchema,
  endAt: TimestampSchema,
  allowanceUnits: z.number().finite().positive().max(MAX_WATCHLIST_RESOURCE_UNITS),
  usedUnits: z.number().finite().nonnegative().max(MAX_WATCHLIST_RESOURCE_UNITS),
  outstandingReservationUnits: z.number().finite().nonnegative().max(MAX_WATCHLIST_RESOURCE_UNITS),
}).strict().superRefine((window, context): void => {
  const startAt = Date.parse(window.startAt);
  const endAt = Date.parse(window.endAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Quota window endAt must be later than startAt.",
      path: ["endAt"],
    });
  }
});

const TickResourceUpperBoundSchema = z.object({
  collectionUnits: BoundedUnitsSchema,
  recheckUnits: BoundedUnitsSchema,
  historyUnits: BoundedUnitsSchema,
  retryUnits: BoundedUnitsSchema,
}).strict();

const QuotaResourceSchema = z.object({
  resourceId: ResourceIdSchema,
  tickUpperBound: TickResourceUpperBoundSchema,
  windows: z.array(QuotaWindowSchema).min(1).max(MAX_WATCHLIST_WINDOWS_PER_RESOURCE),
}).strict();

export const WatchlistQuotaPolicyInputSchema = z.object({
  session: z.object({
    startAt: TimestampSchema,
    endAt: TimestampSchema,
  }).strict(),
  requestedCadenceMinutes: CadenceSchema.default(5),
  safetyFraction: z.number()
    .finite()
    .positive()
    .max(MAX_WATCHLIST_SAFETY_FRACTION)
    .default(DEFAULT_WATCHLIST_SAFETY_FRACTION),
  zeroSpendEntitlementProven: z.boolean().default(false),
  resources: z.array(QuotaResourceSchema).min(1).max(MAX_WATCHLIST_RESOURCES),
}).strict().superRefine((input, context): void => {
  const startAt = Date.parse(input.session.startAt);
  const endAt = Date.parse(input.session.endAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Session endAt must be later than startAt.",
      path: ["session", "endAt"],
    });
  } else if (endAt - startAt > MAX_WATCHLIST_SESSION_DURATION_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Session duration exceeds the bounded quota-policy horizon.",
      path: ["session", "endAt"],
    });
  }

  const resourceIds = new Set<string>();
  for (const [index, resource] of input.resources.entries()) {
    if (resourceIds.has(resource.resourceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Resource IDs must be unique.",
        path: ["resources", index, "resourceId"],
      });
    }
    resourceIds.add(resource.resourceId);

    const costs = Object.values(resource.tickUpperBound);
    if (costs.every((value): value is number => value !== null)) {
      const total = costs.reduce((sum: number, value: number): number => sum + value, 0);
      if (!Number.isFinite(total) || total > MAX_WATCHLIST_TICK_UNITS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The measured complete-tick resource cost exceeds the bounded numeric limit.",
          path: ["resources", index, "tickUpperBound"],
        });
      }
    }

    const orderedWindows = resource.windows
      .map((window, windowIndex): { readonly startAt: number; readonly endAt: number; readonly index: number } => ({
        startAt: Date.parse(window.startAt),
        endAt: Date.parse(window.endAt),
        index: windowIndex,
      }))
      .sort((left, right): number => left.startAt - right.startAt || left.endAt - right.endAt);
    for (let windowIndex = 1; windowIndex < orderedWindows.length; windowIndex += 1) {
      const previous = orderedWindows[windowIndex - 1];
      const current = orderedWindows[windowIndex];
      if (previous === undefined || current === undefined || current.startAt >= previous.endAt) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowance windows for one resource must not overlap; model simultaneous limits as separate resources.",
        path: ["resources", index, "windows", current.index, "startAt"],
      });
    }
  }
});

export type WatchlistQuotaPolicyInput = z.infer<typeof WatchlistQuotaPolicyInputSchema>;
export type WatchlistQuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type WatchlistTickResourceUpperBound = z.infer<typeof TickResourceUpperBoundSchema>;
export type WatchlistQuotaResourceInput = z.infer<typeof QuotaResourceSchema>;

export type WatchlistQuotaPausedReason =
  | "INVALID_INPUT"
  | "ZERO_SPEND_UNVERIFIED"
  | "UNKNOWN_RESOURCE_COSTS"
  | "SESSION_NOT_STARTED"
  | "SESSION_ENDED"
  | "SESSION_WINDOW_TOO_SHORT"
  | "ALLOWANCE_WINDOW_FUTURE"
  | "ALLOWANCE_WINDOW_EXPIRED"
  | "ALLOWANCE_WINDOW_NOT_ACTIVE"
  | "TICK_COST_EXCEEDS_SAFE_QUOTA"
  | "NO_REMAINING_SAFE_QUOTA";

export type WatchlistQuotaCoverageState = "normal" | "slower_cadence" | "paused";

export interface WatchlistQuotaCoverage {
  readonly requestedCadenceMinutes: WatchlistCadenceMinutes | null;
  readonly effectiveCadenceMinutes: WatchlistCadenceMinutes | null;
  readonly plannedTickCount: number;
  readonly evaluatedThroughAt: string | null;
  readonly degraded: boolean;
  readonly state: WatchlistQuotaCoverageState;
}

export interface WatchlistQuotaResourceReservation {
  readonly resourceId: string;
  readonly windowStartAt: string;
  readonly windowEndAt: string;
  readonly units: number;
}

export interface WatchlistQuotaReservationProposal {
  readonly tickAt: string;
  readonly resources: readonly WatchlistQuotaResourceReservation[];
  /** A later durable compare-and-swap must commit this proposal atomically. */
  readonly requiresDurableCompareAndSwap: true;
}

export interface WatchlistQuotaPolicyDecision {
  readonly allowed: boolean;
  readonly paused: boolean;
  readonly effectiveCadenceMinutes: WatchlistCadenceMinutes | null;
  readonly pausedReason: WatchlistQuotaPausedReason | null;
  readonly nextTickAt: string | null;
  readonly reservation: WatchlistQuotaReservationProposal | null;
  readonly coverage: WatchlistQuotaCoverage;
  readonly message: string;
}

export interface ParsedContext {
  readonly requestedCadenceMinutes: WatchlistCadenceMinutes | null;
  readonly sessionStartAt: number | null;
  readonly sessionEndAt: number | null;
}

export interface CandidateSuccess {
  readonly cadence: WatchlistCadenceMinutes;
  readonly tickTimes: readonly number[];
  readonly firstReservations: readonly WatchlistQuotaResourceReservation[];
  readonly evaluatedThroughAt: number;
}

export interface CandidateFailure {
  readonly reason: WatchlistQuotaPausedReason;
}

export type CandidateResult = CandidateSuccess | CandidateFailure;

export interface SimulatedWindow {
  readonly source: WatchlistQuotaWindow;
  readonly startAt: number;
  readonly endAt: number;
  reservedUnits: number;
}

export const CADENCE_OPTIONS: Readonly<Record<WatchlistCadenceMinutes, readonly WatchlistCadenceMinutes[]>> = {
  5: [5, 10, 15],
  10: [10, 15],
  15: [15],
};

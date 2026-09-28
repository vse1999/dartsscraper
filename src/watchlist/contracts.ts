import { z } from "zod";

/** ISO-8601 timestamps are required wherever an observation time is claimed. */
export const WatchlistTimestampSchema = z.string().datetime({ offset: true });
/** History providers sometimes expose only a calendar date. It is never treated as midnight. */
const WatchlistDateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected an ISO date-only value.").refine((value): boolean => {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return daysInMonth !== undefined && day <= daysInMonth;
}, "Date-only value is not a real calendar date.");
export const WatchlistDateOrTimestampSchema = z.union([
  WatchlistTimestampSchema,
  WatchlistDateOnlySchema,
]);

export const MAX_WATCHLIST_TEXT_LENGTH = 512;
export const MAX_WATCHLIST_URL_LENGTH = 2048;
export const MAX_MATCH_LEGS = 10_000;
export const MAX_CHECKOUT_COUNT = 100_000;
export const MAX_ONE_EIGHTY_COUNT = 100_000;
const WatchlistTextSchema = z.string().trim().min(1).max(MAX_WATCHLIST_TEXT_LENGTH);
const OptionalWatchlistTextSchema = WatchlistTextSchema.optional();

export const WatchlistSourceSchema = z.object({
  kind: z.enum(["direct_bookmaker", "aggregator", "official", "fixture"]),
  sourceId: WatchlistTextSchema,
  sourceUrl: z.string().url().max(MAX_WATCHLIST_URL_LENGTH),
  observedAt: WatchlistTimestampSchema,
}).strict();

export type WatchlistSource = z.infer<typeof WatchlistSourceSchema>;

export const WatchlistPlayerSchema = z.object({
  id: WatchlistTextSchema,
  name: WatchlistTextSchema,
}).strict();

export type WatchlistPlayer = z.infer<typeof WatchlistPlayerSchema>;

/** Optional event context is evidence, not a screening signal when absent. */
export const WatchlistEventContextSchema = z.object({
  stage: OptionalWatchlistTextSchema,
  floor: OptionalWatchlistTextSchema,
  format: OptionalWatchlistTextSchema,
  evidence: WatchlistSourceSchema.optional(),
}).strict();

export type WatchlistEventContext = z.infer<typeof WatchlistEventContextSchema>;

/**
 * A quote retains provider identifiers and source provenance. `sourceUpdatedAt`
 * is optional because an observation does not prove an upstream publication
 * update; if present it is validated against the observation timestamps.
 */
export const WatchlistQuoteSchema = z.object({
  competitionOccurrenceId: WatchlistTextSchema,
  eventId: WatchlistTextSchema,
  round: OptionalWatchlistTextSchema,
  players: z.tuple([WatchlistPlayerSchema, WatchlistPlayerSchema]),
  selectedPlayerId: WatchlistTextSchema,
  bookmakerId: WatchlistTextSchema,
  providerEventId: WatchlistTextSchema,
  providerMarketId: WatchlistTextSchema,
  providerSelectionId: WatchlistTextSchema,
  marketType: WatchlistTextSchema,
  marketStatus: WatchlistTextSchema,
  eventStatus: WatchlistTextSchema,
  scheduledStart: WatchlistTimestampSchema,
  observedAt: WatchlistTimestampSchema,
  sourceUpdatedAt: WatchlistTimestampSchema.optional(),
  source: WatchlistSourceSchema,
  eventContext: WatchlistEventContextSchema.optional(),
  isPromotion: z.boolean(),
}).strict();

export type WatchlistQuote = z.infer<typeof WatchlistQuoteSchema>;

export const WatchlistPriceSchema = z.object({
  quote: WatchlistQuoteSchema,
  decimalPrice: z.number().finite().gt(1),
}).strict();

export type WatchlistPrice = z.infer<typeof WatchlistPriceSchema>;

/** Alias used by adapters: complete normalized quote including its price. */
export const NormalizedWatchlistQuoteSchema = WatchlistPriceSchema;
export type NormalizedWatchlistQuote = WatchlistPrice;

export const HistoryContextSchema = z.object({
  competitionId: OptionalWatchlistTextSchema,
  eventId: OptionalWatchlistTextSchema,
  round: OptionalWatchlistTextSchema,
  stage: OptionalWatchlistTextSchema,
  floor: OptionalWatchlistTextSchema,
  format: OptionalWatchlistTextSchema,
}).strict();

export type HistoryContext = z.infer<typeof HistoryContextSchema>;

export const PlayerMatchStatsSchema = z.object({
  average: z.number().finite().nonnegative().max(180).nullable(),
  checkoutHits: z.number().int().nonnegative().max(MAX_CHECKOUT_COUNT).nullable().optional(),
  checkoutAttempts: z.number().int().nonnegative().max(MAX_CHECKOUT_COUNT).nullable().optional(),
  oneEighties: z.number().int().nonnegative().max(MAX_ONE_EIGHTY_COUNT).nullable().optional(),
  legs: z.number().int().positive().max(MAX_MATCH_LEGS).optional(),
}).strict().superRefine((stats, context) => {
  const hitsKnown = stats.checkoutHits !== null && stats.checkoutHits !== undefined;
  const attemptsKnown = stats.checkoutAttempts !== null && stats.checkoutAttempts !== undefined;
  if (hitsKnown !== attemptsKnown) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Checkout hits and attempts must be present together.", path: ["checkoutAttempts"] });
  }
  if (hitsKnown && attemptsKnown && stats.checkoutHits !== null && stats.checkoutHits !== undefined
    && stats.checkoutAttempts !== null && stats.checkoutAttempts !== undefined) {
    if (stats.checkoutHits > stats.checkoutAttempts) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Checkout hits cannot exceed checkout attempts.", path: ["checkoutHits"] });
    }
    if (stats.legs !== undefined && stats.checkoutHits > stats.legs) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Checkout hits cannot exceed completed legs.", path: ["checkoutHits"] });
    }
  }
});

export type PlayerMatchStats = z.infer<typeof PlayerMatchStatsSchema>;

export const CompletedHistoryMatchSchema = z.object({
  matchId: WatchlistTextSchema,
  playerId: WatchlistTextSchema,
  opponent: WatchlistPlayerSchema,
  status: z.literal("completed"),
  result: z.enum(["win", "loss", "draw"]),
  playedAt: WatchlistDateOrTimestampSchema,
  completedAt: WatchlistDateOrTimestampSchema,
  stats: PlayerMatchStatsSchema,
  context: HistoryContextSchema.optional(),
  evidence: WatchlistSourceSchema,
}).strict().superRefine((match, context) => {
  const playedTimestamp = match.playedAt.length === 10 ? null : Date.parse(match.playedAt);
  const completedTimestamp = match.completedAt.length === 10 ? null : Date.parse(match.completedAt);
  const invalidOrder = playedTimestamp !== null && completedTimestamp !== null
    ? playedTimestamp > completedTimestamp
    : match.playedAt.slice(0, 10) > match.completedAt.slice(0, 10);
  if (invalidOrder) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A match cannot be played after it completed.", path: ["playedAt"] });
  }
});

export type CompletedHistoryMatch = z.infer<typeof CompletedHistoryMatchSchema>;

export const HistorySnapshotSchema = z.object({
  playerId: WatchlistTextSchema,
  observedAt: WatchlistTimestampSchema,
  source: WatchlistSourceSchema,
  // This normalized core intentionally accepts at most the 20 rows used by
  // screening. A date-only provider cannot prove the last-20 boundary from
  // exactly 20 rows; its adapter must provide an exhaustiveness/order proof
  // or quarantine that snapshot rather than inventing a timestamp.
  matches: z.array(CompletedHistoryMatchSchema).max(20),
}).strict();

export type HistorySnapshot = z.infer<typeof HistorySnapshotSchema>;

export const MetricThresholdSchema = z.object({
  average: z.number().finite().nonnegative(),
  checkoutRate: z.number().finite().nonnegative().max(1),
  oneEightyPerLeg: z.number().finite().nonnegative(),
}).strict();

export type MetricThreshold = z.infer<typeof MetricThresholdSchema>;

export const WatchlistPriceBandSchema = z.object({
  minInclusive: z.number().finite().gt(1),
  maxExclusive: z.number().finite().gt(1).nullable(),
  minimumAverageDifference: z.number().finite().nonnegative(),
  minimumCheckoutRateDifference: z.number().finite().nonnegative().max(1),
  minimumOneEightyDifference: z.number().finite().nonnegative().optional(),
}).strict().superRefine((band, context) => {
  if (band.maxExclusive !== null && band.maxExclusive <= band.minInclusive) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Price band maxExclusive must exceed minInclusive.", path: ["maxExclusive"] });
  }
});

export type WatchlistPriceBand = z.infer<typeof WatchlistPriceBandSchema>;

/** All screening thresholds are supplied by the caller and versioned. */
export const WatchlistRuleConfigSchema = z.object({
  version: WatchlistTextSchema,
  minimumMatchesByWindow: z.object({
    10: z.number().int().min(10).max(10),
    20: z.number().int().min(10).max(20),
  }).strict(),
  minimumMetricCoverage: z.object({
    average: z.number().finite().gt(0).lte(1),
    checkoutRate: z.number().finite().gt(0).lte(1),
    oneEightyPerLeg: z.number().finite().gt(0).lte(1),
  }).strict(),
  requiredMetrics: z.array(z.enum(["average", "checkoutRate"])).min(2).max(2).optional(),
  /** Legacy fallback for 180 thresholds; price-band thresholds govern avg/checkout. */
  superiority: MetricThresholdSchema.optional(),
  priceBands: z.array(WatchlistPriceBandSchema).min(1).max(20),
  allowedBookmakers: z.array(WatchlistTextSchema).min(1).max(100),
  allowedSourceIds: z.array(WatchlistTextSchema).min(1).max(100),
  quoteMaxAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  historyMaxAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  minimumStartLeadMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((rules, context) => {
  if (rules.minimumMatchesByWindow[20] < rules.minimumMatchesByWindow[10]) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The minimum last-20 sample cannot be lower than the minimum last-10 sample.", path: ["minimumMatchesByWindow", 20] });
  }
  if (rules.quoteMaxAgeMs > 120_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Quote freshness cannot be relaxed beyond two minutes.", path: ["quoteMaxAgeMs"] });
  }
  if (rules.minimumStartLeadMs < 120_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Start suppression cannot be relaxed below two minutes.", path: ["minimumStartLeadMs"] });
  }
  const bands = rules.priceBands;
  for (let index = 1; index < bands.length; index += 1) {
    const previous = bands[index - 1];
    const current = bands[index];
    if (previous === undefined || current === undefined) continue;
    if (current.minInclusive < previous.minInclusive || (previous.maxExclusive !== null && current.minInclusive < previous.maxExclusive)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Price bands must be ordered and non-overlapping.", path: ["priceBands", index] });
    }
    if (current.minimumAverageDifference > previous.minimumAverageDifference
      || current.minimumCheckoutRateDifference > previous.minimumCheckoutRateDifference) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Shorter odds must have thresholds at least as strong as longer odds.", path: ["priceBands", index] });
    }
  }
  const lastBand = bands[bands.length - 1];
  if (bands.some((band, index): boolean => band.maxExclusive === null && index !== bands.length - 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An open-ended price band must be the final band.", path: ["priceBands"] });
  }
  if (lastBand !== undefined && lastBand.maxExclusive !== null && lastBand.maxExclusive <= lastBand.minInclusive) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The final price band has an invalid upper bound.", path: ["priceBands"] });
  }
  if (rules.requiredMetrics !== undefined) {
    const unique = new Set(rules.requiredMetrics);
    if (unique.size !== 2 || !unique.has("average") || !unique.has("checkoutRate")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Average and checkoutRate are both required metrics.", path: ["requiredMetrics"] });
    }
  }
});

export type WatchlistRuleConfig = z.infer<typeof WatchlistRuleConfigSchema>;

export const WatchlistScreenInputSchema = z.object({
  price: WatchlistPriceSchema,
  selectedHistory: HistorySnapshotSchema,
  opponentHistory: HistorySnapshotSchema,
  rules: WatchlistRuleConfigSchema,
}).strict();

export type WatchlistScreenInput = z.infer<typeof WatchlistScreenInputSchema>;

export const WATCHLIST_WINDOW_SIZES = [10, 20] as const;
export type WatchlistWindowSize = (typeof WATCHLIST_WINDOW_SIZES)[number];

export const WATCHLIST_MARKET_TYPE = "match_winner" as const;
export const WATCHLIST_OPEN_MARKET_STATUS = "open" as const;
export const WATCHLIST_PREMATCH_EVENT_STATUS = "prematch" as const;

export type MetricName = "average" | "checkoutRate" | "oneEightyPerLeg";

export const SCREENING_REASON_CODES = [
  "INVALID_INPUT", "UNKNOWN_MARKET_STATUS", "UNSUPPORTED_MARKET", "PROMOTIONAL_MARKET", "INVALID_PRICE",
  "BOOKMAKER_NOT_ALLOWLISTED", "BOABET_EXCLUDED", "SOURCE_NOT_ALLOWLISTED", "SELECTED_PLAYER_NOT_IN_EVENT",
  "AMBIGUOUS_PLAYER_PAIR", "FUTURE_TIMESTAMP", "TIMESTAMP_ORDER_INVALID", "STALE_QUOTE", "STALE_SOURCE",
  "SOURCE_UPDATE_UNAVAILABLE", "START_TOO_SOON", "HISTORY_PLAYER_MISMATCH", "HISTORY_NOT_ORDERED",
  "HISTORY_DUPLICATE_ID", "HISTORY_CONTEXT_UNKNOWN", "HISTORY_DATE_ONLY_AMBIGUOUS", "HISTORY_STALE", "HISTORY_FUTURE_TIMESTAMP",
  "HISTORY_AFTER_QUOTE_CUTOFF", "HISTORY_AFTER_SNAPSHOT", "UNKNOWN_EVENT_CONTEXT", "STALE_CONTEXT",
  "INSUFFICIENT_HISTORY", "HISTORY_WINDOW_UNAVAILABLE", "MISSING_METRIC_DATA", "OPTIONAL_METRIC_UNAVAILABLE",
  "WINDOW_CONTRADICTION", "SELECTED_PLAYER_NOT_SUPERIOR", "PRICE_OUTSIDE_BANDS", "INVALID_PRICE_BANDS",
] as const;

export type ScreeningReasonCode = (typeof SCREENING_REASON_CODES)[number];
export type ScreeningReasonSeverity = "blocking" | "warning";

export interface ScreeningReason {
  readonly code: ScreeningReasonCode;
  readonly severity: ScreeningReasonSeverity;
  readonly message: string;
}

export interface MetricAggregate {
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly availableMatches: number;
  readonly coverage: number;
}

export interface WindowMetrics {
  readonly window: WatchlistWindowSize;
  readonly sampleSize: number;
  readonly average: MetricAggregate;
  readonly checkoutRate: MetricAggregate;
  readonly oneEightyPerLeg: MetricAggregate;
}

export interface WindowComparison {
  readonly window: WatchlistWindowSize;
  readonly deltas: Readonly<Record<MetricName, number | null>>;
  readonly superior: Readonly<Record<MetricName, boolean>>;
  readonly allMetricsSuperior: boolean;
}

export interface CoverageReport {
  readonly selected: Readonly<Record<WatchlistWindowSize, WindowMetrics>>;
  readonly opponent: Readonly<Record<WatchlistWindowSize, WindowMetrics>>;
}

export interface ScreeningResult {
  readonly eligible: boolean;
  readonly identityKey: string | null;
  readonly reasons: readonly ScreeningReason[];
  readonly warnings: readonly ScreeningReason[];
  readonly coverage: CoverageReport | null;
  readonly comparisons: readonly WindowComparison[];
  readonly ruleVersion: string | null;
}

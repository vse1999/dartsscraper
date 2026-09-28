import {
  WATCHLIST_WINDOW_SIZES,
  type CompletedHistoryMatch,
  type CoverageReport,
  type HistorySnapshot,
  type MetricAggregate,
  type MetricName,
  type ScreeningReason,
  type WatchlistPriceBand,
  type WatchlistRuleConfig,
  type WatchlistWindowSize,
  type WindowComparison,
  type WindowMetrics,
} from "./contracts.js";

function emptyAggregate(): MetricAggregate {
  return { value: null, numerator: null, denominator: null, availableMatches: 0, coverage: 0 };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(8));
}

/**
 * Average is the arithmetic mean of available match averages. Checkout is
 * weighted hits / attempts. 180s are optional and use known 180s / known legs;
 * absent values never become zeroes or denominators.
 */
function aggregateMetric(matches: readonly CompletedHistoryMatch[], metric: MetricName): MetricAggregate {
  if (matches.length === 0) return emptyAggregate();
  if (metric === "average") {
    const values = matches
      .map((match): number | null => match.stats.average)
      .filter((value): value is number => value !== null);
    if (values.length === 0) return emptyAggregate();
    const numerator = values.reduce((sum, value): number => sum + value, 0);
    return {
      value: roundMetric(numerator / values.length),
      numerator: roundMetric(numerator),
      denominator: values.length,
      availableMatches: values.length,
      coverage: values.length / matches.length,
    };
  }
  if (metric === "checkoutRate") {
    const available = matches.filter((match): boolean => (
      match.stats.checkoutHits !== null
      && match.stats.checkoutHits !== undefined
      && match.stats.checkoutAttempts !== null
      && match.stats.checkoutAttempts !== undefined
      && match.stats.checkoutAttempts > 0
    ));
    if (available.length === 0) return emptyAggregate();
    const hits = available.reduce((sum, match): number => sum + (match.stats.checkoutHits ?? 0), 0);
    const attempts = available.reduce((sum, match): number => sum + (match.stats.checkoutAttempts ?? 0), 0);
    if (attempts === 0) return emptyAggregate();
    return {
      value: roundMetric(hits / attempts),
      numerator: hits,
      denominator: attempts,
      availableMatches: available.length,
      coverage: available.length / matches.length,
    };
  }
  const available = matches.filter((match): boolean => (
    match.stats.oneEighties !== null
    && match.stats.oneEighties !== undefined
    && match.stats.legs !== undefined
    && match.stats.legs > 0
  ));
  if (available.length === 0) return emptyAggregate();
  const oneEighties = available.reduce((sum, match): number => sum + (match.stats.oneEighties ?? 0), 0);
  const legs = available.reduce((sum, match): number => sum + (match.stats.legs ?? 0), 0);
  if (legs === 0) return emptyAggregate();
  return {
    value: roundMetric(oneEighties / legs),
    numerator: oneEighties,
    denominator: legs,
    availableMatches: available.length,
    coverage: available.length / matches.length,
  };
}

function metricsForWindow(snapshot: HistorySnapshot, window: WatchlistWindowSize): WindowMetrics {
  const matches = snapshot.matches.slice(0, window);
  return {
    window,
    sampleSize: matches.length,
    average: aggregateMetric(matches, "average"),
    checkoutRate: aggregateMetric(matches, "checkoutRate"),
    oneEightyPerLeg: aggregateMetric(matches, "oneEightyPerLeg"),
  };
}

export function calculateWindowMetrics(snapshot: HistorySnapshot, window: WatchlistWindowSize): WindowMetrics {
  return metricsForWindow(snapshot, window);
}

export function buildCoverageReport(selectedHistory: HistorySnapshot, opponentHistory: HistorySnapshot): CoverageReport {
  const selected = {
    10: metricsForWindow(selectedHistory, 10),
    20: metricsForWindow(selectedHistory, 20),
  } as const;
  const opponent = {
    10: metricsForWindow(opponentHistory, 10),
    20: metricsForWindow(opponentHistory, 20),
  } as const;
  return { selected, opponent };
}

function thresholdForMetric(
  metric: MetricName,
  rules: WatchlistRuleConfig,
  band: WatchlistPriceBand | undefined,
): number {
  if (metric === "average" && band !== undefined) return band.minimumAverageDifference;
  if (metric === "checkoutRate" && band !== undefined) return band.minimumCheckoutRateDifference;
  if (metric === "oneEightyPerLeg" && band?.minimumOneEightyDifference !== undefined) return band.minimumOneEightyDifference;
  return rules.superiority?.[metric] ?? 0;
}

export function compareWindowMetrics(
  selected: WindowMetrics,
  opponent: WindowMetrics,
  rules: WatchlistRuleConfig,
  band?: WatchlistPriceBand,
): WindowComparison {
  const names: readonly MetricName[] = ["average", "checkoutRate", "oneEightyPerLeg"];
  const deltas: Record<MetricName, number | null> = { average: null, checkoutRate: null, oneEightyPerLeg: null };
  const superior: Record<MetricName, boolean> = { average: false, checkoutRate: false, oneEightyPerLeg: false };
  const required = new Set<MetricName>(rules.requiredMetrics ?? ["average", "checkoutRate"]);
  for (const name of names) {
    const selectedValue = selected[name].value;
    const opponentValue = opponent[name].value;
    if (selectedValue !== null && opponentValue !== null) {
      const delta = roundMetric(selectedValue - opponentValue);
      deltas[name] = delta;
      const threshold = thresholdForMetric(name, rules, band);
      superior[name] = delta > 0 && delta >= threshold;
    }
  }
  return {
    window: selected.window,
    deltas,
    superior,
    allMetricsSuperior: [...required].every((name): boolean => superior[name]),
  };
}

/** Required average/checkout data blocks. 180 data and last-20 coverage warn. */
export function metricCoverageReasons(
  coverage: CoverageReport,
  rules: WatchlistRuleConfig,
): readonly ScreeningReason[] {
  const reasons: ScreeningReason[] = [];
  const required = new Set<MetricName>(rules.requiredMetrics ?? ["average", "checkoutRate"]);
  for (const window of WATCHLIST_WINDOW_SIZES) {
    const selected = coverage.selected[window];
    const opponent = coverage.opponent[window];
    const bothHaveMinimumHistory = selected.sampleSize >= 10 && opponent.sampleSize >= 10;
    if (!bothHaveMinimumHistory && window === 10) {
      reasons.push({
        code: "INSUFFICIENT_HISTORY",
        severity: "blocking",
        message: `Both players need at least 10 valid completed matches in the last-${window} window.`,
      });
    } else if (window === 20 && (selected.sampleSize < 20 || opponent.sampleSize < 20)) {
      reasons.push({
        code: "HISTORY_WINDOW_UNAVAILABLE",
        severity: "warning",
        message: "Fewer than twenty valid completed matches are available; last-20 evidence is unavailable.",
      });
    }
    const metricNames: readonly MetricName[] = ["average", "checkoutRate", "oneEightyPerLeg"];
    for (const name of metricNames) {
      const minimum = required.has(name) && window === 10 ? 1 : rules.minimumMetricCoverage[name];
      const missing = selected[name].value === null
        || opponent[name].value === null
        || selected[name].coverage < minimum
        || opponent[name].coverage < minimum;
      if (!missing) continue;
      const requiredMetric = required.has(name);
      reasons.push({
        code: "MISSING_METRIC_DATA",
        severity: requiredMetric && window === 10 ? "blocking" : "warning",
        message: `${name} lacks the configured coverage in the ${window}-match window${requiredMetric && window === 10 ? "." : "; this optional window or metric does not block match-winner screening."}`,
      });
    }
  }
  return reasons;
}

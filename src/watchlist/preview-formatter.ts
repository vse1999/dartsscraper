import {
  WatchlistScreenInputSchema,
  type MetricAggregate,
  type ScreeningResult,
  type WatchlistScreenInput,
  type WatchlistWindowSize,
  type WindowMetrics,
} from "./contracts.js";
import { screenWatchlistCandidate } from "./screening.js";

export const WATCHLIST_PREVIEW_MAX_HTML_LENGTH = 4_096;
const MAX_DISPLAY_FIELD_LENGTH = 256;
const CONTINUATION_PREFIX = "<b>WATCHLIST RESEARCH PREVIEW · continued</b>";
const UNKNOWN_CONTEXT_VALUES = new Set(["", "unknown", "unresolved", "n/a", "na", "?"]);

/**
 * Formats only an eligible, freshly screened candidate. This function performs
 * its own strict parse and screening so callers cannot pass a trusted-looking
 * result that was calculated from different input or a different clock.
 */
export function formatWatchlistPreviewPages(input: unknown, now: Date): readonly string[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return [];
  const screening = screenWatchlistCandidate(input, now);
  if (!screening.eligible || screening.coverage === null || screening.ruleVersion === null) return [];

  const parsed = WatchlistScreenInputSchema.safeParse(input);
  if (!parsed.success) return [];
  return formatEligiblePreview(parsed.data, screening);
}

function formatEligiblePreview(input: WatchlistScreenInput, screening: ScreeningResult): readonly string[] {
  const quote = input.price.quote;
  const selected = quote.players.find((player): boolean => player.id === quote.selectedPlayerId);
  const opponent = quote.players.find((player): boolean => player.id !== quote.selectedPlayerId);
  if (selected === undefined || opponent === undefined || screening.coverage === null || screening.ruleVersion === null) return [];

  const band = input.rules.priceBands.find((candidate): boolean => (
    input.price.decimalPrice >= candidate.minInclusive
    && (candidate.maxExclusive === null || input.price.decimalPrice < candidate.maxExclusive)
  ));
  const header = [
    "<b>WATCHLIST RESEARCH PREVIEW</b>",
    "<i>Descriptive research only — not proven value, a win probability, or a staking recommendation.</i>",
    "<i>Last-10 and last-20 windows overlap; they are not independent confirmation.</i>",
    `<b>${escapeHtml(display(selected.name))}</b> vs <b>${escapeHtml(display(opponent.name))}</b>`,
    `Odds: <code>${input.price.decimalPrice.toFixed(2)}</code> · Bookmaker: <code>${escapeHtml(display(quote.bookmakerId))}</code>`,
    `Source: <code>${escapeHtml(display(quote.source.sourceId))}</code> (${escapeHtml(quote.source.kind)}), observed <code>${escapeHtml(quote.observedAt)}</code> (not a publication timestamp)`,
    `Start: <code>${escapeHtml(quote.scheduledStart)}</code>`,
  ].join("\n");

  const blocks: string[] = [
    header,
    formatMetrics("Selected", selected.name, screening.coverage.selected),
    formatMetrics("Opponent", opponent.name, screening.coverage.opponent),
    formatEventContext(quote.eventContext),
    formatRuleEvidence(input, screening, band),
    ...formatWarnings(input, screening),
    "<i>Review the cited evidence and available bookmaker price yourself before making any decision.</i>",
  ];
  return paginateBlocks(blocks);
}

function formatMetrics(
  label: string,
  playerName: string,
  metrics: Readonly<Record<WatchlistWindowSize, WindowMetrics>>,
): string {
  const lines = [
    `<b>${escapeHtml(label)}: ${escapeHtml(display(playerName))}</b>`,
    ...([10, 20] as const).map((window): string => formatWindowMetrics(window, metrics[window])),
  ];
  return lines.join("\n");
}

function formatWindowMetrics(window: WatchlistWindowSize, metrics: WindowMetrics): string {
  if (metrics.sampleSize < window) {
    return `${window}: Avg unavailable (${metrics.sampleSize}/${window} matches) · Weighted checkout unavailable (—/— attempts; ${metrics.sampleSize} matches) · 180/leg unavailable (${metrics.sampleSize} matches)`;
  }
  const average = formatAverage(metrics.average, metrics.sampleSize);
  const checkout = formatCheckout(metrics.checkoutRate);
  const oneEighties = formatOneEighties(metrics.oneEightyPerLeg);
  return `${window}: Avg ${average} · Weighted checkout ${checkout} · 180/leg ${oneEighties}`;
}

function formatAverage(metric: MetricAggregate, sampleSize: number): string {
  const value = metric.value === null ? "unavailable" : metric.value.toFixed(2);
  return `${value} (${metric.availableMatches}/${sampleSize} matches)`;
}

function formatCheckout(metric: MetricAggregate): string {
  const value = metric.value === null ? "unavailable" : `${(metric.value * 100).toFixed(2)}%`;
  const attempts = metric.denominator === null ? "—" : String(metric.denominator);
  const hits = metric.numerator === null ? "—" : String(metric.numerator);
  return `${value} (${hits}/${attempts} attempts; ${metric.availableMatches} matches)`;
}

function formatOneEighties(metric: MetricAggregate): string {
  if (metric.value === null) return `unavailable (${metric.availableMatches} matches)`;
  return `${metric.value.toFixed(3)} (${metric.numerator ?? 0}/${metric.denominator ?? 0}; ${metric.availableMatches} matches)`;
}

function formatEventContext(
  context: WatchlistScreenInput["price"]["quote"]["eventContext"],
): string {
  const stage = formatOptionalContextValue(context?.stage);
  const floor = formatOptionalContextValue(context?.floor);
  const format = formatOptionalContextValue(context?.format);
  const evidence = context?.evidence === undefined
    ? "unavailable"
    : `<code>${escapeHtml(display(context.evidence.sourceId))}</code>`;
  return [
    "<b>EVENT CONTEXT</b>",
    `Stage: ${stage} · Floor: ${floor} · Format: ${format}`,
    `Context evidence: ${evidence}`,
  ].join("\n");
}

function formatOptionalContextValue(value: string | undefined): string {
  if (value === undefined || UNKNOWN_CONTEXT_VALUES.has(value.trim().toLocaleLowerCase("en-US"))) {
    return "unavailable";
  }
  return `<code>${escapeHtml(display(value))}</code>`;
}

function formatRuleEvidence(
  input: WatchlistScreenInput,
  screening: ScreeningResult,
  band: WatchlistScreenInput["rules"]["priceBands"][number] | undefined,
): string {
  const bandLabel = band === undefined
    ? "none"
    : `${band.minInclusive.toFixed(2)}–${band.maxExclusive === null ? "∞" : band.maxExclusive.toFixed(2)}`;
  const lines = [
    "<b>RULE EVIDENCE</b>",
    `Version: <code>${escapeHtml(display(screening.ruleVersion ?? "unknown"))}</code> · price band: <code>${escapeHtml(bandLabel)}</code>`,
  ];
  if (band !== undefined) {
    lines.push(`Thresholds: average Δ ≥ ${band.minimumAverageDifference.toFixed(3)} · checkout Δ ≥ ${(band.minimumCheckoutRateDifference * 100).toFixed(2)} percentage points`);
    if (band.minimumOneEightyDifference !== undefined) lines.push(`Optional 180/leg threshold: Δ ≥ ${band.minimumOneEightyDifference.toFixed(3)}`);
  }
  for (const comparison of screening.comparisons) {
    const average = formatDeltaForWindow(comparison.window, comparison.deltas.average, screening.coverage);
    const checkout = formatDeltaForWindow(comparison.window, comparison.deltas.checkoutRate, screening.coverage, true);
    const optionalOneEighties = formatDeltaForWindow(comparison.window, comparison.deltas.oneEightyPerLeg, screening.coverage);
    const evidenceSummary = comparison.window === 20
      ? formatLastTwentySummary(screening.coverage, input)
      : `required metrics ${comparison.allMetricsSuperior ? "pass" : "not all pass"}`;
    lines.push(`Last-${comparison.window}: average ${average} · checkout ${checkout} · 180/leg ${optionalOneEighties} · ${evidenceSummary}`);
  }
  lines.push(`Required metrics: ${(input.rules.requiredMetrics ?? ["average", "checkoutRate"]).join(", ")}`);
  return lines.join("\n");
}

function formatDelta(value: number | null, percentagePoints: boolean = false): string {
  if (value === null) return "unavailable";
  const formatted = percentagePoints ? `${(value * 100).toFixed(2)} pp` : value.toFixed(3);
  return `${value >= 0 ? "+" : ""}${formatted}`;
}

function formatDeltaForWindow(
  window: WatchlistWindowSize,
  value: number | null,
  coverage: ScreeningResult["coverage"],
  percentagePoints: boolean = false,
): string {
  if (window === 20 && !hasCompleteWindow(coverage, 20)) return "unavailable";
  return formatDelta(value, percentagePoints);
}

function formatLastTwentySummary(
  coverage: ScreeningResult["coverage"],
  input: WatchlistScreenInput,
): string {
  if (!hasCompleteWindow(coverage, 20)) return "required metric direction unavailable (need 20 matches)";
  if (coverage === null) return "required metric direction unavailable (incomplete evidence)";
  const requiredMetrics = input.rules.requiredMetrics ?? ["average", "checkoutRate"];
  const completeRequiredEvidence = requiredMetrics.every((metric): boolean => (
    coverage.selected[20][metric].value !== null
    && coverage.opponent[20][metric].value !== null
    && coverage.selected[20][metric].coverage >= input.rules.minimumMetricCoverage[metric]
    && coverage.opponent[20][metric].coverage >= input.rules.minimumMetricCoverage[metric]
  ));
  if (!completeRequiredEvidence) return "required metric direction unavailable (incomplete evidence)";
  return "required metric direction checked (thresholds apply to last-10)";
}

function hasCompleteWindow(
  coverage: ScreeningResult["coverage"],
  window: WatchlistWindowSize,
): boolean {
  return coverage !== null
    && coverage.selected[window].sampleSize >= window
    && coverage.opponent[window].sampleSize >= window;
}

function formatWarnings(input: WatchlistScreenInput, screening: ScreeningResult): readonly string[] {
  const warnings = new Set<string>();
  const context = input.price.quote.eventContext;
  if (context === undefined || context.stage === undefined || context.floor === undefined || context.format === undefined || context.evidence === undefined) {
    warnings.add("Event stage/floor/format context is unknown; it was not used as a favorable signal.");
  }
  const coverage = screening.coverage;
  if (coverage !== null && ([10, 20] as const).some((window): boolean => (
    coverage.selected[window].oneEightyPerLeg.value === null
    || coverage.opponent[window].oneEightyPerLeg.value === null
  ))) {
    warnings.add("Optional 180/leg evidence is unavailable or partial in at least one displayed window.");
  }
  for (const warning of screening.warnings) warnings.add(warning.message);
  return [...warnings].map((warning): string => `⚠️ ${escapeHtml(display(warning))}`);
}

function paginateBlocks(blocks: readonly string[]): readonly string[] {
  const pages: string[] = [];
  let current = "";
  for (const block of blocks) {
    const lines = block.split("\n");
    const state: MutableText = {
      get: (): string => current,
      set: (value: string): void => { current = value; },
    };
    for (const line of lines) {
      appendPaginatedLine(line, pages, state);
    }
    appendPaginatedLine("", pages, state);
  }
  if (current !== "") pages.push(current);
  return pages;
}

interface MutableText {
  get(): string;
  set(value: string): void;
}

function appendPaginatedLine(line: string, pages: string[], current: MutableText): void {
  if (line === "" && current.get() === "") return;

  const prefix = pages.length === 0 && current.get() === "" ? "" : `${CONTINUATION_PREFIX}\n\n`;
  const candidate = current.get() === "" ? `${prefix}${line}` : `${current.get()}\n${line}`;
  if (candidate.length <= WATCHLIST_PREVIEW_MAX_HTML_LENGTH) {
    current.set(candidate);
    return;
  }

  if (current.get() !== "") {
    pages.push(current.get());
    current.set("");
    appendPaginatedLine(line, pages, current);
    return;
  }

  const available = Math.max(1, WATCHLIST_PREVIEW_MAX_HTML_LENGTH - prefix.length);
  const chunks = splitOversizedEscapedLine(line, available);
  for (const [index, chunk] of chunks.entries()) {
    const chunkPrefix = pages.length === 0 ? "" : `${CONTINUATION_PREFIX}\n\n`;
    current.set(`${chunkPrefix}${chunk}`);
    if (index < chunks.length - 1) {
      pages.push(current.get());
      current.set("");
    }
  }
}

/**
 * The normal formatter keeps each line below the limit through display-field
 * bounds. This defensive path removes formatting tags and splits only a
 * complete Telegram entities if a future field exceeds that bound.
 */
function splitOversizedEscapedLine(line: string, maximumLength: number): readonly string[] {
  const withoutTags = line.replace(/<[^>]*>/gu, "");
  const tokens = withoutTags.match(/&(?:amp|lt|gt|quot|#39);|[^&]+/gu) ?? [withoutTags];
  const chunks: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current !== "" && current.length + token.length > maximumLength) {
      chunks.push(current);
      current = "";
    }
    if (token.length > maximumLength) {
      for (let offset = 0; offset < token.length; offset += maximumLength) {
        chunks.push(token.slice(offset, offset + maximumLength));
      }
    } else {
      current += token;
    }
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks;
}

function display(value: string, maximumLength: number = MAX_DISPLAY_FIELD_LENGTH): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

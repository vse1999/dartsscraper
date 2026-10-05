import type {
  ValueCardStatus,
  ValueMatchCard,
  ValuePlayerAssessment,
  ValueReport,
  ValueSourceCoverage,
  ValueWindowSummary,
} from "../value/contracts.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";
import { buildResearchBrief } from "../research/brief.js";

const MAX_FIELD_LENGTH = 180;
const MAX_URL_LENGTH = 240;
const MAX_WARNING_COUNT = 8;
const MAX_WARNING_LENGTH = 240;

/**
 * Render descriptive odds/statistics evidence in source order. This formatter
 * never ranks cards or adds probabilities, thresholds, signals, or advice.
 */
export function formatValueMessages(report: ValueReport): readonly string[] {
  const header = formatHeader(report);
  if (report.cards.length === 0) {
    return [
      [
        header,
        "No collected odds matchup is available for this date.",
        "This is a successful empty result, not a source outage.",
        ...formatWarnings(report.warnings),
        `Odds source: ${safeUrl(report.odds.sourceUrl)}`,
      ].join("\n"),
    ];
  }

  const pages: string[] = [];
  let current = header;
  for (const card of report.cards) {
    const section = formatCard(card);
    const candidate = `${current}\n\n${section}`;
    if (candidate.length <= TELEGRAM_MAX_TEXT_LENGTH) {
      current = candidate;
      continue;
    }
    if (current !== header) pages.push(current);
    current = `${header}\n(continued)`;
    const available = TELEGRAM_MAX_TEXT_LENGTH - current.length - 2;
    if (section.length <= available) {
      current = `${current}\n\n${section}`;
    } else {
      // A single unusually large card is split into headed pages instead of
      // being truncated, so no matchup or critical evidence disappears.
      const chunks = splitText(section, available);
      for (const chunk of chunks) pages.push(`${current}\n\n${chunk}`);
      current = `${header}\n(continued)`;
    }
  }

  const footer = [
    ...formatWarnings(report.warnings),
    `Odds source: ${safeUrl(report.odds.sourceUrl)}`,
    "Research only: displayed odds and historical statistics are evidence, not a probability or recommendation.",
  ].join("\n");
  if (current.length + footer.length + 2 <= TELEGRAM_MAX_TEXT_LENGTH) {
    pages.push(`${current}\n\n${footer}`);
  } else {
    if (current.length > 0) pages.push(current);
    const footerHeader = `${header}\n(continued)`;
    for (const chunk of splitText(footer, TELEGRAM_MAX_TEXT_LENGTH - footerHeader.length - 2)) {
      pages.push(`${footerHeader}\n\n${chunk}`);
    }
  }
  return pages;
}

/** Alias kept useful for callers that describe the output as a report. */
export const formatValueReportMessages = formatValueMessages;

function formatHeader(report: ValueReport): string {
  const status = report.status === "complete" ? "complete" : report.status;
  const counts = report.counts;
  return [
    `📊 VALUE RESEARCH · ${safeField(report.odds.date, 32)}`,
    `${counts.cards} matchup${counts.cards === 1 ? "" : "s"} · ${status} · schedule/source order preserved`,
    formatObservedAt(report.odds.observedAt, report.odds.timeZone),
    `Generated: ${safeField(report.generatedAt, MAX_FIELD_LENGTH)}`,
    `Resolved identities: ${counts.resolvedPlayers} · unresolved player appearances: ${counts.unresolvedPlayers}`,
  ].join("\n");
}

function formatCard(card: ValueMatchCard): string {
  const match = card.match;
  const status = formatCardStatus(card.status);
  const context = formatContext(card.context.stage, card.context.format, card.context.status);
  return [
    `🟦 ${safeField(match.scheduledTime, 48)} · ${safeField(match.competition, MAX_FIELD_LENGTH)}`,
    `${safeField(match.player1, MAX_FIELD_LENGTH)} — ${formatPrice(match.odds1)}  vs  ${safeField(match.player2, MAX_FIELD_LENGTH)} — ${formatPrice(match.odds2)}`,
    `Bookmaker: ${safeField(match.bookmaker, 48)} · odds source: ${safeUrl(match.sourceUrl)}`,
    `Status: ${status}`,
    `Context: ${context}`,
    ...(card.player1.research === undefined || card.player2.research === undefined ? [] : buildResearchBrief(
      { name: match.player1, summary: card.player1.research },
      { name: match.player2, summary: card.player2.research },
    ).lines),
    formatPlayer(card.player1, 1),
    formatPlayer(card.player2, 2),
  ].join("\n");
}

function formatPlayer(player: ValuePlayerAssessment, position: 1 | 2): string {
  const name = player.canonicalName === null
    ? `unresolved (${safeField(player.requestedName, MAX_FIELD_LENGTH)})`
    : safeField(player.canonicalName, MAX_FIELD_LENGTH);
  const state = player.status === "available" ? "resolved" : player.status;
  const lines = [`Player ${position}: ${name} · ${state}`];
  if (player.status !== "available" && player.status !== "partial") {
    lines.push(`Cannot compare: ${safePlayerFailure(player)}.`);
  } else if (player.status === "partial") {
    // The backend deliberately supplies public state, not provider exception
    // text. Keep this boundary defensive for injected/test reports as well.
    lines.push("Research note: statistics coverage is partial.");
  }
  if (player.last10 !== null) lines.push(formatWindow(player.last10));
  else lines.push("Last 10: unavailable (no verified statistics).");
  if (player.last20 !== null) lines.push(formatWindow(player.last20));
  else lines.push("Last 20: unavailable (no verified statistics).");
  if (player.last10 !== null && player.last20 !== null) lines.push("Last 10 is included in Last 20; these are not independent evidence.");
  if (player.research !== undefined) {
    const research = player.research;
    const recent = research.latest10;
    const previous = research.previous10;
    lines.push(`Disjoint windows: latest 10 mean ${recent.summary.average === null ? "—" : formatNumber(recent.summary.average)} (${recent.matchCount}) vs previous 10 ${previous.summary.average === null ? "—" : formatNumber(previous.summary.average)} (${previous.matchCount}).`);
    lines.push(`Latest 10: median ${recent.medianAverage === null ? "—" : formatNumber(recent.medianAverage)} · sample SD ${recent.sampleStandardDeviation === null ? "—" : formatNumber(recent.sampleStandardDeviation)} · mean without highest/lowest ${recent.meanWithoutHighest === null ? "—" : formatNumber(recent.meanWithoutHighest)}/${recent.meanWithoutLowest === null ? "—" : formatNumber(recent.meanWithoutLowest)}.`);
    if (recent.dateSpan !== null) lines.push(`Observed matches: ${recent.dateSpan.oldest}–${recent.dateSpan.newest} (${recent.dateSpan.days} elapsed days).`);
    lines.push(`180/leg: ${recent.oneEightiesPerLeg === null ? "unavailable (no explicit paired denominator)" : `${formatNumber(recent.oneEightiesPerLeg)} (${recent.pairedOneEighties}/${recent.pairedLegs}; ${recent.pairedLegMatchCount} paired matches)`}.`);
    // Shared metric/context disclaimers appear in the window and matchup brief;
    // repeat only actionable sample/order warnings at player level.
    lines.push(...research.warnings.slice(2).map((warning: string): string => `Research note: ${safeField(warning, 240)}`));
  }
  if (player.source.evidence !== undefined) lines.push(`Evidence ${safeField(player.source.evidence.id, 72)} · observed ${safeField(player.source.evidence.observedAt, 40)} · ${player.source.evidence.persistence}${player.source.evidence.stale ? " · stale" : ""}`);
  if (player.source.sourceUrl !== null) lines.push(`Stats source: ${safeUrl(player.source.sourceUrl)}`);
  for (const evidenceUrl of player.source.evidenceUrls.slice(0, 2)) {
    lines.push(`Stats evidence: ${safeUrl(evidenceUrl)}`);
  }
  return lines.join("\n");
}

function safePlayerFailure(player: ValuePlayerAssessment): string {
  if (player.status === "unresolved") return "player identity could not be verified";
  if (player.error === "Player directory lookup timed out.") return "player identity directory lookup timed out";
  if (player.error === "Player directory lookup cancelled.") return "player identity directory lookup was cancelled";
  if (player.error === "Player directory unavailable.") return "player identity directory unavailable";
  if (player.error === "Source identity verification timed out.") return "source identity verification timed out";
  if (player.error === "Source identity verification was cancelled.") return "source identity verification was cancelled";
  if (player.error === "Source identity verification failed.") return "source identity verification failed";
  if (player.status === "timed_out") return "statistics research deadline reached";
  if (player.status === "cancelled") return "statistics research was cancelled";
  return "statistics source unavailable";
}

function formatWindow(window: ValueWindowSummary): string {
  const samples = `${window.matchCount}/${window.requestedMatches} completed matches`;
  const average = formatMetric(window.average.value, "avg", window.average.coverage);
  const checkout = window.checkout.percentage === null
    ? `checkout unavailable (${formatCoverage(window.checkout.coverage)})`
    : `checkout ${formatPercent(window.checkout.percentage)} (${window.checkout.hits ?? "?"}/${window.checkout.attempts ?? "?"} weighted; ${formatCoverage(window.checkout.coverage)})`;
  const oneEighties = window.oneEighties.total === null
    ? `180s unavailable (${formatCoverage(window.oneEighties.coverage)})`
    : `180s ${window.oneEighties.total} total (${formatCoverage(window.oneEighties.coverage)})`;
  return `Last ${window.window}: ${samples}; ${average} (arithmetic mean of match averages, not pooled); ${checkout}; ${oneEighties}`;
}

function formatMetric(value: number | null, label: string, coverage: ValueSourceCoverage): string {
  return value === null
    ? `${label} unavailable (${formatCoverage(coverage)})`
    : `${label} ${formatNumber(value)} (${formatCoverage(coverage)})`;
}

function formatCardStatus(status: ValueCardStatus): string {
  if (status === "complete") return "comparison complete";
  if (status === "partial") return "partial statistics; available evidence only";
  if (status === "unresolved") return "Cannot compare — player identity unresolved";
  if (status === "timed_out") return "Cannot compare — research deadline reached";
  if (status === "cancelled") return "Cannot compare — research cancelled";
  return "Cannot compare — statistics source failure";
}

function formatContext(stage: string | null, format: string | null, status: "unknown" | "verified"): string {
  if (status === "unknown") return "unknown (stage/format not verified)";
  return `verified${stage === null ? "" : ` · stage ${safeField(stage, 60)}`}${format === null ? "" : ` · format ${safeField(format, 60)}`}`;
}

function formatCoverage(coverage: ValueSourceCoverage): string {
  const status = coverage.status === "available" ? "complete" : coverage.status;
  return `${coverage.available}/${coverage.total} · ${status}`;
}

function formatObservedAt(value: string, timeZone: string): string {
  const original = safeField(value, MAX_FIELD_LENGTH);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return `Observed: ${original} · ${safeField(timeZone, 40)}`;
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(parsed));
  return `Observed: ${original} · local ${local} (${safeField(timeZone, 40)})`;
}

function formatPrice(value: number): string {
  return Number.isFinite(value) && value > 1 ? String(value) : "unavailable";
}

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(2) : "?"}%`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "?";
}

function formatWarnings(warnings: readonly string[]): readonly string[] {
  return warnings.slice(0, MAX_WARNING_COUNT).map((warning: string): string => `⚠️ ${safeField(warning, MAX_WARNING_LENGTH)}`);
}

function safeUrl(value: string): string {
  const normalized = value.trim();
  return /^https?:\/\//iu.test(normalized) ? safeField(normalized, MAX_URL_LENGTH) : "provider URL unavailable";
}

function safeField(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function splitText(value: string, maxLength: number): readonly string[] {
  if (maxLength <= 0) return [""];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    const boundary = remaining.lastIndexOf("\n", maxLength);
    const cut = boundary > 0 ? boundary : maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/u, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

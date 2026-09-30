import type { OddsMatch, OddsReport } from "../odds/contracts.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";

const MAX_SOURCE_URL_LENGTH = 240;
const MAX_FIELD_LENGTH = 180;
const MAX_WARNING_COUNT = 5;
const MAX_WARNING_LENGTH = 240;

/**
 * Render the provider's displayed odds without adding probabilities or a
 * recommendation. A page is kept below Telegram's hard text limit so a
 * large fixture list remains deliverable as several messages.
 */
export function formatOddsMessages(report: OddsReport): readonly string[] {
  const header = formatHeader(report);
  if (report.matches.length === 0) {
    return [
      [
        header,
        "No eligible scheduled TippmixPro match-winner odds were found for this date.",
        "This is a successful empty result, not a source outage.",
        "Read-only displayed prices; no value alert or probability is implied.",
        ...formatWarnings(report),
        `Source: ${safeUrl(report.sourceUrl)}`,
      ].join("\n"),
    ];
  }

  const messages: string[] = [];
  let current = header;
  for (const match of report.matches) {
    const section = formatMatch(match);
    const candidate = `${current}\n\n${section}`;
    if (current !== header && candidate.length > TELEGRAM_MAX_TEXT_LENGTH) {
      messages.push(current);
      current = `${header}\n(continued)`;
    }
    current = `${current}\n\n${section}`;
  }

  const footer = [
    ...formatWarnings(report),
    `Source: ${safeUrl(report.sourceUrl)}`,
    "Read-only displayed prices; prices can change. No value alert or probability is implied.",
  ].join("\n");
  if (current.length + footer.length + 2 <= TELEGRAM_MAX_TEXT_LENGTH) {
    messages.push(`${current}\n\n${footer}`);
  } else {
    messages.push(current);
    messages.push(`${header}\n\n${footer}`);
  }
  return messages;
}

function formatHeader(report: OddsReport): string {
  const observedAt = safeField(report.observedAt, MAX_FIELD_LENGTH);
  const source = safeField(report.source, 40);
  return [
    `🎲 ODDS · ${safeField(report.date, 32)}`,
    `${report.matches.length} match${report.matches.length === 1 ? "" : "es"} · ${source} · scheduled Europe/Budapest`,
    formatObservedAt(observedAt),
  ].join("\n");
}

function formatMatch(match: OddsMatch): string {
  const scheduled = safeField(match.scheduledTime, 48);
  const competition = safeField(match.competition, MAX_FIELD_LENGTH);
  const playerOne = safeField(match.player1, MAX_FIELD_LENGTH);
  const playerTwo = safeField(match.player2, MAX_FIELD_LENGTH);
  return [
    `${scheduled} · ${competition}`,
    `${playerOne} — ${formatPrice(match.odds1)}  vs  ${playerTwo} — ${formatPrice(match.odds2)}`,
    `Bookmaker: ${safeField(match.bookmaker, 40)}`,
    `Source: ${safeUrl(match.sourceUrl)}`,
  ].join("\n");
}

function formatPrice(value: number): string {
  return Number.isFinite(value) && value > 1 ? String(value) : "unavailable";
}

function formatObservedAt(value: string): string {
  const original = safeField(value, MAX_FIELD_LENGTH);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return `Observed: ${original} · Europe/Budapest time zone`;
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Budapest",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(parsed));
  return `Observed: ${original} · Budapest: ${local} (Europe/Budapest)`;
}

function formatWarnings(report: OddsReport): readonly string[] {
  return report.warnings
    .slice(0, MAX_WARNING_COUNT)
    .map((warning: string): string => `⚠️ ${safeField(warning, MAX_WARNING_LENGTH)}`);
}

function safeUrl(value: string): string {
  const normalized = value.trim();
  return /^https?:\/\//iu.test(normalized)
    ? safeField(normalized, MAX_SOURCE_URL_LENGTH)
    : "provider URL unavailable";
}

function safeField(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

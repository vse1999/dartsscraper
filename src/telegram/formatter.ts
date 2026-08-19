import type { Match } from "../schemas/match.js";
import { calculateMatchSummary } from "../services/statistics.js";
import type { PlayerStatsResult } from "./stats-service.js";

export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;
const MAX_PLAYER_NAME_LENGTH = 64;
const MAX_OPPONENT_NAME_LENGTH = 48;
const MAX_SOURCE_LABEL_LENGTH = 64;
const MAX_SOURCE_URL_LENGTH = 180;
const MAX_PROOF_URL_LENGTH = 100;
const SECTION_DIVIDER = "────────────────────";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatPlayerStats(result: PlayerStatsResult): string {
  if (result.provider === "modus-official" && result.evidenceUrls.length !== result.matches.length) {
    throw new Error("Official MODUS matches and evidence URLs are not aligned.");
  }
  const playerName = truncate(result.playerName, MAX_PLAYER_NAME_LENGTH);
  const summary = calculateMatchSummary(result.matches);
  const rows = result.matches.flatMap((match: Match, index: number): readonly string[] => {
    const opponent = truncate(match.opponent, MAX_OPPONENT_NAME_LENGTH);
    const average = match.average === null ? "—" : match.average.toFixed(2);
    const oneEighties = match.oneEighties === null || match.oneEighties === undefined ? "—" : String(match.oneEighties);
    const checkout = match.checkoutPercentage === null || match.checkoutPercentage === undefined
      ? "—"
      : `${match.checkoutPercentage.toFixed(2)}%`;
    const heading = `${index + 1}. ${formatResult(match.result)} vs ${opponent} (${formatScore(match.score)})`;
    const details = result.provider === "modus-official"
      ? `   ${formatDate(match.date)}  │  Average ${average}`
      : `   ${formatDate(match.date)}  │  Avg ${average}  │  180s ${oneEighties}  │  Checkout ${checkout}`;
    const evidenceUrl = result.evidenceUrls[index];
    return result.provider === "modus-official" && evidenceUrl !== undefined
      ? [heading, details, `   ↗ Proof: ${truncate(evidenceUrl, MAX_PROOF_URL_LENGTH)}`, ""]
      : [heading, details, ""];
  });
  const mean = result.meanAverage === null ? "—" : result.meanAverage.toFixed(2);
  const requestedNotice = result.matches.length === result.requestedCount
    ? ""
    : `⚠️ Requested ${result.requestedCount}; found ${result.matches.length}.`;
  const unclassifiedNotice = summary.unclassifiedResults === 0
    ? ""
    : `⚠️ Unclassified results: ${summary.unclassifiedResults}`;
  const missingDataNotice = hasIncompleteMetricCoverage(summary, result.matches.length)
    ? "ℹ️ Unavailable source values are shown as —."
    : "";

  const message = [
    `🎯 ${playerName}`,
    `${result.matches.length} latest completed matches`,
    `📍 ${truncate(result.sourceLabel, MAX_SOURCE_LABEL_LENGTH)}`,
    ...(requestedNotice === "" ? [] : [requestedNotice]),
    "",
    ...rows,
    SECTION_DIVIDER,
    "📊 SUMMARY",
    `Form: ${summary.wins}W · ${summary.losses}L · ${summary.draws}D`,
    `Average: ${mean}  │  Best: ${summary.bestAverage === null ? "—" : summary.bestAverage.toFixed(2)}`,
    `180s: ${summary.totalOneEighties === null ? "—" : `${summary.totalOneEighties} total`}`,
    `Checkout: ${summary.checkoutPercentage === null ? "—" : `${summary.checkoutPercentage.toFixed(2)}% · ${summary.checkoutHits}/${summary.checkoutAttempts} converted`}`,
    `Coverage: Avg ${result.availableAverageCount}/${result.matches.length} · 180s ${summary.availableOneEightiesCount}/${result.matches.length} · Checkout ${summary.availableCheckoutCount}/${result.matches.length}`,
    ...(unclassifiedNotice === "" ? [] : [unclassifiedNotice]),
    ...(missingDataNotice === "" ? [] : [missingDataNotice]),
    "",
    `🔗 Source: ${truncate(result.sourceUrl, MAX_SOURCE_URL_LENGTH)}`,
  ].join("\n");

  if (message.length > TELEGRAM_MAX_TEXT_LENGTH) {
    throw new Error("Formatted Telegram response exceeds the platform limit.");
  }
  return message;
}

function formatResult(result: string): string {
  const normalized = result.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (normalized === "won" || normalized === "win") return "✅ WIN";
  if (normalized === "lost" || normalized === "loss") return "❌ LOSS";
  if (normalized === "draw" || normalized === "drawn") return "➖ DRAW";
  return `• ${truncate(result, 16)}`;
}

function formatScore(score: string): string {
  const normalized = score.normalize("NFKC").trim();
  const legs = /^(\d+)\s+V\s+(\d+)$/iu.exec(normalized);
  return legs === null ? truncate(normalized, 20) : `${legs[1]}–${legs[2]}`;
}

function formatDate(date: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (parts === null) return truncate(date, 20);
  const monthIndex = Number(parts[2]) - 1;
  const month = MONTH_NAMES[monthIndex];
  if (month === undefined) return truncate(date, 20);
  return `${Number(parts[3])} ${month} ${parts[1]}`;
}

function hasIncompleteMetricCoverage(
  summary: ReturnType<typeof calculateMatchSummary>,
  matchCount: number,
): boolean {
  return summary.availableAverageCount < matchCount
    || summary.availableOneEightiesCount < matchCount
    || summary.availableCheckoutCount < matchCount;
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

import type { Match } from "../schemas/match.js";
import type { PlayerStatsResult } from "./stats-service.js";

export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_SOURCE_URL_LENGTH = 240;

export function formatPlayerStats(result: PlayerStatsResult): string {
  const playerName = truncate(result.playerName, MAX_DISPLAY_NAME_LENGTH);
  const rows = result.matches.map((match: Match, index: number): string => {
    const opponent = truncate(match.opponent, MAX_DISPLAY_NAME_LENGTH);
    const average = match.average === null ? "—" : match.average.toFixed(2);
    return `${index + 1}. ${match.date} vs ${opponent}: ${average}`;
  });
  const mean = result.meanAverage === null ? "—" : result.meanAverage.toFixed(2);
  const requestedNotice = result.matches.length === result.requestedCount
    ? ""
    : `Requested ${result.requestedCount}; found ${result.matches.length}.`;

  const message = [
    `${playerName} — ${result.matches.length} most recent completed matches`,
    requestedNotice,
    "",
    ...rows,
    "",
    `Mean match average: ${mean}`,
    `Available averages: ${result.availableAverageCount}/${result.matches.length}`,
    `Source: ${truncate(result.sourceUrl, MAX_SOURCE_URL_LENGTH)}`,
  ].filter((line: string): boolean => line !== "").join("\n");

  if (message.length > TELEGRAM_MAX_TEXT_LENGTH) {
    throw new Error("Formatted Telegram response exceeds the platform limit.");
  }
  return message;
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

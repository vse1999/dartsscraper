import type { MatchupAnalysis, MatchupPlayerAnalysis } from "../services/matchup-analysis.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";

const MAX_PLAYER_NAME_LENGTH = 64;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ModusMatchupFormatterOptions {
  readonly date: string;
  readonly dateLabel: "today" | "tomorrow";
  readonly matchCount: number;
  readonly analyses: readonly MatchupAnalysis[];
  readonly timeZone?: string;
  readonly incomplete?: boolean;
}

export function formatModusMatchupMessages(options: ModusMatchupFormatterOptions): readonly string[] {
  const header = [
    `🎯 MODUS ${options.dateLabel.toLocaleUpperCase("en-US")} · ${formatDate(options.date)}`,
    `${options.analyses.length} scheduled matchup${options.analyses.length === 1 ? "" : "s"}`,
    `Form = last ${options.matchCount} completed DartsOrakel matches`,
    ...(options.incomplete ? ["⚠️ Research incomplete; unavailable players were not retried."] : []),
  ].join("\n");
  const cards = options.analyses.map((analysis, index) => formatMatchupCard(
    analysis,
    index,
    options.timeZone ?? "Europe/Budapest",
  ));
  const footer = [
    ...(options.incomplete ? ["⚠️ MODUS research incomplete; unavailable players were not retried."] : []),
    "👇 Tap a player below for detailed match statistics.",
  ].join("\n");
  return splitAtCardBoundaries(header, cards, footer);
}

function formatMatchupCard(analysis: MatchupAnalysis, index: number, timeZone: string): string {
  const playerOne = truncate(analysis.fixture.playerOne, MAX_PLAYER_NAME_LENGTH);
  const playerTwo = truncate(analysis.fixture.playerTwo, MAX_PLAYER_NAME_LENGTH);
  const lines = [
    `${index + 1}. ${formatTime(analysis.fixture.startTime, timeZone)} · ${playerOne} vs ${playerTwo}`,
    formatParticipant(analysis.playerOne),
    formatTrend(analysis.playerOne),
    formatParticipant(analysis.playerTwo),
    formatTrend(analysis.playerTwo),
  ].filter((line): line is string => line !== null);
  if (analysis.headToHead.meetings > 0) {
    lines.push(
      `H2H in form window: ${playerOne} ${analysis.headToHead.playerOneWins}–${analysis.headToHead.playerTwoWins} ${playerTwo}`
      + (analysis.headToHead.draws === 0 ? "" : ` · ${analysis.headToHead.draws}D`),
    );
  } else {
    lines.push("H2H in form window: none found");
  }
  lines.push(`Signal: ${analysis.signal.description}`);
  lines.push(
    `Confidence: ${analysis.confidence.toLocaleUpperCase("en-US")} · Avg coverage ${analysis.availableAverageCount}/${analysis.expectedAverageCount}`,
  );
  return lines.join("\n");
}

function formatParticipant(player: MatchupPlayerAnalysis): string {
  const name = truncate(player.player, MAX_PLAYER_NAME_LENGTH);
  const summary = player.summary;
  if (!player.available || summary === null) return `${name}: form unavailable`;
  const average = summary.average === null ? "—" : summary.average.toFixed(2);
  const record = `${summary.wins}W–${summary.losses}L${summary.draws === 0 ? "" : `–${summary.draws}D`}`;
  const oneEighties = player.oneEightiesPerMatch === null ? "—" : player.oneEightiesPerMatch.toFixed(2);
  const checkout = summary.checkoutPercentage === null ? "—" : `${summary.checkoutPercentage.toFixed(2)}%`;
  return `${name}: ${average} avg · ${record} · ${oneEighties} 180/m · ${checkout} CO`;
}

function formatTrend(player: MatchupPlayerAnalysis): string | null {
  if (!player.available) return null;
  const trend = player.trend;
  if (trend === null) return "   Trend: —";
  const sign = trend.delta > 0 ? "+" : "";
  return `   Trend: ${sign}${trend.delta.toFixed(2)} (last ${trend.windowSize} vs previous ${trend.windowSize})`;
}

function splitAtCardBoundaries(header: string, cards: readonly string[], footer: string): readonly string[] {
  const messages: string[] = [];
  let currentHeader = header;
  let currentCards: string[] = [];
  for (const card of cards) {
    const candidate = joinMessage(currentHeader, currentCards.concat(card), "");
    if (currentCards.length > 0 && candidate.length > TELEGRAM_MAX_TEXT_LENGTH) {
      messages.push(joinMessage(currentHeader, currentCards, ""));
      currentHeader = `${header.split("\n")[0] ?? "🎯 MODUS"} · continued`;
      currentCards = [card];
      continue;
    }
    currentCards.push(card);
  }

  const finalMessage = joinMessage(currentHeader, currentCards, footer);
  if (finalMessage.length <= TELEGRAM_MAX_TEXT_LENGTH) {
    messages.push(finalMessage);
  } else {
    messages.push(joinMessage(currentHeader, currentCards, ""));
    messages.push(`${currentHeader}\n\n${footer}`);
  }
  if (messages.some((message) => message.length > TELEGRAM_MAX_TEXT_LENGTH)) {
    throw new Error("A MODUS matchup card exceeds Telegram's message limit.");
  }
  return messages;
}

function joinMessage(header: string, cards: readonly string[], footer: string): string {
  return [header, ...cards, footer].filter((part) => part !== "").join("\n\n");
}

function formatDate(date: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (parts === null) return date;
  const month = MONTH_NAMES[Number(parts[2]) - 1];
  return month === undefined ? date : `${Number(parts[3])} ${month} ${parts[1]}`;
}

function formatTime(startTime: string | null, timeZone: string): string {
  if (startTime === null) return "Time TBA";
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) return "Time TBA";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
}

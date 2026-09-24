import type { PdcFixture } from "../pdc/schemas.js";
import type { PdcUpcomingReport } from "../pdc/service.js";
import { normalizePlayerName } from "../player/resolver.js";
import {
  analyzeMatchup,
  type MatchupAnalysis,
  type MatchupPlayerAnalysis,
  type MatchupPlayerHistory,
} from "../services/matchup-analysis.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";

const DEFAULT_MATCH_COUNT = 10;
const MAX_PLAYER_NAME_LENGTH = 64;

export function formatPdcMatchupMessages(report: PdcUpcomingReport): readonly string[] {
  if (report.fixtures.length === 0) {
    return [`🎯 PDC MATCHUPS · ${report.date}\nNo scheduled PDC match was found for this date.`];
  }
  const histories = new Map<string, MatchupPlayerHistory>();
  let requestedCount = DEFAULT_MATCH_COUNT;
  for (const player of report.players) {
    if (player.stats === null) continue;
    histories.set(normalizePlayerName(player.requestedName), player.stats);
    requestedCount = player.stats.requestedCount;
  }
  const analyzedFixtures = report.fixtures.map((fixture): {
    readonly fixture: PdcFixture;
    readonly analysis: MatchupAnalysis;
  } => ({
    fixture,
    analysis: analyzeMatchup(
      fixture,
      histories.get(normalizePlayerName(fixture.playerOne)),
      histories.get(normalizePlayerName(fixture.playerTwo)),
      requestedCount,
    ),
  }));
  const incomplete = report.players.some((player) => player.failureCode !== null);
  const header = [
    `🎯 PDC MATCHUPS · ${report.date}`,
    `${report.fixtures.length} scheduled matchup${report.fixtures.length === 1 ? "" : "s"}`,
    `Form = last ${requestedCount} completed DartsOrakel matches`,
    ...(incomplete ? ["⚠️ Research incomplete; unavailable players were not retried."] : []),
  ].join("\n");
  const cards = analyzedFixtures.map(({ fixture, analysis }, index) => formatCard(fixture, analysis, index));
  const evidenceUrls = [...new Set(report.fixtures.flatMap(
    (fixture) => fixture.evidenceUrls ?? [fixture.sourceUrl],
  ))];
  const footer = [
    ...(incomplete
      ? ["⚠️ PDC research incomplete; some player form lookups reached the deadline."]
      : []),
    "Signals compare recent form only; they are not bookmaker-value estimates.",
    ...evidenceUrls.map((url) => `Schedule source: ${url}`),
  ].join("\n");
  return splitAtCardBoundaries(header, cards, footer);
}

function formatCard(fixture: PdcFixture, analysis: MatchupAnalysis, index: number): string {
  const playerOne = truncate(fixture.playerOne, MAX_PLAYER_NAME_LENGTH);
  const playerTwo = truncate(fixture.playerTwo, MAX_PLAYER_NAME_LENGTH);
  const context = [fixture.tournamentName, fixture.round].filter(
    (value): value is string => value !== null,
  ).join(" · ");
  const lines = [
    `${index + 1}. ${formatFixtureTime(fixture)} · ${playerOne} vs ${playerTwo}`,
    context,
    formatParticipant(analysis.playerOne),
    formatTrend(analysis.playerOne),
    formatParticipant(analysis.playerTwo),
    formatTrend(analysis.playerTwo),
    formatHeadToHead(analysis, playerOne, playerTwo),
    `Signal: ${analysis.signal.description}`,
    `Confidence: ${analysis.confidence.toLocaleUpperCase("en-US")} · Avg coverage ${analysis.availableAverageCount}/${analysis.expectedAverageCount}`,
  ];
  return lines.filter((line) => line !== "").join("\n");
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

function formatTrend(player: MatchupPlayerAnalysis): string {
  if (!player.available || player.trend === null) return "   Trend: —";
  const sign = player.trend.delta > 0 ? "+" : "";
  return `   Trend: ${sign}${player.trend.delta.toFixed(2)} (last ${player.trend.windowSize} vs previous ${player.trend.windowSize})`;
}

function formatHeadToHead(analysis: MatchupAnalysis, playerOne: string, playerTwo: string): string {
  const headToHead = analysis.headToHead;
  if (headToHead.meetings === 0) return "H2H in form window: none found";
  return `H2H in form window: ${playerOne} ${headToHead.playerOneWins}–${headToHead.playerTwoWins} ${playerTwo}`
    + (headToHead.draws === 0 ? "" : ` · ${headToHead.draws}D`);
}

function formatFixtureTime(fixture: PdcFixture): string {
  if (fixture.startTime === null) return fixture.session ?? "Time TBC";
  const start = new Date(fixture.startTime);
  if (Number.isNaN(start.getTime())) return fixture.session ?? "Time TBC";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Budapest",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(start);
}

function splitAtCardBoundaries(header: string, cards: readonly string[], footer: string): readonly string[] {
  const messages: string[] = [];
  let currentHeader = header;
  let currentCards: string[] = [];
  for (const card of cards) {
    const candidate = joinMessage(currentHeader, currentCards.concat(card), "");
    if (currentCards.length > 0 && candidate.length > TELEGRAM_MAX_TEXT_LENGTH) {
      messages.push(joinMessage(currentHeader, currentCards, ""));
      currentHeader = `${header.split("\n")[0] ?? "🎯 PDC MATCHUPS"} · continued`;
      currentCards = [card];
      continue;
    }
    currentCards.push(card);
  }
  const finalMessage = joinMessage(currentHeader, currentCards, footer);
  if (finalMessage.length <= TELEGRAM_MAX_TEXT_LENGTH) messages.push(finalMessage);
  else {
    messages.push(joinMessage(currentHeader, currentCards, ""));
    messages.push(`${currentHeader}\n\n${footer}`);
  }
  if (messages.some((message) => message.length > TELEGRAM_MAX_TEXT_LENGTH)) {
    throw new Error("A PDC matchup card exceeds Telegram's message limit.");
  }
  return messages;
}

function joinMessage(header: string, cards: readonly string[], footer: string): string {
  return [header, ...cards, footer].filter((part) => part !== "").join("\n\n");
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
}

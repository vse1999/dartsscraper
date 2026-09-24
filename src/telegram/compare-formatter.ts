import type { Match } from "../schemas/match.js";
import { calculateMatchSummary } from "../services/statistics.js";
import type { PlayerHistoryComparison } from "../services/matchup-analysis.js";
import type { ComparePlayerResearch, CompareReport } from "./compare-command.js";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";

const MAX_LABEL_LENGTH = 80;

export function formatCompareMessages(report: CompareReport): readonly string[] {
  const messages: string[] = [...formatSummary(report)];
  for (const player of report.players) {
    if (player.result === null) continue;
    messages.push(...formatEvidencePages(player));
  }
  return messages;
}

function formatSummary(report: CompareReport): readonly string[] {
  const header = [
    "🎯 PLAYER COMPARISON",
    `Latest ${report.requestedCount} completed DartsOrakel matches per player`,
    "This is descriptive recent-form research, not a betting-value or win-probability claim.",
  ].join("\n");
  const blocks: string[] = [];

  for (const player of report.players) blocks.push(formatPlayerSummary(player, report.requestedCount));
  const analysis = formatAnalysis(report.analysis);
  if (analysis !== null) blocks.push(analysis);
  blocks.push(`Generated ${report.generatedAt}`);
  return paginateBlocks(header, blocks);
}

function formatPlayerSummary(player: ComparePlayerResearch, requestedCount: number): string {
  const requestedName = truncateLabel(player.requestedName);
  if (player.result === null) {
    const prefix = `⚠️ ${requestedName}: `;
    const suffix = "… (details exceeded Telegram's message limit)";
    const maxFailureLength = TELEGRAM_MAX_TEXT_LENGTH - prefix.length - suffix.length;
    const failure = player.failureMessage.length <= maxFailureLength
      ? player.failureMessage
      : `${player.failureMessage.slice(0, maxFailureLength)}${suffix}`;
    return `${prefix}${failure}`;
  }

  const result = player.result;
  const summary = calculateMatchSummary(result.matches);
  const displayName = truncateLabel(result.playerName);
  const average = summary.average === null ? "—" : summary.average.toFixed(2);
  const best = summary.bestAverage === null ? "—" : summary.bestAverage.toFixed(2);
  const checkout = summary.checkoutPercentage === null ? "—" : `${summary.checkoutPercentage.toFixed(2)}%`;
  const checkoutEvidence = summary.checkoutAttempts === 0 ? "—" : `${summary.checkoutHits}/${summary.checkoutAttempts}`;
  const availableOneEighties = result.matches
    .map((match: Match): number | null => match.oneEighties ?? null)
    .filter((value: number | null): value is number => value !== null && Number.isFinite(value));
  const oneEightiesSum = availableOneEighties.reduce((total: number, value: number): number => total + value, 0);
  const oneEightiesTotal = result.matches.length > 0 && availableOneEighties.length === result.matches.length
    ? String(oneEightiesSum)
    : "—";
  const perMatch180s = availableOneEighties.length === 0 ? "—" : (oneEightiesSum / availableOneEighties.length).toFixed(2);
  return [
    `${displayName} · ${result.matches.length}/${requestedCount} matches`,
    `Form ${summary.wins}W-${summary.losses}L-${summary.draws}D · Unknown/unclassified ${summary.unclassifiedResults}`,
    `Avg ${average} · Best ${best}`,
    `180s ${oneEightiesTotal} total · ${perMatch180s} per available match`,
    `Checkout ${checkout} (${checkoutEvidence})`,
    `Coverage Avg ${summary.availableAverageCount}/${result.matches.length} · 180s ${summary.availableOneEightiesCount}/${result.matches.length} · Checkout ${summary.availableCheckoutCount}/${result.matches.length}`,
  ].join("\n");
}

function formatAnalysis(analysis: PlayerHistoryComparison | null): string | null {
  if (analysis === null) return null;
  const first = analysis.playerOne;
  const second = analysis.playerTwo;
  const h2h = analysis.headToHead;
  return [
    "📊 COMPARISON DETAILS",
    formatTrend(first.player, first.trend),
    formatTrend(second.player, second.trend),
    `H2H (${h2h.meetings} meetings in retrieved window): ${truncateLabel(first.player)} ${h2h.playerOneWins}W · ${truncateLabel(second.player)} ${h2h.playerTwoWins}W · draws ${h2h.draws}`,
    `Data coverage: ${analysis.availableAverageCount}/${analysis.expectedAverageCount} averages`,
  ].join("\n");
}

function formatTrend(playerName: string, trend: PlayerHistoryComparison["playerOne"]["trend"]): string {
  const label = truncateLabel(playerName);
  if (trend === null) return `Trend ${label}: unavailable (insufficient match/average coverage)`;
  return `Trend ${label}: latest ${trend.windowSize} avg ${trend.recentAverage.toFixed(2)} vs preceding ${trend.windowSize} avg ${trend.previousAverage.toFixed(2)} (${trend.delta >= 0 ? "+" : ""}${trend.delta.toFixed(2)})`;
}

function formatEvidencePages(player: ComparePlayerResearch): readonly string[] {
  const result = player.result;
  if (result === null) return [];
  const name = truncateLabel(result.playerName);
  const baseHeader = `📚 ${name} · evidence (${result.matches.length}/${result.requestedCount})`;
  const pages: string[] = [];
  let current = baseHeader;
  for (const [index, match] of result.matches.entries()) {
    const row = formatMatchRow(index + 1, match);
    const candidate = `${current}\n\n${row}`;
    if (candidate.length > TELEGRAM_MAX_TEXT_LENGTH) {
      pages.push(current);
      current = `${baseHeader} · continued`;
    }
    current = `${current}\n\n${row}`;
  }
  if (current !== baseHeader) {
    const sourceFooter = formatSourceFooter(result.sourceUrl);
    if (sourceFooter !== null && `${current}\n\n${sourceFooter}`.length <= TELEGRAM_MAX_TEXT_LENGTH) {
      pages.push(`${current}\n\n${sourceFooter}`);
    } else {
      pages.push(current);
      pages.push(...formatSourcePages(name, result.sourceUrl));
    }
  } else {
    pages.push(...formatSourcePages(name, result.sourceUrl));
  }
  return pages;
}

function formatSourceFooter(sourceUrl: string): string | null {
  if (sourceUrl.length === 0 || sourceUrl.length > TELEGRAM_MAX_TEXT_LENGTH) return null;
  return `Source: ${sourceUrl}`;
}

function formatSourcePages(playerName: string, sourceUrl: string): readonly string[] {
  const heading = `🔗 Source for ${playerName}`;
  if (sourceUrl.length === 0) return [`${heading}\nSource URL is unavailable.`];
  if (sourceUrl.length > TELEGRAM_MAX_TEXT_LENGTH) {
    return [`${heading}\nSource URL is too long to send safely (${sourceUrl.length} characters). Open DartsOrakel and search for ${playerName}.`];
  }
  const labeled = `${heading}\n${sourceUrl}`;
  // Keep the URL byte-for-byte intact. If the heading would make the page too
  // large, put the complete URL on its own page instead of cutting it.
  return labeled.length <= TELEGRAM_MAX_TEXT_LENGTH ? [labeled] : [heading, sourceUrl];
}

function formatMatchRow(index: number, match: Match): string {
  const average = match.average === null ? "—" : match.average.toFixed(2);
  const oneEighties = match.oneEighties === null || match.oneEighties === undefined ? "—" : String(match.oneEighties);
  const checkout = match.checkoutPercentage === null || match.checkoutPercentage === undefined ? "—" : `${match.checkoutPercentage.toFixed(2)}%`;
  return [
    `${index}. ${formatResult(match.result)} vs ${truncateLabel(match.opponent, 80)}`,
    `   ${truncateLabel(match.date, 32)} · ${truncateLabel(match.tournament, 100)} · ${formatScore(match.score)}`,
    `   Avg ${average} · 180s ${oneEighties} · Checkout ${checkout}`,
    match.round === null ? "" : `   Round ${truncateLabel(match.round, 60)}`,
  ].filter((line: string): boolean => line !== "").join("\n");
}

function formatResult(result: string): string {
  const normalized = result.trim().toLocaleLowerCase("en-US");
  if (normalized === "won" || normalized === "win" || normalized === "w") return "✅ WIN";
  if (normalized === "lost" || normalized === "loss" || normalized === "l") return "❌ LOSS";
  if (normalized === "draw" || normalized === "drawn" || normalized === "d") return "➖ DRAW";
  return truncateLabel(result, 16);
}

function formatScore(score: string): string {
  const match = /^(\d+)\s+V\s+(\d+)$/iu.exec(score.trim());
  return match === null ? truncateLabel(score, 20) : `${match[1]}–${match[2]}`;
}

function truncateLabel(value: string, maximumLength: number = MAX_LABEL_LENGTH): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

function paginateBlocks(header: string, blocks: readonly string[]): readonly string[] {
  const pages: string[] = [];
  let current = header;
  for (const block of blocks) {
    if (block.length > TELEGRAM_MAX_TEXT_LENGTH) {
      if (current !== header) pages.push(current);
      pages.push(`${block.slice(0, TELEGRAM_MAX_TEXT_LENGTH - 64)}… (details exceeded Telegram's message limit)`);
      current = `${header} · continued`;
      continue;
    }
    if (`${current}\n\n${block}`.length > TELEGRAM_MAX_TEXT_LENGTH) {
      pages.push(current);
      const continuation = `${header} · continued`;
      if (`${continuation}\n\n${block}`.length <= TELEGRAM_MAX_TEXT_LENGTH) {
        current = `${continuation}\n\n${block}`;
      } else {
        pages.push(block);
        current = continuation;
      }
    } else {
      current = `${current}\n\n${block}`;
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

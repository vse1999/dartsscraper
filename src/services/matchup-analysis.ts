import { normalizePlayerName } from "../player/resolver.js";
import type { Match } from "../schemas/match.js";
import { calculateMatchSummary, type MatchSummary } from "./statistics.js";

const MAX_TREND_WINDOW = 5;
const MIN_TREND_WINDOW = 3;
const MIN_AVERAGE_ADVANTAGE = 2;
const MIN_MOMENTUM_ADVANTAGE = 3;

export interface MatchupFixture {
  readonly id: string;
  readonly date: string;
  readonly startTime: string | null;
  readonly playerOne: string;
  readonly playerTwo: string;
}

export interface MatchupPlayerHistory {
  readonly playerName: string;
  readonly requestedCount: number;
  readonly matches: readonly Match[];
}

export interface AverageTrend {
  readonly windowSize: number;
  readonly recentAverage: number;
  readonly previousAverage: number;
  readonly delta: number;
}

export interface MatchupPlayerAnalysis {
  readonly player: string;
  readonly available: boolean;
  readonly summary: MatchSummary | null;
  readonly oneEightiesPerMatch: number | null;
  readonly trend: AverageTrend | null;
}

export interface MatchupHeadToHead {
  readonly meetings: number;
  readonly playerOneWins: number;
  readonly playerTwoWins: number;
  readonly draws: number;
}

export type MatchupConfidence = "high" | "medium" | "low";

export interface MatchupSignal {
  readonly code: "form-advantage" | "momentum-advantage" | "no-clear-edge" | "insufficient-data";
  readonly favoredPlayer: string | null;
  readonly description: string;
}

export interface MatchupAnalysis {
  readonly fixture: MatchupFixture;
  readonly playerOne: MatchupPlayerAnalysis;
  readonly playerTwo: MatchupPlayerAnalysis;
  readonly headToHead: MatchupHeadToHead;
  readonly confidence: MatchupConfidence;
  readonly signal: MatchupSignal;
  readonly availableAverageCount: number;
  readonly expectedAverageCount: number;
}

/**
 * The fixture-independent part of a matchup analysis. Manual comparisons use
 * this shape so their report does not invent an upcoming fixture or a
 * confidence/signal claim that was not requested.
 */
export interface PlayerHistoryComparison {
  readonly playerOne: MatchupPlayerAnalysis;
  readonly playerTwo: MatchupPlayerAnalysis;
  readonly headToHead: MatchupHeadToHead;
  readonly availableAverageCount: number;
  readonly expectedAverageCount: number;
}

export function analyzePlayerHistories(
  playerOneHistory: MatchupPlayerHistory,
  playerTwoHistory: MatchupPlayerHistory,
  requestedCount: number,
): PlayerHistoryComparison {
  validateRequestedCount(requestedCount);
  const playerOne = analyzePlayer(playerOneHistory.playerName, playerOneHistory);
  const playerTwo = analyzePlayer(playerTwoHistory.playerName, playerTwoHistory);
  return {
    playerOne,
    playerTwo,
    headToHead: calculateHeadToHeadByNames(
      playerOneHistory.playerName,
      playerTwoHistory.playerName,
      playerOneHistory,
      playerTwoHistory,
    ),
    availableAverageCount: (playerOne.summary?.availableAverageCount ?? 0)
      + (playerTwo.summary?.availableAverageCount ?? 0),
    expectedAverageCount: requestedCount * 2,
  };
}

export function analyzeMatchup(
  fixture: MatchupFixture,
  playerOneHistory: MatchupPlayerHistory | undefined,
  playerTwoHistory: MatchupPlayerHistory | undefined,
  requestedCount: number,
): MatchupAnalysis {
  validateRequestedCount(requestedCount);
  const playerOne = analyzePlayer(fixture.playerOne, playerOneHistory);
  const playerTwo = analyzePlayer(fixture.playerTwo, playerTwoHistory);
  const availableAverageCount = (playerOne.summary?.availableAverageCount ?? 0)
    + (playerTwo.summary?.availableAverageCount ?? 0);
  const expectedAverageCount = requestedCount * 2;
  const confidence = calculateConfidence(playerOne, playerTwo, requestedCount);
  return {
    fixture,
    playerOne,
    playerTwo,
    headToHead: calculateHeadToHead(fixture, playerOneHistory, playerTwoHistory),
    confidence,
    signal: calculateSignal(playerOne, playerTwo, confidence),
    availableAverageCount,
    expectedAverageCount,
  };
}

function analyzePlayer(player: string, history: MatchupPlayerHistory | undefined): MatchupPlayerAnalysis {
  if (history === undefined) {
    return { player, available: false, summary: null, oneEightiesPerMatch: null, trend: null };
  }
  const summary = calculateMatchSummary(history.matches);
  const availableOneEighties = history.matches
    .map((match) => match.oneEighties)
    .filter((value): value is number => value !== null && value !== undefined);
  return {
    player,
    available: true,
    summary,
    oneEightiesPerMatch: availableOneEighties.length === 0
      ? null
      : roundToTwo(availableOneEighties.reduce((total, value) => total + value, 0) / availableOneEighties.length),
    trend: calculateAverageTrend(history.matches),
  };
}

function calculateAverageTrend(matches: readonly Match[]): AverageTrend | null {
  const windowSize = Math.min(MAX_TREND_WINDOW, Math.floor(matches.length / 2));
  if (windowSize < MIN_TREND_WINDOW) return null;
  const recentAverage = calculateWindowAverage(matches.slice(0, windowSize), windowSize);
  const previousAverage = calculateWindowAverage(matches.slice(windowSize, windowSize * 2), windowSize);
  if (recentAverage === null || previousAverage === null) return null;
  return {
    windowSize,
    recentAverage,
    previousAverage,
    delta: roundToTwo(recentAverage - previousAverage),
  };
}

function calculateWindowAverage(matches: readonly Match[], windowSize: number): number | null {
  const values = matches
    .map((match) => match.average)
    .filter((average): average is number => average !== null && Number.isFinite(average));
  if (values.length < Math.ceil(windowSize * 0.6)) return null;
  return roundToTwo(values.reduce((total, average) => total + average, 0) / values.length);
}

function calculateHeadToHead(
  fixture: MatchupFixture,
  playerOneHistory: MatchupPlayerHistory | undefined,
  playerTwoHistory: MatchupPlayerHistory | undefined,
): MatchupHeadToHead {
  return calculateHeadToHeadByNames(fixture.playerOne, fixture.playerTwo, playerOneHistory, playerTwoHistory);
}

function calculateHeadToHeadByNames(
  playerOneName: string,
  playerTwoName: string,
  playerOneHistory: MatchupPlayerHistory | undefined,
  playerTwoHistory: MatchupPlayerHistory | undefined,
): MatchupHeadToHead {
  const fromPlayerOne = playerOneHistory?.matches.filter(
    (match) => normalizePlayerName(match.opponent) === normalizePlayerName(playerTwoName),
  ) ?? [];
  if (fromPlayerOne.length > 0) return summarizeHeadToHead(fromPlayerOne, false);

  const fromPlayerTwo = playerTwoHistory?.matches.filter(
    (match) => normalizePlayerName(match.opponent) === normalizePlayerName(playerOneName),
  ) ?? [];
  return summarizeHeadToHead(fromPlayerTwo, true);
}

function summarizeHeadToHead(matches: readonly Match[], reversePerspective: boolean): MatchupHeadToHead {
  let playerOneWins = 0;
  let playerTwoWins = 0;
  let draws = 0;
  for (const match of matches) {
    const result = classifyResult(match.result);
    if (result === "draw") draws += 1;
    else if (result === "win") {
      if (reversePerspective) playerTwoWins += 1;
      else playerOneWins += 1;
    } else if (result === "loss") {
      if (reversePerspective) playerOneWins += 1;
      else playerTwoWins += 1;
    }
  }
  return { meetings: playerOneWins + playerTwoWins + draws, playerOneWins, playerTwoWins, draws };
}

function classifyResult(result: string): "win" | "loss" | "draw" | "unknown" {
  const normalized = result.trim().toLocaleLowerCase("en-US");
  if (normalized === "won" || normalized === "win" || normalized === "w") return "win";
  if (normalized === "lost" || normalized === "loss" || normalized === "l") return "loss";
  if (normalized === "draw" || normalized === "drawn" || normalized === "d") return "draw";
  return "unknown";
}

function calculateConfidence(
  playerOne: MatchupPlayerAnalysis,
  playerTwo: MatchupPlayerAnalysis,
  requestedCount: number,
): MatchupConfidence {
  const summaries = [playerOne.summary, playerTwo.summary];
  if (summaries.some((summary) => summary === null)) return "low";
  const available = summaries.reduce((total, summary) => total + (summary?.availableAverageCount ?? 0), 0);
  const expected = requestedCount * 2;
  const minimumMatches = Math.min(...summaries.map((summary) => summary?.matchCount ?? 0));
  if (minimumMatches >= Math.min(requestedCount, 8) && available / expected >= 0.8) return "high";
  if (minimumMatches >= Math.min(requestedCount, 5) && available / expected >= 0.6) return "medium";
  return "low";
}

function calculateSignal(
  playerOne: MatchupPlayerAnalysis,
  playerTwo: MatchupPlayerAnalysis,
  confidence: MatchupConfidence,
): MatchupSignal {
  const firstAverage = playerOne.summary?.average;
  const secondAverage = playerTwo.summary?.average;
  if (confidence === "low" || firstAverage === null || firstAverage === undefined
    || secondAverage === null || secondAverage === undefined) {
    return {
      code: "insufficient-data",
      favoredPlayer: null,
      description: "Insufficient form coverage for a reliable comparison",
    };
  }

  const averageDifference = roundToTwo(firstAverage - secondAverage);
  if (Math.abs(averageDifference) >= MIN_AVERAGE_ADVANTAGE) {
    const favoredPlayer = averageDifference > 0 ? playerOne.player : playerTwo.player;
    return {
      code: "form-advantage",
      favoredPlayer,
      description: `${favoredPlayer} recent-form advantage (${formatSigned(Math.abs(averageDifference))} avg)`,
    };
  }

  const firstTrend = playerOne.trend?.delta;
  const secondTrend = playerTwo.trend?.delta;
  if (firstTrend !== undefined && secondTrend !== undefined) {
    const momentumDifference = roundToTwo(firstTrend - secondTrend);
    if (Math.abs(momentumDifference) >= MIN_MOMENTUM_ADVANTAGE) {
      const favoredPlayer = momentumDifference > 0 ? playerOne.player : playerTwo.player;
      return {
        code: "momentum-advantage",
        favoredPlayer,
        description: `${favoredPlayer} recent momentum advantage`,
      };
    }
  }

  return { code: "no-clear-edge", favoredPlayer: null, description: "No clear recent-form edge" };
}

function formatSigned(value: number): string {
  return `+${value.toFixed(2)}`;
}

function roundToTwo(value: number): number {
  return Number(value.toFixed(2));
}

function validateRequestedCount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("requestedCount must be a positive integer.");
}

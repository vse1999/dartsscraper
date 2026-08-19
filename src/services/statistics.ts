import type { Match } from "../schemas/match.js";

export interface MatchSummary {
  readonly matchCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly unclassifiedResults: number;
  readonly average: number | null;
  readonly availableAverageCount: number;
  readonly bestAverage: number | null;
  readonly totalOneEighties: number | null;
  readonly availableOneEightiesCount: number;
  readonly checkoutPercentage: number | null;
  readonly checkoutHits: number;
  readonly checkoutAttempts: number;
  readonly availableCheckoutCount: number;
}

export function calculateMatchAverage(matches: readonly Match[]): number | null {
  const availableAverages = matches
    .map((match) => match.average)
    .filter((average): average is number => average !== null && Number.isFinite(average));
  if (availableAverages.length === 0) {
    return null;
  }
  const total = availableAverages.reduce((sum, average) => sum + average, 0);
  return Number((total / availableAverages.length).toFixed(2));
}

export function calculateMatchSummary(matches: readonly Match[]): MatchSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let unclassifiedResults = 0;
  const averages: number[] = [];
  const oneEighties: number[] = [];
  let checkoutHits = 0;
  let checkoutAttempts = 0;
  let availableCheckoutCount = 0;

  for (const match of matches) {
    const result = match.result.trim().toLocaleLowerCase("en-US");
    if (result === "won" || result === "win" || result === "w") wins += 1;
    else if (result === "lost" || result === "loss" || result === "l") losses += 1;
    else if (result === "draw" || result === "drawn" || result === "d") draws += 1;
    else unclassifiedResults += 1;

    if (match.average !== null && Number.isFinite(match.average)) averages.push(match.average);
    if (match.oneEighties !== null && match.oneEighties !== undefined) oneEighties.push(match.oneEighties);
    if (
      match.checkoutHits !== null
      && match.checkoutHits !== undefined
      && match.checkoutAttempts !== null
      && match.checkoutAttempts !== undefined
      && match.checkoutAttempts > 0
    ) {
      checkoutHits += match.checkoutHits;
      checkoutAttempts += match.checkoutAttempts;
      availableCheckoutCount += 1;
    }
  }

  return {
    matchCount: matches.length,
    wins,
    losses,
    draws,
    unclassifiedResults,
    average: calculateMatchAverage(matches),
    availableAverageCount: averages.length,
    bestAverage: averages.length === 0 ? null : Math.max(...averages),
    totalOneEighties: matches.length > 0 && oneEighties.length === matches.length
      ? oneEighties.reduce((total, count) => total + count, 0)
      : null,
    availableOneEightiesCount: oneEighties.length,
    checkoutPercentage: checkoutAttempts === 0
      ? null
      : Number(((checkoutHits / checkoutAttempts) * 100).toFixed(2)),
    checkoutHits,
    checkoutAttempts,
    availableCheckoutCount,
  };
}

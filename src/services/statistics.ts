import type { Match } from "../schemas/match.js";

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

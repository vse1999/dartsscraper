import type { ResearchHistorySummary } from "./statistics.js";
import type { MatchSummary } from "../services/statistics.js";

export interface ResearchBriefPlayer {
  readonly name: string;
  readonly summary: ResearchHistorySummary;
}

export interface ResearchBrief { readonly lines: readonly string[] }

/** Pure descriptive evidence: no thresholds, probabilities, ranking, or action recommendation. */
export function buildResearchBrief(first: ResearchBriefPlayer, second: ResearchBriefPlayer): ResearchBrief {
  return buildSummaryBrief(first.name, first.summary.latest10.summary, second.name, second.summary.latest10.summary);
}

export function buildSummaryBrief(firstName: string, left: MatchSummary, secondName: string, right: MatchSummary): ResearchBrief {
  const label = `${safeName(firstName)} minus ${safeName(secondName)}`;
  const scoring = difference(left.average, right.average);
  const finishing = difference(left.checkoutPercentage, right.checkoutPercentage);
  const lines = [
    `Brief (${label}): mean-of-match-averages delta ${signed(scoring)}; weighted checkout delta ${signed(finishing)} percentage points.`,
    `Samples: averages ${left.availableAverageCount}/${left.matchCount} vs ${right.availableAverageCount}/${right.matchCount}; checkout ${left.checkoutAttempts === 0 ? "unavailable" : `${left.checkoutHits}/${left.checkoutAttempts}`} vs ${right.checkoutAttempts === 0 ? "unavailable" : `${right.checkoutHits}/${right.checkoutAttempts}`} hits/attempts.`,
  ];
  if (scoring !== null && finishing !== null && scoring * finishing < 0) {
    lines.push("Contrary evidence: scoring and finishing differences point in opposite directions.");
  }
  if (scoring === null || finishing === null) lines.push("Missing evidence: a scoring or finishing comparison is unavailable; no advantage is inferred.");
  lines.push("Unknowns: match-format comparability, opponent adjustment, and source-update freshness. Descriptive evidence only.");
  lines.push("Next useful evidence: verified format and source-update time" + (scoring === null || finishing === null ? ", plus the missing scoring/checkout denominators." : "; these could change the comparison."));
  return { lines };
}

function difference(first: number | null, second: number | null): number | null {
  return first === null || second === null ? null : Number((first - second).toFixed(2));
}
function signed(value: number | null): string { return value === null ? "unavailable" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`; }
function safeName(value: string): string { return value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 64); }

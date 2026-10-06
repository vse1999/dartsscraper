import type { OddsDay, OddsIdentityReader, OddsMatch, OddsReader, OddsReport } from "../odds/contracts.js";
import type { PlayerStatsReader, PlayerStatsResult } from "../telegram/stats-service.js";
import type { PlayerIdentity } from "../schemas/player.js";
import type { ResearchHistorySummary } from "../research/statistics.js";
import type { ResearchEvidenceReference } from "../research/history-service.js";
import type { QualityAssessment } from "../research/quality.js";
import type { ResearchCoverageScopes } from "../research/history-service.js";

export type ValueReaderDay = OddsDay;
export type ValueDataStatus = "available" | "partial" | "unavailable" | "unresolved" | "timed_out" | "cancelled" | "failed";
export type ValueCardStatus = "complete" | "partial" | "unresolved" | "timed_out" | "cancelled" | "failed";
export type ValueMetricStatus = "available" | "partial" | "unavailable";

export interface ValueSourceCoverage {
  readonly available: number;
  readonly total: number;
  readonly ratio: number;
  readonly status: ValueMetricStatus;
}

export interface ValueAverageSummary {
  readonly value: number | null;
  readonly coverage: ValueSourceCoverage;
}

export interface ValueOneEightiesSummary {
  readonly total: number | null;
  readonly average: number | null;
  readonly coverage: ValueSourceCoverage;
}

/** Checkout is intentionally aggregated from hit/attempt counts (weighted), never by averaging percentages. */
export interface ValueCheckoutSummary {
  readonly hits: number | null;
  readonly attempts: number | null;
  readonly percentage: number | null;
  readonly zeroAttemptMatches: number;
  readonly coverage: ValueSourceCoverage;
}

export interface ValueWindowSummary {
  readonly window: 10 | 20;
  readonly requestedMatches: number;
  readonly matchCount: number;
  readonly average: ValueAverageSummary;
  readonly oneEighties: ValueOneEightiesSummary;
  readonly checkout: ValueCheckoutSummary;
}

export interface ValuePlayerContext {
  readonly stage: string | null;
  readonly format: string | null;
  readonly status: "unknown" | "verified";
}

export interface ValuePlayerAssessment {
  readonly assessment?: QualityAssessment;
  readonly coverage?: ResearchCoverageScopes;
  readonly research?: ResearchHistorySummary;
  readonly requestedName: string;
  readonly status: ValueDataStatus;
  readonly identity: PlayerIdentity | null;
  readonly canonicalName: string | null;
  readonly source: {
    readonly evidence?: ResearchEvidenceReference;
    readonly label: string | null;
    readonly provider: PlayerStatsResult["provider"] | null;
    readonly sourceUrl: string | null;
    readonly evidenceUrls: readonly string[];
  };
  readonly last10: ValueWindowSummary | null;
  readonly last20: ValueWindowSummary | null;
  readonly error: string | null;
  readonly context: ValuePlayerContext;
}

export interface ValueMatchCard {
  readonly match: OddsMatch;
  /** Player assessments retain the displayed odds order. */
  readonly players: readonly [ValuePlayerAssessment, ValuePlayerAssessment];
  readonly player1: ValuePlayerAssessment;
  readonly player2: ValuePlayerAssessment;
  readonly status: ValueCardStatus;
  readonly context: ValuePlayerContext;
}

export interface ValueOddsObservation {
  readonly source: OddsReport["source"];
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly date: string;
  readonly timeZone: OddsReport["timeZone"];
  readonly warnings: readonly string[];
  readonly matchCount: number;
}

export interface ValueReportCounts {
  readonly oddsMatches: number;
  readonly cards: number;
  readonly completeCards: number;
  readonly partialCards: number;
  readonly unresolvedCards: number;
  readonly timedOutCards: number;
  readonly cancelledCards: number;
  readonly failedCards: number;
  readonly resolvedPlayers: number;
  readonly unresolvedPlayers: number;
}

export interface ValueReport {
  readonly day: ValueReaderDay;
  readonly generatedAt: string;
  readonly odds: ValueOddsObservation;
  readonly cards: readonly ValueMatchCard[];
  readonly counts: ValueReportCounts;
  readonly status: "complete" | "partial" | "failed" | "cancelled";
  readonly warnings: readonly string[];
}

export interface ValuePlayerDirectory {
  getPlayers(signal?: AbortSignal): Promise<readonly PlayerIdentity[]>;
  /** Bounded same-provider refresh for a verified full-name miss, never a guessed identity. */
  refreshAfterMiss?(signal?: AbortSignal): Promise<readonly PlayerIdentity[]>;
}

export interface ValueReaderDependencies {
  readonly oddsReader: Pick<OddsReader, "getOdds"> & Partial<Pick<OddsIdentityReader, "getIdentityEvidence" | "maxIdentityEvidenceMatches">>;
  readonly playerStatsReader: Pick<PlayerStatsReader, "getPlayerStats">;
  /** A DartsOrakel-backed directory. Matching is exact or surname+first-initial only. */
  readonly playerDirectory: ValuePlayerDirectory;
  readonly maxConcurrency?: number;
  /** Soft cutoff for directory/history enrichment. Odds acquisition keeps its own source timeout. */
  readonly researchBudgetMs?: number;
  readonly now?: () => Date;
}

export interface ValueReader {
  getReport(day: OddsDay, signal?: AbortSignal): Promise<ValueReport>;
}

export type ValueResearchDependencies = ValueReaderDependencies;

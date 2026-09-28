import type {
  CompletedHistoryMatch,
  HistorySnapshot,
  WatchlistScreenInput,
} from "../../src/watchlist/contracts.js";

export const SYNTHETIC_NOW = new Date("2026-01-20T12:00:00.000Z");

function makeHistoryMatch(
  playerId: string,
  opponentId: string,
  matchNumber: number,
  average: number,
  checkoutHits: number,
  oneEighties: number,
): CompletedHistoryMatch {
  const completedAt = new Date(Date.UTC(2026, 0, 20, 11, 20 - matchNumber)).toISOString();
  return {
    matchId: `${playerId}-match-${matchNumber}`,
    playerId,
    opponent: { id: opponentId, name: opponentId === "p1" ? "Alpha" : "Beta" },
    status: "completed",
    result: "win",
    playedAt: completedAt,
    completedAt,
    stats: {
      average,
      checkoutHits,
      checkoutAttempts: 10,
      oneEighties,
      legs: 10,
    },
    context: {
      competitionId: "competition-1",
      eventId: `history-event-${playerId}-${matchNumber}`,
      round: "round-1",
      stage: "main",
      floor: "stage",
      format: "best-of-11",
    },
    evidence: {
      kind: "official",
      sourceId: "synthetic-history",
      sourceUrl: "https://example.test/history",
      observedAt: "2026-01-20T11:55:00.000Z",
    },
  };
}

function makeHistory(playerId: string, opponentId: string, average: number, hits: number, oneEighties: number): HistorySnapshot {
  return {
    playerId,
    observedAt: "2026-01-20T11:55:00.000Z",
    source: {
      kind: "official",
      sourceId: "synthetic-history",
      sourceUrl: "https://example.test/history",
      observedAt: "2026-01-20T11:55:00.000Z",
    },
    matches: Array.from({ length: 20 }, (_, index) => makeHistoryMatch(
      playerId,
      opponentId,
      index + 1,
      average,
      hits,
      oneEighties,
    )),
  };
}

export function createSyntheticWatchlistInput(): WatchlistScreenInput {
  return {
    price: {
      quote: {
        competitionOccurrenceId: "competition-1-2026-01-20",
        eventId: "event-1",
        round: "round-1",
        players: [
          { id: "p1", name: "Álpha" },
          { id: "p2", name: "Beta" },
        ],
        selectedPlayerId: "p1",
        bookmakerId: "tippmixpro",
        providerEventId: "provider-event-1",
        providerMarketId: "provider-market-1",
        providerSelectionId: "provider-selection-p1",
        marketType: "match_winner",
        marketStatus: "open",
        eventStatus: "prematch",
        scheduledStart: "2026-01-20T12:10:00.000Z",
        observedAt: "2026-01-20T11:59:00.000Z",
        sourceUpdatedAt: "2026-01-20T11:59:00.000Z",
        source: {
          kind: "aggregator",
          sourceId: "oddsportal",
          sourceUrl: "https://example.test/odds",
          observedAt: "2026-01-20T11:59:00.000Z",
        },
        eventContext: {
          stage: "main",
          floor: "stage",
          format: "best-of-11",
          evidence: {
            kind: "official",
            sourceId: "synthetic-context",
            sourceUrl: "https://example.test/context",
            observedAt: "2026-01-20T11:58:00.000Z",
          },
        },
        isPromotion: false,
      },
      decimalPrice: 2.1,
    },
    selectedHistory: makeHistory("p1", "p2", 95, 4, 3),
    opponentHistory: makeHistory("p2", "p1", 90, 2, 1),
    rules: {
      version: "synthetic-v1",
      minimumMatchesByWindow: { 10: 10, 20: 20 },
      minimumMetricCoverage: { average: 1, checkoutRate: 1, oneEightyPerLeg: 1 },
      superiority: { average: 1, checkoutRate: 0.05, oneEightyPerLeg: 0.05 },
      priceBands: [
        { minInclusive: 1.01, maxExclusive: 1.5, minimumAverageDifference: 3, minimumCheckoutRateDifference: 0.08, minimumOneEightyDifference: 0.08 },
        { minInclusive: 1.5, maxExclusive: 2, minimumAverageDifference: 2, minimumCheckoutRateDifference: 0.06, minimumOneEightyDifference: 0.06 },
        { minInclusive: 2, maxExclusive: null, minimumAverageDifference: 1, minimumCheckoutRateDifference: 0.05, minimumOneEightyDifference: 0.05 },
      ],
      allowedBookmakers: ["tippmixpro"],
      allowedSourceIds: ["oddsportal"],
      quoteMaxAgeMs: 120_000,
      historyMaxAgeMs: 86_400_000,
      minimumStartLeadMs: 120_000,
    },
  };
}

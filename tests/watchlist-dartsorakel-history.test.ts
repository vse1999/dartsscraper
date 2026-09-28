import { describe, expect, it } from "vitest";

import {
  normalizeDartsOrakelHistory,
  type DartsOrakelHistoryNormalizationInput,
} from "../src/watchlist/dartsorakel-history.js";
import { screenWatchlistCandidate } from "../src/watchlist/screening.js";
import { formatWatchlistPreviewPages } from "../src/watchlist/preview-formatter.js";
import type { DartsOrakelMatchRow, DartsOrakelMatchesResponse } from "../src/dartsorakel/parser.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import { readMatchFixture } from "./helpers.js";
import { createSyntheticWatchlistInput } from "./fixtures/watchlist-screening.js";

const PLAYER: PlayerIdentity = { id: 29, name: "Rob Cross", slug: "rob-cross" };
const SOURCE_OBSERVED_AT = "2026-09-10T12:00:00.000Z";
const SOURCE_URL = "https://dartsorakel.com/player/details/29/rob-cross";

function baseInput(rowCount: number = 21): DartsOrakelHistoryNormalizationInput {
  const rows = syntheticRows(rowCount);
  return {
    player: PLAYER,
    sourceObservedAt: SOURCE_OBSERVED_AT,
    sourceUrl: SOURCE_URL,
    responses: {
      average: response(rows, "average"),
      oneEighties: response(rows, "oneEighties"),
      checkoutPercentage: response(rows, "checkoutPercentage"),
    },
  };
}

function fixtureInput(
  player: PlayerIdentity,
  fixtureName: string,
  average: number,
  checkoutHits: number,
): DartsOrakelHistoryNormalizationInput {
  const rows = syntheticRowsFromFixture(fixtureName, 21).map((row): DartsOrakelMatchRow => ({ ...row, stat: average }));
  return {
    player,
    sourceObservedAt: SOURCE_OBSERVED_AT,
    sourceUrl: SOURCE_URL,
    responses: {
      average: response(rows, "average"),
      oneEighties: response(rows, "oneEighties"),
      checkoutPercentage: responseWithCheckout(rows, checkoutHits),
    },
  };
}

function syntheticRows(count: number): DartsOrakelMatchRow[] {
  return syntheticRowsFromFixture("rob-cross-matches.json", count);
}

function syntheticRowsFromFixture(fixtureName: string, count: number): DartsOrakelMatchRow[] {
  const fixture = readMatchFixture(fixtureName);
  return fixture.data.slice(0, count).map((row, index): DartsOrakelMatchRow => ({
    ...row,
    match_date: new Date(Date.UTC(2026, 7, 31 - index)).toISOString().slice(0, 10),
  }));
}

function response(rows: readonly DartsOrakelMatchRow[], metric: "average" | "oneEighties" | "checkoutPercentage"): DartsOrakelMatchesResponse {
  const data = rows.map((row, index): DartsOrakelMatchRow => {
    if (metric === "average") return row;
    if (metric === "oneEighties") return { ...row, stat: index, stat1: index, stat2: null };
    return { ...row, stat: "50.00%", stat1: 1, stat2: 2 };
  });
  return { draw: 0, recordsTotal: data.length, recordsFiltered: data.length, data };
}

function responseWithCheckout(rows: readonly DartsOrakelMatchRow[], hits: number): DartsOrakelMatchesResponse {
  const attempts = 10;
  const percentage = `${((hits / attempts) * 100).toFixed(2)}%`;
  const data = rows.map((row): DartsOrakelMatchRow => ({ ...row, stat: percentage, stat1: hits, stat2: attempts }));
  return { draw: 0, recordsTotal: data.length, recordsFiltered: data.length, data };
}

function result(input: DartsOrakelHistoryNormalizationInput = baseInput()): ReturnType<typeof normalizeDartsOrakelHistory> {
  return normalizeDartsOrakelHistory(input);
}

describe("DartsOrakel history normalizer", () => {
  it("normalizes occurrence IDs, counterpart metrics, provenance, and date-only history", () => {
    const normalized = result();

    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected a ready history snapshot.");
    expect(normalized.snapshot.matches).toHaveLength(20);
    expect(normalized.snapshot.playerId).toBe("29");
    expect(normalized.snapshot.matches[0]).toMatchObject({
      matchId: expect.stringContaining("dartsorakel-composite:"),
      opponent: { id: "2", name: "Gerwyn Price" },
      result: "loss",
      playedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      context: { competitionId: "29", eventId: "7536" },
      stats: { average: 93.82, oneEighties: 0, checkoutHits: 1, checkoutAttempts: 2 },
    });
    expect(normalized.snapshot.source).toMatchObject({ sourceId: "dartsorakel", sourceUrl: SOURCE_URL, observedAt: SOURCE_OBSERVED_AT });
    expect(normalized.metadata.collectionPermissionVerified).toBe(false);
    expect(normalized.metadata.usableAsLiveQuote).toBe(false);
  });

  it("matches shuffled metric rows by invariant identity, never response position", () => {
    const input = baseInput();
    const responses = input.responses as { average: DartsOrakelMatchesResponse; oneEighties: DartsOrakelMatchesResponse; checkoutPercentage: DartsOrakelMatchesResponse };
    responses.oneEighties = { ...responses.oneEighties, data: [...responses.oneEighties.data].reverse() };
    responses.checkoutPercentage = { ...responses.checkoutPercentage, data: [...responses.checkoutPercentage.data].reverse() };

    const normalized = result(input);
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected a ready history snapshot.");
    expect(normalized.snapshot.matches[0]?.stats.oneEighties).toBe(0);
    expect(normalized.snapshot.matches[0]?.stats.checkoutHits).toBe(1);
  });

  it("preserves missing checkout evidence without converting it to zero", () => {
    const input = baseInput();
    const responses = input.responses as { checkoutPercentage: DartsOrakelMatchesResponse };
    const first = responses.checkoutPercentage.data[0];
    if (first === undefined) throw new Error("Synthetic response is empty.");
    responses.checkoutPercentage = {
      ...responses.checkoutPercentage,
      data: [{ ...first, stat: null, stat1: null, stat2: null }, ...responses.checkoutPercentage.data.slice(1)],
    };

    const normalized = result(input);
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected a ready history snapshot.");
    expect(normalized.snapshot.matches[0]?.stats.checkoutHits).toBeNull();
    expect(normalized.snapshot.matches[0]?.stats.checkoutAttempts).toBeNull();
    expect(normalized.warnings.some((warning): boolean => warning.code === "OPTIONAL_STATISTIC_UNAVAILABLE")).toBe(true);
  });

  it("omits an absent or partial optional 180 response instead of claiming it was complete", () => {
    const absent = baseInput();
    const absentResponses = absent.responses as Record<string, unknown>;
    delete absentResponses["oneEighties"];
    const absentResult = result(absent);
    expect(absentResult.status).toBe("ready");
    if (absentResult.status !== "ready") throw new Error("Expected absent optional 180 evidence to remain usable.");
    expect(absentResult.metadata.oneEightyResponseVerified).toBe(false);
    expect(absentResult.warnings.some((warning): boolean => warning.code === "OPTIONAL_STATISTIC_UNAVAILABLE")).toBe(true);

    const partial = baseInput();
    const partialResponses = partial.responses as { oneEighties: DartsOrakelMatchesResponse };
    partialResponses.oneEighties = response(syntheticRows(20), "oneEighties");
    const partialResult = result(partial);
    expect(partialResult.status).toBe("ready");
    if (partialResult.status !== "ready") throw new Error("Expected partial optional 180 evidence to remain usable.");
    expect(partialResult.metadata.oneEightyResponseVerified).toBe(false);
    expect(partialResult.snapshot.matches[0]?.stats.oneEighties).toBeNull();
  });

  it("blocks date-only history near an offset observation boundary", () => {
    const rows = syntheticRows(21);
    rows[0] = { ...rows[0]!, match_date: "2026-09-09" };
    const original = baseInput();
    const input: DartsOrakelHistoryNormalizationInput = {
      ...original,
      responses: {
      ...(original.responses as Record<string, unknown>),
      average: response(rows, "average"),
      },
      sourceObservedAt: "2026-09-10T00:30:00+02:00",
    };

    expect(result(input)).toMatchObject({ status: "blocked", reasons: [{ code: "DATE_ONLY_CLOSE_TO_OBSERVATION" }] });
  });

  it("rejects credential-bearing source URLs before provenance is returned", () => {
    const input = { ...baseInput(), sourceUrl: "https://user:secret@dartsorakel.com/player/details/29/rob-cross" };
    const normalized = result(input);
    expect(normalized).toMatchObject({ status: "blocked", reasons: [{ code: "INVALID_SOURCE" }] });
    expect(normalized.metadata.sourceUrl).toBeNull();
  });

  it("bounds UTF-8 payload size before full response validation", () => {
    const original = baseInput();
    const rows = syntheticRows(1);
    rows[0] = { ...rows[0]!, tournament_name: "😀".repeat(600_000) };
    const input: DartsOrakelHistoryNormalizationInput = {
      ...original,
      responses: {
      ...(original.responses as Record<string, unknown>),
      average: response(rows, "average"),
      },
    };

    expect(result(input)).toMatchObject({ status: "blocked", reasons: [{ code: "INCOMPLETE_RESPONSE" }] });
  });

  it("blocks an incomplete or silently truncated response boundary", () => {
    const input = baseInput();
    const responses = input.responses as { average: DartsOrakelMatchesResponse };
    responses.average = { ...responses.average, recordsFiltered: responses.average.data.length + 1 };

    const normalized = result(input);
    expect(normalized.status).toBe("blocked");
    if (normalized.status !== "blocked") throw new Error("Expected a blocked history snapshot.");
    expect(normalized.reasons[0]?.code).toBe("RECORDS_FILTERED_INCONSISTENT");
  });

  it("blocks same-day cutoff ambiguity, future dates, missing IDs, and self-opponents", () => {
    const sameDayInput = baseInput();
    const sameDayRows = syntheticRows(21);
    sameDayRows[10] = { ...sameDayRows[10]!, match_date: sameDayRows[9]!.match_date };
    (sameDayInput.responses as { average: DartsOrakelMatchesResponse }).average = response(sameDayRows, "average");
    expect(result(sameDayInput)).toMatchObject({ status: "blocked", reasons: [{ code: "LAST_TEN_CUTOFF_AMBIGUOUS" }] });

    const futureInput = baseInput();
    const futureRows = syntheticRows(21);
    futureRows[0] = { ...futureRows[0]!, match_date: "2026-09-11" };
    (futureInput.responses as { average: DartsOrakelMatchesResponse }).average = response(futureRows, "average");
    expect(result(futureInput)).toMatchObject({ status: "blocked", reasons: [{ code: "FUTURE_DATE" }] });

    const missingIdInput = baseInput();
    const missingIdRows = syntheticRows(21);
    const missingIdRow = { ...missingIdRows[0] } as Record<string, unknown>;
    delete missingIdRow["winner_key"];
    (missingIdInput.responses as { average: unknown }).average = { ...response(missingIdRows, "average"), data: [missingIdRow, ...missingIdRows.slice(1)] };
    expect(result(missingIdInput)).toMatchObject({ status: "blocked", reasons: [{ code: "INCOMPLETE_RESPONSE" }] });

    const selfInput = baseInput();
    const selfRows = syntheticRows(21);
    selfRows[0] = { ...selfRows[0]!, winner_key: PLAYER.id, loser_key: PLAYER.id };
    (selfInput.responses as { average: DartsOrakelMatchesResponse }).average = response(selfRows, "average");
    expect(result(selfInput)).toMatchObject({ status: "blocked", reasons: [{ code: "RAW_OPPONENT_SELF" }] });
  });

  it("returns only ten matches with a warning when the twentieth cutoff is date-ambiguous", () => {
    const input = baseInput();
    const rows = syntheticRows(21);
    rows[20] = { ...rows[20]!, match_date: rows[19]!.match_date };
    const responses = input.responses as { average: DartsOrakelMatchesResponse; oneEighties: DartsOrakelMatchesResponse; checkoutPercentage: DartsOrakelMatchesResponse };
    responses.average = response(rows, "average");
    responses.oneEighties = response(rows, "oneEighties");
    responses.checkoutPercentage = response(rows, "checkoutPercentage");

    const normalized = result(input);
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected a ready history snapshot.");
    expect(normalized.snapshot.matches).toHaveLength(10);
    expect(normalized.warnings.some((warning): boolean => warning.code === "LAST_TWENTY_CUTOFF_AMBIGUOUS")).toBe(true);
  });

  it("derives player side by numeric IDs when rows are swapped", () => {
    const input = baseInput();
    const responses = input.responses as { average: DartsOrakelMatchesResponse; oneEighties: DartsOrakelMatchesResponse; checkoutPercentage: DartsOrakelMatchesResponse };
    for (const key of ["average", "oneEighties", "checkoutPercentage"] as const) {
      const current = responses[key];
      const first = current.data[0];
      if (first === undefined) throw new Error("Synthetic response is empty.");
      const swapped = { ...first, winner_key: PLAYER.id, loser_key: first.winner_key };
      responses[key] = { ...current, data: [swapped, ...current.data.slice(1)] };
    }

    const normalized = result(input);
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected a ready history snapshot.");
    expect(normalized.snapshot.matches[0]?.result).toBe("win");
  });

  it("produces snapshots that the core screening and preview layers can consume", () => {
    const selected = normalizeDartsOrakelHistory(fixtureInput(PLAYER, "rob-cross-matches.json", 95, 8));
    const opponent = normalizeDartsOrakelHistory(fixtureInput({ id: 13, name: "Damon Heta", slug: "damon-heta" }, "damon-heta-matches.json", 90, 2));
    expect(selected.status).toBe("ready");
    expect(opponent.status).toBe("ready");
    if (selected.status !== "ready" || opponent.status !== "ready") throw new Error("Expected ready normalized histories.");

    const input = createSyntheticWatchlistInput();
    input.price.quote.players = [
      { id: "29", name: "Rob Cross" },
      { id: "13", name: "Damon Heta" },
    ];
    input.price.quote.selectedPlayerId = "29";
    input.price.quote.scheduledStart = "2026-09-10T12:10:00.000Z";
    input.price.quote.observedAt = "2026-09-10T11:59:00.000Z";
    input.price.quote.sourceUpdatedAt = "2026-09-10T11:59:00.000Z";
    input.price.quote.source.sourceId = "dartsorakel";
    input.price.quote.source.observedAt = "2026-09-10T11:59:00.000Z";
    input.rules.allowedSourceIds = ["dartsorakel"];
    input.selectedHistory = selected.snapshot;
    input.opponentHistory = opponent.snapshot;

    const now = new Date("2026-09-10T12:00:00.000Z");
    const screened = screenWatchlistCandidate(input, now);
    expect(screened.eligible).toBe(true);
    expect(formatWatchlistPreviewPages(input, now).length).toBeGreaterThan(0);
  });
});

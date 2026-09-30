import { describe, expect, it, vi } from "vitest";

import type { ModusHistoricalMatch, ModusMatchReference } from "../src/modus/history-schemas.js";
import { ModusFixtureIdentitySource } from "../src/modus/fixture-identity-source.js";
import type { OfficialModusHistorySource } from "../src/modus/history-source.js";
import type { ParsedModusResultsPage } from "../src/modus/results-index-source.js";

const reference: ModusMatchReference = {
  matchId: "19003",
  seriesId: "26",
  seriesName: "Series 15",
  seriesOrder: 1,
  weekId: "192",
  weekName: "Week 2",
  weekOrder: 1,
  group: "Group A",
  matchNumber: 1,
  homeName: "Jack Drayton",
  awayName: "Zvonimir Lesic",
};

const page: ParsedModusResultsPage = {
  series: [{ id: "26", name: "Series 15", order: 1 }],
  weeks: [{ id: "192", name: "Week 2", order: 1 }],
  selectedSeriesId: "26",
  selectedWeekId: "192",
  selectedGroup: "Group A",
  matches: [reference],
};

function details(overrides: Partial<ModusHistoricalMatch> = {}): ModusHistoricalMatch {
  return {
    matchId: "19003",
    playedAtLocal: "2026-09-30T12:00",
    date: "2026-09-30",
    seriesName: "Series 15",
    weekName: "Week 2",
    group: "Group A",
    home: { name: "Jack Drayton", score: 4, average: 97.29 },
    away: { name: "Zvonimir Lesic", score: 1, average: 88.83 },
    sourceUrl: "https://modussuperseries.com/match-db-stats.php?match_id=19003",
    ...overrides,
  };
}

function source(
  getResultsPage: OfficialModusHistorySource["getResultsPage"],
  getMatchDetails: OfficialModusHistorySource["getMatchDetails"],
): Pick<OfficialModusHistorySource, "getResultsPage" | "getMatchDetails"> {
  return { getResultsPage, getMatchDetails };
}

describe("bounded official MODUS fixture identity fallback", () => {
  it("resolves an abbreviated fixture pair only after verifying one official match detail", async () => {
    const getResultsPage = vi.fn<OfficialModusHistorySource["getResultsPage"]>().mockResolvedValue(page);
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>().mockResolvedValue(details());
    const fallback = new ModusFixtureIdentitySource({ source: source(getResultsPage, getMatchDetails) });

    await expect(fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toEqual([
      "Jack Drayton",
      "Zvonimir Lesic",
    ]);
    expect(getResultsPage).toHaveBeenCalledOnce();
    expect(getMatchDetails).toHaveBeenCalledOnce();
    expect(getMatchDetails).toHaveBeenCalledWith("19003");
  });

  it("preserves labels and makes no detail request when an abbreviated name is ambiguous", async () => {
    const ambiguousPage: ParsedModusResultsPage = {
      ...page,
      matches: [
        { ...reference, homeName: "John Smith", awayName: "First Opponent" },
        { ...reference, matchId: "19004", homeName: "Jack Smith", awayName: "Second Opponent" },
      ],
    };
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>().mockResolvedValue(details());
    const fallback = new ModusFixtureIdentitySource({
      source: source(async (): Promise<ParsedModusResultsPage> => ambiguousPage, getMatchDetails),
    });

    await expect(fallback.resolvePair("2026-09-30", "Smith J.", "First Opponent")).resolves.toBeNull();
    expect(getMatchDetails).not.toHaveBeenCalled();
  });

  it("uses known catalogue homonyms to reject an unqualified label hidden outside the selected group", async () => {
    const qualifiedReference: ModusMatchReference = {
      ...reference,
      homeName: "Lee (ENG) Evans",
      awayName: "Other Player",
    };
    const selectedPage: ParsedModusResultsPage = { ...page, matches: [qualifiedReference] };
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>().mockResolvedValue(details({
      home: { name: "Lee (ENG) Evans", score: 4, average: 97.29 },
      away: { name: "Other Player", score: 1, average: 88.83 },
    }));
    const fallback = new ModusFixtureIdentitySource({
      source: source(async (): Promise<ParsedModusResultsPage> => selectedPage, getMatchDetails),
      knownIdentityNames: ["Lee (WAL) Evans"],
    });

    await expect(fallback.resolvePair("2026-09-30", "Lee Evans", "Other Player")).resolves.toBeNull();
    expect(getMatchDetails).not.toHaveBeenCalled();
  });

  it("requires qualifier agreement in the label and detail before qualified recovery", async () => {
    const qualifiedReference: ModusMatchReference = {
      ...reference,
      homeName: "Lee (ENG) Evans",
      awayName: "Other Player",
    };
    const selectedPage: ParsedModusResultsPage = { ...page, matches: [qualifiedReference] };
    const qualified = new ModusFixtureIdentitySource({
      source: source(
        async (): Promise<ParsedModusResultsPage> => selectedPage,
        async (): Promise<ModusHistoricalMatch> => details({
          home: { name: "Lee (ENG) Evans", score: 4, average: 97.29 },
          away: { name: "Other Player", score: 1, average: 88.83 },
        }),
      ),
      knownIdentityNames: ["Lee (WAL) Evans"],
    });
    const missingDetailQualifier = new ModusFixtureIdentitySource({
      source: source(
        async (): Promise<ParsedModusResultsPage> => selectedPage,
        async (): Promise<ModusHistoricalMatch> => details({
          home: { name: "Lee Evans", score: 4, average: 97.29 },
          away: { name: "Other Player", score: 1, average: 88.83 },
        }),
      ),
      knownIdentityNames: ["Lee (WAL) Evans"],
    });

    await expect(qualified.resolvePair("2026-09-30", "Lee (ENG) Evans", "Other Player")).resolves.toEqual([
      "Lee (ENG) Evans",
      "Other Player",
    ]);
    await expect(missingDetailQualifier.resolvePair("2026-09-30", "Lee (ENG) Evans", "Other Player")).resolves.toBeNull();
  });

  it("rejects a detail page with the wrong date or matchup", async () => {
    const wrongDate = new ModusFixtureIdentitySource({
      source: source(
        async (): Promise<ParsedModusResultsPage> => page,
        async (): Promise<ModusHistoricalMatch> => details({ date: "2026-09-29" }),
      ),
    });
    const wrongMatchup = new ModusFixtureIdentitySource({
      source: source(
        async (): Promise<ParsedModusResultsPage> => page,
        async (): Promise<ModusHistoricalMatch> => details({
          away: { name: "Other Player", score: 1, average: 88.83 },
        }),
      ),
    });

    await expect(wrongDate.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toBeNull();
    await expect(wrongMatchup.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toBeNull();
  });

  it("checks repeated current-week pairings newest-first within one shared detail budget", async () => {
    const repeatedMatches: ModusMatchReference[] = Array.from({ length: 6 }, (_value, index) => ({
      ...reference,
      matchId: String(19003 + index),
      matchNumber: index + 1,
    }));
    const repeatedPage: ParsedModusResultsPage = { ...page, matches: repeatedMatches };
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>(async (matchId: string) => details({
      matchId,
      date: "2026-09-29",
      sourceUrl: `https://modussuperseries.com/match-db-stats.php?match_id=${matchId}`,
    }));
    const fallback = new ModusFixtureIdentitySource({
      source: source(async (): Promise<ParsedModusResultsPage> => repeatedPage, getMatchDetails),
    });

    await expect(fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toBeNull();
    await expect(fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toBeNull();
    expect(getMatchDetails).toHaveBeenCalledTimes(4);
    expect(getMatchDetails.mock.calls.map(([matchId]) => matchId)).toEqual(["19008", "19007", "19006", "19005"]);
  });

  it("recovers a repeated pair when one bounded detail proves the requested date", async () => {
    const repeatedMatches: ModusMatchReference[] = [
      { ...reference, matchId: "19004", matchNumber: 2 },
      { ...reference, matchId: "19003", matchNumber: 1 },
    ];
    const repeatedPage: ParsedModusResultsPage = { ...page, matches: repeatedMatches };
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>(async (matchId: string) => details({
      matchId,
      date: matchId === "19004" ? "2026-09-29" : "2026-09-30",
      sourceUrl: `https://modussuperseries.com/match-db-stats.php?match_id=${matchId}`,
    }));
    const fallback = new ModusFixtureIdentitySource({
      source: source(async (): Promise<ParsedModusResultsPage> => repeatedPage, getMatchDetails),
    });

    await expect(fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.")).resolves.toEqual([
      "Jack Drayton",
      "Zvonimir Lesic",
    ]);
    expect(getMatchDetails).toHaveBeenCalledTimes(2);
  });

  it("shares one root-page read across callers and lets one caller cancel independently", async () => {
    let releasePage: ((value: ParsedModusResultsPage) => void) | undefined;
    const pageRequest = new Promise<ParsedModusResultsPage>((resolve): void => {
      releasePage = resolve;
    });
    const getResultsPage = vi.fn<OfficialModusHistorySource["getResultsPage"]>(() => pageRequest);
    const getMatchDetails = vi.fn<OfficialModusHistorySource["getMatchDetails"]>().mockResolvedValue(details());
    const fallback = new ModusFixtureIdentitySource({ source: source(getResultsPage, getMatchDetails) });
    const controller = new AbortController();
    const cancelled = fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.", controller.signal);
    void cancelled.catch((): undefined => undefined);
    const surviving = fallback.resolvePair("2026-09-30", "Drayton J.", "Lesic Z.");

    await vi.waitFor(() => expect(getResultsPage).toHaveBeenCalledOnce());
    controller.abort(new Error("caller cancelled"));
    releasePage?.(page);

    await expect(cancelled).rejects.toThrow("caller cancelled");
    await expect(surviving).resolves.toEqual(["Jack Drayton", "Zvonimir Lesic"]);
    expect(getResultsPage).toHaveBeenCalledOnce();
    expect(getMatchDetails).toHaveBeenCalledOnce();
  });
});

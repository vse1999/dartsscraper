import { describe, expect, it, vi } from "vitest";

import { InsufficientMatchDataError } from "../src/errors.js";
import {
  MODUS_RESULTS_URL,
  type ModusHistoricalMatch,
  type ModusMatchReference,
  type ModusResultsIndex,
} from "../src/modus/history-schemas.js";
import { parseModusMatchDetails } from "../src/modus/match-details-source.js";
import {
  ModusPlayerHistoryService,
  type ModusPlayerHistoryReader,
} from "../src/modus/player-history-service.js";
import { parseModusResultsPage } from "../src/modus/results-index-source.js";
import type { OfficialModusHistoryReader } from "../src/modus/history-source.js";
import {
  ModusFirstPlayerStatsService,
  type PlayerStatsReader,
  type PlayerStatsResult,
} from "../src/telegram/stats-service.js";

const resultsHtml = `<!doctype html><html><body>
<select id="seriesSelect"><option value="1">Series 1</option><option value="26" selected>Series 15</option></select>
<div class="group-tabs"><button class="active">Group A</button><button>Group B</button><button>Group C</button><button>Final</button></div>
<select id="weekSelect"><option value="191">Week 1</option><option value="192" selected>Week 2</option></select>
<article class="fixture-card" onclick="location.href='match-db-stats.php?match_id=19003'">
  <div class="match-label">G1 Match 1</div>
  <div class="player-row"><span class="score">4</span><span>Jack Drayton</span></div>
  <div class="player-row"><span class="score">1</span><span>Lesic Zvonimir</span></div>
</article></body></html>`;

function matchDetailsHtml(options: {
  readonly date: string;
  readonly home: string;
  readonly away: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly homeAverage: string;
  readonly awayAverage: string;
}): string {
  return `<!doctype html><html><body><main><section class="match-stats"><div class="wrap">
  <div class="meta meta-desktop"><div class="meta-right"><a class="tab">${options.date}</a><a class="tab">Series 15</a><a class="tab">Final Group 1</a></div></div>
  <div class="meta meta-mobile"><div class="mobile-tabs"><a class="tab">Final Group 1</a><a class="tab">Series 15</a><a class="tab">Week 2</a></div></div>
  <div class="vs-row"><div class="player-name player-one">${options.home}</div><div class="score-area"><span>${options.homeScore}</span><span>${options.awayScore}</span></div><div class="player-name player-two">${options.away}</div></div>
  <div class="stat-row"><div class="stat-left">${options.homeAverage}</div><div class="stat-label">Average</div><div class="stat-right">${options.awayAverage}</div></div>
  </div></section></main></body></html>`;
}

function reference(matchId: string, weekOrder: number, names: readonly [string, string]): ModusMatchReference {
  return {
    matchId,
    seriesId: "26",
    seriesName: "Series 15",
    seriesOrder: 1,
    weekId: String(191 + weekOrder),
    weekName: `Week ${weekOrder + 1}`,
    weekOrder,
    group: "Final",
    matchNumber: 1,
    homeName: names[0],
    awayName: names[1],
  };
}

function index(matches: readonly ModusMatchReference[]): ModusResultsIndex {
  return {
    version: 1,
    generatedAt: "2026-08-16T00:00:00.000Z",
    sourceUrl: MODUS_RESULTS_URL,
    series: [{
      id: "26",
      name: "Series 15",
      order: 1,
      weeks: [
        { id: "191", name: "Week 1", order: 0 },
        { id: "192", name: "Week 2", order: 1 },
      ],
    }],
    matches: [...matches],
  };
}

function detail(
  matchId: string,
  playedAtLocal: string,
  homeAverage: number,
  awayAverage: number,
  weekName = "Week 2",
): ModusHistoricalMatch {
  return {
    matchId,
    playedAtLocal,
    date: playedAtLocal.slice(0, 10),
    seriesName: "Series 15",
    weekName,
    group: "Final Group 1",
    home: { name: "Jack Drayton", score: 4, average: homeAverage },
    away: { name: "Zvonimir Lesic", score: 1, average: awayAverage },
    sourceUrl: `https://modussuperseries.com/match-db-stats.php?match_id=${matchId}`,
  };
}

describe("official MODUS historical parsers", () => {
  it("discovers official match IDs, players, series, week, and group", () => {
    const page = parseModusResultsPage(resultsHtml);
    expect(page).toMatchObject({ selectedSeriesId: "26", selectedWeekId: "192", selectedGroup: "Group A" });
    expect(page.matches).toEqual([expect.objectContaining({
      matchId: "19003",
      homeName: "Jack Drayton",
      awayName: "Lesic Zvonimir",
      matchNumber: 1,
    })]);
  });

  it("parses exact match-level score, date, and three-dart averages", () => {
    const parsed = parseModusMatchDetails(matchDetailsHtml({
      date: "15 Aug 2026 / 19:50",
      home: "Jack Drayton",
      away: "Zvonimir Lesic",
      homeScore: 4,
      awayScore: 1,
      homeAverage: "97.29",
      awayAverage: "88.83",
    }), "https://modussuperseries.com/match-db-stats.php?match_id=19003");
    expect(parsed).toMatchObject({
      matchId: "19003",
      playedAtLocal: "2026-08-15T19:50",
      home: { name: "Jack Drayton", score: 4, average: 97.29 },
      away: { name: "Zvonimir Lesic", score: 1, average: 88.83 },
    });
  });
});

describe("MODUS player history and routing", () => {
  it("handles official reversed-name variants, sorts newest first, and selects the player's side", async () => {
    const references = [
      reference("19003", 1, ["Jack Drayton", "Lesic Zvonimir"]),
      reference("18819", 0, ["Zvonimir Lesic", "Jack Drayton"]),
    ];
    const details = new Map<string, ModusHistoricalMatch>([
      ["19003", detail("19003", "2026-08-15T19:50", 97.29, 88.83)],
      ["18819", detail("18819", "2026-08-10T09:38", 91.58, 81, "Week 1")],
    ]);
    const source: OfficialModusHistoryReader = {
      getLiveReferences: async (): Promise<readonly ModusMatchReference[]> => [],
      getMatchDetails: async (matchId: string): Promise<ModusHistoricalMatch> => {
        const found = details.get(matchId);
        if (found === undefined) throw new Error("missing fixture");
        return found;
      },
    };
    const service = new ModusPlayerHistoryService({ source, index: index(references) });
    const result = await service.findPlayerHistory("Zvonimir Lesic", 2);
    expect(result?.playerName).toBe("Zvonimir Lesic");
    expect(result?.matches.map((match) => [match.date, match.opponent, match.average, match.score])).toEqual([
      ["2026-08-15", "Jack Drayton", 88.83, "1 V 4"],
      ["2026-08-10", "Jack Drayton", 81, "1 V 4"],
    ]);
    expect(result?.evidenceUrls).toHaveLength(2);
  });

  it("routes a non-current player immediately without making a live MODUS request", async () => {
    const getLiveReferences = vi.fn<OfficialModusHistoryReader["getLiveReferences"]>().mockRejectedValue(new Error("must not be called"));
    const source: OfficialModusHistoryReader = {
      getLiveReferences,
      getMatchDetails: async (): Promise<ModusHistoricalMatch> => { throw new Error("not expected"); },
    };
    const service = new ModusPlayerHistoryService({
      source,
      index: index([reference("19003", 1, ["Jack Drayton", "Zvonimir Lesic"])]),
    });
    await expect(service.findPlayerHistory("PDC Player", 10)).resolves.toBeNull();
    expect(getLiveReferences).not.toHaveBeenCalled();
  });

  it("checks the live catalogue for an explicitly requested unindexed MODUS player", async () => {
    const liveReference = reference("19004", 1, ["Dylan Slevin", "Other Player"]);
    const getLiveReferences = vi.fn<OfficialModusHistoryReader["getLiveReferences"]>()
      .mockResolvedValue([liveReference]);
    const source: OfficialModusHistoryReader = {
      getLiveReferences,
      getMatchDetails: async (): Promise<ModusHistoricalMatch> => ({
        matchId: "19004",
        playedAtLocal: "2026-08-17T12:30",
        date: "2026-08-17",
        seriesName: "Series 15",
        weekName: "Week 2",
        group: "Final Group 1",
        home: { name: "Dylan Slevin", score: 4, average: 96.25 },
        away: { name: "Other Player", score: 2, average: 88.5 },
        sourceUrl: "https://modussuperseries.com/match-db-stats.php?match_id=19004",
      }),
    };
    const service = new ModusPlayerHistoryService({
      source,
      index: index([reference("19003", 1, ["Jack Drayton", "Zvonimir Lesic"])]),
    });

    const result = await service.findPlayerHistory("Dylan Slevin", 1, { forceLiveLookup: true });

    expect(getLiveReferences).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      playerName: "Dylan Slevin",
      matches: [{ date: "2026-08-17", opponent: "Other Player", average: 96.25 }],
    });
  });

  it("prefers official MODUS and calls DartsOrakel only when MODUS confirms no match", async () => {
    const modusResult = {
      playerName: "Jack Drayton",
      matches: [{ date: "2026-08-15", tournament: "MODUS", round: "Final", result: "Won", opponent: "Opponent", score: "4 V 1", average: 97.29 }],
      evidenceUrls: ["https://modussuperseries.com/match-db-stats.php?match_id=19003"],
      sourceUrl: MODUS_RESULTS_URL,
    };
    const modus: ModusPlayerHistoryReader = { findPlayerHistory: vi.fn().mockResolvedValue(modusResult) };
    const dartsResult: PlayerStatsResult = {
      playerName: "Other",
      requestedCount: 1,
      matches: [],
      meanAverage: null,
      availableAverageCount: 0,
      sourceUrl: "https://dartsorakel.com/",
      sourceLabel: "DartsOrakel",
      provider: "dartsorakel",
      evidenceUrls: [],
    };
    const darts: PlayerStatsReader = { getPlayerStats: vi.fn().mockResolvedValue(dartsResult) };
    const router = new ModusFirstPlayerStatsService(modus, darts);
    const selected = await router.getPlayerStats("Jack Drayton", 1);
    expect(selected.provider).toBe("modus-official");
    expect(selected.meanAverage).toBe(97.29);
    expect(darts.getPlayerStats).not.toHaveBeenCalled();

    vi.mocked(modus.findPlayerHistory).mockResolvedValueOnce(null);
    await expect(router.getPlayerStats("Darts Player", 1)).resolves.toBe(dartsResult);
    expect(darts.getPlayerStats).toHaveBeenCalledOnce();
  });

  it("honors explicit source overrides without silently falling back", async () => {
    const modus: ModusPlayerHistoryReader = { findPlayerHistory: vi.fn().mockResolvedValue(null) };
    const dartsResult: PlayerStatsResult = {
      playerName: "Dylan Slevin",
      requestedCount: 10,
      matches: [],
      meanAverage: null,
      availableAverageCount: 0,
      sourceUrl: "https://dartsorakel.com/",
      sourceLabel: "DartsOrakel",
      provider: "dartsorakel",
      evidenceUrls: [],
    };
    const darts: PlayerStatsReader = { getPlayerStats: vi.fn().mockResolvedValue(dartsResult) };
    const router = new ModusFirstPlayerStatsService(modus, darts);

    await expect(router.getPlayerStats("Dylan Slevin", 10, "dartsorakel")).resolves.toBe(dartsResult);
    expect(modus.findPlayerHistory).not.toHaveBeenCalled();

    await expect(router.getPlayerStats("Dylan Slevin", 10, "modus"))
      .rejects.toBeInstanceOf(InsufficientMatchDataError);
    expect(modus.findPlayerHistory).toHaveBeenCalledWith(
      "Dylan Slevin",
      10,
      { forceLiveLookup: true },
    );
    expect(darts.getPlayerStats).toHaveBeenCalledOnce();
  });
});

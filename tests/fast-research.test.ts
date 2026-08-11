import { describe, expect, it, vi } from "vitest";

import type { AgentConversationMessage } from "../src/agent/harness.js";
import {
  FastResearchService,
  type FastResearchServiceDependencies,
} from "../src/services/fast-research.js";
import type { SnapshotRead } from "../src/services/snapshot-store.js";
import type { MatchResult } from "../src/schemas/match.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import type { ModusResultsSnapshot } from "../src/modus/results-schemas.js";

const player: PlayerIdentity = { id: 29, name: "Rob Cross", slug: "rob-cross" };
const fixedNow = new Date("2026-08-11T12:00:00.000Z");

function readSnapshot<T>(value: T, dataAgeMs: number, stale = false): SnapshotRead<T> {
  return {
    value,
    fetchedAt: new Date(fixedNow.getTime() - dataAgeMs).toISOString(),
    dataAgeMs,
    stale,
  };
}

function modusSnapshot(): ModusResultsSnapshot {
  return {
    event: "MODUS Super Series",
    date: "2026-08-11",
    generatedAt: "2026-08-11T11:59:00.000Z",
    fetchedAt: "2026-08-11T11:59:30.000Z",
    context: {
      seriesId: "26",
      seriesName: "Series 15",
      weekId: "192",
      weekName: "Week 2",
      group: "Group A",
    },
    matches: [
      {
        id: "modus-match-1",
        matchNumber: 1,
        startTime: "2026-08-11T10:00:00+00:00",
        status: "completed",
        home: { name: "Jack Drayton", score: 4, average: 91.58 },
        away: { name: "Ryan Branley", score: 2, average: 81.0 },
      },
    ],
    weekAverages: [
      {
        position: 1,
        player: "George Cressey",
        played: 12,
        points: 11_472,
        darts: 386,
        average: 89.16,
      },
    ],
    source: {
      dailyFeedUrl: "https://modussuperseries.com/live-scores-json.php",
      resultsUrl: "https://modussuperseries.com/results.php",
      weekAveragesUrl: "https://modussuperseries.com/week-averages.php?series_id=26&week_id=192",
    },
    warnings: [],
  };
}

function playerMatches(): MatchResult {
  return {
    player,
    matches: [
      {
        date: "2026-08-10",
        tournament: "Players Championship 24",
        round: "Last 16",
        result: "Lost",
        opponent: "Danny Noppert",
        score: "4 V 6",
        average: 100.01,
      },
      {
        date: "2026-08-10",
        tournament: "Players Championship 24",
        round: "Last 32",
        result: "Won",
        opponent: "Joe Cullen",
        score: "6 V 5",
        average: 90.49,
      },
    ],
  };
}

interface TestServices {
  service: FastResearchService;
  modusActivate: ReturnType<typeof vi.fn<FastResearchServiceDependencies["modusResultsService"]["activate"]>>;
  playerGetLastMatchesSnapshot: ReturnType<typeof vi.fn<FastResearchServiceDependencies["playerMatchesService"]["getLastMatchesSnapshot"]>>;
}

function createServices(): TestServices {
  const modusRead = readSnapshot(modusSnapshot(), 1_250);
  const matchesRead = readSnapshot(playerMatches(), 275);
  const modusActivate = vi.fn<FastResearchServiceDependencies["modusResultsService"]["activate"]>()
    .mockResolvedValue(modusRead);
  const playerGetLastMatchesSnapshot = vi.fn<FastResearchServiceDependencies["playerMatchesService"]["getLastMatchesSnapshot"]>()
    .mockResolvedValue(matchesRead);
  const findMentions = vi.fn<FastResearchServiceDependencies["playerResolver"]["findMentions"]>()
    .mockImplementation(async (text: string): Promise<readonly PlayerIdentity[]> => (
      text.toLocaleLowerCase("en-US").includes("rob cross") ? [player] : []
    ));

  const dependencies: FastResearchServiceDependencies = {
    modusResultsService: {
      activate: modusActivate,
      stopBackgroundRefresh: vi.fn(),
    },
    playerMatchesService: {
      getLastMatchesSnapshot: playerGetLastMatchesSnapshot,
    },
    playerResolver: {
      findMentions,
      preload: vi.fn<FastResearchServiceDependencies["playerResolver"]["preload"]>().mockResolvedValue(undefined),
    },
    now: () => fixedNow,
    timeZone: "Europe/Budapest",
  };

  return {
    service: new FastResearchService(dependencies),
    modusActivate,
    playerGetLastMatchesSnapshot,
  };
}

describe("FastResearchService", () => {
  it("answers today's MODUS results deterministically and includes source metadata", async () => {
    const { service, modusActivate } = createServices();

    const answer = await service.tryAnswer("today MODUS results and averages");

    expect(answer).not.toBeNull();
    expect(answer).toMatchObject({
      intent: "modus-current-results",
      executionMode: "fast-path",
      dataAgeMs: 1_250,
      fetchedAt: new Date(fixedNow.getTime() - 1_250).toISOString(),
      stale: false,
    });
    expect(answer?.sourceLatencyMs).toEqual(expect.any(Number));
    expect(answer?.answer).toContain("Official MODUS results — 2026-08-11");
    expect(answer?.answer).toContain("Jack Drayton");
    expect(answer?.answer).toContain("Official cumulative weekly averages");
    expect(modusActivate).toHaveBeenCalledWith("2026-08-11", undefined);
  });

  it("answers a player last-matches question with deterministic match and mean data", async () => {
    const { service, playerGetLastMatchesSnapshot } = createServices();

    const answer = await service.tryAnswer("Show Rob Cross's last 2 matches and average");

    expect(answer).toMatchObject({
      intent: "player-last-matches",
      executionMode: "fast-path",
      dataAgeMs: 275,
      stale: false,
    });
    expect(answer?.answer).toContain("Rob Cross — 2 latest matches");
    expect(answer?.answer).toContain("Danny Noppert");
    expect(answer?.answer).toContain("Mean match average: 95.25");
    expect(playerGetLastMatchesSnapshot).toHaveBeenCalledWith("Rob Cross", 2, undefined);
  });

  it("returns null for open-ended questions so the LLM can handle them", async () => {
    const { service, modusActivate, playerGetLastMatchesSnapshot } = createServices();
    const history: readonly AgentConversationMessage[] = [
      { role: "user", content: "Show Rob Cross's last 10 matches" },
    ];

    await expect(service.tryAnswer("Explain whether Rob Cross is improving compared with last season", history))
      .resolves.toBeNull();
    expect(modusActivate).not.toHaveBeenCalled();
    expect(playerGetLastMatchesSnapshot).not.toHaveBeenCalled();
  });
});

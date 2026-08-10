import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type CacheStore } from "../src/cache.js";
import {
  OfficialModusResultsSource,
  parseModusResultsContext,
  parseModusWeekAverages,
} from "../src/modus/official-results-source.js";
import { ModusResultsSnapshotSchema } from "../src/modus/results-schemas.js";
import { OfficialModusResultsService } from "../src/modus/results-service.js";

const fixtureDirectory = path.resolve(process.cwd(), "tests", "fixtures");
const date = "2026-08-10";
const resultsUrl = "https://modussuperseries.com/results.php";

function readTextFixture(name: string): string {
  return readFileSync(path.join(fixtureDirectory, name), "utf8");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function fixtureFetch(resultsBody: string = readTextFixture("modus-live-results.json")): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("week-averages.php")) {
      return textResponse(readTextFixture("modus-week-averages.html"));
    }
    if (url.includes("results.php")) {
      return textResponse(readTextFixture("modus-results-context.html"));
    }
    if (url.includes("live-scores-json.php")) {
      return new Response(resultsBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function snapshotFixture(): ReturnType<typeof ModusResultsSnapshotSchema.parse> {
  return ModusResultsSnapshotSchema.parse({
    event: "MODUS Super Series",
    date,
    generatedAt: "2026-08-10T10:12:00Z",
    fetchedAt: "2026-08-10T10:12:02Z",
    context: { seriesId: "26", seriesName: "Series 15", weekId: "192", weekName: "Week 2", group: "Group A" },
    matches: [
      {
        id: "modus-26-192-a-001",
        matchNumber: 1,
        startTime: "2026-08-10T10:00:00+01:00",
        status: "completed",
        home: { name: "Jack Drayton", score: 4, average: 91.58 },
        away: { name: "Ryan Branley", score: 2, average: 81 },
      },
    ],
    weekAverages: [
      { position: 1, player: "George Cressey", played: 12, points: 11472, darts: 386, average: 89.16 },
    ],
    source: {
      dailyFeedUrl: "https://modussuperseries.com/live-scores-json.php",
      resultsUrl,
      weekAveragesUrl: "https://modussuperseries.com/week-averages.php?series_id=26&week_id=192",
    },
    warnings: [],
  });
}

describe("official MODUS result fixtures", () => {
  it("parses the selected series, week, group, and averages link", () => {
    const parsed = parseModusResultsContext(readTextFixture("modus-results-context.html"), resultsUrl);

    expect(parsed).toMatchObject({
      context: {
        seriesId: "26",
        seriesName: "Series 15",
        weekId: "192",
        weekName: "Week 2",
        group: "Group A",
      },
      weekAveragesUrl: "https://modussuperseries.com/week-averages.php?series_id=26&week_id=192",
    });
  });

  it("parses weekly aggregate statistics and verifies points divided by darts times three", () => {
    const averages = parseModusWeekAverages(readTextFixture("modus-week-averages.html"));
    const george = averages.find((row) => row.player === "George Cressey");

    expect(george).toMatchObject({
      position: 1,
      player: "George Cressey",
      played: 12,
      points: 11472,
      darts: 386,
      average: 89.16,
    });
    expect(george?.average).toBe(Math.round((11472 / 386) * 3 * 100) / 100);
  });

  it("joins match averages by competitor id and qualifier while preserving canonical names", async () => {
    const source = new OfficialModusResultsSource({ fetchImpl: fixtureFetch() });
    const snapshot = await source.getResults(date);

    const completed = snapshot.matches.find((match) => match.id === "modus-26-192-a-001");
    expect(completed).toMatchObject({
      id: "modus-26-192-a-001",
      matchNumber: 1,
      status: "completed",
      home: {
        name: "Jack Drayton",
        score: 4,
        average: 91.58,
      },
      away: {
        name: "Ryan Branley",
        score: 2,
        average: 81,
      },
    });

    const george = snapshot.weekAverages.find((row) => row.player === "George Cressey");
    expect(george).toMatchObject({
      average: 89.16,
    });
  });

  it("retains completed, live, and scheduled statuses and keeps unfinished averages null", async () => {
    const source = new OfficialModusResultsSource({ fetchImpl: fixtureFetch() });
    const snapshot = await source.getResults(date);

    expect(snapshot.matches.map((match) => match.status)).toEqual([
      "completed",
      "live",
      "scheduled",
    ]);

    for (const match of snapshot.matches.slice(1)) {
      expect(match.home.average).toBeNull();
      expect(match.away.average).toBeNull();
      expect(match.home.score).toBeNull();
      expect(match.away.score).toBeNull();
    }
  });

  it("rejects a daily payload for a different requested date", async () => {
    const mismatchedBody = readTextFixture("modus-live-results.json").replace(
      '"date": "2026-08-10"',
      '"date": "2026-08-11"',
    );
    const source = new OfficialModusResultsSource({ fetchImpl: fixtureFetch(mismatchedBody) });

    await expect(source.getResults(date)).rejects.toThrow(/reported.*requested/i);
  });

  it("rejects malformed or internally inconsistent weekly averages", () => {
    const malformed = readTextFixture("modus-week-averages.html").replace(
      '<td>89.16</td>',
      '<td>88.00</td>',
    );

    expect(() => parseModusWeekAverages(malformed)).toThrow(/average|inconsistent|invalid/i);
  });

  it("rejects weekly context whose fixture cards do not match the daily feed", async () => {
    const wrongContext = readTextFixture("modus-results-context.html").replace(
      "Ryan Branley</div>",
      "Unrelated Player</div>",
    );
    const fetchImpl = fixtureFetch();
    vi.mocked(fetchImpl).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("results.php")) return textResponse(wrongContext);
      if (url.includes("week-averages.php")) return textResponse(readTextFixture("modus-week-averages.html"));
      if (url.includes("live-scores-json.php")) {
        return new Response(readTextFixture("modus-live-results.json"), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const source = new OfficialModusResultsSource({ fetchImpl });

    await expect(source.getResults(date)).rejects.toThrow(/does not match|differ/i);
  });

  it("cancels in-flight official requests through AbortSignal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
      });
    });
    const controller = new AbortController();
    const source = new OfficialModusResultsSource({ fetchImpl });
    const result = source.getResults(date, controller.signal);

    controller.abort(new Error("test cancellation"));

    await expect(result).rejects.toThrow(/cancelled/i);
  });

  it("reports an actionable error when the official results endpoint fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "upstream unavailable" }, 503),
    );
    const source = new OfficialModusResultsSource({ fetchImpl });

    await expect(source.getResults(date)).rejects.toThrow(/MODUS|503|results/i);
  });
});

describe("official MODUS result service cache contract", () => {
  it("returns a valid cached snapshot without calling the source", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("source must not be called"));
    const source = new OfficialModusResultsSource({ fetchImpl });
    const cacheGet = vi.fn<CacheStore["get"]>().mockResolvedValue(snapshotFixture());
    const cache: CacheStore = {
      get: cacheGet,
      set: vi.fn<CacheStore["set"]>(),
    };
    const service = new OfficialModusResultsService({ source, cache, cacheTtlMs: 15_000 });

    await expect(service.getResults(date)).resolves.toMatchObject({ date });
    expect(cacheGet).toHaveBeenCalledWith(expect.stringMatching(/^modus-official-results-v\d+-2026-08-10$/));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes a fresh snapshot with a versioned key and a 15-second TTL", async () => {
    const source = new OfficialModusResultsSource({ fetchImpl: fixtureFetch() });
    const cacheSet = vi.fn<CacheStore["set"]>();
    const cache: CacheStore = {
      get: vi.fn<CacheStore["get"]>().mockResolvedValue(null),
      set: cacheSet,
    };
    const service = new OfficialModusResultsService({ source, cache, cacheTtlMs: 15_000 });

    await service.getResults(date);

    expect(cacheSet).toHaveBeenCalledWith(
      expect.stringMatching(/^modus-official-results-v\d+-2026-08-10$/),
      expect.objectContaining({ event: "MODUS Super Series", date }),
      15_000,
    );
  });
});

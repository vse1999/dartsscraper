import { afterEach, describe, expect, it, vi } from "vitest";
import { readMatchFixture, readPlayerStatsFixture } from "./helpers.js";
import type { DartsOrakelMatchesResponse } from "../src/dartsorakel/parser.js";
import { createResearchReaderFetch } from "../src/research/config.js";

afterEach((): void => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("real research factory integration", () => {
  it("shares the paced provider reader between interactive and bulk commands with evidence propagation", async () => {
    vi.resetModules();
    vi.stubEnv("RESEARCH_LOCAL_LEDGER_ENABLED", "false");
    const sample = readMatchFixture("damon-heta-matches.json");
    const base = sample.data.find((row) => row.winner_key === 13 || row.loser_key === 13);
    if (base === undefined) throw new Error("Factory fixture needs a Damon Heta match.");
    const responseFor = (statistic: string | null): DartsOrakelMatchesResponse => ({
      draw: 1, recordsTotal: 20, recordsFiltered: 20,
      data: Array.from({ length: 20 }, (_, index) => ({ ...base, winner_key: 13, loser_key: 500 + index,
        result: "Won", opponent: `Opponent ${index}`, round: `Round ${index}`, match_date: "2026-09-01",
        stat: statistic === "26" ? 2 : statistic === "1053" ? "50.00%" : 90,
        stat1: statistic === "1053" ? 3 : null, stat2: statistic === "1053" ? 6 : null })),
    });
    const fetchMock = vi.fn<typeof fetch>(async (input): Promise<Response> => {
      const url = String(input);
      const target = new URL(url.replace("https://r.jina.ai/", ""));
      const payload = target.pathname === "/api/stats/player" ? readPlayerStatsFixture() : responseFor(target.searchParams.get("rankKey"));
      return Response.json({ data: { httpStatus: 200, content: JSON.stringify(payload) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createDefaultBulkPlayerStatsService, createDefaultPlayerStatsService } = await import("../src/telegram/stats-service.js");
    const interactive = createDefaultPlayerStatsService();
    const bulk = createDefaultBulkPlayerStatsService();
    const first = await interactive.getPlayerStats("Damon Heta", 10, "auto", new AbortController().signal);
    const second = await bulk.getPlayerStats("heta", 20);
    expect(first.matches).toHaveLength(10);
    expect(second.matches).toHaveLength(20);
    expect(first.research?.previous10.matchCount).toBe(10);
    expect(first.evidence?.id).toBe(second.evidence?.id);
    expect(first.evidence?.observedAt).toBe(second.evidence?.observedAt);
    expect(first.evidence?.persistence).toBe("memory");
    expect(first.assessment?.validity.status).toBe("valid");
    expect(first.assessment?.dimensions.persistence).toBe("memory");
    expect(first.assessment?.eligibility.chronologicalTrendComparison.status).toBe("unavailable");
    expect(first.coverage?.displayed.observedRowCount).toBe(10);
    expect(first.coverage?.previous10.observedRowCount).toBe(10);
    expect(second.matches[0]?.provenance?.provider).toBe("dartsorakel");
    expect(fetchMock).toHaveBeenCalledTimes(4); // directory + average/180/checkout views once
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith("https://r.jina.ai/https://dartsorakel.com/"))).toBe(true);
  }, 20_000);

  it("retains the exact public transport and rejects local serverless reservations", async () => {
    const mock = vi.fn<typeof fetch>(async (): Promise<Response> => Response.json({ data: { httpStatus: 200, content: "{}" } }));
    vi.stubGlobal("fetch", mock);
    const response = await createResearchReaderFetch({})("https://dartsorakel.com/api/stats/player");
    expect(await response.json()).toEqual({});
    expect(mock).toHaveBeenCalledOnce();
    expect(() => createResearchReaderFetch({ RESEARCH_LOCAL_LEDGER_ENABLED: "true", VERCEL: "1" })).toThrow("serverless");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { OfficialPdcApiFixtureSource, OfficialPdcScheduleUnavailableError } from "../src/pdc/official-api-fixture-source.js";
import type { PdcFixture } from "../src/pdc/schemas.js";

function capture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./pdc-fixtures/${name}.json`, import.meta.url), "utf8")) as unknown;
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function oneTournament(date: string): unknown {
  return { data: [{ id: "10823", attributes: { name: "Swiss Darts Trophy", startDate: date, endDate: date } }], meta: { count: 1, totalCount: 1 } };
}

function oneFixture(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { id: "123", attributes: {
    tournamentID: "10823", startDate: "2026-10-09", startTime: null,
    participant1: { participantID: "1", firstName: "Rob", lastName: "Cross" },
    participant2: { participantID: "2", firstName: "Ryan", lastName: "Searle" },
    stage: { name: "Last 48" }, ...overrides,
  } };
}

const empty = { data: [], meta: { count: 0, totalCount: 0 } };

describe("official PDC public API discovery", () => {
  it("recovers all 70 captured Oct 8 official qualifier pairings including completed matches", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(capture("oct8-tournaments")))
      .mockResolvedValueOnce(response(capture("oct8-fixtures")));
    const fixtures = await new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-08");
    expect(fixtures).toHaveLength(70);
    expect(fixtures[0]).toMatchObject({ playerOne: "Rene Kern", playerTwo: "Alex Fehlmann", date: "2026-10-08", startTime: null, round: "Last 8" });
    expect(fixtures.every((fixture) => fixture.sourceUrl.startsWith("https://fixtures.darts.web.gc.pdcservices.co.uk/v2/") && fixture.evidenceUrls?.length === 2)).toBe(true);
    const requestedUrls = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
    expect(requestedUrls[1]?.searchParams.get("filter")).toBe("tournamentID:eq:10853");
    expect(requestedUrls.some((url) => url.searchParams.get("filter")?.includes("startDate"))).toBe(false);
  });

  it("does not call Oct 9 a no-match day when the captured official event exists without pairings", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(capture("oct9-tournaments")))
      .mockResolvedValueOnce(response(capture("oct9-fixtures")));
    const source = new OfficialPdcApiFixtureSource({ fetchImpl });
    await expect(source.getFixtures("2026-10-09")).rejects.toMatchObject({
      name: "OfficialPdcScheduleUnavailableError", date: "2026-10-09", tournamentNames: ["2026 ET14 - Swiss Darts Trophy"], availableFixtures: [],
    });
  });

  it("returns verified empty only when the complete official calendar has no event on that date", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(capture("oct9-tournaments")));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-12")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("loads all calendar and fixture pages using controlled URLs, not response-supplied next links", async () => {
    const calendar = capture("oct9-tournaments");
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "1", attributes: { name: "Old", startDate: "2026-01-01", endDate: "2026-01-01" } }], meta: { count: 1, totalCount: 2 }, links: { next: "https://evil.example" } }))
      .mockResolvedValueOnce(response({ ...(calendar as object), meta: { count: 1, totalCount: 2 } }))
      .mockResolvedValueOnce(response({ data: [oneFixture()], meta: { count: 1, totalCount: 2 } }))
      .mockResolvedValueOnce(response({ data: [{ ...(oneFixture() as object), id: "124" }], meta: { count: 1, totalCount: 2 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).resolves.toHaveLength(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("page.number=2");
    expect(fetchImpl.mock.calls.every(([input]) => !String(input).includes("evil"))).toBe(true);
  });

  it("rejects unrelated tournaments rather than importing their pairings", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ tournamentID: "999" })], meta: { count: 1, totalCount: 1 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
  });

  it("filters adjacent-day pairings locally and does not invent unknown or bare-time timestamps", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ startTime: "13:00:00" }), { ...(oneFixture({ startDate: "2026-10-10" }) as object), id: "124" }], meta: { count: 2, totalCount: 2 } }));
    const fixtures = await new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09");
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.startTime).toBeNull();
  });

  it("treats placeholder participants as unpublished instead of fabricating players", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ participant2: null })], meta: { count: 1, totalCount: 1 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toMatchObject({ tournamentNames: ["Swiss Darts Trophy"] });
  });

  it("retains known partial pairings in structured unavailable evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ data: [
      { id: "10823", attributes: { name: "Swiss", startDate: "2026-10-09", endDate: "2026-10-09" } },
      { id: "10824", attributes: { name: "Other", startDate: "2026-10-09", endDate: "2026-10-09" } },
    ], meta: { count: 2, totalCount: 2 } }))
      .mockResolvedValueOnce(response({ data: [oneFixture()], meta: { count: 1, totalCount: 1 } }))
      .mockResolvedValueOnce(response(empty));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toMatchObject({
      tournamentNames: ["Other"], availableFixtures: [expect.objectContaining({ playerOne: "Rob Cross" })],
    });
  });

  it("rejects repeated pagination rows rather than claiming complete coverage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValue(response({ data: [oneFixture()], meta: { count: 1, totalCount: 2 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
  });

  it("reports an HTTP outage or malformed calendar as unavailable, even when fallback is empty", async () => {
    for (const apiResponse of [new Response("outage", { status: 503 }), response({ data: [] })]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(apiResponse);
      await expect(new OfficialPdcApiFixtureSource({ fetchImpl, fallbackSource: { name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => [] } }).getFixtures("2026-10-09"))
        .rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
    }
  });

  it("accepts an official dated PDPA fallback when API is unavailable", async () => {
    const fixture: PdcFixture = { id: "pdpa:1", tournamentName: "Swiss", date: "2026-10-09", playerOne: "Rob Cross", playerTwo: "Ryan Searle", startTime: null, session: null, round: null, sourceUrl: "https://pdpa.co.uk/event/swiss/" };
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline"));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl, fallbackSource: { name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => [fixture] } }).getFixtures("2026-10-09")).resolves.toEqual([fixture]);
  });

  it("propagates caller cancellation without fetching fallback", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetchImpl = vi.fn<typeof fetch>();
    const fallback = vi.fn<() => Promise<readonly PdcFixture[]>>();
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl, fallbackSource: { name: "PDPA", getFixtures: fallback } }).getFixtures("2026-10-09", controller.signal)).rejects.toThrow("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("checks the previous season for January tournaments crossing the year boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "10823", attributes: { name: "World Championship", startDate: "2026-12-10", endDate: "2027-01-03" } }], meta: { count: 1, totalCount: 1 } }))
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response({ data: [oneFixture({ startDate: "2027-01-01" })], meta: { count: 1, totalCount: 1 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2027-01-01")).resolves.toHaveLength(1);
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("filter")).toBe("seasonID:eq:2026");
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get("filter")).toBe("seasonID:eq:2027");
  });

  it("bounds a hanging API request and reports unavailable rather than empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl, timeoutMs: 5 }).getFixtures("2026-10-09"))
      .rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
  });
});

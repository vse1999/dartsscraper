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

function tournament(id: string, name: string, date: string): unknown {
  return { id, attributes: { name, startDate: date, endDate: date } };
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

  it("canonicalizes concrete provider names through the directory adapter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ participant2: { participantID: "11795", firstName: "Rob", lastName: "Owen" } })], meta: { count: 1, totalCount: 1 } }));
    const resolve = vi.fn(async (name: string): Promise<string> => name === "Rob Owen" ? "Robert Owen" : name);
    const fixtures = await new OfficialPdcApiFixtureSource({ fetchImpl, resolver: { resolve } }).getFixtures("2026-10-09");
    expect(fixtures[0]).toMatchObject({ playerOne: "Rob Cross", playerTwo: "Robert Owen" });
    expect(resolve).toHaveBeenCalledWith("Rob Owen", undefined);
  });

  it("preserves official event evidence when object-shaped draw slots are unassigned", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ participant1: { participantID: null, firstName: null, lastName: null }, participant2: { participantID: null, firstName: null, lastName: null } })], meta: { count: 1, totalCount: 1 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toMatchObject({
      date: "2026-10-09", tournamentNames: ["Swiss Darts Trophy"], availableFixtures: [],
    });
  });

  it("keeps concrete pairings when other rows have null player fields", async () => {
    for (const participant of [
      { participantID: null, firstName: null, lastName: null },
      { participantID: "2", firstName: null, lastName: "Searle" },
      { participantID: null, firstName: "Ryan", lastName: "Searle" },
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
        .mockResolvedValueOnce(response({ data: [oneFixture(), { ...(oneFixture({ participant2: participant }) as object), id: "124" }], meta: { count: 2, totalCount: 2 } }));
      const schedule = await new OfficialPdcApiFixtureSource({ fetchImpl }).getSchedule("2026-10-09");
      expect(schedule.events[0]).toMatchObject({ coverage: "partial", pendingSlots: 1, fixtures: [expect.objectContaining({ playerOne: "Rob Cross", playerTwo: "Ryan Searle" })] });
    }
  });

  it("still rejects malformed non-null participant fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [oneFixture({ participant2: { participantID: "invalid", firstName: 12, lastName: "Searle" } })], meta: { count: 1, totalCount: 1 } }));
    await expect(new OfficialPdcApiFixtureSource({ fetchImpl }).getFixtures("2026-10-09")).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
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
    const source = new OfficialPdcApiFixtureSource({ fetchImpl, fallbackSource: { name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => [fixture] } });
    const schedule = await source.getSchedule("2026-10-09");
    expect(schedule.calendarStatus).toBe("unavailable");
    expect(schedule.events[0]).toMatchObject({ coverage: "partial", reason: "fallback_only", fixtures: [fixture] });
    await expect(source.getFixtures("2026-10-09")).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
  });

  it("does not merge distinct event identities that differ only by their ET number", async () => {
    const date = "2026-10-09";
    const fallbackFixtures: PdcFixture[] = [13, 14].map((number): PdcFixture => ({
      id: `pdpa:et${number}`,
      tournamentName: `ET ${number}`,
      date,
      playerOne: `Player ${number}`,
      playerTwo: `Opponent ${number}`,
      startTime: null,
      session: null,
      round: null,
      sourceUrl: `https://pdpa.co.uk/event/et-${number}/`,
    }));
    const schedule = await new OfficialPdcApiFixtureSource({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("calendar unavailable")),
      fallbackSource: { name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => fallbackFixtures },
    }).getSchedule(date);

    expect(schedule.events.map((event) => event.name)).toEqual(["ET 13", "ET 14"]);
    expect(schedule.events.map((event) => event.fixtures)).toEqual([[fallbackFixtures[0]], [fallbackFixtures[1]]]);
  });

  it("keeps a synthetic 16-match Swiss event visible beside two isolated unresolved events", async () => {
    const date = "2026-10-11";
    const swissRows = Array.from({ length: 16 }, (_, index) => ({
      ...(oneFixture({ tournamentID: "10823", startDate: date }) as { id: string; attributes: Record<string, unknown> }),
      id: String(2000 + index),
    }));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [
        tournament("10823", "Swiss Darts Trophy", date),
        tournament("10824", "Women's World Matchplay", date),
        tournament("10825", "Players Championship", date),
      ], meta: { count: 3, totalCount: 3 } }))
      .mockResolvedValueOnce(response({ data: swissRows, meta: { count: 16, totalCount: 16 } }))
      .mockResolvedValueOnce(new Response("event unavailable", { status: 503 }))
      .mockResolvedValueOnce(response(empty));

    const schedule = await new OfficialPdcApiFixtureSource({ fetchImpl }).getSchedule(date);

    expect(schedule.calendarStatus).toBe("verified");
    expect(schedule.events.map((event) => [event.name, event.coverage])).toEqual([
      ["Swiss Darts Trophy", "available"],
      ["Women's World Matchplay", "unavailable"],
      ["Players Championship", "unavailable"],
    ]);
    expect(schedule.events[0]?.fixtures).toHaveLength(16);
    expect(schedule.events.slice(1).every((event) => event.fixtures.length === 0 && event.pendingSlots === null)).toBe(true);
  });

  it("counts only explicit unassigned participant slots and preserves named rows", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(oneTournament("2026-10-09")))
      .mockResolvedValueOnce(response({ data: [
        oneFixture(),
        { ...(oneFixture({ participant2: null }) as object), id: "124" },
      ], meta: { count: 2, totalCount: 2 } }));

    const schedule = await new OfficialPdcApiFixtureSource({ fetchImpl }).getSchedule("2026-10-09");

    expect(schedule.events[0]).toMatchObject({ coverage: "partial", pendingSlots: 1, fixtures: [expect.objectContaining({ id: "pdc-official:123" })] });
  });

  it("merges fallback rows without erasing unrelated verified official fixtures", async () => {
    const date = "2026-10-09";
    const officialFixture = oneFixture();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [
        tournament("10823", "Swiss Darts Trophy", date),
        tournament("10824", "Players Championship", date),
      ], meta: { count: 2, totalCount: 2 } }))
      .mockResolvedValueOnce(response({ data: [officialFixture], meta: { count: 1, totalCount: 1 } }))
      .mockResolvedValueOnce(response(empty));
    const fallbackFixture: PdcFixture = {
      id: "pdpa:players-championship", tournamentName: "Players Championship 2026", date,
      startTime: null, session: null, round: "Last 64", playerOne: "Other One", playerTwo: "Other Two",
      sourceUrl: "https://pdpa.co.uk/event/players-championship/",
    };
    const source = new OfficialPdcApiFixtureSource({ fetchImpl, fallbackSource: {
      name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => [fallbackFixture],
    } });

    const schedule = await source.getSchedule(date);

    const swiss = schedule.events.find((event) => event.eventId === "10823");
    const playersChampionship = schedule.events.find((event) => event.eventId === "10824");
    expect(swiss?.fixtures).toHaveLength(1);
    expect(swiss?.fixtures[0]?.id).toBe("pdc-official:123");
    expect(swiss?.coverage).toBe("available");
    expect(playersChampionship).toMatchObject({ coverage: "partial", reason: "fallback_only", fixtures: [expect.objectContaining({ id: fallbackFixture.id })] });
  });

  it("keeps validated official rows when fallback data fails validation", async () => {
    const date = "2026-10-09";
    const pendingFixture = {
      ...(oneFixture({ tournamentID: "10824", participant2: { participantID: null, firstName: null, lastName: null } }) as { id: string; attributes: Record<string, unknown> }),
      id: "124",
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [
        tournament("10823", "Swiss Darts Trophy", date),
        tournament("10824", "Players Championship", date),
      ], meta: { count: 2, totalCount: 2 } }))
      .mockResolvedValueOnce(response({ data: [oneFixture()], meta: { count: 1, totalCount: 1 } }))
      .mockResolvedValueOnce(response({ data: [pendingFixture], meta: { count: 1, totalCount: 1 } }));
    const badFallbackFixture: PdcFixture = {
      id: "pdpa:wrong-date", tournamentName: "Players Championship", date: "2026-10-10",
      startTime: null, session: null, round: null, playerOne: "A", playerTwo: "B",
      sourceUrl: "https://pdpa.co.uk/event/players-championship/",
    };

    const schedule = await new OfficialPdcApiFixtureSource({
      fetchImpl,
      fallbackSource: { name: "PDPA", getFixtures: async (): Promise<readonly PdcFixture[]> => [badFallbackFixture] },
    }).getSchedule(date);

    expect(schedule.calendarStatus).toBe("verified");
    expect(schedule.events[0]).toMatchObject({ name: "Swiss Darts Trophy", coverage: "available", fixtures: [expect.objectContaining({ id: "pdc-official:123" })] });
    expect(schedule.events[1]).toMatchObject({ name: "Players Championship", coverage: "opponents_pending", pendingSlots: 1 });
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

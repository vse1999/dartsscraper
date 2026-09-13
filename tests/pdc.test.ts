import { describe, expect, it, vi } from "vitest";

import { readTextFixture } from "./helpers.js";
import {
  DartsOrakelPdcSource,
  parsePdcTournamentMatches,
} from "../src/pdc/source.js";
import { PdcTournamentService } from "../src/pdc/service.js";
import {
  PdcTournamentEventSchema,
  type PdcTournamentEvent,
  type PdcTournamentResult,
  type PdcTournamentSource,
} from "../src/pdc/schemas.js";

const resultsUrl = "https://dartsorakel.com/events/result/8022/2026-european-tour";

function event(): PdcTournamentEvent {
  return PdcTournamentEventSchema.parse({
    eventKey: 8022,
    tournamentKey: 5,
    tournamentName: "European Tour",
    tournamentNumber: 12,
    category: "ET",
    eventDate: "2026-09-06",
    startDate: "2026-09-06",
    endDate: "2026-09-06",
    eventAverage: 93.47,
    winnerAverage: 101.73,
    winnerName: "Luke Littler",
    winnerPlayerId: 5403,
    calendarUrl: "https://dartsorakel.com/api/events?year=2026&organCal=PDCE",
    resultsUrl,
  });
}

describe("PDC source parsing", () => {
  it("parses tournament rounds, players, scores, and proof URLs from HTML", () => {
    const matches = parsePdcTournamentMatches(readTextFixture("pdc-european-tour.html"), resultsUrl);
    expect(matches).toHaveLength(3);
    expect(matches[0]).toMatchObject({
      matchId: 565570,
      round: "Final",
      winnerName: "Luke Littler",
      loserName: "Luke Humphries",
      winnerScore: 8,
      loserScore: 6,
      sourceUrl: "https://dartsorakel.com/match/stats/565570",
    });
  });

  it("parses the markdown returned by a reader transport", () => {
    const markdown = "[Luke Littler](https://dartsorakel.com/player/details/5403/luke-littler)8 V 6[Luke Humphries](https://dartsorakel.com/player/details/34/luke-humphries)[](https://dartsorakel.com/match/stats/565570)";
    expect(parsePdcTournamentMatches(markdown, resultsUrl)).toHaveLength(1);
  });

  it("loads and filters PDC calendar rows while rejecting unrelated tournaments", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          event_key: 8022, tournament_key: 5, tournament_name: "European Tour", tournament_no: 12,
          category: "ET", event_date: "2026-09-06 00:00:00", start_date: "2026-09-06 00:00:00", end_date: "2026-09-06 00:00:00",
          event_avg: 93.47, winner_avg: 101.73, winner_name: "Luke Littler", player_key: 5403, events_result_url: resultsUrl,
        },
        {
          event_key: 9000, tournament_key: 90, tournament_name: "World Seniors Championship", tournament_no: 0,
          category: "OTHER", event_date: "2026-09-06 00:00:00", start_date: "2026-09-06 00:00:00", end_date: "2026-09-06 00:00:00",
          event_avg: 80, winner_avg: 85, winner_name: "Other Player", player_key: 1, events_result_url: "https://dartsorakel.com/events/result/9000/other",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const source = new DartsOrakelPdcSource({ fetchImpl, timeoutMs: 1000 });
    await expect(source.getCalendar(2026, "PDCE")).resolves.toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dartsorakel.com/api/events?year=2026&organCal=PDCE",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("PDC tournament service", () => {
  it("discovers a date independently of MODUS and fetches its tournament results", async () => {
    const source: PdcTournamentSource = {
      getCalendar: async (): Promise<readonly PdcTournamentEvent[]> => [event()],
      getResults: async (value: PdcTournamentEvent): Promise<PdcTournamentResult> => ({
        event: value,
        matches: [...parsePdcTournamentMatches(readTextFixture("pdc-european-tour.html"), resultsUrl)],
        sourceUrl: resultsUrl,
      }),
    };
    const service = new PdcTournamentService({ source, categories: ["PDCE"] });
    const results = await service.getResultsForDate("2026-09-06");
    expect(results).toHaveLength(1);
    expect(results[0]?.event.tournamentName).toBe("European Tour");
    expect(results[0]?.matches).toHaveLength(3);
  });

  it("does not treat an in-progress calendar row as the latest completed tournament", async () => {
    const incomplete = PdcTournamentEventSchema.parse({
      ...event(),
      eventKey: 8120,
      eventDate: "2026-09-13",
      startDate: "2026-09-13",
      endDate: "2026-09-13",
      winnerName: null,
      winnerAverage: null,
      winnerPlayerId: null,
      resultsUrl: "https://dartsorakel.com/events/result/8120/2026-european-tour",
    });
    const source: PdcTournamentSource = {
      getCalendar: async (): Promise<readonly PdcTournamentEvent[]> => [event(), incomplete],
      getResults: async (value: PdcTournamentEvent): Promise<PdcTournamentResult> => ({
        event: value,
        matches: [...parsePdcTournamentMatches(readTextFixture("pdc-european-tour.html"), resultsUrl)],
        sourceUrl: resultsUrl,
      }),
    };
    const service = new PdcTournamentService({ source, categories: ["PDCE"] });

    const results = await service.getLatestResults("2026-09-13");

    expect(results).toHaveLength(1);
    expect(results[0]?.event.eventKey).toBe(8022);
  });
});

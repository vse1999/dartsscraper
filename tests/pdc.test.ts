import { describe, expect, it, vi } from "vitest";

import { readTextFixture } from "./helpers.js";
import {
  DartsOrakelPdcSource,
  parsePdcTournamentMatches,
} from "../src/pdc/source.js";
import { parsePdpaEventFixtures, parsePdpaEventReferences } from "../src/pdc/pdpa-fixture-source.js";
import { parseDartsNerdPdcFixtures, reconcileFixtures } from "../src/pdc/darts-nerd-fixture-source.js";
import { PdcTournamentService } from "../src/pdc/service.js";
import {
  PdcTournamentEventSchema,
  type PdcFixture,
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

describe("official PDPA fixture discovery", () => {
  it("discovers candidate events and extracts only concrete matches for the requested day", () => {
    const calendar = `<a class="event-tile-small" href="https://pdpa.co.uk/event/world-series/"><div class="title">World Series Finals</div><div class="date">17 September 2026</div></a>`;
    const references = parsePdpaEventReferences(calendar, "https://pdpa.co.uk/events/calendar/", "2026-09-17");
    expect(references).toEqual([{
      title: "World Series Finals",
      startDate: "2026-09-17",
      url: "https://pdpa.co.uk/event/world-series/",
    }]);

    const details = `<h1 class="page-title">World Series Finals 2026</h1>
      <div class="info-group"><div class="heading">More Information:</div><div class="content">
      <p><strong>Thursday September 17 (1900 CEST)</strong><br><strong>Round One x8</strong><br>Viktor Tingstrom v Dirk van Duijvenbode<br>Rob Cross v Ryan Searle</p>
      <p><strong>Friday September 18 (1900 CEST)</strong><br>Winner A/B v Winner C/D</p>
      </div></div>`;
    const fixtures = parsePdpaEventFixtures(details, references[0]?.url ?? "", "2026-09-17");
    expect(fixtures).toHaveLength(2);
    expect(fixtures[1]).toMatchObject({
      tournamentName: "World Series Finals 2026",
      session: "19:00 CEST",
      round: "Round One x8",
      playerOne: "Rob Cross",
      playerTwo: "Ryan Searle",
    });
  });
});

describe("live PDC fixture corroboration", () => {
  it("parses dated matchups and start times from the live preview", () => {
    const html = `<div class="hm-match">
      <span class="hm-time" data-utc="2026-09-17T20:10:00+00:00"></span>
      <span class="hm-round-badge">1/16-finals</span>
      <span class="hm-name">van Gerwen M.</span><span class="hm-name">Gurney D.</span>
    </div>`;

    expect(parseDartsNerdPdcFixtures(html, "2026-09-17")).toMatchObject([{
      startTime: "2026-09-17T20:10:00+00:00",
      round: "1/16-finals",
      playerOne: "van Gerwen M.",
      playerTwo: "Gurney D.",
    }]);
  });

  it("applies a late live replacement only when the row overlaps the official fixture", () => {
    const official: PdcFixture[] = [{
      id: "pdpa:1",
      tournamentName: "World Series of Darts Finals 2026",
      date: "2026-09-17",
      startTime: null,
      session: "19:00 CEST",
      round: "Round One x8",
      playerOne: "Michael van Gerwen",
      playerTwo: "Lourence Ilagan",
      sourceUrl: "https://pdpa.co.uk/event/world-series/",
    }];
    const live: PdcFixture[] = [{
      id: "live:1",
      tournamentName: "PDC live fixture",
      date: "2026-09-17",
      startTime: "2026-09-17T20:10:00+00:00",
      session: null,
      round: "1/16-finals",
      playerOne: "Michael van Gerwen",
      playerTwo: "Daryl Gurney",
      sourceUrl: "https://www.darts-nerd.com/en/matches/preview",
    }];

    expect(reconcileFixtures(official, live)).toMatchObject([{
      tournamentName: "World Series of Darts Finals 2026",
      playerOne: "Michael van Gerwen",
      playerTwo: "Daryl Gurney",
      evidenceUrls: [
        "https://pdpa.co.uk/event/world-series/",
        "https://www.darts-nerd.com/en/matches/preview",
      ],
    }]);
  });

  it("uses the official full name when a globally ambiguous live abbreviation matches in fixture context", () => {
    const official: PdcFixture[] = [{
      id: "pdpa:2",
      tournamentName: "World Series of Darts Finals 2026",
      date: "2026-09-17",
      startTime: null,
      session: "19:00 CEST",
      round: "Round One x8",
      playerOne: "Kevin Doets",
      playerTwo: "Ross Smith",
      sourceUrl: "https://pdpa.co.uk/event/world-series/",
    }];
    const live: PdcFixture[] = [{
      id: "live:2",
      tournamentName: "PDC live fixture",
      date: "2026-09-17",
      startTime: "2026-09-17T18:40:00+00:00",
      session: null,
      round: "1/16-finals",
      playerOne: "Doets K.",
      playerTwo: "Smith R.",
      sourceUrl: "https://www.darts-nerd.com/en/matches/preview",
    }];

    expect(reconcileFixtures(official, live)).toMatchObject([{
      playerOne: "Kevin Doets",
      playerTwo: "Ross Smith",
    }]);
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

  it("loads every unique scheduled player through the last-10 DartsOrakel pipeline", async () => {
    const statsCalls: Array<{ readonly name: string; readonly count: number; readonly source: string | undefined }> = [];
    const service = new PdcTournamentService({
      source: {
        getCalendar: async (): Promise<readonly PdcTournamentEvent[]> => [],
        getResults: async (): Promise<PdcTournamentResult> => { throw new Error("not used"); },
      },
      fixtureSource: {
        name: "fixture test",
        getFixtures: async () => [{
          id: "fixture-1",
          tournamentName: "World Series Finals 2026",
          date: "2026-09-17",
          startTime: null,
          session: "19:00 CEST",
          round: "Round One",
          playerOne: "Rob Cross",
          playerTwo: "Ryan Searle",
          sourceUrl: "https://pdpa.co.uk/event/world-series/",
        }],
      },
      playerStats: {
        getPlayerStats: async (name, count, source) => {
          statsCalls.push({ name, count, source });
          return {
            playerName: name,
            requestedCount: count,
            matches: [],
            meanAverage: null,
            availableAverageCount: 0,
            sourceUrl: "https://dartsorakel.com/player/details/1/player",
            sourceLabel: "DartsOrakel",
            provider: "dartsorakel",
            evidenceUrls: [],
          };
        },
      },
    });

    const report = await service.getUpcomingReportForDate("2026-09-17");

    expect(report.fixtures).toHaveLength(1);
    expect(report.players).toHaveLength(2);
    expect(statsCalls).toEqual([
      { name: "Rob Cross", count: 10, source: "dartsorakel" },
      { name: "Ryan Searle", count: 10, source: "dartsorakel" },
    ]);
  });
});

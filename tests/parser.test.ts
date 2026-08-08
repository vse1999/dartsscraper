import { describe, expect, it } from "vitest";

import { DartsOrakelStructureChangedError } from "../src/errors.js";
import {
  DartsOrakelMatchesResponseSchema,
  parseDartsOrakelMatchRow,
  parseDartsOrakelMatches,
} from "../src/dartsorakel/parser.js";
import type { PlayerIdentity } from "../src/schemas/player.js";
import { readMatchFixture, readFixture } from "./helpers.js";

const damon: PlayerIdentity = { id: 13, name: "Damon Heta", slug: "damon-heta" };
const robert: PlayerIdentity = { id: 73, name: "Robert Thornton", slug: "robert-thornton" };
const robCross: PlayerIdentity = { id: 29, name: "Rob Cross", slug: "rob-cross" };

describe("DartsOrakel match parser", () => {
  it("parses Damon Heta fixture rows newest first", () => {
    const matches = parseDartsOrakelMatches(damon, readMatchFixture("damon-heta-matches.json"));

    expect(matches.length).toBeGreaterThan(10);
    expect(matches.slice(0, 3)).toEqual([
      {
        date: "2026-07-29",
        tournament: "Players Championship 26",
        round: "Quarter Final",
        result: "Lost",
        opponent: "Sebastian Bialecki",
        score: "2 V 6",
        average: 90.74,
      },
      {
        date: "2026-07-29",
        tournament: "Players Championship 26",
        round: "Last 16",
        result: "Won",
        opponent: "Raymond van Barneveld",
        score: "6 V 2",
        average: 96.34,
      },
      {
        date: "2026-07-29",
        tournament: "Players Championship 26",
        round: "Last 32",
        result: "Won",
        opponent: "Beau Greaves",
        score: "6 V 3",
        average: 97.96,
      },
    ]);
  });

  it("includes Rob Cross matches from TV and European Tour events", () => {
    const matches = parseDartsOrakelMatches(robCross, readMatchFixture("rob-cross-matches.json"));

    expect(matches.slice(0, 10)).toEqual([
      { date: "2026-07-22", tournament: "World Matchplay", round: "Last 16", result: "Lost", opponent: "Gerwyn Price", score: "5 V 11", average: 93.82 },
      { date: "2026-07-20", tournament: "World Matchplay", round: "Last 32", result: "Won", opponent: "Danny Noppert", score: "10 V 3", average: 97.41 },
      { date: "2026-07-10", tournament: "European Tour 10", round: "Last 48 (Premier)", result: "Lost", opponent: "Max Hopp", score: "3 V 6", average: 93.3 },
      { date: "2026-07-07", tournament: "Players Championship 24", round: "Last 16", result: "Lost", opponent: "Danny Noppert", score: "4 V 6", average: 100.01 },
      { date: "2026-07-07", tournament: "Players Championship 24", round: "Last 32", result: "Won", opponent: "Joe Cullen", score: "6 V 5", average: 96.25 },
      { date: "2026-07-07", tournament: "Players Championship 24", round: "Last 64", result: "Won", opponent: "Adam Gawlas", score: "6 V 2", average: 98.22 },
      { date: "2026-07-07", tournament: "Players Championship 24", round: "Last 128", result: "Won", opponent: "Leon Weber", score: "6 V 0", average: 96.97 },
      { date: "2026-07-06", tournament: "Players Championship 23", round: "Last 32", result: "Lost", opponent: "Wesley Plaisier", score: "2 V 6", average: 98.18 },
      { date: "2026-07-06", tournament: "Players Championship 23", round: "Last 64", result: "Won", opponent: "Max Hopp", score: "6 V 4", average: 94.84 },
      { date: "2026-07-06", tournament: "Players Championship 23", round: "Last 128", result: "Won", opponent: "Keane Barry", score: "6 V 2", average: 103.99 },
    ]);
  });

  it("includes all-competition matches for Robert Thornton", () => {
    const matches = parseDartsOrakelMatches(robert, readMatchFixture("robert-thornton-matches.json"));

    expect(matches.length).toBeGreaterThan(1_000);
    expect(matches[0]).toMatchObject({
      date: "2026-07-03",
      tournament: "MODUS Super Series #14 Week 10",
      result: "Lost",
      opponent: "Mason Whitlock",
      score: "1 V 4",
      average: 72.73,
    });
  });

  it("preserves legitimate repeated matchups with different underlying stats", () => {
    const matches = parseDartsOrakelMatches(robert, readMatchFixture("robert-thornton-matches.json"));
    const repeatedMatches = matches.filter((match) =>
      match.date === "2025-10-25"
      && match.opponent === "Jake Jones"
      && match.round === "Round Robin"
      && match.score === "4 V 3"
    );

    expect(repeatedMatches).toHaveLength(2);
    expect(repeatedMatches.map((match) => match.average)).toEqual([81.57, 80.57]);
  });

  it("represents a missing average as null", () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const first = fixture.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a match.");
    }
    const row = { ...first, stat: null };

    expect(parseDartsOrakelMatchRow(damon, row).average).toBeNull();
  });

  it("removes exact duplicate match rows", () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const first = fixture.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a match.");
    }
    const duplicated = { ...fixture, data: [first, first] };

    expect(parseDartsOrakelMatches(damon, duplicated)).toHaveLength(1);
  });

  it("rejects malformed response envelopes", () => {
    expect(() => parseDartsOrakelMatches(damon, { data: [] })).toThrow(DartsOrakelStructureChangedError);
  });

  it("rejects a site structure mismatch in a match row", () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const first = fixture.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a match.");
    }
    const malformed: unknown = {
      ...fixture,
      data: [{ ...first, opponent: undefined }],
    };

    expect(() => DartsOrakelMatchesResponseSchema.parse(malformed)).toThrow();
  });

  it("does not return incomplete or bye rows", () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const first = fixture.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a match.");
    }
    const response = {
      ...fixture,
      data: [
        { ...first, result: "Scheduled" },
        { ...first, event_key: first.event_key + 1, is_bye: 1 },
        first,
      ],
    };

    expect(parseDartsOrakelMatches(damon, response)).toHaveLength(1);
  });

  it("accepts Unicode entity text in opponents", () => {
    const fixture = readMatchFixture("damon-heta-matches.json");
    const first = fixture.data[0];
    if (first === undefined) {
      throw new Error("Fixture must contain a match.");
    }

    const parsed = parseDartsOrakelMatchRow(damon, {
      ...first,
      opponent: "<a>O&#39;Connor &amp; Co.</a>",
    });
    expect(parsed.opponent).toBe("O'Connor & Co.");
  });
});






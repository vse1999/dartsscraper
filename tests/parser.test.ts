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

  it("parses Robert Thornton historical fixture rows", () => {
    const matches = parseDartsOrakelMatches(robert, readMatchFixture("robert-thornton-matches.json"));

    expect(matches.length).toBeGreaterThan(10);
    expect(matches[0]).toMatchObject({
      date: "2021-11-04",
      tournament: "Players Championship 30",
      result: "Lost",
      opponent: "Matthew Edgar",
      score: "1 V 6",
      average: 82.18,
    });
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






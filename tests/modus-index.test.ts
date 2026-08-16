import bundledModusIndex from "../data/modus-results-index.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { ModusResultsIndexSchema } from "../src/modus/history-schemas.js";

describe("bundled official MODUS historical index", () => {
  it("is schema-valid, internally connected, and contains the proven official match", () => {
    const index = ModusResultsIndexSchema.parse(bundledModusIndex);
    const matchIds = new Set(index.matches.map((match) => match.matchId));
    const weekKeys = new Set(index.series.flatMap((series) => {
      return series.weeks.map((week) => `${series.id}:${week.id}`);
    }));
    expect(index.series.length).toBeGreaterThanOrEqual(16);
    expect(index.matches.length).toBeGreaterThan(18_000);
    expect(matchIds.size).toBe(index.matches.length);
    expect(index.matches.every((match) => weekKeys.has(`${match.seriesId}:${match.weekId}`))).toBe(true);
    expect(index.matches.find((match) => match.matchId === "19003")).toMatchObject({
      homeName: "Jack Drayton",
      awayName: "Zvonimir Lesic",
      seriesName: "Series 15",
      weekName: "Week 2",
      group: "Final",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { CorroboratedPdcFixtureSource } from "../src/pdc/darts-nerd-fixture-source.js";
import { PdpaPdcFixtureSource, parsePdpaEventFixtures } from "../src/pdc/pdpa-fixture-source.js";
import { readTextFixture } from "./helpers.js";

const sourceUrl = "https://pdpa.co.uk/event/world-grand-prix-2026/";
const html = readTextFixture("pdpa-world-grand-prix-2026.html");

describe("World Grand Prix dated schedule discovery", () => {
  it("reads all eight Monday matches from Entries, not the undated draw bracket", () => {
    const fixtures = parsePdpaEventFixtures(html, sourceUrl, "2026-09-28");
    expect(fixtures.map((fixture) => [fixture.playerOne, fixture.playerTwo])).toEqual([
      ["Danny Noppert", "Niko Springer"],
      ["Ross Smith", "Cameron Menzies"],
      ["Nathan Aspinall", "Kevin Doets"],
      ["Jonny Clayton", "Krzysztof Ratajski"],
      ["Gerwyn Price", "Sebastian Bialecki"],
      ["Michael van Gerwen", "Ryan Joyce"],
      ["Luke Littler", "Luke Woodhouse"],
      ["Wessel Nijman", "Rob Cross"],
    ]);
    expect(fixtures.every((fixture) => fixture.session === "18:00 BST"
      && fixture.round === "Round One x8" && fixture.sourceUrl === sourceUrl)).toBe(true);
  });

  it("keeps Tuesday separate and excludes unresolved later rounds", () => {
    const fixtures = parsePdpaEventFixtures(html, sourceUrl, "2026-09-29");
    expect(fixtures).toHaveLength(8);
    expect(fixtures[0]).toMatchObject({ playerOne: "Chris Dobey", playerTwo: "Jermaine Wattimena" });
    expect(fixtures[7]).toMatchObject({ playerOne: "Stephen Bunting", playerTwo: "Andrew Gilding" });
    for (const date of ["2026-09-27", "2026-09-30", "2026-10-01", "2026-10-04"]) {
      expect(parsePdpaEventFixtures(html, sourceUrl, date)).toEqual([]);
    }
  });

  it("does not carry a date, round, or session into another information section", () => {
    const sections = `<h1 class="page-title">PDC event</h1>
      <div class="info-group"><div class="content"><p>Monday September 28 (1800 BST)<br>Round One<br>Danny Noppert v Niko Springer</p></div></div>
      <div class="info-group"><div class="content"><p>Undated draw<br>Luke Humphries v Dave Chisnall</p></div></div>
      <div class="info-group"><div class="content"><p>Monday September 28<br>Ross Smith v Cameron Menzies</p></div></div>`;
    const fixtures = parsePdpaEventFixtures(sections, sourceUrl, "2026-09-28");
    expect(fixtures).toHaveLength(2);
    expect(fixtures[1]).toMatchObject({ playerOne: "Ross Smith", round: null, session: null });
  });

  it("deduplicates schedules repeated in different information sections", () => {
    expect(parsePdpaEventFixtures(html + html, sourceUrl, "2026-09-28")).toHaveLength(8);
  });

  it("discovers the event through the calendar and reaches live corroboration", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`<a class="event-tile-small" href="${sourceUrl}"><div class="title">World Grand Prix 2026</div><div class="date">28 September 2026</div></a>`))
      .mockResolvedValueOnce(new Response(html));
    const getFixtures = vi.fn().mockResolvedValue([]);
    const source = new CorroboratedPdcFixtureSource({
      officialSource: new PdpaPdcFixtureSource({ fetchImpl }),
      liveSource: { name: "test live feed", getFixtures },
    });
    await expect(source.getFixtures("2026-09-28")).resolves.toHaveLength(8);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getFixtures).toHaveBeenCalledWith("2026-09-28", undefined);
  });
});

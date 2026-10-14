import { describe, expect, it, vi } from "vitest";

import { EredmenyekModusSource, parseEredmenyekModusDetail, parseEredmenyekModusSchedule } from "../src/modus/eredmenyek-source.js";
import { ModusPlayersService } from "../src/modus/service.js";
import type { ModusFixture, ModusFixtureSource } from "../src/modus/schemas.js";

const schedule = `<div id="score-data">
  <h4>VILÁG: MODUS Super Series</h4>
  <span>10:40</span>Mitchell S. (Eng) - McEwan J. (Sco) <a class="sched" href="/merkozes/xQS8wk2M/?s=1&amp;d=1">-</a><br>
  <span>11:15</span>van Ockenburg - Zwaan S. (Ned) - Coleman A. (Eng) <a class="sched" href="/merkozes/vgHnW6fd/?s=1&amp;d=1">-</a><br>
  <h4>VILÁG: PDC</h4>
  <span>12:00</span>Other Player - Another Player <a class="sched" href="/merkozes/other1234/?s=1&amp;d=1">-</a><br>
</div>`;

const mitchellDetail = `<div id="main">
  <h3><a href="https://www.eredmenyek.com/csapat/mitchell-scott/M7buVy1d/">Mitchell S.</a> - <a href="https://www.eredmenyek.com/csapat/mcewan-jim/GWBRlg6A/">McEwan J.</a></h3>
  <div class="detail"></div><div class="detail">12.10.2026 10:40</div>
</div>`;

function emptySource(name: string): ModusFixtureSource {
  return {
    name,
    sourceUrl: (): string => `https://example.test/${name}`,
    getPlayers: async (): Promise<readonly string[]> => [],
    getFixtures: async (): Promise<readonly ModusFixture[]> => [],
  };
}

describe("Eredmenyek MODUS schedule fallback", () => {
  it("reads only MODUS match links from the date-scoped public schedule", () => {
    expect(parseEredmenyekModusSchedule(schedule, 1)).toEqual([
      { matchId: "xQS8wk2M", matchUrl: "https://m.eredmenyek.com/merkozes/xQS8wk2M/?s=1&d=1", scheduledTime: "10:40" },
      { matchId: "vgHnW6fd", matchUrl: "https://m.eredmenyek.com/merkozes/vgHnW6fd/?s=1&d=1", scheduledTime: "11:15" },
    ]);
  });

  it("validates the exact match date and time and uses verified player profile slugs", () => {
    const row = parseEredmenyekModusSchedule(schedule, 1)[0];
    if (row === undefined) throw new Error("Fixture test schedule is missing its first MODUS row.");

    expect(parseEredmenyekModusDetail(mitchellDetail, row, "2026-10-12")).toEqual({
      playerOne: "Scott Mitchell",
      playerTwo: "Jim McEwan",
      date: "2026-10-12",
      time: "10:40",
      startTime: "2026-10-12T08:40:00.000Z",
    });
    expect(() => parseEredmenyekModusDetail(mitchellDetail.replace("12.10.2026", "13.10.2026"), row, "2026-10-12"))
      .toThrow("requested schedule date");
  });

  it("loads date-verified fixtures and keeps the Budapest start time", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "https://m.eredmenyek.com/darts/?d=1&s=1") return new Response(schedule, { status: 200 });
      if (url === "https://m.eredmenyek.com/merkozes/xQS8wk2M/?s=1&d=1") return new Response(mitchellDetail, { status: 200 });
      if (url === "https://m.eredmenyek.com/merkozes/vgHnW6fd/?s=1&d=1") {
        return new Response(`<div id="main"><h3><a>van Ockenburg - Zwaan S.</a><a>Coleman A.</a></h3><div class="detail">12.10.2026 11:15</div></div>`, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const modusSource = new EredmenyekModusSource({
      fetchImpl,
      now: (): Date => new Date("2026-10-11T12:00:00.000Z"),
    });

    const fixtures = await modusSource.getFixtures("2026-10-12");

    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]).toMatchObject({
      id: "eredmenyek:xQS8wk2M",
      date: "2026-10-12",
      startTime: "2026-10-12T08:40:00.000Z",
      playerOne: "Scott Mitchell",
      playerTwo: "Jim McEwan",
      source: "https://m.eredmenyek.com/merkozes/xQS8wk2M/?s=1&d=1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps valid same-day fixtures when the schedule also contains an adjacent-date row", async () => {
    const adjacentDateRow = `<span>00:05</span>Smith A. (Eng) - Jones B. (Wal) <a class="sched" href="/merkozes/0f4twr0d/?s=1&amp;d=1">-</a><br>`;
    const scheduleWithAdjacentDate = schedule.replace("<h4>VILÁG: PDC</h4>", `${adjacentDateRow}<h4>VILÁG: PDC</h4>`);
    const adjacentDateDetail = `<div id="main">
      <h3><a>Smith A.</a> - <a>Jones B.</a></h3>
      <div class="detail">13.10.2026 00:05</div>
    </div>`;
    const fetchImpl = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "https://m.eredmenyek.com/darts/?d=1&s=1") return new Response(scheduleWithAdjacentDate, { status: 200 });
      if (url === "https://m.eredmenyek.com/merkozes/0f4twr0d/?s=1&d=1") return new Response(adjacentDateDetail, { status: 200 });
      if (url === "https://m.eredmenyek.com/merkozes/vgHnW6fd/?s=1&d=1") {
        return new Response(`<div id="main"><h3><a>van Ockenburg - Zwaan S.</a><a>Coleman A.</a></h3><div class="detail">12.10.2026 11:15</div></div>`, { status: 200 });
      }
      return new Response(mitchellDetail, { status: 200 });
    });
    const modusSource = new EredmenyekModusSource({
      fetchImpl,
      now: (): Date => new Date("2026-10-11T12:00:00.000Z"),
    });

    const fixtures = await modusSource.getFixtures("2026-10-12");

    expect(fixtures).toHaveLength(2);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(["eredmenyek:xQS8wk2M", "eredmenyek:vgHnW6fd"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("is reached after empty providers rather than reporting a false empty slate", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/darts/")) return new Response(schedule, { status: 200 });
      if (url.includes("/vgHnW6fd/")) {
        return new Response(`<div id="main"><h3><a>van Ockenburg - Zwaan S.</a><a>Coleman A.</a></h3><div class="detail">12.10.2026 11:15</div></div>`, { status: 200 });
      }
      return new Response(mitchellDetail, { status: 200 });
    });
    const eredmenyek = new EredmenyekModusSource({ fetchImpl, now: (): Date => new Date("2026-10-11T12:00:00.000Z") });
    const service = new ModusPlayersService({ sources: [emptySource("official"), eredmenyek] });

    const result = await service.getModusFixtures("2026-10-12");

    expect(result.fixtures).toHaveLength(2);
    expect(result.fixtures.map((fixture) => fixture.playerOne)).toEqual(["Scott Mitchell", "van Ockenburg - Zwaan S."]);
  });

  it("rejects malformed or cross-origin match links instead of following them", () => {
    expect(() => parseEredmenyekModusSchedule(schedule.replace("/merkozes/xQS8wk2M/", "https://attacker.test/merkozes/xQS8wk2M/"), 1))
      .toThrow("untrusted match URL");
    expect(() => parseEredmenyekModusSchedule("<div>Loading</div>", 1)).toThrow("markup is unavailable");
    expect(() => parseEredmenyekModusSchedule(schedule, 8)).toThrow("within seven days");
  });
});

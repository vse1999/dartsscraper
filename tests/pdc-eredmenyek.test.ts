import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { EredmenyekPdcFixtureSource, parseEredmenyekPdcDetail, parseEredmenyekPdcSchedule } from "../src/pdc/eredmenyek-fixture-source.js";
import { OfficialPdcScheduleUnavailableError } from "../src/pdc/official-api-fixture-source.js";
import type { PdcFixture, PdcFixtureSource } from "../src/pdc/schemas.js";

const event = "2026 ET14 - Swiss Darts Trophy";
const date = "2026-10-09";
const schedule = readFileSync(new URL("./pdc-fixtures/eredmenyek-oct9-schedule.html", import.meta.url), "utf8");
const detail = readFileSync(new URL("./pdc-fixtures/eredmenyek-oct9-detail.html", import.meta.url), "utf8");
const firstRow = parseEredmenyekPdcSchedule(schedule, [event])[0];
if (firstRow === undefined) throw new Error("Captured Eredmenyek schedule must contain fixtures.");
const singleSchedule = `<div id="score-data"><h4>EURÓPA: European Tour 14</h4><span>13:00</span>Zonneveld N. (Ned) - Brooks B. (Eng) <a href="/merkozes/0E6NVbSi/?s=1" class="sched"> - </a><br></div>`;

function unavailable(events: readonly string[] = [event], fixtures: readonly PdcFixture[] = []): OfficialPdcScheduleUnavailableError {
  return new OfficialPdcScheduleUnavailableError("Official draw unavailable", undefined, { date, tournamentNames: events, availableFixtures: fixtures });
}
function official(error: Error = unavailable()): PdcFixtureSource {
  return { name: "official test", getFixtures: vi.fn(async (): Promise<readonly PdcFixture[]> => { throw error; }) };
}
function source(fetchImpl: typeof fetch, officialSource: PdcFixtureSource = official()): EredmenyekPdcFixtureSource {
  return new EredmenyekPdcFixtureSource({ fetchImpl, officialSource, now: (): Date => new Date("2026-10-09T08:00:00Z") });
}
function fetchCapture(scheduleBody: string = singleSchedule, detailBody: string = detail): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(async (input): Promise<Response> => new Response(String(input).includes("/darts/") ? scheduleBody : detailBody));
}

describe("Eredmenyek official-event-backed PDC fallback", () => {
  it("finds the exact 16 captured European Tour pairings, not MODUS", () => {
    const rows = parseEredmenyekPdcSchedule(schedule, [event]);
    expect(rows).toHaveLength(16);
    expect(rows[0]).toMatchObject({ playerOne: "Zonneveld N.", playerTwo: "Brooks B." });
    expect(rows.at(-1)).toMatchObject({ playerOne: "Doets K.", playerTwo: "Kenny N." });
    expect(rows.every((row) => row.tournamentName === event)).toBe(true);
    expect(parseEredmenyekPdcSchedule(singleSchedule.replace("European Tour 14", "Swiss Darts Trophy"), [event])).toHaveLength(1);
  });

  it("verifies the full detail date, participants and provider-backed full names", () => {
    expect(parseEredmenyekPdcDetail(detail, firstRow)).toEqual({ date, time: "13:00", playerOne: "Niels Zonneveld", playerTwo: "Bradley Brooks" });
  });

  it("handles multi-letter initials, apostrophes, and surname particles without guessing from initials alone", () => {
    const gyorgy = detail.replaceAll("Zonneveld N.", "Jehirszki Gy.").replace("zonneveld-niels/MeTrr5Fk", "jehirszki-gyorgy/j9o4oiID");
    expect(parseEredmenyekPdcDetail(gyorgy, { playerOne: "Jehirszki Gy.", playerTwo: "Brooks B." }).playerOne).toBe("Gyorgy Jehirszki");
    const connor = detail.replaceAll("Zonneveld N.", "O'Connor W.").replace("zonneveld-niels/MeTrr5Fk", "o-connor-william/pSbuZfV4");
    expect(parseEredmenyekPdcDetail(connor, { playerOne: "O'Connor W.", playerTwo: "Brooks B." }).playerOne).toBe("William O'Connor");
    const graaf = detail.replaceAll("Zonneveld N.", "de Graaf J.").replace("zonneveld-niels/MeTrr5Fk", "de-graaf-jeffrey/QihQLWNE");
    expect(parseEredmenyekPdcDetail(graaf, { playerOne: "de Graaf J.", playerTwo: "Brooks B." }).playerOne).toBe("Jeffrey de Graaf");
    for (const bad of [detail.replace("zonneveld-niels", "zonneveld-john"), detail.replaceAll("https://www.eredmenyek.com/csapat/", "https://evil.test/csapat/")]) {
      expect(parseEredmenyekPdcDetail(bad, firstRow).playerOne).toBe("Zonneveld N.");
    }
  });

  it("recovers empty official draw via real lightweight markup and publishes honest provenance", async () => {
    const fetchImpl = fetchCapture();
    const fixtures = await source(fetchImpl).getFixtures(date);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ date, playerOne: "Niels Zonneveld", playerTwo: "Bradley Brooks", startTime: null, session: "13:00 (Eredmenyek display time)", sourceUrl: firstRow.url });
    expect(fixtures[0]?.evidenceUrls).toContain("https://www.pdc.tv/matches");
    expect(fetchImpl).toHaveBeenCalledWith("https://m.eredmenyek.com/darts/?d=0&s=1", expect.objectContaining({ redirect: "error" }));
    expect(fetchImpl).toHaveBeenCalledWith(firstRow.url, expect.objectContaining({ redirect: "error" }));
  });

  it("uses shared strict directory resolution when available", async () => {
    const resolve = vi.fn(async (name: string): Promise<string> => `Canonical ${name}`);
    const fixtures = await new EredmenyekPdcFixtureSource({ officialSource: official(), fetchImpl: fetchCapture(), resolver: { resolve }, now: (): Date => new Date(`${date}T08:00:00Z`) }).getFixtures(date);
    expect(resolve).toHaveBeenCalledWith("Niels Zonneveld", expect.any(AbortSignal));
    expect(fixtures[0]?.playerOne).toBe("Canonical Niels Zonneveld");
  });

  it("does not fetch fallback for verified official fixtures or verified empty calendar", async () => {
    const fetchImpl = fetchCapture();
    const getFixtures = vi.fn(async (): Promise<readonly PdcFixture[]> => []);
    expect(await source(fetchImpl, { name: "official", getFixtures }).getFixtures(date)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves other official pairings and includes completed provider rows", async () => {
    const known: PdcFixture = { id: "official:other", tournamentName: "World Grand Prix", date, startTime: null, session: null, round: null, playerOne: "Rob Cross", playerTwo: "Ryan Searle", sourceUrl: "https://www.pdc.tv/matches" };
    const fixtures = await source(fetchCapture(singleSchedule.replace('class="sched"', 'class="fin"')), official(unavailable([event], [known]))).getFixtures(date);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]).toEqual(known);
  });

  it("never treats a calendar outage as evidence of an official event", async () => {
    const fetchImpl = fetchCapture();
    const error = unavailable([]);
    await expect(source(fetchImpl, official(error)).getFixtures(date)).rejects.toBe(error);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unrelated tour numbers, qualifier/main-event mismatches, and ambiguous event mappings", () => {
    expect(parseEredmenyekPdcSchedule(schedule, ["2026 ET13 - Hungarian Darts Trophy"])).toEqual([]);
    expect(parseEredmenyekPdcSchedule(schedule, ["2026 ET14 - Swiss Darts Trophy Qualifier"])).toEqual([]);
    expect(() => parseEredmenyekPdcSchedule(schedule, [event, "2026 ET14 - other"])).toThrow("ambiguously");
  });

  it("rejects missing markup, repeated rows, placeholder players, and untrusted detail URLs", () => {
    expect(() => parseEredmenyekPdcSchedule("Loading...", [event])).toThrow("markup");
    expect(() => parseEredmenyekPdcSchedule(singleSchedule.replace("</div>", singleSchedule.replace(/<\/?div[^>]*>/gu, "") + "</div>"), [event])).toThrow("repeated");
    expect(() => parseEredmenyekPdcSchedule(singleSchedule.replace("Brooks B. (Eng)", "TBA"), [event])).toThrow("concrete");
    for (const url of ["https://evil.test/merkozes/0E6NVbSi/", "http://m.eredmenyek.com/merkozes/0E6NVbSi/", "/merkozes/0E6NVbSi/?evil=1"]) {
      expect(() => parseEredmenyekPdcSchedule(singleSchedule.replace("/merkozes/0E6NVbSi/?s=1", url), [event])).toThrow("untrusted");
    }
  });

  it("rejects conflicting participants, malformed dates/times and missing dates", () => {
    expect(() => parseEredmenyekPdcDetail(detail.replaceAll("Brooks B.", "Cross R."), firstRow)).toThrow("participants");
    expect(() => parseEredmenyekPdcDetail(detail.replace("09.10.2026", "31.02.2026"), firstRow)).toThrow();
    expect(() => parseEredmenyekPdcDetail(detail.replace("13:00", "25:00"), firstRow)).toThrow("time");
    expect(() => parseEredmenyekPdcDetail(detail.replace("09.10.2026 13:00", "Tomorrow"), firstRow)).toThrow("explicit");
  });

  it("does not mislabel adjacent-day rows or return a partial missing-event slate", async () => {
    await expect(source(fetchCapture(singleSchedule, detail.replace("09.10.2026", "10.10.2026"))).getFixtures(date)).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
    await expect(source(fetchCapture(), official(unavailable([event, "World Grand Prix"])) ).getFixtures(date)).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
  });

  it("fails honestly on HTTP errors or detail read failure rather than returning empty", async () => {
    const error = unavailable();
    await expect(source(vi.fn<typeof fetch>().mockResolvedValue(new Response("blocked", { status: 403 })), official(error)).getFixtures(date)).rejects.toBe(error);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(singleSchedule)).mockRejectedValueOnce(new Error("network"));
    await expect(source(fetchImpl, official(error)).getFixtures(date)).rejects.toBe(error);
  });

  it("cancels a pending fallback, times out a hung reader, and avoids out-of-window reads", async () => {
    const controller = new AbortController();
    const pending = vi.fn<typeof fetch>(async (): Promise<Response> => new Promise<Response>(() => {}));
    const work = source(pending).getFixtures(date, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort(new Error("user cancelled"));
    await expect(work).rejects.toThrow("user cancelled");
    await expect(new EredmenyekPdcFixtureSource({ officialSource: official(), fetchImpl: pending, timeoutMs: 5, now: (): Date => new Date(`${date}T08:00:00Z`) }).getFixtures(date)).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
    const fetchImpl = fetchCapture();
    await expect(new EredmenyekPdcFixtureSource({ officialSource: official(), fetchImpl, now: (): Date => new Date("2026-11-09T08:00:00Z") }).getFixtures(date)).rejects.toBeInstanceOf(OfficialPdcScheduleUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

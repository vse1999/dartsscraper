import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enqueueBrowserRun, filterElapsedMatches, hasTippmixProMapping, requestedDateFor } from "../src/odds/runtime.js";
import type { OddsReport } from "../src/odds/contracts.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve): void => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred promise resolver was not initialized.");
  return { promise, resolve: resolvePromise };
}

describe("odds browser queue", () => {
  it("keeps one active run and bounds pending work at two entries", async () => {
    const release = deferred<void>();
    const active = enqueueBrowserRun(async (): Promise<void> => release.promise, new AbortController().signal);
    await Promise.resolve();
    const pendingOne = enqueueBrowserRun(async (): Promise<void> => undefined, new AbortController().signal);
    const pendingTwo = enqueueBrowserRun(async (): Promise<void> => undefined, new AbortController().signal);
    await expect(enqueueBrowserRun(async (): Promise<void> => undefined, new AbortController().signal)).rejects.toThrow(/busy/iu);
    release.resolve(undefined);
    await Promise.all([active, pendingOne, pendingTwo]);
  });

  it("does not launch an aborted queued run", async () => {
    const release = deferred<void>();
    const active = enqueueBrowserRun(async (): Promise<void> => release.promise, new AbortController().signal);
    const controller = new AbortController();
    let launched = false;
    const queued = enqueueBrowserRun(async (): Promise<void> => { launched = true; }, controller.signal);
    controller.abort(new Error("caller cancelled"));
    release.resolve(undefined);
    await expect(queued).rejects.toThrow(/cancelled/iu);
    await active;
    expect(launched).toBe(false);
  });

  it("rejects an aborted queued run immediately and reclaims its slot", async () => {
    const release = deferred<void>();
    const active = enqueueBrowserRun(async (): Promise<void> => release.promise, new AbortController().signal);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstQueued = enqueueBrowserRun(async (): Promise<void> => undefined, firstController.signal);
    const secondQueued = enqueueBrowserRun(async (): Promise<void> => undefined, secondController.signal);
    firstController.abort(new Error("queue caller cancelled"));
    await expect(firstQueued).rejects.toThrow(/cancelled/iu);
    const reclaimed = enqueueBrowserRun(async (): Promise<void> => undefined, new AbortController().signal);
    release.resolve(undefined);
    await Promise.all([active, secondQueued, reclaimed]);
  });

  it("rejects a pre-aborted run without consuming a queue slot", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let launched = false;
    await expect(enqueueBrowserRun(async (): Promise<void> => { launched = true; }, controller.signal)).rejects.toThrow(/already cancelled/iu);
    await enqueueBrowserRun(async (): Promise<void> => undefined, new AbortController().signal);
    expect(launched).toBe(false);
  });
});

describe("odds runtime date and source guards", () => {
  it("accepts only the same public bookmaker mapping object", () => {
    const current = `<script>bookmakerSettings={bookmakersData:{"default":[{"main_bookmaker_id":"498","project_id":"15","geo_ip":"default","name":"TippmixPro","has_inplay_odds":"1"}]}}</script>`;
    expect(hasTippmixProMapping([current])).toBe(true);
    expect(hasTippmixProMapping([current.replace('"main_bookmaker_id":"498"', '"main_bookmaker_id":"497"')])).toBe(false);
    expect(hasTippmixProMapping([current.replace('"name":"TippmixPro"', '"name":"OtherBookmaker"')])).toBe(false);
    expect(hasTippmixProMapping([`<script>"default":[{"main_bookmaker_id":"498","name":"OtherBookmaker"},{"main_bookmaker_id":"497","name":"TippmixPro"}]</script>`])).toBe(false);
  });

  it("computes Budapest dates across midnight and DST boundaries", () => {
    expect(requestedDateFor("today", new Date("2026-03-29T23:30:00.000Z"))).toBe("2026-03-30");
    expect(requestedDateFor("tomorrow", new Date("2026-10-25T22:30:00.000Z"))).toBe("2026-10-26");
  });

  it("strictly removes a match at the current displayed minute and reports the count", () => {
    const report: OddsReport = {
      source: "eredmenyek",
      sourceUrl: "https://www.eredmenyek.com/darts/oddsok/",
      observedAt: "2026-09-30T08:00:00.000Z",
      date: "2026-09-30",
      timeZone: "Europe/Budapest",
      matches: [
        { eventId: "now", competition: "D", player1: "A", player2: "B", odds1: 1.8, odds2: 2.2, bookmaker: "TippmixPro", scheduledTime: "10:00", sourceUrl: "https://www.eredmenyek.com/merkozes/darts/a/now/?mid=now" },
        { eventId: "later", competition: "D", player1: "C", player2: "E", odds1: 1.9, odds2: 2.1, bookmaker: "TippmixPro", scheduledTime: "10:01", sourceUrl: "https://www.eredmenyek.com/merkozes/darts/c/later/?mid=later" },
      ],
      warnings: [],
    };
    const filtered = filterElapsedMatches(report, new Date("2026-09-30T08:00:00.000Z"));
    expect(filtered.matches.map((match) => match.eventId)).toEqual(["later"]);
    expect(filtered.warnings).toEqual(["Filtered 1 match(es) whose displayed Budapest start time had passed."]);
  });

  it("keeps the Vercel Chromium bundle include glob as a schema-valid string", () => {
    const config: unknown = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as unknown;
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("vercel.json must contain an object");
    const functions = (config as { functions?: unknown }).functions;
    if (typeof functions !== "object" || functions === null || Array.isArray(functions)) throw new Error("vercel.json functions must contain an object");
    const webhook = (functions as { [key: string]: unknown })["api/telegram-webhook.ts"];
    if (typeof webhook !== "object" || webhook === null || Array.isArray(webhook)) throw new Error("Telegram webhook function config missing");
    expect((webhook as { includeFiles?: unknown }).includeFiles).toBe("node_modules/@sparticuz/chromium/bin/**");
  });
});

import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../src/logger.js";
import { runPdcReportJob, type PdcReportJobDependencies } from "../src/pdc/report-job.js";
import { signPdcJob, verifyPdcJob, type PdcReportJob } from "../src/pdc/report-job-protocol.js";
import { InMemoryPdcJobReceiptStore, type PdcJobReceiptReservation, type PdcJobReceiptStore } from "../src/pdc/job-receipt-store.js";
import { handlePdcJobRequest, type PdcJobEndpointDependencies } from "../api/pdc-report.js";
import { createPdcJobDispatcher, PdcJobDispatchError } from "../src/telegram/pdc-job-trigger.js";
import type { PdcFixture, PdcScheduleSnapshot } from "../src/pdc/schemas.js";
import type { PdcUpcomingReport, PdcPlayerStats } from "../src/pdc/service.js";
import type { ImageReport } from "../src/telegram/report-image.js";
import { createBot, createConfiguredPdcJobDispatcher, resolvePdcReportEndpointUrl, type BotEnvironment } from "../src/telegram/bot.js";
import type { Update } from "grammy/types";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

const secret = "s".repeat(64);
const cron = "c".repeat(64);
function job(): PdcReportJob { return { version: 1, jobId: "85fba983-a3f7-4817-b7e0-4670741569e5", date: "2026-10-09", createdAt: new Date().toISOString(), acknowledgementMessageId: 1, cursor: 0 }; }
function fixtures(count: number = 16): PdcFixture[] {
  return Array.from({ length: count }, (_, index): PdcFixture => ({ id: `fixture-${index}`, date: "2026-10-09", tournamentName: "Swiss Darts Trophy", startTime: null, session: null, round: null, playerOne: `Player ${index * 2}`, playerTwo: `Player ${index * 2 + 1}`, sourceUrl: "https://www.pdc.tv/matches" }));
}
function schedule(input: readonly PdcFixture[]): PdcScheduleSnapshot {
  return {
    schemaVersion: 1, date: "2026-10-09", timeZone: "Europe/Budapest", observedAt: new Date().toISOString(),
    calendarStatus: "verified", calendarReason: null,
    events: input.length === 0 ? [] : [{ eventId: "event-1", name: input[0]?.tournamentName ?? "Swiss Darts Trophy", coverage: "available", fixtures: [...input], pendingSlots: 0, reason: null, evidenceUrls: ["https://www.pdc.tv/matches"] }],
  };
}
function stats(name: string): PdcPlayerStats { return { playerName: name, requestedCount: 10, matches: Array.from({ length: 10 }, (_, index) => ({ date: "2026-10-08", tournament: "PDC", round: null, result: "Won", opponent: `Other ${index}`, score: "6-3", average: 95, oneEighties: 3, checkoutPercentage: 50, checkoutHits: 6, checkoutAttempts: 12 })), meanAverage: 95, availableAverageCount: 10, sourceUrl: "https://dartsorakel.com/player/details/1/example", sourceLabel: "DartsOrakel", provider: "dartsorakel", evidenceUrls: [] }; }
function report(input: readonly PdcFixture[]): PdcUpcomingReport { return { date: "2026-10-09", fixtures: input, players: [...new Set(input.flatMap((fixture) => [fixture.playerOne, fixture.playerTwo]))].map((requestedName) => ({ requestedName, stats: stats(requestedName), failureCode: null })) }; }
function endpoint(): PdcJobEndpointDependencies & { readonly tasks: Promise<void>[] } {
  const tasks: Promise<void>[] = [];
  return { tasks, cronSecret: cron, signingSecret: secret, logger: noopLogger, receiptStore: new InMemoryPdcJobReceiptStore(), execute: vi.fn(async (): Promise<void> => {}), schedule: (task: Promise<void>): void => { tasks.push(task); } };
}
function request(value: unknown = signPdcJob(job(), secret), authorization: string = `Bearer ${cron}`): Request { return new Request("https://example.test/api/pdc-report", { method: "POST", headers: { authorization }, body: JSON.stringify(value) }); }

describe("signed PDC job endpoint", () => {
  it("accepts a signed job once per warm receipt and acknowledges before work completes", async () => {
    const dependencies = endpoint();
    const signed = signPdcJob(job(), secret);
    expect((await handlePdcJobRequest(request(signed), dependencies)).status).toBe(202);
    expect((await handlePdcJobRequest(request(signed), dependencies)).status).toBe(202);
    await Promise.all(dependencies.tasks);
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
  });
  it("admits concurrent duplicate requests through one atomic in-process reservation", async () => {
    const dependencies = endpoint();
    const signed = signPdcJob(job(), secret);

    const responses = await Promise.all([
      handlePdcJobRequest(request(signed), dependencies),
      handlePdcJobRequest(request(signed), dependencies),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(dependencies.tasks).toHaveLength(1);
  });
  it("fails closed when duplicate-receipt admission is unavailable", async () => {
    const dependencies = endpoint();
    const schedule = vi.fn((_task: Promise<void>): void => undefined);
    const receiptStore: PdcJobReceiptStore = {
      reserve: async (): Promise<PdcJobReceiptReservation> => { throw new Error("private store details"); },
      release: async (): Promise<void> => undefined,
    };

    const result = await handlePdcJobRequest(request(), { ...dependencies, receiptStore, schedule });

    expect(result.status).toBe(503);
    expect(schedule).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it("rejects missing/wrong authorization and modified or expired signed data", async () => {
    const dependencies = endpoint();
    expect((await handlePdcJobRequest(request(undefined, "Bearer bad"), dependencies)).status).toBe(404);
    const signed = signPdcJob(job(), secret);
    expect((await handlePdcJobRequest(request({ ...signed, job: { ...signed.job, date: "2026-10-10" } }), dependencies)).status).toBe(400);
    expect((await handlePdcJobRequest(request(signPdcJob({ ...job(), createdAt: "2000-01-01T00:00:00.000Z" }, secret)), dependencies)).status).toBe(400);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it("rejects invalid cursors, foreign dates, duplicate IDs and future jobs", () => {
    expect(() => signPdcJob({ ...job(), cursor: 4 }, secret)).toThrow();
    expect(() => signPdcJob({ ...job(), fixtures: fixtures(4), cursor: 4 }, secret)).toThrow();
    expect(() => signPdcJob({ ...job(), fixtures: [{ ...fixtures(1)[0]!, date: "2026-10-10" }] }, secret)).toThrow();
    expect(() => signPdcJob({ ...job(), fixtures: [fixtures(1)[0]!, fixtures(1)[0]!] }, secret)).toThrow();
    expect(() => verifyPdcJob(signPdcJob({ ...job(), createdAt: new Date(Date.now() + 60_000).toISOString() }, secret), secret)).toThrow("future");
  });
  it("verifies a serialized continuation snapshot and refuses changed pairing data", async () => {
    const signed = signPdcJob({ ...job(), cursor: 4, fixtures: fixtures(16) }, secret);
    expect(verifyPdcJob(JSON.parse(JSON.stringify(signed)) as unknown, secret).job.cursor).toBe(4);
    const changed = { ...signed, job: { ...signed.job, fixtures: signed.job.fixtures?.map((fixture, index) => index === 0 ? { ...fixture, playerOne: "Wrong player" } : fixture) } };
    expect((await handlePdcJobRequest(request(changed), endpoint())).status).toBe(400);
  });
  it("rejects participant changes when the full schedule is pinned", () => {
    const input = fixtures(4);
    const pinned = signPdcJob({ ...job(), fixtures: input, schedule: schedule(input) }, secret);
    const changed = {
      ...pinned,
      job: { ...pinned.job, fixtures: pinned.job.fixtures?.map((fixture, index) => index === 0 ? { ...fixture, playerOne: "Different player" } : fixture) },
    };
    expect(() => verifyPdcJob(changed, secret)).toThrow("schedule and pinned fixtures disagree");
  });
  it("does not start any work when scheduler registration fails", async () => {
    const dependencies = endpoint();
    const signed = signPdcJob(job(), secret);
    expect((await handlePdcJobRequest(request(signed), { ...dependencies, schedule: (): never => { throw new Error("scheduler unavailable"); } })).status).toBe(503);
    await Promise.resolve();
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect(await dependencies.receiptStore.reserve(`${signed.job.jobId}:${signed.job.cursor}`, { signature: signed.signature, expiresAt: Date.now() + 10000 }, Date.now())).toBe("reserved");
  });
  it("bounds request bytes, admission capacity and key reuse with changed input", async () => {
    const dependencies = endpoint();
    const first = job();
    await handlePdcJobRequest(request(signPdcJob(first, secret)), dependencies);
    expect((await handlePdcJobRequest(request(signPdcJob({ ...first, acknowledgementMessageId: 2 }, secret)), dependencies)).status).toBe(409);
    const oversized = new Request("https://example.test/api/pdc-report", { method: "POST", headers: { authorization: `Bearer ${cron}`, "content-length": "999999" }, body: "{}" });
    expect((await handlePdcJobRequest(oversized, dependencies)).status).toBe(413);
    const now = Date.now();
    for (let i = 0; i < 1023; i += 1) {
      expect(await dependencies.receiptStore.reserve(`old-${i}`, { signature: "x", expiresAt: now + 10000 }, now)).toBe("reserved");
    }
    expect((await handlePdcJobRequest(request(signPdcJob({ ...job(), jobId: "ff879acd-29f4-4c1c-b026-acd880f15bcb" }, secret)), dependencies)).status).toBe(503);
  });
});

describe("complete statistic chunks", () => {
  it("bounds a hung research dependency without sending incomplete cards", async () => {
    const sendReport = vi.fn();
    const editStatus = vi.fn(async (): Promise<void> => {});
    const dispatch = vi.fn();
    await runPdcReportJob(job(), { reader: { getScheduleForDate: async () => schedule(fixtures(4)), getReportForFixtures: async () => new Promise<PdcUpcomingReport>(() => {}) }, sender: { sendReport, sendMessage: vi.fn() }, editStatus, dispatcher: { dispatch }, logger: noopLogger, chatId: 1, researchMs: 10, totalMs: 100 });
    expect(sendReport).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining("lookup stopped"), expect.any(AbortSignal));
  });
  it("delivers all 16 complete cards sequentially across four bounded invocations", async () => {
    const input = fixtures();
    const queued: PdcReportJob[] = [job()];
    let sent = 0;
    const getScheduleForDate = vi.fn(async (): Promise<PdcScheduleSnapshot> => schedule(input));
    const editStatus = vi.fn(async (_id: number, _text: string, _signal: AbortSignal): Promise<void> => {});
    const dependencies: PdcReportJobDependencies = {
      reader: { getScheduleForDate, getReportForFixtures: vi.fn(async (_date: string, batch: readonly PdcFixture[]): Promise<PdcUpcomingReport> => { expect(batch.length).toBeLessThanOrEqual(4); return report(batch); }) },
      sender: { sendReport: vi.fn(async (): Promise<void> => { sent += 1; }), sendMessage: vi.fn(async (): Promise<void> => {}) },
      editStatus, chatId: 1, logger: noopLogger,
      dispatcher: { dispatch: vi.fn(async (next: PdcReportJob): Promise<void> => { expect(sent).toBe(next.cursor); queued.push(next); }) },
    };
    while (queued.length > 0) { const next = queued.shift(); if (next !== undefined) await runPdcReportJob(next, dependencies); }
    expect(sent).toBe(16);
    expect(getScheduleForDate).toHaveBeenCalledTimes(1);
    expect(dependencies.reader.getReportForFixtures).toHaveBeenCalledTimes(4);
    expect(editStatus.mock.calls.filter(([, text]) => text.includes("PDC SCHEDULE"))).toHaveLength(1);
    expect(dependencies.editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining("Completed: 16"), expect.any(AbortSignal));
  });
  it("continues an older pinned job without rediscovery or repeating the schedule preview", async () => {
    const input = fixtures(8);
    const getScheduleForDate = vi.fn(async (): Promise<PdcScheduleSnapshot> => schedule(input));
    const getReportForFixtures = vi.fn(async (_date: string, batch: readonly PdcFixture[]): Promise<PdcUpcomingReport> => report(batch));
    const editStatus = vi.fn(async (_id: number, _text: string, _signal: AbortSignal): Promise<void> => {});
    await runPdcReportJob({ ...job(), cursor: 4, fixtures: input }, {
      reader: { getScheduleForDate, getReportForFixtures },
      sender: { sendReport: vi.fn(async (): Promise<void> => {}), sendMessage: vi.fn(async (): Promise<void> => {}) },
      editStatus,
      dispatcher: { dispatch: vi.fn(async (): Promise<void> => {}) },
      logger: noopLogger,
      chatId: 1,
    });

    expect(getScheduleForDate).not.toHaveBeenCalled();
    expect(getReportForFixtures).toHaveBeenCalledWith("2026-10-09", input.slice(4, 8), expect.any(AbortSignal), undefined, expect.objectContaining({ calendarStatus: "unavailable" }));
    expect(editStatus.mock.calls.some(([, text]) => text.includes("PDC SCHEDULE"))).toBe(false);
  });
  it("shows full event coverage and named fixtures before starting history work", async () => {
    const input = fixtures(16);
    const base = schedule(input);
    const snapshot: PdcScheduleSnapshot = {
      ...base,
      events: [
        ...(base.events),
        { eventId: "womens", name: "Women's World Matchplay", coverage: "unavailable", fixtures: [], pendingSlots: null, reason: "event_unavailable", evidenceUrls: ["https://www.pdc.tv/matches"] },
        { eventId: "pending", name: "Players Championship", coverage: "opponents_pending", fixtures: [], pendingSlots: 2, reason: "opponents_unassigned", evidenceUrls: ["https://www.pdc.tv/matches"] },
      ],
    };
    const order: string[] = [];
    const editStatus = vi.fn(async (_id: number, text: string): Promise<void> => { order.push(`edit:${text}`); });
    const getReportForFixtures = vi.fn(async (_date: string, batch: readonly PdcFixture[]): Promise<PdcUpcomingReport> => {
      order.push("statistics");
      return report(batch);
    });
    await runPdcReportJob(job(), {
      reader: { getScheduleForDate: async () => snapshot, getReportForFixtures },
      sender: { sendReport: vi.fn(async (): Promise<void> => {}), sendMessage: vi.fn(async (): Promise<void> => {}) },
      editStatus,
      dispatcher: { dispatch: vi.fn(async (): Promise<void> => {}) },
      logger: noopLogger,
      chatId: 1,
    });

    const preview = order.find((entry) => entry.startsWith("edit:")) ?? "";
    expect(order[1]).toBe("statistics");
    expect(preview).toContain("Swiss Darts Trophy · 16 named matchups · validated");
    expect(preview).toContain("Women's World Matchplay · schedule verification unavailable");
    expect(preview).toContain("Players Championship · 2 opponent slots pending · no history requested");
    expect(getReportForFixtures).toHaveBeenCalledWith("2026-10-09", input.slice(0, 4), expect.any(AbortSignal), undefined, snapshot);
  });
  it("withholds only pairings that depend on a failed player and continues later batches", async () => {
    const input = fixtures(8);
    const queued: PdcReportJob[] = [job()];
    const sent: string[] = [];
    const dispatch = vi.fn(async (next: PdcReportJob): Promise<void> => { queued.push(next); });
    const reports = vi.fn(async (_date: string, batch: readonly PdcFixture[]): Promise<PdcUpcomingReport> => {
      const complete = report(batch);
      return {
        ...complete,
        players: complete.players.map((player) => player.requestedName === "Player 0"
          ? { ...player, stats: null, failureCode: "unavailable" }
          : player),
      };
    });
    const dependencies: PdcReportJobDependencies = {
      reader: { getScheduleForDate: async () => schedule(input), getReportForFixtures: reports },
      sender: {
        sendReport: async (_chat: number | string, image: ImageReport): Promise<void> => { sent.push(image.caption); },
        sendMessage: vi.fn(async (): Promise<void> => {}),
      },
      editStatus: vi.fn(async (): Promise<void> => {}),
      chatId: 1,
      logger: noopLogger,
      dispatcher: { dispatch },
    };

    while (queued.length > 0) {
      const next = queued.shift();
      if (next !== undefined) await runPdcReportJob(next, dependencies);
    }

    expect(reports).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(7);
    expect(dependencies.editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining("7/8 complete cards delivered"), expect.any(AbortSignal));
    const continuation = dispatch.mock.calls[0]?.[0];
    expect(continuation).toMatchObject({ cursor: 4, deliveredCount: 3, failedCount: 1 });
    expect(continuation?.deliveredFixtureIds).toHaveLength(3);
  });
  it("withholds incomplete/empty/foreign report batches and stops instead of sending partial cards", async () => {
    for (const broken of [
      { ...report(fixtures(2)), players: [] },
      { ...report(fixtures(2)), date: "2026-10-10" },
      { ...report(fixtures(2)), players: report(fixtures(2)).players.map((player) => ({ ...player, stats: null, failureCode: "timeout" as const })) },
    ]) {
      const dependencies: PdcReportJobDependencies = { reader: { getScheduleForDate: async () => schedule(fixtures(2)), getReportForFixtures: async () => broken }, sender: { sendReport: vi.fn(), sendMessage: vi.fn() }, editStatus: vi.fn(async (): Promise<void> => {}), chatId: 1, logger: noopLogger, dispatcher: { dispatch: vi.fn() } };
      await runPdcReportJob(job(), dependencies);
      expect(dependencies.sender.sendReport).not.toHaveBeenCalled();
      expect(dependencies.dispatcher.dispatch).not.toHaveBeenCalled();
      const validIdentity = broken.date === "2026-10-09" && broken.players.length > 0;
      expect(dependencies.editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining(validIdentity
        ? "Completed: 0/2 complete cards delivered"
        : "Incomplete cards were not substituted"), expect.any(AbortSignal));
    }
  });
  it("does not automatically repeat an ambiguous continuation or exceed the global image cap", async () => {
    const input = fixtures(32);
    const sendReport = vi.fn(async (_chat: number | string, _image: ImageReport): Promise<void> => {});
    const editStatus = vi.fn(async (): Promise<void> => {});
    const dispatch = vi.fn(async (): Promise<void> => { throw new PdcJobDispatchError("network", true); });
    await runPdcReportJob({ ...job(), cursor: 24, fixtures: input }, { reader: { getScheduleForDate: async () => schedule(input), getReportForFixtures: async (_date: string, batch: readonly PdcFixture[]) => report(batch) }, sender: { sendReport, sendMessage: vi.fn() }, editStatus, dispatcher: { dispatch }, logger: noopLogger, chatId: 1 });
    expect(sendReport.mock.calls.filter((call) => { const value: unknown = call[1]; return typeof value === "object" && value !== null && "card" in value; })).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining("may still be running"), expect.any(AbortSignal));
  });
  it("reports a safe continuation stage and HTTP code without exposing error details", async () => {
    const editStatus = vi.fn(async (_messageId: number, _text: string, _signal: AbortSignal): Promise<void> => {});
    await runPdcReportJob(job(), { reader: { getScheduleForDate: async () => schedule(fixtures(8)), getReportForFixtures: async (_date: string, batch: readonly PdcFixture[]) => report(batch) },
      sender: { sendReport: vi.fn(async (): Promise<void> => {}), sendMessage: vi.fn() }, editStatus, chatId: 1, logger: noopLogger,
      dispatcher: { dispatch: async (): Promise<void> => { throw new PdcJobDispatchError("private credential detail", false, undefined, 400); } },
    });
    expect(editStatus).toHaveBeenLastCalledWith(1, expect.stringContaining("Stopped at: continuation (HTTP 400)"), expect.any(AbortSignal));
    expect(editStatus.mock.calls.at(-1)?.[1]).not.toContain("private credential detail");
  });
});

describe("PDC job dispatch safety", () => {
  it("signs requests, denies non-HTTPS/non-local routes, and never retries a network ambiguity", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
    const dispatcher = createPdcJobDispatcher({ endpointUrl: "https://example.test/api/pdc-report", cronSecret: cron, signingSecret: secret, fetchImpl });
    await expect(dispatcher.dispatch(job())).rejects.toMatchObject({ uncertain: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(() => createPdcJobDispatcher({ endpointUrl: "http://evil.test/api/pdc-report", cronSecret: cron, signingSecret: secret })).toThrow("HTTPS");
    expect(() => createPdcJobDispatcher({ endpointUrl: "https://example.test/wrong", cronSecret: cron, signingSecret: secret })).toThrow();
  });
});

describe("complete PDC bot wiring and native bundle", () => {
  it("does not break other bot commands when continuation credentials are missing or invalid", () => {
    expect(createConfiguredPdcJobDispatcher({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "example.test" }, noopLogger)).toBeUndefined();
    expect(createConfiguredPdcJobDispatcher({ PDC_REPORT_URL: "http://evil.test/api/pdc-report", CRON_SECRET: cron, WEBHOOK_SECRET: secret }, noopLogger)).toBeUndefined();
    expect(createConfiguredPdcJobDispatcher({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "example.test", CRON_SECRET: cron, WEBHOOK_SECRET: secret }, noopLogger)).toBeDefined();
  });
  it("keeps preview PDC continuations on the preview deployment, never the production host", () => {
    const preview: BotEnvironment = {
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "preview-abc.example.test",
      VERCEL_PROJECT_PRODUCTION_URL: "production.example.test",
    };
    expect(resolvePdcReportEndpointUrl(preview)).toBe("https://preview-abc.example.test/api/pdc-report");
    expect(resolvePdcReportEndpointUrl({
      VERCEL_ENV: "preview",
      VERCEL_URL: "preview-abc.example.test",
      VERCEL_PROJECT_PRODUCTION_URL: "production.example.test",
    })).toBe("https://preview-abc.example.test/api/pdc-report");
    expect(resolvePdcReportEndpointUrl({
      ...preview,
      PDC_REPORT_URL: "https://production.example.test/api/pdc-report",
    })).toBeUndefined();
    expect(resolvePdcReportEndpointUrl({
      ...preview,
      PDC_REPORT_URL: "https://preview-abc.example.test/api/pdc-report",
    })).toBe("https://preview-abc.example.test/api/pdc-report");
    expect(resolvePdcReportEndpointUrl({ VERCEL: "1", VERCEL_ENV: "development", VERCEL_URL: "preview.example.test" })).toBeUndefined();
  });
  it("routes the owner's PDC command to signed continuation jobs, not the old partial reader", async () => {
    const dispatch = vi.fn(async (): Promise<void> => {});
    const getUpcomingReportForDate = vi.fn(async (): Promise<PdcUpcomingReport> => report([]));
    const apiFetch = vi.fn<typeof fetch>(async (): Promise<Response> => Response.json({ ok: true, result: { message_id: 77, date: 1, chat: { id: 1, type: "private" }, text: "status" } }));
    const bot = createBot({ token: "123456:test-token", allowedUserId: 1, statsService: { getPlayerStats: async (name: string): Promise<PdcPlayerStats> => stats(name) }, logger: noopLogger, apiFetch,
      botInfo: { id: 123456, is_bot: true, first_name: "Bot", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
      pdcJobDispatcher: { dispatch }, pdcTournamentService: { getUpcomingReportForDate, getLatestResults: async () => [] },
    });
    const update: Update = { update_id: 1, message: { message_id: 1, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, text: "/pdc today", entities: [{ type: "bot_command", offset: 0, length: 4 }] } };
    await bot.handleUpdate(update);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ cursor: 0, acknowledgementMessageId: 77 }));
    expect(getUpcomingReportForDate).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await bot.handleUpdate({ ...update, update_id: 2, message: { ...update.message!, from: { id: 2, is_bot: false, first_name: "Other" } } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("bundles fonts and Linux native renderer for the new 300-second endpoint", () => {
    const config: unknown = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    if (typeof config !== "object" || config === null || !("functions" in config)) throw new Error("Missing functions config");
    const functions: unknown = config.functions;
    if (typeof functions !== "object" || functions === null || !("api/pdc-report.ts" in functions)) throw new Error("Missing PDC job config");
    const entry: unknown = functions["api/pdc-report.ts"];
    if (typeof entry !== "object" || entry === null || !("includeFiles" in entry) || typeof entry.includeFiles !== "string") throw new Error("Invalid include glob");
    expect(entry).toHaveProperty("maxDuration", 300);
    expect(matchesGlob("public/fonts/noto-sans.ttf", entry.includeFiles)).toBe(true);
    expect(matchesGlob("node_modules/@resvg/resvg-js-linux-x64-gnu/resvgjs.linux-x64-gnu.node", entry.includeFiles)).toBe(true);
  });
});

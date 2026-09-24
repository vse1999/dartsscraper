import { describe, expect, it, vi } from "vitest";

import { handleModusReportCommand, parseModusReportCommand } from "../src/telegram/modus-command.js";
import { resolveModusReportEndpointUrl } from "../src/telegram/bot.js";
import { createHttpModusReportTrigger } from "../src/telegram/modus-trigger.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

describe("manual MODUS Telegram command", () => {
  it("accepts today, tomorrow, and defaults to tomorrow", () => {
    expect(parseModusReportCommand("/modus today")).toBe("today");
    expect(parseModusReportCommand("/modus tomorrow")).toBe("tomorrow");
    expect(parseModusReportCommand("/modus@darts_bot")).toBe("tomorrow");
    expect(parseModusReportCommand("/modus next-week")).toBeNull();
  });

  it("acknowledges the command and triggers the separate report endpoint", async () => {
    const replies: string[] = [];
    const start = vi.fn(async (): Promise<void> => undefined);

    const outcome = await handleModusReportCommand(
      "/modus today",
      { start },
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
    );

    expect(outcome).toBe("started");
    expect(start).toHaveBeenCalledWith("today");
    expect(replies).toEqual(["🎯 Starting MODUS today report…"]);
  });

  it("reports trigger failures without throwing through Telegram", async () => {
    const replies: string[] = [];
    const outcome = await handleModusReportCommand(
      "/modus tomorrow",
      { start: async (): Promise<void> => { throw new Error("endpoint unavailable"); } },
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
    );

    expect(outcome).toBe("failed");
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("could not be completed");
  });

  it("returns immediately while a scheduled report continues in the background", async () => {
    let finishTrigger: (() => void) | undefined;
    const triggerFinished = new Promise<void>((resolve: () => void): void => { finishTrigger = resolve; });
    const scheduled: Promise<void>[] = [];
    const replies: string[] = [];

    const outcome = await handleModusReportCommand(
      "/modus today",
      { start: async (): Promise<void> => triggerFinished },
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
      (task: Promise<void>): void => { scheduled.push(task); },
    );

    expect(outcome).toBe("started");
    expect(replies).toEqual(["🎯 Starting MODUS today report…"]);
    expect(scheduled).toHaveLength(1);
    finishTrigger?.();
    await scheduled[0];
  });

  it("uses the authenticated endpoint and forwards the selected date", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      status: "succeeded",
      date: "2026-09-11",
      players: 6,
      succeeded: 6,
      failed: 0,
      discoverySucceeded: true,
      outcome: {
        status: "succeeded",
        discovery: { status: "succeeded", playersDiscovered: 6, fixturesDiscovered: 3, warnings: [] },
        data: { status: "complete", attempted: 6, succeeded: 6, failed: 0 },
        delivery: { status: "complete", attempted: 1, succeeded: 1, failed: 0, failures: [] },
      },
    }), { status: 200 }));
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch,
    });

    await trigger.start("tomorrow");

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [request, init] = apiFetch.mock.calls[0] ?? [];
    expect(String(request)).toBe("https://example.test/api/daily-modus-report?date=tomorrow");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"s".repeat(32)}`);
  });

  it("rejects a report response that explicitly reports a partial outcome", async () => {
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch: async (): Promise<Response> => new Response(JSON.stringify({
        ok: false,
        status: "partial",
        date: "2026-09-11",
        players: 2,
        succeeded: 1,
        failed: 1,
        discoverySucceeded: true,
        outcome: {
          status: "partial",
          discovery: { status: "succeeded", playersDiscovered: 2, fixturesDiscovered: 1, warnings: [] },
          data: { status: "partial", attempted: 2, succeeded: 1, failed: 1 },
          delivery: { status: "complete", attempted: 1, succeeded: 1, failed: 0, failures: [] },
        },
      }), { status: 200 }),
    });

    await expect(trigger.start("today")).rejects.toThrow("reported status partial");
  });

  it("preserves the report status when the endpoint returns a gateway failure", async () => {
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch: async (): Promise<Response> => new Response(JSON.stringify({ ok: false, status: "failed" }), { status: 502 }),
    });

    await expect(trigger.start("today")).rejects.toThrow("reported status failed (HTTP 502)");
  });

  it("rejects a success payload with no players or delivery attempts", async () => {
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch: async (): Promise<Response> => new Response(JSON.stringify({
        ok: true,
        status: "succeeded",
        date: "2026-09-11",
        players: 0,
        succeeded: 0,
        failed: 0,
        discoverySucceeded: true,
        outcome: {
          status: "succeeded",
          discovery: { status: "succeeded", playersDiscovered: 0, fixturesDiscovered: 0, warnings: [] },
          data: { status: "complete", attempted: 0, succeeded: 0, failed: 0 },
          delivery: { status: "complete", attempted: 0, succeeded: 0, failed: 0, failures: [] },
        },
      }), { status: 200 }),
    });

    await expect(trigger.start("today")).rejects.toThrow("unexpected response");
  });

  it("uses the stable production URL instead of the protected deployment URL", () => {
    expect(resolveModusReportEndpointUrl({
      VERCEL_PROJECT_PRODUCTION_URL: "dartsscraper.vercel.app",
    })).toBe("https://dartsscraper.vercel.app/api/daily-modus-report");
    expect(resolveModusReportEndpointUrl({
      MODUS_REPORT_URL: "https://custom.example/api/report",
      VERCEL_PROJECT_PRODUCTION_URL: "dartsscraper.vercel.app",
    })).toBe("https://custom.example/api/report");
  });

  it("rejects a protected deployment login page even when it returns HTTP 200", async () => {
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch: async (): Promise<Response> => new Response("<html>Sign in</html>", { status: 200 }),
    });

    await expect(trigger.start("today")).rejects.toThrow("unexpected response");
  });

  it("bounds a stalled report endpoint request", async () => {
    const apiFetch: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject): void => {
        init?.signal?.addEventListener("abort", (): void => reject(new Error("aborted")), { once: true });
      });
    };
    const trigger = createHttpModusReportTrigger({
      endpointUrl: "https://example.test/api/daily-modus-report",
      cronSecret: "s".repeat(32),
      apiFetch,
      timeoutMs: 5,
    });

    await expect(trigger.start("today")).rejects.toThrow("timed out after 5ms");
  });
});

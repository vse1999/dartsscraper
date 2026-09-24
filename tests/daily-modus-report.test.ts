import { describe, expect, it } from "vitest";

import { handleDailyModusReport, readCronSecret } from "../api/daily-modus-report.js";
import type { Logger } from "../src/logger.js";
import type { ModusReportOutcome } from "../src/daily/modus-report.js";

const secret = "c".repeat(64);
const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function outcomeFor(
  status: ModusReportOutcome["status"],
  players: number,
  succeeded: number,
  failed: number,
): ModusReportOutcome {
  const discoveryStatus = status === "succeeded" ? "succeeded" : "partial";
  const dataStatus = status === "succeeded" ? "complete" : "partial";
  const deliveryStatus = status === "succeeded" ? "complete" : "partial";
  return {
    status,
    discovery: { status: discoveryStatus, playersDiscovered: players, fixturesDiscovered: 0, warnings: [] },
    data: { status: dataStatus, attempted: players, succeeded, failed },
    delivery: { status: deliveryStatus, attempted: 1, succeeded: status === "succeeded" ? 1 : 0, failed: status === "succeeded" ? 0 : 1, failures: status === "succeeded" ? [] : [{ stage: "overview", failureCode: "TELEGRAM_OVERVIEW_SEND_FAILED" }] },
  };
}

describe("daily MODUS report cron boundary", () => {
  it("rejects an unauthorized cron call without executing the job", async () => {
    let executions = 0;
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report", { method: "GET", headers: { authorization: "Bearer wrong" } }),
      { expectedSecret: secret, execute: async () => { executions += 1; throw new Error("must not run"); }, logger },
    );

    expect(response.status).toBe(401);
    expect(executions).toBe(0);
  });

  it("executes an authorized cron call and returns a compact result", async () => {
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      {
        expectedSecret: secret,
        execute: async () => ({ date: "2026-09-11", players: ["A"], results: [{ player: "A", status: "succeeded" }], discoverySucceeded: true, outcome: outcomeFor("succeeded", 1, 1, 0) }),
        logger,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, date: "2026-09-11", players: 1, succeeded: 1, failed: 0 });
  });

  it("forwards an authorized manual today selector to the report", async () => {
    let requestedDate: string | undefined;
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report?date=today", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      {
        expectedSecret: secret,
        execute: async (date) => {
          requestedDate = date;
          return { date: "2026-09-10", players: [], results: [], discoverySucceeded: false, outcome: outcomeFor("failed", 0, 0, 0) };
        },
        logger,
      },
    );

    expect(response.status).toBe(502);
    expect(requestedDate).toBe("today");
  });

  it("returns ok false and the complete outcome for a partial report", async () => {
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      {
        expectedSecret: secret,
        execute: async () => ({
          date: "2026-09-11",
          players: ["A", "B"],
          results: [{ player: "A", status: "succeeded" }, { player: "B", status: "failed", error: "PLAYER_NOT_FOUND" }],
          discoverySucceeded: true,
          outcome: outcomeFor("partial", 2, 1, 1),
        }),
        logger,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "partial", succeeded: 1, failed: 1, outcome: { status: "partial" } });
  });

  it("returns a gateway failure for a report that produced no player data", async () => {
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      {
        expectedSecret: secret,
        execute: async () => ({
          date: "2026-09-11",
          players: ["A"],
          results: [{ player: "A", status: "failed", error: "PLAYER_NOT_FOUND" }],
          discoverySucceeded: true,
          outcome: {
            ...outcomeFor("failed", 1, 0, 1),
            discovery: { status: "succeeded", playersDiscovered: 1, fixturesDiscovered: 0, warnings: [] },
            data: { status: "failed", attempted: 1, succeeded: 0, failed: 1 },
            delivery: { status: "complete", attempted: 1, succeeded: 1, failed: 0, failures: [] },
          },
        }),
        logger,
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "failed", outcome: { data: { status: "failed" } } });
  });

  it("returns a gateway failure when an empty-roster warning cannot be delivered", async () => {
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      {
        expectedSecret: secret,
        execute: async () => ({
          date: "2026-09-11",
          players: [],
          results: [],
          discoverySucceeded: false,
          outcome: {
            status: "failed" as const,
            discovery: { status: "empty" as const, playersDiscovered: 0, fixturesDiscovered: 0, warnings: [] },
            data: { status: "empty" as const, attempted: 0, succeeded: 0, failed: 0 },
            delivery: {
              status: "failed" as const,
              attempted: 3,
              succeeded: 0,
              failed: 3,
              failures: [
                { stage: "header" as const, failureCode: "TELEGRAM_HEADER_SEND_FAILED" },
                { stage: "warning" as const, failureCode: "TELEGRAM_WARNING_SEND_FAILED" },
                { stage: "summary" as const, failureCode: "TELEGRAM_SUMMARY_SEND_FAILED" },
              ],
            },
          },
        }),
        logger,
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "failed", outcome: { delivery: { status: "failed" } } });
  });

  it("rejects unsupported manual date selectors", async () => {
    const response = await handleDailyModusReport(
      new Request("https://example.test/api/daily-modus-report?date=next-week", { method: "GET", headers: { authorization: `Bearer ${secret}` } }),
      { expectedSecret: secret, execute: async () => { throw new Error("must not run"); }, logger },
    );

    expect(response.status).toBe(400);
  });

  it("validates the cron secret", () => {
    expect(readCronSecret({ CRON_SECRET: secret })).toBe(secret);
    expect(() => readCronSecret({ CRON_SECRET: "short" })).toThrow("CRON_SECRET");
  });
});

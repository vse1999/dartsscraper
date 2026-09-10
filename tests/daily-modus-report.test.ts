import { describe, expect, it } from "vitest";

import { handleDailyModusReport, readCronSecret } from "../api/daily-modus-report.js";
import type { Logger } from "../src/logger.js";

const secret = "c".repeat(64);
const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

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
        execute: async () => ({ date: "2026-09-11", players: ["A"], results: [{ player: "A", status: "succeeded" }], discoverySucceeded: true }),
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
          return { date: "2026-09-10", players: [], results: [], discoverySucceeded: true };
        },
        logger,
      },
    );

    expect(response.status).toBe(200);
    expect(requestedDate).toBe("today");
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

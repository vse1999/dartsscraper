import { describe, expect, it, vi } from "vitest";

import { handleModusReportCommand, parseModusReportCommand } from "../src/telegram/modus-command.js";
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
    expect(replies[1]).toContain("could not be started");
  });

  it("uses the authenticated endpoint and forwards the selected date", async () => {
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
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
});

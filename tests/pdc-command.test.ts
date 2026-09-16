import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logger.js";
import { handlePdcReportCommand, parsePdcReportCommand } from "../src/telegram/pdc-command.js";
import { PdcTournamentResultSchema, type PdcTournamentResult } from "../src/pdc/schemas.js";
import type { PdcUpcomingReport } from "../src/pdc/service.js";

const logger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function result(): PdcTournamentResult {
  return PdcTournamentResultSchema.parse({
    event: {
      eventKey: 8022,
      tournamentKey: 5,
      tournamentName: "European Tour",
      tournamentNumber: 12,
      category: "ET",
      eventDate: "2026-09-06",
      startDate: "2026-09-06",
      endDate: "2026-09-06",
      eventAverage: 93.47,
      winnerAverage: 101.73,
      winnerName: "Luke Littler",
      winnerPlayerId: 5403,
      calendarUrl: "https://dartsorakel.com/api/events?year=2026&organCal=PDCE",
      resultsUrl: "https://dartsorakel.com/events/result/8022/2026-european-tour",
    },
    matches: [{
      matchId: 565570,
      round: "Final",
      winnerName: "Luke Littler",
      winnerPlayerId: 5403,
      loserName: "Luke Humphries",
      loserPlayerId: 34,
      winnerScore: 8,
      loserScore: 6,
      sourceUrl: "https://dartsorakel.com/match/stats/565570",
    }],
    sourceUrl: "https://dartsorakel.com/events/result/8022/2026-european-tour",
  });
}

describe("PDC Telegram command", () => {
  it("parses the supported date expressions without changing MODUS command semantics", () => {
    expect(parsePdcReportCommand("/pdc today")).toBe("today");
    expect(parsePdcReportCommand("/pdc tomorrow")).toBe("tomorrow");
    expect(parsePdcReportCommand("/pdc@darts_bot")).toBe("tomorrow");
    expect(parsePdcReportCommand("/pdc latest")).toBe("latest");
    expect(parsePdcReportCommand("/pdc next-week")).toBeNull();
  });

  it("scans the independent PDC service and sends formatted tournament evidence", async () => {
    const replies: string[] = [];
    const tournamentResult = result();
    const reader = {
      getUpcomingReportForDate: vi.fn(async (): Promise<PdcUpcomingReport> => ({ date: "2026-09-13", fixtures: [], players: [] })),
      getLatestResults: vi.fn(async (): Promise<readonly PdcTournamentResult[]> => [tournamentResult]),
    };

    const outcome = await handlePdcReportCommand(
      "/pdc latest",
      reader,
      (): string => "2026-09-13",
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
    );

    expect(outcome).toBe("success");
    expect(reader.getLatestResults).toHaveBeenCalledWith("2026-09-13");
    expect(reader.getUpcomingReportForDate).not.toHaveBeenCalled();
    expect(replies[0]).toContain("Scanning PDC latest");
    expect(replies.join("\n")).toContain("European Tour 12");
    expect(replies.join("\n")).toContain("https://dartsorakel.com/events/result/8022/2026-european-tour");
  });

  it("does not expose upstream failure details to Telegram", async () => {
    const replies: string[] = [];
    const outcome = await handlePdcReportCommand(
      "/pdc today",
      { getUpcomingReportForDate: async (): Promise<PdcUpcomingReport> => { throw new Error("secret upstream detail"); }, getLatestResults: async (): Promise<readonly PdcTournamentResult[]> => [] },
      (): string => "2026-09-13",
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
    );

    expect(outcome).toBe("failed");
    expect(replies.join("\n")).not.toContain("secret upstream detail");
    expect(replies.at(-1)).toContain("could not be completed");
  });

  it("uses the upcoming fixture pipeline for tomorrow and includes last-10 player form", async () => {
    const replies: string[] = [];
    const report: PdcUpcomingReport = {
      date: "2026-09-17",
      fixtures: [{
        id: "pdpa:1",
        tournamentName: "World Series of Darts Finals 2026",
        date: "2026-09-17",
        startTime: null,
        session: "19:00 CEST",
        round: "Round One x8",
        playerOne: "Rob Cross",
        playerTwo: "Ryan Searle",
        sourceUrl: "https://pdpa.co.uk/event/world-series-of-darts-finals-2026/",
      }],
      players: [],
    };
    const reader = {
      getUpcomingReportForDate: vi.fn(async (): Promise<PdcUpcomingReport> => report),
      getLatestResults: vi.fn(async (): Promise<readonly PdcTournamentResult[]> => []),
    };

    const outcome = await handlePdcReportCommand(
      "/pdc tomorrow",
      reader,
      (): string => "2026-09-17",
      { reply: async (text: string): Promise<void> => { replies.push(text); } },
      logger,
    );

    expect(outcome).toBe("success");
    expect(reader.getUpcomingReportForDate).toHaveBeenCalledWith("2026-09-17");
    expect(reader.getLatestResults).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("Rob Cross vs Ryan Searle");
    expect(replies.join("\n")).toContain("World Series of Darts Finals 2026");
  });
});

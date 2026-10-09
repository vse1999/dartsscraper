import { describe, expect, it, vi } from "vitest";
import { runModusReport } from "../src/daily/modus-report.js";
import { createBot } from "../src/telegram/bot.js";
import { handlePdcReportCommand } from "../src/telegram/pdc-command.js";
import { noopLogger } from "../src/logger.js";
import type { PlayerStatsResult } from "../src/telegram/stats-service.js";
import type { ImageReport } from "../src/telegram/report-image.js";

function stats(playerName: string): PlayerStatsResult {
  return { playerName, requestedCount: 10, matches: [{ date: "2026-09-01", tournament: "Test", round: null, result: "Won", opponent: "Other", score: "4 V 2", average: 90, oneEighties: 1, checkoutPercentage: 50, checkoutHits: 2, checkoutAttempts: 4 }], meanAverage: 90, availableAverageCount: 1,
    sourceUrl: "https://dartsorakel.com/player/details/1/test", sourceLabel: "DartsOrakel", provider: "dartsorakel", evidenceUrls: [] };
}
describe("image report integration", () => {
  it("routes MODUS fixtures through the image sender and preserves outcome/keyboard", async () => {
    const sendReport = vi.fn(async (_chat: number | string, _report: ImageReport): Promise<void> => undefined);
    const sendMessage = vi.fn(async (): Promise<void> => undefined);
    const result = await runModusReport({ date: "2026-09-11", matchCount: 10, chatId: 123, dependencies: {
      modusPlayersService: { getModusPlayers: async () => ({ date: "2026-09-11", event: "MODUS Super Series", players: [] }), getModusFixtures: async () => ({ date: "2026-09-11", event: "MODUS Super Series", fixtures: [{ id: "f", date: "2026-09-11", event: "MODUS Super Series", startTime: null, playerOne: "Alpha", playerTwo: "Beta", source: "https://example.test/fixture" }] }) },
      playerStatsService: { getPlayerStats: async (name: string): Promise<PlayerStatsResult> => stats(name) },
      telegram: { imagesEnabled: true, sendReport, sendMessage }, logger: noopLogger,
    } });
    expect(sendReport).toHaveBeenCalledTimes(1); expect(sendMessage).not.toHaveBeenCalled();
    expect(sendReport.mock.calls[0]?.[1].text).toContain("Warning: incomplete"); expect(result.outcome.delivery.succeeded).toBe(1);
    expect(sendReport).toHaveBeenCalledWith(123, expect.objectContaining({ card: expect.objectContaining({ title: "Alpha vs Beta" }) }), expect.objectContaining({ replyMarkup: expect.objectContaining({ inline_keyboard: expect.any(Array) }), signal: expect.any(AbortSignal) }));
  });
  it("sends PDC image comparisons and source evidence instead of duplicate raw histories", async () => {
    const images: ImageReport[] = []; const text: string[] = [];
    const outcome = await handlePdcReportCommand("/pdc today", {
      getUpcomingReportForDate: async () => ({ date: "2026-09-11", fixtures: [{ id: "f", date: "2026-09-11", tournamentName: "PDC Test", round: null, session: null, startTime: null, playerOne: "Alpha", playerTwo: "Beta", sourceUrl: "https://example.test/fixture" }],
        players: [{ requestedName: "Alpha", stats: stats("Alpha"), failureCode: null }, { requestedName: "Beta", stats: null, failureCode: "unstarted" }] }),
      getLatestResults: async () => [],
    }, () => "2026-09-11", { reply: async (value: string): Promise<void> => { text.push(value); }, replyReport: async (report: ImageReport): Promise<void> => { images.push(report); } }, noopLogger);
    expect(outcome).toBe("success"); expect(images).toHaveLength(1); expect(images[0]?.text).toContain("report research is incomplete");
    expect(images[0]?.text).toContain("Beta form unavailable"); expect(text.join("\n")).toContain("Schedule source:"); expect(text.join("\n")).not.toContain("Observed scope");
  });
  it("serves personal image reports only to the owner, through the real bot adapter", async () => {
    const getPlayerStats = vi.fn(async (name: string): Promise<PlayerStatsResult> => stats(name));
    const apiFetch = vi.fn<typeof fetch>().mockImplementation(async (): Promise<Response> => Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 123, type: "private" }, text: "ok" } }));
    const bot = createBot({ token: "123456:abcdefghijklmnopqrstuvwxyz_123456", allowedUserId: 123, imagesEnabled: true, statsService: { getPlayerStats }, apiFetch,
      logger: noopLogger, botInfo: { id: 456, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: { id: 999, is_bot: false, first_name: "Other" }, chat: { id: 999, type: "private", first_name: "Other" }, text: "Alpha last 10 matches" } });
    expect(apiFetch).not.toHaveBeenCalled(); expect(getPlayerStats).not.toHaveBeenCalled();
    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 0, from: { id: 123, is_bot: false, first_name: "Owner" }, chat: { id: 123, type: "private", first_name: "Owner" }, text: "Alpha last 10 matches" } });
    expect(getPlayerStats).toHaveBeenCalledTimes(1); expect(apiFetch.mock.calls.some(call => String(call[0]).includes("sendPhoto"))).toBe(true);
    expect(apiFetch.mock.calls.some(call => String(call[0]).includes("editMessageText"))).toBe(true);
  });
});

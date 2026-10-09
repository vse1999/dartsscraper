import { describe, expect, it, vi } from "vitest";
import { analyzeMatchup, type MatchupPlayerHistory } from "../src/services/matchup-analysis.js";
import { calculateMatchSummary } from "../src/services/statistics.js";
import { matchupImageReport, playerImageReports, limitImageReports } from "../src/telegram/image-report-model.js";
import { renderReportImage, renderReportSvg, reportImagesEnabled, type ReportImageCard } from "../src/telegram/report-image.js";
import { createTelegramSender } from "../src/telegram/sender.js";
import { createTelegramDeliveryPolicy } from "../src/telegram/delivery-policy.js";
import type { PlayerStatsResult } from "../src/telegram/stats-service.js";

function history(name: string, average: number = 90): MatchupPlayerHistory {
  return { playerName: name, requestedCount: 10, matches: Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(20 - i).padStart(2, "0")}`, tournament: "Test", round: null, result: "Won", opponent: "Other Player", score: "4 V 2", average, oneEighties: 1, checkoutHits: 2, checkoutAttempts: 4, checkoutPercentage: 50 })) };
}
function report(): ReturnType<typeof matchupImageReport> {
  return matchupImageReport(analyzeMatchup({ id: "test", date: "2026-10-08", startTime: null, playerOne: "Alpha", playerTwo: "Beta" }, history("Alpha"), history("Beta", 85), 10), "Test · 8 Oct", true);
}
function stats(): PlayerStatsResult {
  const h = history("Alpha"); const summary = calculateMatchSummary(h.matches);
  return { playerName: h.playerName, requestedCount: 10, matches: h.matches, meanAverage: summary.average, availableAverageCount: 10, sourceUrl: "https://dartsorakel.com/player/details/1/alpha", sourceLabel: "DartsOrakel", provider: "dartsorakel", evidenceUrls: [] };
}
function sender(apiFetch: typeof fetch, renderImage?: (card: ReportImageCard, signal?: AbortSignal) => Promise<Buffer>): ReturnType<typeof createTelegramSender> {
  return createTelegramSender({ token: "123456:abcdefghijklmnopqrstuvwxyz_123456", imagesEnabled: true, apiFetch, deliveryPolicy: createTelegramDeliveryPolicy({ minIntervalMs: 1 }), ...(renderImage === undefined ? {} : { renderImage }) });
}
describe("production image reports", () => {
  it("renders successive pages using the same report deadline signal", async () => {
    const card = report().card; if (card === undefined) throw new Error("Missing test card");
    const signal = AbortSignal.timeout(10_000);
    for (let i = 0; i < 3; i += 1) expect((await renderReportImage(card, signal)).length).toBeGreaterThan(1000);
  });
  it("renders a real PNG without browser, system fonts or external images", async () => {
    const card = report().card; if (card === undefined) throw new Error("Missing test card");
    const png = await renderReportImage(card);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.length).toBeLessThan(1_000_000);
    expect(renderReportSvg(card)).toContain("Warning: report research is incomplete.");
  });
  it("escapes hostile names and wraps long names without external SVG content", () => {
    const card = report().card; if (card === undefined) throw new Error("Missing test card");
    const svg = renderReportSvg({ ...card, title: '<image href="https://evil.test"/> & Player', columns: ["Very long canonical player name", "Beta"] });
    expect(svg).not.toContain("<image"); expect(svg).toContain("&lt;image"); expect(svg).toContain("&amp;");
    expect(svg).not.toContain("foreignObject");
  });
  it("preserves unavailable form and metrics, and never replaces them with zero", () => {
    const r = matchupImageReport(analyzeMatchup({ id: "x", date: "2026-10-08", startTime: null, playerOne: "A", playerTwo: "B" }, undefined, undefined, 10), "Test");
    expect(r.text).toContain("Insufficient data"); expect(r.text).toContain("form unavailable"); expect(r.card?.rows[0]?.values).toEqual(["Unavailable", "Unavailable"]);
  });
  it("places ten personal matches in one aligned image with a complete text fallback", () => {
    const rows = playerImageReports(stats()); expect(rows).toHaveLength(1);
    expect(rows[0]?.card?.matchTable).toHaveLength(10);
    expect(rows[0]?.caption).not.toContain("Page"); expect(rows[0]?.text).toContain("10."); expect(rows.every(r => r.text.length > 0 && r.text.length < 4096)).toBe(true);
    expect(rows[0]?.text).toContain("20/40 hits/attempts");
    const input = stats();
    const unknown = playerImageReports({ ...input, matches: input.matches.map((match, index) => index === 0 ? { ...match, result: "Unclassified" } : match) });
    expect(unknown[0]?.text).toContain("1 results could not be classified");
  });
  it("keeps twenty-match requests as two complete ten-row images, including long names and context", async () => {
    const input = stats();
    const rows = playerImageReports({ ...input, requestedCount: 20, matches: [...input.matches, ...input.matches].map((match, index) => ({ ...match, opponent: index === 9 ? "Dimitri van den Bergh" : match.opponent, tournament: "World Series of Darts Finals", round: "Last 32" })) });
    expect(rows).toHaveLength(2); expect(rows.every(r => r.card?.matchTable?.length === 10)).toBe(true);
    const card = rows[0]?.card; if (card === undefined) throw new Error("Missing card");
    const text = [...renderReportSvg(card).matchAll(/<text[^>]*>([^<]*)<\/text>/gu)].map(match => match[1] ?? "").join(" ");
    expect(text).toContain("Dimitri van den Bergh");
    expect(renderReportSvg(card)).toContain("World Series of Darts Finals");
    expect((await renderReportImage(card)).length).toBeLessThan(1_000_000);
  });
  it("caps images, not fixtures; remaining reports retain their text", () => {
    const rows = limitImageReports(Array.from({ length: 40 }, (_, index) => ({ ...report(), text: `Fixture ${index}\n${report().text}` })));
    expect(rows.filter(r => r.card !== undefined)).toHaveLength(25); expect(rows.length).toBeLessThan(40);
    for (let i = 0; i < 40; i += 1) expect(rows.map(r => r.text).join("\n")).toContain(`Fixture ${i}\n`);
  });
  it("validates the kill switch and card size before rasterization", () => {
    expect(reportImagesEnabled({})).toBe(true); expect(reportImagesEnabled({ REPORT_IMAGES_ENABLED: "false" })).toBe(false);
    expect(() => reportImagesEnabled({ REPORT_IMAGES_ENABLED: "TRUE" })).toThrow();
    const card = report().card; if (card === undefined) throw new Error("Missing test card");
    expect(() => renderReportSvg({ ...card, title: "a".repeat(513) })).toThrow();
  });
  it("sends multipart photos with keyboard, caption and paid broadcast explicitly off", async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: {} }));
    const s = sender(api, async (): Promise<Buffer> => Buffer.from("png"));
    await s.sendReport?.(123, report(), { replyMarkup: { inline_keyboard: [[{ text: "Alpha", callback_data: "modus-player:0:10" }]] } });
    expect(String(api.mock.calls[0]?.[0])).toContain("sendPhoto");
    const body = api.mock.calls[0]?.[1]?.body; expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart");
    expect(body.get("allow_paid_broadcast")).toBe("false"); expect(body.get("reply_markup")).toContain("modus-player");
  });
  it("falls back on rendering failure or definitive HTTP400 rejection", async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: {} }));
    const s = sender(api, async (): Promise<Buffer> => { throw new Error("Font failed"); });
    await s.sendReport?.(123, report()); expect(String(api.mock.calls[0]?.[0])).toContain("sendMessage");
    const rejected = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValue(Response.json({ ok: true, result: {} }));
    await sender(rejected, async (): Promise<Buffer> => Buffer.from("png")).sendReport?.(123, report()); expect(rejected).toHaveBeenCalledTimes(2);
  });
  it("does not retry or fall back after ambiguous network delivery or cancellation", async () => {
    const api = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unknown delivery"));
    const s = sender(api, async (): Promise<Buffer> => Buffer.from("png"));
    await expect(s.sendReport?.(123, report())).rejects.toThrow(); expect(api).toHaveBeenCalledTimes(1);
    const aborted = new AbortController(); aborted.abort();
    await expect(s.sendReport?.(123, report(), { signal: aborted.signal })).rejects.toThrow(); expect(api).toHaveBeenCalledTimes(1);
  });
  it("retries explicit429 using the shared delivery policy", async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })).mockResolvedValue(Response.json({ ok: true, result: {} }));
    await sender(api, async (): Promise<Buffer> => Buffer.from("png")).sendReport?.(123, report()); expect(api).toHaveBeenCalledTimes(2);
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createDefaultBulkPlayerStatsService, type PlayerStatsResult } from "../src/telegram/stats-service.js";
import { noopLogger } from "../src/logger.js";
import { analyzeMatchup, type MatchupAnalysis } from "../src/services/matchup-analysis.js";
import { readBotConfiguration } from "../src/telegram/bot.js";
import { createReportLayouts, parseLabAnalyses, renderReportImageHtml } from "./report-layouts.js";
import { formatModusMatchupMessages } from "../src/telegram/modus-matchup-formatter.js";

const output = join(process.cwd(), ".tmp", "report-layout-lab");
await mkdir(output, { recursive: true });
const mode = process.argv[2] ?? "collect";
const samplePath = join(output, "live-data.json");

async function telegram(method: string, payload: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  process.loadEnvFile(".env.local");
  const config = readBotConfiguration(process.env);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.allowedUserId, disable_notification: true, ...payload }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error("Telegram test request failed; no automatic retry was attempted."); }
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new Error("Invalid Telegram response.");
  const body = value as Record<string, unknown>;
  if (!response.ok || body.ok !== true) throw new Error(`Telegram test ${method} rejected (HTTP ${response.status}): ${typeof body.description === "string" ? body.description.replaceAll(config.token, "[redacted]") : "unknown reason"}`);
  const result = body.result;
  if (typeof result !== "object" || result === null) throw new Error("Missing Telegram result.");
  return result as Record<string, unknown>;
}

if (mode === "collect") {
  const service = createDefaultBulkPlayerStatsService(noopLogger);
  const names = ["Niek Tuik", "Danny Lauby", "William Borland", "Danny Trueman"];
  const histories: PlayerStatsResult[] = [];
  for (const name of names) {
    histories.push(await service.getPlayerStats(name, 10, "dartsorakel", AbortSignal.timeout(180_000)));
    console.log(JSON.stringify({ collected: name, matches: histories.at(-1)?.matches.length }));
  }
  const analyses: MatchupAnalysis[] = [];
  for (let index = 0; index < histories.length; index += 2) {
    const a = histories[index]; const b = histories[index + 1];
    if (a === undefined || b === undefined) throw new Error("Incomplete comparison pair.");
    analyses.push(analyzeMatchup({ id: `layout-test-${index}`, date: "2026-10-08", startTime: null, playerOne: a.playerName, playerTwo: b.playerName }, a, b, 10));
  }
  await writeFile(samplePath, JSON.stringify({ observedAt: new Date().toISOString(), scope: "Presentation comparisons only; scheduled fixtures not verified", histories, analyses }, null, 2));
  console.log("Live source sample saved. No Telegram messages sent during collection.");
} else if (mode === "send") {
  const index = Number(process.argv[3] ?? 0);
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("Select text approach 0–3.");
  const raw: unknown = JSON.parse(await readFile(samplePath, "utf8"));
  const analysis = parseLabAnalyses(raw)[0];
  if (analysis === undefined) throw new Error("Missing live comparison.");
  const layout = createReportLayouts(analysis)[index];
  if (layout === undefined) throw new Error("Unknown approach.");
  const html = layout.method === "sendRichMessage" ? `<p><b>LAYOUT TEST · ${layout.label}</b></p>${layout.html}` : `<b>LAYOUT TEST · ${layout.label}</b>\nLast 10 matches · comparison, not schedule verification\n\n${layout.html}`;
  const payload = layout.method === "sendRichMessage" ? { rich_message: { html } } : { text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  const result = await telegram(layout.method, payload);
  const receipt = { approach: layout.id, method: layout.method, messageId: result.message_id, entities: result.entities, richMessageAccepted: result.rich_message !== undefined, deliveredAt: new Date().toISOString() };
  await writeFile(join(output, `${layout.id}-receipt.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} else if (mode === "summarize") {
  const raw: unknown = JSON.parse(await readFile(samplePath, "utf8"));
  const analyses = parseLabAnalyses(raw);
  const first = analyses[0];
  if (first === undefined) throw new Error("Missing sample.");
  const baseline = formatModusMatchupMessages({ date: "2026-10-08", dateLabel: "today", matchCount: 10, analyses: [first] }).join("\n");
  const summary = { baselineCharacters: baseline.length, baselineLines: baseline.split("\n").length,
    layouts: createReportLayouts(first).map(layout => ({ id: layout.id, payloadCharacters: layout.html.length })),
    comparisons: analyses.map(a => ({ players: [a.playerOne.player, a.playerTwo.player], signal: a.signal.code, averages: [a.playerOne.summary?.average, a.playerTwo.summary?.average] })) };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} else if (mode === "render-image") {
  const raw: unknown = JSON.parse(await readFile(samplePath, "utf8"));
  const analysis = parseLabAnalyses(raw)[0];
  if (analysis === undefined) throw new Error("Missing sample.");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 1000 }, deviceScaleFactor: 2 });
    await page.setContent(renderReportImageHtml(analysis));
    await page.locator("body").screenshot({ path: join(output, "visual-card.png") });
    console.log("Image card rendered from the live source sample.");
  } finally { await browser.close(); }
} else if (mode === "send-image" || mode === "edit-image") {
  process.loadEnvFile(".env.local");
  const config = readBotConfiguration(process.env);
  const form = new FormData();
  form.set("chat_id", String(config.allowedUserId)); form.set("disable_notification", "true");
  form.set("caption", "LAYOUT TEST · Visual image card\nSame live last-10 comparison; not a schedule verification or win prediction.");
  form.set("photo", new Blob([await readFile(join(output, "visual-card.png"))], { type: "image/png" }), "comparison.png");
  if (mode === "edit-image") {
    const receipt = z.object({ messageId: z.number().int().positive() }).parse(JSON.parse(await readFile(join(output, "image-receipt.json"), "utf8")) as unknown);
    form.set("message_id", String(receipt.messageId));
    form.set("media", JSON.stringify({ type: "photo", media: "attach://photo", caption: form.get("caption") }));
    form.delete("caption");
  }
  const method = mode === "edit-image" ? "editMessageMedia" : "sendPhoto";
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error("Telegram image upload failed; no ambiguous retry attempted."); }
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true) throw new Error(`Telegram image upload rejected (HTTP ${response.status}).`);
  const result: unknown = "result" in body ? body.result : undefined;
  if (typeof result !== "object" || result === null || !("message_id" in result)) throw new Error("Missing image receipt.");
  const receipt = { approach: "image", method, messageId: result.message_id, deliveredAt: new Date().toISOString() };
  await writeFile(join(output, "image-receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} else { throw new Error("Use collect, send <0–3>, render-image or send-image."); }

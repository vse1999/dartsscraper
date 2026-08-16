import { createDefaultPlayerStatsService } from "../src/telegram/stats-service.js";
import { formatPlayerStats, TELEGRAM_MAX_TEXT_LENGTH } from "../src/telegram/formatter.js";

const playerName = process.argv[2]?.trim() || "Jack Drayton";
const requestedCountText = process.argv[3]?.trim() || "10";
const requestedCount = Number(requestedCountText);
if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 20) {
  throw new Error("MODUS smoke match count must be an integer between 1 and 20.");
}

const startedAt = Date.now();
const result = await createDefaultPlayerStatsService().getPlayerStats(playerName, requestedCount);
if (result.provider !== "modus-official") {
  throw new Error(`${JSON.stringify(playerName)} did not resolve to the official MODUS source.`);
}
if (result.matches.length === 0 || result.evidenceUrls.length !== result.matches.length) {
  throw new Error("The official MODUS smoke result did not contain aligned matches and evidence URLs.");
}
for (const evidenceUrl of result.evidenceUrls) {
  const url = new URL(evidenceUrl);
  if (url.protocol !== "https:" || url.host !== "modussuperseries.com" || url.pathname !== "/match-db-stats.php") {
    throw new Error("The official MODUS smoke result contained a non-official evidence URL.");
  }
}
const telegramMessage = formatPlayerStats(result);
if (telegramMessage.length > TELEGRAM_MAX_TEXT_LENGTH) {
  throw new Error("The official MODUS smoke response exceeds Telegram's message limit.");
}

process.stdout.write(`${JSON.stringify({
  provider: result.provider,
  playerName: result.playerName,
  requestedCount,
  returnedCount: result.matches.length,
  availableAverageCount: result.availableAverageCount,
  newestMatch: result.matches[0],
  newestEvidenceUrl: result.evidenceUrls[0],
  telegramMessageLength: telegramMessage.length,
  durationMs: Date.now() - startedAt,
})}\n`);

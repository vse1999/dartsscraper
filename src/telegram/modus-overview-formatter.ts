import { calculateMatchSummary } from "../services/statistics.js";
import type { PlayerStatsResult } from "./stats-service.js";

import { TELEGRAM_MAX_TEXT_LENGTH } from "./formatter.js";

const MAX_PLAYER_NAME_LENGTH = 64;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ModusOverviewPlayer {
  readonly player: string;
  readonly status: "succeeded" | "failed";
  readonly stats?: PlayerStatsResult;
  readonly error?: string;
}

export interface ModusOverviewOptions {
  readonly date: string;
  readonly dateLabel: "today" | "tomorrow";
  readonly matchCount: number;
  readonly players: readonly string[];
  readonly results: readonly ModusOverviewPlayer[];
}

/**
 * Creates compact overview messages and only splits at player-row boundaries
 * when the Telegram message limit makes a single dashboard impossible.
 */
export function formatModusOverviewMessages(options: ModusOverviewOptions): readonly string[] {
  const rows = options.results.map(formatPlayerRow);
  const header = overviewHeader(options);
  const footer = overviewFooter(options);
  const messages: string[] = [];
  let currentRows: string[] = [];
  let currentHeader = header;

  for (const row of rows) {
    const candidate = joinOverviewMessage(currentHeader, currentRows.concat(row), "");
    if (currentRows.length > 0 && candidate.length > TELEGRAM_MAX_TEXT_LENGTH) {
      messages.push(joinOverviewMessage(currentHeader, currentRows, ""));
      currentRows = [row];
      currentHeader = continuationHeader(options);
      continue;
    }
    currentRows.push(row);
  }

  const finalMessage = joinOverviewMessage(currentHeader, currentRows, footer);
  if (finalMessage.length <= TELEGRAM_MAX_TEXT_LENGTH) {
    messages.push(finalMessage);
  } else if (currentRows.length > 0) {
    messages.push(joinOverviewMessage(currentHeader, currentRows, ""));
    messages.push(joinOverviewMessage(continuationHeader(options), [], footer));
  } else {
    throw new Error("MODUS overview header and footer exceed Telegram's message limit.");
  }

  return messages;
}

function overviewHeader(options: ModusOverviewOptions): string {
  const successful = options.results.find((result) => result.status === "succeeded" && result.stats !== undefined);
  const matchCount = successful?.stats?.requestedCount ?? options.matchCount;
  return [
    `🎯 MODUS ${options.dateLabel.toLocaleUpperCase("en-US")} · ${formatDate(options.date)}`,
    `${options.players.length} scheduled players`,
    `Form = last ${matchCount} completed DartsOrakel matches`,
    "",
    "PLAYER FORM",
  ].join("\n");
}

function continuationHeader(options: ModusOverviewOptions): string {
  return `🎯 MODUS ${options.dateLabel.toLocaleUpperCase("en-US")} · continued`;
}

function overviewFooter(options: ModusOverviewOptions): string {
  const succeeded = options.results.filter((result) => result.status === "succeeded").length;
  const failed = options.results
    .filter((result) => result.status === "failed")
    .map((result) => truncate(result.player, MAX_PLAYER_NAME_LENGTH));
  const visibleFailed = failed.slice(0, 10);
  const remainingFailed = failed.length - visibleFailed.length;
  const failedLabel = remainingFailed > 0
    ? `${visibleFailed.join(", ")}, +${remainingFailed} more`
    : visibleFailed.join(", ");
  return [
    `✅ Form available for ${succeeded}/${options.players.length} players`,
    ...(failed.length === 0 ? [] : [`⚠️ ${failed.length} player${failed.length === 1 ? "" : "s"} unavailable: ${failedLabel}`]),
    "",
    "👇 Tap a player below for detailed match statistics.",
  ].join("\n");
}

function formatPlayerRow(result: ModusOverviewPlayer): string {
  const player = truncate(result.player, MAX_PLAYER_NAME_LENGTH);
  if (result.status === "failed" || result.stats === undefined) {
    return `${player} — unavailable`;
  }

  const summary = calculateMatchSummary(result.stats.matches);
  const average = result.stats.meanAverage === null ? "—" : result.stats.meanAverage.toFixed(2);
  const record = `${summary.wins}W–${summary.losses}L${summary.draws === 0 ? "" : `–${summary.draws}D`}`;
  const oneEighties = summary.totalOneEighties === null ? "—" : `${summary.totalOneEighties}×180`;
  const checkout = summary.checkoutPercentage === null ? "—" : `${summary.checkoutPercentage.toFixed(2)}% checkout`;
  return `${player} — ${average} avg · ${record} · ${oneEighties} · ${checkout}`;
}

function joinOverviewMessage(header: string, rows: readonly string[], footer: string): string {
  return [header, ...rows, footer].filter((part) => part !== "").join("\n");
}

function formatDate(date: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (parts === null) return date;
  const month = MONTH_NAMES[Number(parts[2]) - 1];
  return month === undefined ? date : `${Number(parts[3])} ${month} ${parts[1]}`;
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

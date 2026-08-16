import * as cheerio from "cheerio";

import {
  MODUS_MATCH_DETAILS_URL,
  ModusHistoricalMatchSchema,
  type ModusHistoricalMatch,
} from "./history-schemas.js";
import { buildModusMatchDetailsUrl } from "./results-index-source.js";

const MONTHS: Readonly<Record<string, string>> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export function parseModusMatchDetails(html: string, sourceUrl: string): ModusHistoricalMatch {
  if (html.trim() === "") throw new Error("The official MODUS match-details page was empty.");
  const url = validateDetailsUrl(sourceUrl);
  const matchId = url.searchParams.get("match_id") ?? "";
  if (!/^\d+$/u.test(matchId)) throw new Error("The official MODUS match-details URL had no numeric match_id.");
  const $ = cheerio.load(html);
  const metadata = $(".match-stats .meta-desktop .meta-right .tab").map((_index, element) => normalizeText($(element).text())).get();
  if (metadata.length < 3) throw new Error(`Official MODUS match ${matchId} had incomplete metadata.`);
  const playedAt = parsePlayedAt(metadata[0] ?? "");
  const seriesName = requireText(metadata[1] ?? "", "series name");
  const group = requireText(metadata[2] ?? "", "group name");
  const weekName = requireText($(".match-stats .meta-mobile .mobile-tabs .tab").last().text(), "week name");
  const homeName = requireText($(".match-stats .vs-row .player-one").first().text(), "home player");
  const awayName = requireText($(".match-stats .vs-row .player-two").first().text(), "away player");
  const scores = $(".match-stats .vs-row .score-area span").map((_index, element) => parseNonNegativeInteger($(element).text(), "score")).get();
  if (scores.length !== 2) throw new Error(`Official MODUS match ${matchId} did not contain two scores.`);
  const averageRow = $(".match-stats .stat-row").filter((_index, element) => {
    return normalizeText($(element).find(".stat-label").text()).toLocaleLowerCase("en-US") === "average";
  });
  if (averageRow.length !== 1) throw new Error(`Official MODUS match ${matchId} did not contain one Average row.`);
  const homeAverage = parseAverage(averageRow.find(".stat-left").text(), "home average");
  const awayAverage = parseAverage(averageRow.find(".stat-right").text(), "away average");
  return ModusHistoricalMatchSchema.parse({
    matchId,
    playedAtLocal: playedAt.playedAtLocal,
    date: playedAt.date,
    seriesName,
    weekName,
    group,
    home: { name: homeName, score: scores[0], average: homeAverage },
    away: { name: awayName, score: scores[1], average: awayAverage },
    sourceUrl: buildModusMatchDetailsUrl(matchId),
  });
}

function validateDetailsUrl(value: string): URL {
  const parsed = new URL(value);
  const allowed = new URL(MODUS_MATCH_DETAILS_URL);
  if (parsed.protocol !== allowed.protocol || parsed.host !== allowed.host || parsed.pathname !== allowed.pathname) {
    throw new Error("Only the official MODUS match-details endpoint can be parsed.");
  }
  return parsed;
}

function parsePlayedAt(value: string): { readonly date: string; readonly playedAtLocal: string } {
  const match = /^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s*\/\s*(\d{2}):(\d{2})$/u.exec(normalizeText(value));
  if (match === null) throw new Error(`Invalid official MODUS match date ${JSON.stringify(value)}.`);
  const day = match[1] ?? "";
  const month = MONTHS[match[2] ?? ""];
  const year = match[3] ?? "";
  const hour = match[4] ?? "";
  const minute = match[5] ?? "";
  if (month === undefined) throw new Error(`Unknown official MODUS match month in ${JSON.stringify(value)}.`);
  const date = `${year}-${month}-${day.padStart(2, "0")}`;
  const validation = new Date(`${date}T${hour}:${minute}:00Z`);
  if (Number.isNaN(validation.getTime()) || validation.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid official MODUS calendar date ${JSON.stringify(value)}.`);
  }
  return { date, playedAtLocal: `${date}T${hour}:${minute}` };
}

function parseNonNegativeInteger(value: string, label: string): number {
  const normalized = normalizeText(value);
  if (!/^\d+$/u.test(normalized)) throw new Error(`Invalid official MODUS ${label} ${JSON.stringify(normalized)}.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Official MODUS ${label} was outside the safe integer range.`);
  return parsed;
}

function parseAverage(value: string, label: string): number {
  const normalized = normalizeText(value);
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) throw new Error(`Invalid official MODUS ${label} ${JSON.stringify(normalized)}.`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
    throw new Error(`Official MODUS ${label} was outside the valid range.`);
  }
  return parsed;
}

function requireText(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (normalized === "") throw new Error(`Missing official MODUS ${label}.`);
  return normalized;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

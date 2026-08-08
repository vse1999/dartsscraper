import { z } from "zod";

import { DartsOrakelStructureChangedError } from "../errors.js";
import { MatchSchema, type Match } from "../schemas/match.js";
import type { PlayerIdentity } from "../schemas/player.js";

const NullableStatSchema = z.union([z.number(), z.string()]).nullable().optional();

export const DartsOrakelMatchRowSchema = z.object({
  tournament_key: z.number().int().positive(),
  event_key: z.number().int().positive(),
  tournament_name: z.string().trim().min(1),
  tournament_no: z.union([z.number().int().nonnegative(), z.string()]).nullable().optional(),
  match_date: z.string().trim().min(1),
  round: z.string().nullable().optional(),
  winner_key: z.number().int().positive(),
  loser_key: z.number().int().positive(),
  result: z.string().trim().min(1),
  opponent: z.string().trim().min(1),
  score: z.string().trim().min(1),
  stat: NullableStatSchema,
  stat1: NullableStatSchema,
  stat2: NullableStatSchema,
  is_bye: z.union([z.number().int(), z.string()]).nullable().optional(),
});

export const DartsOrakelMatchesResponseSchema = z.object({
  draw: z.number().int().nonnegative(),
  recordsTotal: z.number().int().nonnegative(),
  recordsFiltered: z.number().int().nonnegative(),
  data: z.array(DartsOrakelMatchRowSchema),
});

export type DartsOrakelMatchRow = z.infer<typeof DartsOrakelMatchRowSchema>;
export type DartsOrakelMatchesResponse = z.infer<typeof DartsOrakelMatchesResponseSchema>;

export function parseDartsOrakelMatches(
  player: PlayerIdentity,
  response: unknown,
): Match[] {
  const responseResult = DartsOrakelMatchesResponseSchema.safeParse(response);
  if (!responseResult.success) {
    const issue = responseResult.error.issues[0];
    throw new DartsOrakelStructureChangedError(
      `DartsOrakel match response failed validation${issue === undefined ? "." : ` at ${formatPath(issue.path)}: ${issue.message}.`}`,
    );
  }

  const uniqueMatches = new Map<string, Match>();
  for (const row of responseResult.data.data) {
    if (isBye(row) || isIncompleteResult(row.result)) {
      continue;
    }

    const identity = matchIdentity(row);
    const parsed = parseMatchRow(player, row);
    const existing = uniqueMatches.get(identity);
    if (existing === undefined) {
      uniqueMatches.set(identity, parsed);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new DartsOrakelStructureChangedError(
        `DartsOrakel returned conflicting duplicate match data for ${identity}.`,
      );
    }
  }

  return [...uniqueMatches.values()].sort((left, right) => right.date.localeCompare(left.date));
}

export function parseDartsOrakelMatchRow(
  player: PlayerIdentity,
  row: unknown,
): Match {
  const rowResult = DartsOrakelMatchRowSchema.safeParse(row);
  if (!rowResult.success) {
    const issue = rowResult.error.issues[0];
    throw new DartsOrakelStructureChangedError(
      `DartsOrakel match row failed validation${issue === undefined ? "." : ` at ${formatPath(issue.path)}: ${issue.message}.`}`,
    );
  }
  return parseMatchRow(player, rowResult.data);
}

function parseMatchRow(player: PlayerIdentity, row: DartsOrakelMatchRow): Match {
  const date = parseDate(row.match_date);
  const tournament = formatTournament(row.tournament_name, row.tournament_no);
  const opponent = parseOpponent(row.opponent);
  const round = normalizeNullableText(row.round);
  const result = row.result.trim();
  const score = row.score.trim();
  const average = parseAverage(row.stat);

  if (opponent === player.name) {
    throw new DartsOrakelStructureChangedError("DartsOrakel returned the requested player as their own opponent.");
  }

  const parsed = MatchSchema.safeParse({ date, tournament, round, result, opponent, score, average });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DartsOrakelStructureChangedError(
      `Parsed match failed validation${issue === undefined ? "." : ` at ${formatPath(issue.path)}: ${issue.message}.`}`,
    );
  }
  return parsed.data;
}

function parseDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\s|T|$)/.exec(value.trim());
  const date = match?.[1];
  if (date === undefined || !isIsoCalendarDate(date)) {
    throw new DartsOrakelStructureChangedError(`Invalid DartsOrakel match date ${JSON.stringify(value)}.`);
  }
  return date;
}

function isIsoCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function formatTournament(
  tournamentName: string,
  tournamentNumber: number | string | null | undefined,
): string {
  const base = tournamentName.trim();
  if (tournamentNumber === null || tournamentNumber === undefined || String(tournamentNumber).trim() === "") {
    return base;
  }
  const number = Number(tournamentNumber);
  return Number.isFinite(number) && number === 0 ? base : `${base} ${String(tournamentNumber).trim()}`;
}

function parseOpponent(value: string): string {
  const text = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(text);
  const normalized = decoded.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new DartsOrakelStructureChangedError("DartsOrakel returned an empty opponent value.");
  }
  return normalized;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|quot|nbsp);/gi, (entity, body: string) => {
    const normalized = body.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "apos") return "'";
    if (normalized === "gt") return ">";
    if (normalized === "lt") return "<";
    if (normalized === "quot") return '"';
    if (normalized === "nbsp") return " ";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const digits = normalized.replace(/^#x?/, "");
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function parseAverage(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (text === "" || text === "0" || text === "0.00%") {
    return null;
  }
  const parsed = Number(text.replace(/%$/, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function isBye(row: DartsOrakelMatchRow): boolean {
  return row.is_bye === 1 || row.is_bye === "1";
}

function isIncompleteResult(result: string): boolean {
  return new Set(["", "pending", "scheduled", "upcoming", "live", "cancelled", "abandoned"]).has(result.trim().toLowerCase());
}

function matchIdentity(row: DartsOrakelMatchRow): string {
  return [
    row.tournament_key,
    row.event_key,
    row.winner_key,
    row.loser_key,
    row.match_date,
    row.round?.trim() ?? "",
    row.score.trim(),
    row.stat1 ?? "",
    row.stat2 ?? "",
  ].join("|");
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "response" : path.map((part) => String(part)).join(".");
}

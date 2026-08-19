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
  winner_score: z.union([z.number().int().nonnegative(), z.string()]).nullable().optional(),
  loser_score: z.union([z.number().int().nonnegative(), z.string()]).nullable().optional(),
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

export interface DartsOrakelStatisticResponses {
  readonly average: unknown;
  readonly oneEighties: unknown;
  readonly checkoutPercentage: unknown;
}

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

export function parseDartsOrakelMatchesWithStatistics(
  player: PlayerIdentity,
  responses: DartsOrakelStatisticResponses,
): Match[] {
  const averageResponse = parseResponse(responses.average, "average");
  const oneEightiesResponse = parseResponse(responses.oneEighties, "180s");
  const checkoutResponse = parseResponse(responses.checkoutPercentage, "checkout percentage");
  const averageGroups = groupRows(averageResponse.data);
  const oneEightiesGroups = groupRows(oneEightiesResponse.data);
  const checkoutGroups = groupRows(checkoutResponse.data);
  const uniqueMatches = new Map<string, Match>();

  for (const row of averageResponse.data) {
    if (isBye(row) || isIncompleteResult(row.result)) continue;
    const correlationKey = correlationIdentity(row);
    const canonicalGroup = averageGroups.get(correlationKey) ?? [];
    const oneEightiesRow = uniqueCorrelatedRow(canonicalGroup, oneEightiesGroups.get(correlationKey));
    const checkoutRow = uniqueCorrelatedRow(canonicalGroup, checkoutGroups.get(correlationKey));
    const parsed = parseMatchRow(player, row, {
      oneEighties: parseOneEighties(oneEightiesRow),
      checkout: parseCheckout(checkoutRow),
    });
    const identity = matchIdentity(row);
    const existing = uniqueMatches.get(identity);
    if (existing === undefined) {
      uniqueMatches.set(identity, parsed);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new DartsOrakelStructureChangedError(
        `DartsOrakel returned conflicting duplicate enriched match data for ${identity}.`,
      );
    }
  }

  return [...uniqueMatches.values()].sort((left, right) => right.date.localeCompare(left.date));
}

interface ParsedCheckout {
  readonly percentage: number | null;
  readonly hits: number | null;
  readonly attempts: number | null;
}

interface ParsedEnrichment {
  readonly oneEighties: number | null;
  readonly checkout: ParsedCheckout;
}

function parseMatchRow(
  player: PlayerIdentity,
  row: DartsOrakelMatchRow,
  enrichment?: ParsedEnrichment,
): Match {
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

  const parsed = MatchSchema.safeParse({
    date,
    tournament,
    round,
    result,
    opponent,
    score,
    average,
    ...(enrichment === undefined ? {} : {
      oneEighties: enrichment.oneEighties,
      checkoutPercentage: enrichment.checkout.percentage,
      checkoutHits: enrichment.checkout.hits,
      checkoutAttempts: enrichment.checkout.attempts,
    }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DartsOrakelStructureChangedError(
      `Parsed match failed validation${issue === undefined ? "." : ` at ${formatPath(issue.path)}: ${issue.message}.`}`,
    );
  }
  return parsed.data;
}

function parseResponse(value: unknown, statistic: string): DartsOrakelMatchesResponse {
  const result = DartsOrakelMatchesResponseSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new DartsOrakelStructureChangedError(
    `DartsOrakel ${statistic} response failed validation${issue === undefined ? "." : ` at ${formatPath(issue.path)}: ${issue.message}.`}`,
  );
}

function groupRows(rows: readonly DartsOrakelMatchRow[]): ReadonlyMap<string, readonly DartsOrakelMatchRow[]> {
  const groups = new Map<string, DartsOrakelMatchRow[]>();
  for (const row of rows) {
    if (isBye(row) || isIncompleteResult(row.result)) continue;
    const key = correlationIdentity(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

function uniqueCorrelatedRow(
  canonicalGroup: readonly DartsOrakelMatchRow[],
  metricGroup: readonly DartsOrakelMatchRow[] | undefined,
): DartsOrakelMatchRow | undefined {
  // DartsOrakel exposes no durable match ID. Only one-to-one invariant groups
  // are safe; repeated or missing groups remain unavailable instead of being
  // joined by response position.
  return canonicalGroup.length === 1 && metricGroup?.length === 1 ? metricGroup[0] : undefined;
}

function correlationIdentity(row: DartsOrakelMatchRow): string {
  return [
    row.tournament_key,
    row.event_key,
    row.match_date,
    row.round?.trim() ?? "",
    row.winner_key,
    row.loser_key,
    normalizeScorePart(row.winner_score),
    normalizeScorePart(row.loser_score),
  ].join("|");
}

function normalizeScorePart(value: number | string | null | undefined): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseOneEighties(row: DartsOrakelMatchRow | undefined): number | null {
  if (row === undefined) return null;
  const primary = parseNonNegativeInteger(row.stat1 ?? row.stat, "180 count");
  if (primary === null) return null;
  const displayed = parseNonNegativeInteger(row.stat, "displayed 180 count");
  if (displayed !== null && displayed !== primary) {
    throw new DartsOrakelStructureChangedError("DartsOrakel returned inconsistent 180 count fields.");
  }
  return primary;
}

function parseCheckout(row: DartsOrakelMatchRow | undefined): ParsedCheckout {
  if (row === undefined) return { percentage: null, hits: null, attempts: null };
  const hits = parseNonNegativeInteger(row.stat1, "checkout hits");
  const attempts = parseNonNegativeInteger(row.stat2, "checkout attempts");
  if (hits === null || attempts === null) return { percentage: null, hits: null, attempts: null };
  if (hits > attempts) {
    throw new DartsOrakelStructureChangedError("DartsOrakel returned more checkout hits than attempts.");
  }
  if (attempts === 0) return { percentage: null, hits, attempts };
  const percentage = Number(((hits / attempts) * 100).toFixed(2));
  const displayed = parsePercentage(row.stat);
  if (displayed !== null && Math.abs(displayed - percentage) > 0.011) {
    throw new DartsOrakelStructureChangedError("DartsOrakel returned an inconsistent checkout percentage.");
  }
  return { percentage, hits, attempts };
}

function parseNonNegativeInteger(value: number | string | null | undefined, label: string): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    throw new DartsOrakelStructureChangedError(`Invalid DartsOrakel ${label} ${JSON.stringify(value)}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DartsOrakelStructureChangedError(`Invalid DartsOrakel ${label} ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function parsePercentage(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?%?$/u.test(text)) {
    throw new DartsOrakelStructureChangedError(`Invalid DartsOrakel checkout percentage ${JSON.stringify(value)}.`);
  }
  const parsed = Number(text.endsWith("%") ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new DartsOrakelStructureChangedError(`Invalid DartsOrakel checkout percentage ${JSON.stringify(value)}.`);
  }
  return parsed;
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

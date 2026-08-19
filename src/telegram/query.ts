export const MAX_PLAYER_NAME_LENGTH = 80;
export const MAX_MATCH_COUNT = 20;

export type PlayerStatsSource = "auto" | "modus" | "dartsorakel";

export interface StatsQuery {
  readonly playerName: string;
  readonly matchCount: number;
  readonly source: PlayerStatsSource;
}

const STATISTIC_TERMS = new Set([
  "average",
  "averages",
  "stats",
  "statistics",
  "180",
  "180s",
  "checkout",
  "checkouts",
  "checkout percent",
  "checkout percentage",
]);

export function parseStatsQuery(text: string): StatsQuery | null {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const sourceRequest = extractSource(normalized);
  if (sourceRequest === null) return null;
  const request = stripConversationalPrefix(sourceRequest.request);
  const match = /^(.+?)\s+(?:last|latest|most recent)\s+(\d{1,2})\s+(?:completed\s+)?match(?:es)?(?:\s+(.+?))?[.!?]?$/iu.exec(request);
  if (match === null) return null;

  const statisticsSuffix = match[3];
  if (statisticsSuffix !== undefined && !isStatisticsSuffix(statisticsSuffix)) return null;

  const playerName = match[1]?.trim().replace(/[’']s$/iu, "").trim() ?? "";
  const matchCount = Number(match[2]);
  if (
    playerName.length === 0
    || playerName.length > MAX_PLAYER_NAME_LENGTH
    || !Number.isSafeInteger(matchCount)
    || matchCount < 1
    || matchCount > MAX_MATCH_COUNT
  ) {
    return null;
  }

  return { playerName, matchCount, source: sourceRequest.source };
}

export function statsQueryUsage(): string {
  return [
    `Ask: <player name> last <1-${MAX_MATCH_COUNT}> matches`,
    "Examples:",
    "Dylan Slevin last 10 match",
    "Dylan Slevin last 10 matches from MODUS",
    "Dylan Slevin last 10 matches from DartsOrakel",
    "Robert Thornton last 10 matches with averages, 180s and checkout percentage from DartsOrakel",
    "DartsOrakel returns average, 180s, and checkout percentage for every available match.",
    "MODUS currently returns match averages only.",
    "Without a source, the bot chooses automatically.",
  ].join("\n");
}

interface SourceRequest {
  readonly request: string;
  readonly source: PlayerStatsSource;
}

const SOURCE_NAME_PATTERN = "(?:modus(?:\\s+super\\s+series)?|darts\\s*orakel)";

function extractSource(value: string): SourceRequest | null {
  const prefix = new RegExp(`^(?:from|using|via)\\s+(${SOURCE_NAME_PATTERN})\\s*[:,\\-]?\\s+(.+)$`, "iu").exec(value)
    ?? new RegExp(`^(${SOURCE_NAME_PATTERN})\\s*:\\s*(.+)$`, "iu").exec(value);
  const suffix = new RegExp(`^(.+?)\\s+(?:from|using|via|on)\\s+(${SOURCE_NAME_PATTERN})[.!?]?$`, "iu").exec(value);
  if (prefix !== null && suffix !== null) return null;
  if (prefix !== null) {
    const source = normalizeSource(prefix[1]);
    const request = prefix[2]?.trim();
    return source === null || request === undefined || request === "" ? null : { request, source };
  }
  if (suffix !== null) {
    const source = normalizeSource(suffix[2]);
    const request = suffix[1]?.trim();
    return source === null || request === undefined || request === "" ? null : { request, source };
  }
  return { request: value, source: "auto" };
}

function normalizeSource(value: string | undefined): Exclude<PlayerStatsSource, "auto"> | null {
  if (value === undefined) return null;
  const normalized = value.toLocaleLowerCase("en-US").replace(/\s+/gu, "");
  if (normalized === "modus" || normalized === "modussuperseries") return "modus";
  if (normalized === "dartsorakel") return "dartsorakel";
  return null;
}

function stripConversationalPrefix(value: string): string {
  return value
    .replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:show|give)(?:\s+me)?\s+/iu, "")
    .replace(/^(?:please\s+)?what\s+(?:is|are)\s+/iu, "")
    .trim();
}

function isStatisticsSuffix(value: string): boolean {
  const normalized = value
    .toLocaleLowerCase("en-US")
    .replace(/^(?:with|including)\s+/u, "")
    .trim();
  if (normalized === "") return false;
  const terms = normalized.split(/\s*(?:,|\band\b)\s*/u);
  return terms.length > 0 && terms.every((term: string): boolean => STATISTIC_TERMS.has(term));
}

export const MAX_PLAYER_NAME_LENGTH = 80;
export const MAX_MATCH_COUNT = 20;

export interface StatsQuery {
  readonly playerName: string;
  readonly matchCount: number;
}

export function parseStatsQuery(text: string): StatsQuery | null {
  const normalized = text.normalize("NFKC").trim();
  const match = /^(.+?)\s+last\s+(\d{1,2})\s+match(?:es)?\s+averages?[.!?]?$/iu.exec(normalized);
  if (match === null) return null;

  const playerName = match[1]?.trim().replace(/\s+/gu, " ") ?? "";
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

  return { playerName, matchCount };
}

export function statsQueryUsage(): string {
  return `Format: <player name> last <1-${MAX_MATCH_COUNT}> match averages\nExample: Rob Cross last 10 match averages`;
}

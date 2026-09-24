import {
  MAX_PLAYER_NAME_LENGTH,
} from "./query.js";
import { normalizePlayerName } from "../player/resolver.js";

export const COMPARE_DEFAULT_MATCH_COUNT = 10 as const;
export const COMPARE_ALLOWED_MATCH_COUNTS = [10, 20] as const;

export type CompareMatchCount = (typeof COMPARE_ALLOWED_MATCH_COUNTS)[number];

export interface CompareQuery {
  readonly playerNames: readonly [string, string];
  readonly matchCount: CompareMatchCount;
}

export function parseCompareCommand(text: string): CompareQuery | null {
  const normalized = normalizeUnicodeWhitespace(text);
  const commandMatch = /^\/compare(?:@[A-Za-z0-9_]+)?(?:\s+(.+?))?$/iu.exec(normalized);
  if (commandMatch === null) return null;

  const body = commandMatch[1]?.trim();
  if (body === undefined || body === "") return null;

  const countMatch = /^(.*)\s+last\s+(10|20)$/iu.exec(body);
  if (countMatch === null && hasUnsupportedCompareSuffix(body)) return null;
  const namesText = (countMatch?.[1] ?? body).trim();
  if (hasUnsupportedCompareSuffix(namesText)) return null;
  const countText = countMatch?.[2];
  const matchCount: CompareMatchCount = countText === "20" ? 20 : COMPARE_DEFAULT_MATCH_COUNT;

  const names = namesText.split(",").map((name: string): string => normalizeUnicodeWhitespace(name));
  if (names.length !== 2 || names.some((name: string): boolean => name === "" || [...name].length > MAX_PLAYER_NAME_LENGTH)) {
    return null;
  }
  const first = names[0];
  const second = names[1];
  if (first === undefined || second === undefined) return null;
  if (first.toLocaleLowerCase("en-US") === second.toLocaleLowerCase("en-US")) return null;

  return { playerNames: [first, second], matchCount };
}

function normalizeUnicodeWhitespace(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function hasUnsupportedCompareSuffix(value: string): boolean {
  // `last` is reserved for the supported count suffix. Treat every other
  // trailing use as malformed rather than accidentally making it part of a
  // player name (for example, `last banana` or `last 11`).
  if (/\blast(?:\s+\d+|\d+|\s|$)/iu.test(value)) return true;
  // A slash-prefixed count is another command, not a player-name suffix.
  if (/\/last(?:\d+)?(?:\b|\s)/iu.test(value)) return true;
  // /compare always uses DartsOrakel; source-routing instructions belong to
  // the stats query grammar and must not become part of a player name.
  return /\b(?:from|using|via)\s+(?:modus(?:\s+super\s+series)?|darts\s*orakel|auto)\b/iu.test(value);
}

export function compareQueryUsage(): string {
  return "Compare two players: /compare Player One, Player Two [last 10|last 20]";
}

export function sameComparisonPlayer(left: string, right: string): boolean {
  return normalizePlayerName(left) === normalizePlayerName(right);
}

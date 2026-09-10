import type { InlineKeyboardMarkup } from "grammy/types";

import { MAX_MATCH_COUNT, MAX_PLAYER_NAME_LENGTH, type StatsQuery } from "./query.js";

const CALLBACK_PREFIX = "modus-player:";
const BUTTONS_PER_ROW = 2;

export function createModusPlayerKeyboard(
  players: readonly string[],
  matchCount: number,
): InlineKeyboardMarkup {
  validateMatchCount(matchCount);
  const buttons = players.map((player: string, index: number) => ({
    text: normalizePlayerName(player),
    callback_data: `${CALLBACK_PREFIX}${index}:${matchCount}`,
  }));
  const inlineKeyboard: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
    inlineKeyboard.push(buttons.slice(index, index + BUTTONS_PER_ROW));
  }
  return { inline_keyboard: inlineKeyboard };
}

/**
 * Resolves an index-only callback against Telegram's copy of the originating
 * keyboard, keeping callback_data comfortably below Telegram's 64-byte limit
 * without relying on server memory between Vercel invocations.
 */
export function resolveModusPlayerCallback(
  callbackData: string,
  replyMarkup: unknown,
): StatsQuery | null {
  const parsed = new RegExp(`^${CALLBACK_PREFIX}(\\d{1,3}):(\\d{1,2})$`, "u").exec(callbackData);
  if (parsed === null) return null;
  const buttonIndex = Number(parsed[1]);
  const matchCount = Number(parsed[2]);
  if (!Number.isSafeInteger(buttonIndex) || buttonIndex < 0 || !isValidMatchCount(matchCount)) return null;

  const buttons = readInlineKeyboardButtons(replyMarkup);
  const button = buttons[buttonIndex];
  if (typeof button !== "object" || button === null) return null;
  if (Reflect.get(button, "callback_data") !== callbackData) return null;
  const text = Reflect.get(button, "text");
  if (typeof text !== "string") return null;
  const playerName = normalizePlayerName(text);
  if (playerName === "" || playerName.length > MAX_PLAYER_NAME_LENGTH) return null;
  return { playerName, matchCount, source: "dartsorakel" };
}

export const MODUS_PLAYER_CALLBACK_PATTERN = /^modus-player:\d{1,3}:\d{1,2}$/u;

function readInlineKeyboardButtons(replyMarkup: unknown): readonly unknown[] {
  if (typeof replyMarkup !== "object" || replyMarkup === null) return [];
  const rows = Reflect.get(replyMarkup, "inline_keyboard");
  if (!Array.isArray(rows)) return [];
  const buttons: unknown[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) return [];
    buttons.push(...row);
  }
  return buttons;
}

function normalizePlayerName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function validateMatchCount(matchCount: number): void {
  if (!isValidMatchCount(matchCount)) {
    throw new Error(`matchCount must be an integer between 1 and ${MAX_MATCH_COUNT}.`);
  }
}

function isValidMatchCount(matchCount: number): boolean {
  return Number.isSafeInteger(matchCount) && matchCount >= 1 && matchCount <= MAX_MATCH_COUNT;
}

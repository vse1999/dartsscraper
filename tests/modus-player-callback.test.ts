import { describe, expect, it } from "vitest";

import {
  createModusPlayerKeyboard,
  resolveModusPlayerCallback,
} from "../src/telegram/modus-player-callback.js";

describe("MODUS player callback keyboard", () => {
  it("lays every player out as a clickable two-column keyboard", () => {
    const keyboard = createModusPlayerKeyboard(
      ["Kevin Lane", "Jack Drayton", "Ryan Branley"],
      10,
    );

    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "Kevin Lane", callback_data: "modus-player:0:10" },
        { text: "Jack Drayton", callback_data: "modus-player:1:10" },
      ],
      [{ text: "Ryan Branley", callback_data: "modus-player:2:10" }],
    ]);
    expect(keyboard.inline_keyboard.flat()).toHaveLength(3);
    expect(keyboard.inline_keyboard.flat().every((button) => (
      "callback_data" in button && Buffer.byteLength(button.callback_data, "utf8") <= 64
    ))).toBe(true);
  });

  it("resolves a stateless callback through the originating keyboard", () => {
    const keyboard = createModusPlayerKeyboard(["Kevin Lane", "Jack Drayton"], 10);

    expect(resolveModusPlayerCallback("modus-player:1:10", keyboard)).toEqual({
      playerName: "Jack Drayton",
      matchCount: 10,
      source: "dartsorakel",
    });
  });

  it("rejects forged, stale, or malformed callback data", () => {
    const keyboard = createModusPlayerKeyboard(["Kevin Lane"], 10);

    expect(resolveModusPlayerCallback("modus-player:1:10", keyboard)).toBeNull();
    expect(resolveModusPlayerCallback("modus-player:0:20", keyboard)).toBeNull();
    expect(resolveModusPlayerCallback("not-a-modus-callback", keyboard)).toBeNull();
    expect(resolveModusPlayerCallback("modus-player:0:10", undefined)).toBeNull();
  });
});

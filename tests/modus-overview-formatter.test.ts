import { describe, expect, it } from "vitest";

import { formatModusOverviewMessages, type ModusOverviewPlayer } from "../src/telegram/modus-overview-formatter.js";
import type { PlayerStatsResult } from "../src/telegram/stats-service.js";

function stats(playerName: string): PlayerStatsResult {
  return {
    playerName,
    requestedCount: 10,
    matches: [
      {
        date: "2026-09-01",
        tournament: "Example Open",
        round: "Final",
        result: "Won",
        opponent: "Opponent",
        score: "6 V 3",
        average: 92,
        oneEighties: 2,
        checkoutPercentage: 50,
        checkoutHits: 2,
        checkoutAttempts: 4,
      },
    ],
    meanAverage: 92,
    availableAverageCount: 1,
    sourceUrl: "https://dartsorakel.com/player/details/1/player",
    sourceLabel: "DartsOrakel",
    provider: "dartsorakel",
    evidenceUrls: [],
  };
}

function player(playerName: string): ModusOverviewPlayer {
  return { player: playerName, status: "succeeded", stats: stats(playerName) };
}

describe("MODUS compact overview formatter", () => {
  it("renders a scannable comparison dashboard with unavailable players", () => {
    const messages = formatModusOverviewMessages({
      date: "2026-09-11",
      dateLabel: "tomorrow",
      matchCount: 10,
      players: ["Jack Drayton", "Missing Player"],
      results: [player("Jack Drayton"), { player: "Missing Player", status: "failed", error: "PLAYER_NOT_FOUND" }],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe([
      "🎯 MODUS TOMORROW · 11 Sep 2026",
      "2 scheduled players",
      "Form = last 10 completed DartsOrakel matches",
      "",
      "PLAYER FORM",
      "Jack Drayton — 92.00 avg · 1W–0L · 2×180 · 50.00% checkout",
      "Missing Player — unavailable",
      "✅ Form available for 1/2 players",
      "⚠️ 1 player unavailable: Missing Player",
      "",
      "👇 Tap a player below for detailed match statistics.",
    ].join("\n"));
  });

  it("splits oversized dashboards only between player rows", () => {
    const players = Array.from({ length: 100 }, (_, index): string => `Player ${index + 1}`);
    const messages = formatModusOverviewMessages({
      date: "2026-09-11",
      dateLabel: "tomorrow",
      matchCount: 10,
      players,
      results: players.map(player),
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 4_096)).toBe(true);
    expect(messages.join("\n")).toContain("Player 1 — 92.00 avg");
    expect(messages.join("\n")).toContain("Player 100 — 92.00 avg");
  });
});

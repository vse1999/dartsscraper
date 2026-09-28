import { describe, expect, it } from "vitest";

import { formatWatchlistPreviewPages, WATCHLIST_PREVIEW_MAX_HTML_LENGTH } from "../src/watchlist/preview-formatter.js";
import type { WatchlistScreenInput } from "../src/watchlist/contracts.js";
import { createSyntheticWatchlistInput, SYNTHETIC_NOW } from "./fixtures/watchlist-screening.js";

function cloneInput(): WatchlistScreenInput {
  return structuredClone(createSyntheticWatchlistInput());
}

describe("watchlist preview formatter", () => {
  it("screens independently and formats eligible evidence with weighted denominators", () => {
    const pages = formatWatchlistPreviewPages(cloneInput(), SYNTHETIC_NOW);
    expect(pages).toHaveLength(1);
    const preview = pages[0] ?? "";

    expect(preview).toContain("WATCHLIST RESEARCH PREVIEW");
    expect(preview).toContain("not proven value");
    expect(preview).toContain("Last-10 and last-20 windows overlap");
    expect(preview).toContain("Álpha");
    expect(preview).toContain("2.10");
    expect(preview).toContain("Bookmaker: <code>tippmixpro</code>");
    expect(preview).toContain("observed <code>2026-01-20T11:59:00.000Z</code>");
    expect(preview).toContain("Start: <code>2026-01-20T12:10:00.000Z</code>");
    expect(preview).toContain("Stage: <code>main</code> · Floor: <code>stage</code> · Format: <code>best-of-11</code>");
    expect(preview).toContain("Weighted checkout 40.00% (40/100 attempts; 10 matches)");
    expect(preview).toContain("Version: <code>synthetic-v1</code>");
    expect(preview).toContain("price band: <code>2.00–∞</code>");
    expect(preview).toContain("average Δ ≥ 1.000");
    expect(preview).toContain("checkout Δ ≥ 5.00 percentage points");
    expect(preview).toContain("required metrics pass");
    expect(preview).not.toContain("https://example.test/odds");
  });

  it("returns no alert pages for malformed or blocked candidates", () => {
    const blocked = cloneInput();
    blocked.price.quote.marketStatus = "suspended";
    expect(formatWatchlistPreviewPages(blocked, SYNTHETIC_NOW)).toEqual([]);
    expect(formatWatchlistPreviewPages(null, SYNTHETIC_NOW)).toEqual([]);
    expect(formatWatchlistPreviewPages(cloneInput(), new Date(Number.NaN))).toEqual([]);
    expect(formatWatchlistPreviewPages(cloneInput(), null as unknown as Date)).toEqual([]);
  });

  it("escapes control characters and source-controlled HTML", () => {
    const input = cloneInput();
    input.price.quote.players[0]!.name = "<b>unsafe</b>\u0000";
    input.price.quote.source.sourceId = "<script>alert(1)</script>";
    input.rules.allowedSourceIds = ["<script>alert(1)</script>"];
    const preview = formatWatchlistPreviewPages(input, SYNTHETIC_NOW).join("\n");

    expect(preview).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
    expect(preview).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(preview).not.toContain("<script>");
    expect(preview).not.toContain("\u0000");
  });

  it("shows missing optional context and optional 180/leg warnings", () => {
    const input = cloneInput();
    delete input.price.quote.eventContext;
    for (const match of input.selectedHistory.matches) delete match.stats.oneEighties;
    const preview = formatWatchlistPreviewPages(input, SYNTHETIC_NOW).join("\n");

    expect(preview).toContain("Event stage/floor/format context is unknown");
    expect(preview).toContain("Optional 180/leg evidence is unavailable or partial");
  });

  it("keeps long hostile names bounded and paginates at the Telegram limit", () => {
    const input = cloneInput();
    input.price.quote.players[0]!.name = "<&".repeat(128);
    input.price.quote.players[1]!.name = "&<".repeat(128);
    input.price.quote.bookmakerId = "<&".repeat(128);
    input.price.quote.source.sourceId = "&<".repeat(128);
    input.rules.allowedBookmakers = [input.price.quote.bookmakerId];
    input.rules.allowedSourceIds = [input.price.quote.source.sourceId];
    const pages = formatWatchlistPreviewPages(input, SYNTHETIC_NOW);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page): boolean => page.length <= WATCHLIST_PREVIEW_MAX_HTML_LENGTH)).toBe(true);
    expect(pages.join("\n")).not.toContain("https://example.test/odds");
    expect(pages.join("\n")).toContain("&lt;&amp;");
    expect(pages.join("\n").match(/&(?!amp;|lt;|gt;|quot;|#39;)/gu)).toBeNull();
  });

  it("does not duplicate a ten-match sample as last-20 evidence", () => {
    const input = cloneInput();
    input.selectedHistory.matches = input.selectedHistory.matches.slice(0, 10);
    input.opponentHistory.matches = input.opponentHistory.matches.slice(0, 10);

    const preview = formatWatchlistPreviewPages(input, SYNTHETIC_NOW).join("\n");

    expect(preview).toContain("10: Avg 95.00 (10/10 matches)");
    expect(preview).toContain("20: Avg unavailable (10/20 matches)");
    expect(preview).toContain("Last-20: average unavailable · checkout unavailable · 180/leg unavailable · required metric direction unavailable (need 20 matches)");
    expect(preview).not.toContain("Last-20: average +5.000 · checkout +20.00 pp");
  });

  it("does not claim last-20 direction checked with incomplete required coverage", () => {
    const input = cloneInput();
    for (const match of input.selectedHistory.matches.slice(10)) {
      delete match.stats.checkoutHits;
      delete match.stats.checkoutAttempts;
    }

    const preview = formatWatchlistPreviewPages(input, SYNTHETIC_NOW).join("\n");

    expect(preview).toContain("Last-20: average +5.000 · checkout +20.00 pp");
    expect(preview).toContain("required metric direction unavailable (incomplete evidence)");
    expect(preview).not.toContain("required metric direction checked (thresholds apply to last-10)");
  });
});

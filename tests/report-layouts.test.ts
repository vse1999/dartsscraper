import { describe, expect, it } from "vitest";
import { analyzeMatchup, type MatchupAnalysis, type MatchupPlayerHistory } from "../src/services/matchup-analysis.js";
import { createReportLayouts, escapeReportHtml, parseLabAnalyses, renderReportImageHtml } from "../scripts/report-layouts.js";

function history(playerName: string, average: number, enriched: boolean = true): MatchupPlayerHistory {
  return { playerName, requestedCount: 10, matches: Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(20 - i).padStart(2,"0")}`, tournament: "Test", round: null, result: "Won", opponent: "Opponent", score: "4 V 2", average,
    ...(enriched ? { oneEighties: 1, checkoutPercentage: 50, checkoutHits: 2, checkoutAttempts: 4 } : {}) })) };
}
function analysis(average: number = 85, enriched: boolean = true): MatchupAnalysis {
  return analyzeMatchup({ id: "test", date: "2026-10-08", startTime: null, playerOne: "Alpha <Player>", playerTwo: "Beta & Player" }, history("Alpha <Player>", 90, enriched), history("Beta & Player", average, enriched), 10);
}
describe("report layout experiments", () => {
  it("creates four text approaches without changing the analytical signal", () => {
    const layouts = createReportLayouts(analysis()); expect(layouts).toHaveLength(4);
    for (const layout of layouts) {
      expect(layout.html).toContain("leads on recent average"); expect(layout.html).toContain("not a win prediction");
      expect(layout.html).toContain("10/10 &amp; 10/10"); expect(layout.html).not.toContain("HIGH");
      expect(layout.html.length).toBeLessThan(4096); expect(layout.html).not.toContain("<Player>");
    }
  });
  it("preserves missing metrics rather than converting them to zero", () => {
    const layouts = createReportLayouts(analysis(85, false));
    expect(layouts[0]?.html).toContain("— checkout"); expect(layouts[1]?.html).toContain("—");
  });
  it("retains neutral and insufficient-data outcomes", () => {
    expect(createReportLayouts(analysis(89))[0]?.html).toContain("No clear recent-form edge");
    const a = analysis(); expect(createReportLayouts({ ...a, signal: { code: "insufficient-data", favoredPlayer: null, description: "" } })[0]?.html).toContain("Insufficient data");
  });
  it("uses the correct API boundary for rich HTML and expandable evidence", () => {
    const layouts = createReportLayouts(analysis()); expect(layouts[2]?.html).toContain("<blockquote expandable>");
    expect(layouts[3]?.method).toBe("sendRichMessage"); expect(layouts[3]?.html).toContain("<details>");
  });
  it("renders an image with labeled scales and exact source values", () => {
    const html = renderReportImageHtml(analysis()); expect(html).toContain("scale 0–180");
    expect(html).toContain("90.00"); expect(html).toContain("85.00"); expect(html).toContain("50.0%");
  });
  it("escapes names and rejects malformed saved samples", () => {
    expect(escapeReportHtml('<script>&"')).toBe("&lt;script&gt;&amp;&quot;"); expect(() => parseLabAnalyses({ histories: [] })).toThrow();
  });
});

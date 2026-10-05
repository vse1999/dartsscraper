import { describe, expect, it } from "vitest";
import type { Match } from "../src/schemas/match.js";
import { summarizeResearchHistory } from "../src/research/statistics.js";
import { buildResearchBrief } from "../src/research/brief.js";

function history(average: number | null, hits: number, attempts: number): readonly Match[] {
  return [{ date: "2026-09-30", tournament: "Test", round: null, result: "Won", opponent: "Other", score: "6 V 3", average,
    checkoutHits: hits, checkoutAttempts: attempts, checkoutPercentage: attempts === 0 ? null : hits / attempts * 100 }];
}

describe("deterministic research brief", () => {
  it("shows opposing scoring/finishing evidence with exact sample denominators", () => {
    const result = buildResearchBrief(
      { name: "Alpha", summary: summarizeResearchHistory(history(100, 1, 4)) },
      { name: "Beta", summary: summarizeResearchHistory(history(90, 2, 4)) },
    ).lines.join("\n");
    expect(result).toContain("Alpha minus Beta");
    expect(result).toContain("+10.00");
    expect(result).toContain("-25.00 percentage points");
    expect(result).toContain("1/4 vs 2/4 hits/attempts");
    expect(result).toContain("Contrary evidence");
    expect(result).not.toMatch(/win probability|recommended|bet on|value score/iu);
  });

  it("does not infer an advantage from missing opposing metrics", () => {
    const result = buildResearchBrief(
      { name: "Alpha", summary: summarizeResearchHistory(history(100, 1, 4)) },
      { name: "Beta", summary: summarizeResearchHistory(history(null, 0, 0)) },
    ).lines.join("\n");
    expect(result).toContain("delta unavailable");
    expect(result).toContain("no advantage is inferred");
    expect(result).not.toContain("Contrary evidence");
  });

  it("bounds adversarial names and strips control characters deterministically", () => {
    const player = { name: "Name\n\u0000" + "X".repeat(10_000), summary: summarizeResearchHistory(history(90, 1, 2)) };
    const first = buildResearchBrief(player, player);
    expect(first).toEqual(buildResearchBrief(player, player));
    expect(first.lines[0]?.length).toBeLessThan(300);
    expect(first.lines.join("\n")).not.toContain("\u0000");
  });
});

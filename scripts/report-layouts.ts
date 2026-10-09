import type { MatchupAnalysis, MatchupPlayerAnalysis } from "../src/services/matchup-analysis.js";
import { formatResearchDiagnostics } from "../src/research/diagnostic-format.js";
import { z } from "zod";
import { MatchSchema } from "../src/schemas/match.js";
import { analyzeMatchup } from "../src/services/matchup-analysis.js";
import { assessResearchQuality } from "../src/research/quality.js";

export function parseLabAnalyses(value: unknown): readonly MatchupAnalysis[] {
  const sample = z.object({ histories: z.array(z.object({ playerName: z.string().min(1).max(100), requestedCount: z.literal(10), matches: z.array(MatchSchema).min(1).max(10), evidence: z.unknown().optional() })).length(4) }).parse(value);
  const results: MatchupAnalysis[] = [];
  for (let i = 0; i < sample.histories.length; i += 2) {
    const a = sample.histories[i]; const b = sample.histories[i + 1];
    if (a === undefined || b === undefined) throw new Error("Incomplete sample pair.");
    results.push(analyzeMatchup({ id: `layout-test-${i}`, date: "2026-10-08", startTime: null, playerOne: a.playerName, playerTwo: b.playerName },
      { ...a, assessment: assessResearchQuality(a.matches, { evidence: a.evidence }) },
      { ...b, assessment: assessResearchQuality(b.matches, { evidence: b.evidence }) }, 10));
  }
  return results;
}

export interface ReportLayout {
  readonly id: string;
  readonly label: string;
  readonly method: "sendMessage" | "sendRichMessage";
  readonly html: string;
}

export function escapeReportHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function number(value: number | null | undefined, digits: number = 2): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function record(player: MatchupPlayerAnalysis): string {
  const s = player.summary;
  return s === null ? "—" : `${s.wins}W–${s.losses}L${s.draws > 0 ? `–${s.draws}D` : ""}`;
}

export function reportTakeaway(analysis: MatchupAnalysis): string {
  if (analysis.signal.code === "insufficient-data") return "Insufficient data to compare";
  if (analysis.signal.code === "no-clear-edge") return "No clear recent-form edge";
  const favored = analysis.signal.favoredPlayer;
  if (favored === null) return "No clear recent-form edge";
  return analysis.signal.code === "form-advantage"
    ? `${favored} leads on recent average`
    : `${favored} leads on recent average change`;
}

export function reportMetrics(analysis: MatchupAnalysis): readonly (readonly [string, string, string])[] {
  const a = analysis.playerOne;
  const b = analysis.playerTwo;
  return [
    ["Average", number(a.summary?.average), number(b.summary?.average)],
    ["Checkout", a.summary?.checkoutPercentage == null ? "—" : `${number(a.summary.checkoutPercentage, 1)}%`, b.summary?.checkoutPercentage == null ? "—" : `${number(b.summary.checkoutPercentage, 1)}%`],
    ["180s/match", number(a.oneEightiesPerMatch), number(b.oneEightiesPerMatch)],
    ["Record", record(a), record(b)],
  ];
}

function coverage(analysis: MatchupAnalysis): string {
  return `Average data: ${analysis.playerOne.summary?.availableAverageCount ?? 0}/${analysis.expectedAverageCount / 2} & ${analysis.playerTwo.summary?.availableAverageCount ?? 0}/${analysis.expectedAverageCount / 2}`;
}

function evidence(analysis: MatchupAnalysis): string {
  return [analysis.playerOne, analysis.playerTwo].map((player: MatchupPlayerAnalysis): string => {
    const s = player.summary;
    return [player.player, `Checkout hits/attempts: ${s?.checkoutHits ?? 0}/${s?.checkoutAttempts ?? 0}`,
      `Metric rows: 180s ${s?.availableOneEightiesCount ?? 0}/${s?.matchCount ?? 0}; checkout ${s?.availableCheckoutCount ?? 0}/${s?.matchCount ?? 0}`,
      ...formatResearchDiagnostics(player.assessment, player.coverage)].join("\n");
  }).join("\n\n") + `\n\nH2H meetings in retrieved window: ${analysis.headToHead.meetings}. Not a complete career H2H.`;
}

export function createReportLayouts(analysis: MatchupAnalysis): readonly ReportLayout[] {
  const nameA = escapeReportHtml(analysis.playerOne.player);
  const nameB = escapeReportHtml(analysis.playerTwo.player);
  const title = `<b>${nameA} vs ${nameB}</b>`;
  const takeaway = `<b>${escapeReportHtml(reportTakeaway(analysis))}</b>`;
  const disclaimer = "Descriptive form, not a win prediction.\nFormat, opponent adjustment & source freshness unverified.";
  const dataNote = escapeReportHtml(coverage(analysis));
  const metrics = reportMetrics(analysis);
  const players = [analysis.playerOne, analysis.playerTwo].map((p: MatchupPlayerAnalysis): string => {
    const s = p.summary;
    return `<b>${escapeReportHtml(p.player)}</b>\n${number(s?.average)} avg · ${s?.checkoutPercentage == null ? "—" : `${number(s.checkoutPercentage, 1)}%`} checkout\n${record(p)} · ${number(p.oneEightiesPerMatch)} 180s/match`;
  }).join("\n\n");
  const compact = `${title}\n\n${takeaway}\n\n${players}\n\n${dataNote}\n\n<i>${disclaimer}</i>`;
  const shortName = (name: string): string => name.split(/\s+/u).at(-1)?.slice(0, 9) ?? "Player";
  const mono = ["Metric".padEnd(11) + shortName(analysis.playerOne.player).padStart(9) + shortName(analysis.playerTwo.player).padStart(9),
    ...metrics.map(([label, a, b]: readonly [string, string, string]): string => label.padEnd(11) + a.padStart(9) + b.padStart(9))].join("\n");
  const rows = metrics.map(([label, a, b]: readonly [string, string, string]): string => `<tr><th>${label}</th><td align="right">${a}</td><td align="right">${b}</td></tr>`).join("");
  return [
    { id: "compact", label: "Compact digest", method: "sendMessage", html: compact },
    { id: "monospace", label: "Fixed-width table", method: "sendMessage", html: `${title}\n\n${takeaway}\n\n<pre>${escapeReportHtml(mono)}</pre>\n${dataNote}\n\n<i>${disclaimer}</i>` },
    { id: "expandable", label: "Compact + expandable evidence", method: "sendMessage", html: `${compact}\n\n<blockquote expandable>${escapeReportHtml(evidence(analysis))}</blockquote>` },
    { id: "rich", label: "Native rich table + details", method: "sendRichMessage", html: `<h3>${nameA} vs ${nameB}</h3><p>${takeaway}</p><table compact><tr><th>Metric</th><th>${nameA}</th><th>${nameB}</th></tr>${rows}</table><p>${dataNote}</p><details><summary>Sample sizes & limitations</summary><p>${escapeReportHtml(evidence(analysis)).replaceAll("\n", "<br>")}</p></details><footer>${disclaimer}</footer>` },
  ];
}

export function renderReportImageHtml(analysis: MatchupAnalysis): string {
  const metrics = reportMetrics(analysis);
  const a = analysis.playerOne; const b = analysis.playerTwo;
  const chart = [a, b].map((p: MatchupPlayerAnalysis): string => {
    const value = p.summary?.average;
    return `<div class="bar-row"><span>${escapeReportHtml(p.player)}</span><b>${number(value)}</b><div class="track"><div class="fill" style="width:${value == null ? 0 : Math.max(0, Math.min(100, value / 180 * 100))}%"></div></div></div>`;
  }).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Darts comparison</title><style>
  *{box-sizing:border-box}body{margin:0;background:#172735;color:#edf4fa;font:18px/1.5 Arial,sans-serif;padding:28px;width:640px}header,footer,.muted{color:#b4c5d5;font-size:15px}h1{font-size:25px;margin:14px 0}h2{font-size:20px;margin:20px 0 12px;color:#89dac0}table{width:100%;border-collapse:collapse;margin:22px 0}th,td{text-align:right;padding:13px 5px;border-bottom:1px solid #3a4e60;font-variant-numeric:tabular-nums}th:first-child{text-align:left;font-weight:400}thead{font-size:15px;color:#b4c5d5}.bar-row{display:grid;grid-template-columns:1fr auto;gap:6px;margin:15px 0}.track{grid-column:1/-1;height:8px;background:#314554;border-radius:4px}.fill{height:8px;background:#89dac0;border-radius:4px}footer{border-top:1px solid #3a4e60;padding-top:16px;margin-top:20px}
  </style><header>LAYOUT TEST · Visual image card<br>Last 10 matches · comparison, not schedule verification</header><h1>${escapeReportHtml(a.player)}<br>vs ${escapeReportHtml(b.player)}</h1><h2>${escapeReportHtml(reportTakeaway(analysis))}</h2><div class="muted">Average · mean of match averages · scale 0–180</div>${chart}<table><thead><tr><th>Metric</th><th>${escapeReportHtml(a.player)}</th><th>${escapeReportHtml(b.player)}</th></tr></thead><tbody>${metrics.slice(1).map(([label,x,y]:readonly[string,string,string]):string=>`<tr><th>${label}</th><td>${x}</td><td>${y}</td></tr>`).join("")}</tbody></table><div class="muted">${escapeReportHtml(coverage(analysis))}<br>Checkout hits/attempts: ${a.summary?.checkoutHits ?? 0}/${a.summary?.checkoutAttempts ?? 0} vs ${b.summary?.checkoutHits ?? 0}/${b.summary?.checkoutAttempts ?? 0}</div><footer>Descriptive form, not a win prediction.<br>Format, opponent adjustment & source freshness unverified.</footer></html>`;
}

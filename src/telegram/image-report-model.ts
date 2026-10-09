import type { MatchupAnalysis, MatchupPlayerAnalysis } from "../services/matchup-analysis.js";
import { calculateMatchSummary } from "../services/statistics.js";
import type { PlayerStatsResult } from "./stats-service.js";
import { MAX_REPORT_IMAGES, qualityNotes, type ImageReport, type ReportImageCard } from "./report-image.js";

function number(value: number | null | undefined, digits: number = 2): string {
  return value == null || !Number.isFinite(value) ? "Unavailable" : value.toFixed(digits);
}
function percentage(value: number | null | undefined): string {
  return value == null ? "Unavailable" : `${number(value, 1)}%`;
}
function record(player: MatchupPlayerAnalysis): string {
  const s = player.summary;
  return s === null ? "Unavailable" : `${s.wins}W–${s.losses}L${s.draws > 0 ? `–${s.draws}D` : ""}`;
}
function participantNotes(player: MatchupPlayerAnalysis, requestedCount: number): readonly string[] {
  const s = player.summary;
  if (!player.available || s === null) return [`Warning: ${player.player} form unavailable.`, ...qualityNotes(player.assessment)];
  const notes = [`${player.player}: Avg ${s.availableAverageCount}/${requestedCount}; 180s ${s.availableOneEightiesCount}/${requestedCount}; checkout ${s.availableCheckoutCount}/${requestedCount}.`,
    `Checkout hits/attempts: ${s.checkoutHits}/${s.checkoutAttempts}.`];
  if (s.matchCount < requestedCount || s.availableAverageCount < requestedCount || s.availableOneEightiesCount < requestedCount || s.availableCheckoutCount < requestedCount) notes.push("Warning: incomplete history or metric coverage.");
  if (s.unclassifiedResults > 0) notes.push(`Warning: ${s.unclassifiedResults} results could not be classified as win/loss/draw.`);
  return [...notes, ...qualityNotes(player.assessment)];
}

export function matchupImageReport(analysis: MatchupAnalysis, context: string, incomplete: boolean = false): ImageReport {
  const a = analysis.playerOne; const b = analysis.playerTwo;
  const requested = analysis.expectedAverageCount / 2;
  const headline = analysis.signal.code === "no-clear-edge" ? "No clear recent-form edge"
    : analysis.signal.code === "insufficient-data" ? "Insufficient data to compare"
      : `${analysis.signal.favoredPlayer ?? "Player"} leads on ${analysis.signal.code === "form-advantage" ? "recent average" : "recent average change"}`;
  const rows = [
    { label: "Average", values: [number(a.summary?.average), number(b.summary?.average)] },
    { label: "Checkout", values: [percentage(a.summary?.checkoutPercentage), percentage(b.summary?.checkoutPercentage)] },
    { label: "180s / match", values: [number(a.oneEightiesPerMatch), number(b.oneEightiesPerMatch)] },
    { label: "Record", values: [record(a), record(b)] },
    { label: "Avg change", values: [a.trend === null ? "Unavailable" : `${a.trend.delta > 0 ? "+" : ""}${number(a.trend.delta)} (${a.trend.windowSize} vs ${a.trend.windowSize})`, b.trend === null ? "Unavailable" : `${b.trend.delta > 0 ? "+" : ""}${number(b.trend.delta)} (${b.trend.windowSize} vs ${b.trend.windowSize})`] },
  ];
  const h2h = analysis.headToHead;
  const fullyCovered = [a, b].every(p => p.available && p.summary !== null && p.summary.matchCount === requested && p.summary.unclassifiedResults === 0 && p.summary.availableAverageCount === requested && p.summary.availableOneEightiesCount === requested && p.summary.availableCheckoutCount === requested);
  const notes = [...(incomplete ? ["Warning: report research is incomplete."] : []),
    ...(fullyCovered ? [`Data rows: average, 180s & checkout ${requested}/${requested} each.`,
      `Checkout hits/attempts: ${a.summary?.checkoutHits}/${a.summary?.checkoutAttempts} vs ${b.summary?.checkoutHits}/${b.summary?.checkoutAttempts}.`,
      ...qualityNotes(a.assessment), ...qualityNotes(b.assessment)] : [...participantNotes(a, requested), ...participantNotes(b, requested)]),
    h2h.meetings === 0 ? "H2H: no meetings found in the retrieved window." : `H2H in retrieved window: ${h2h.playerOneWins}–${h2h.playerTwoWins}${h2h.draws > 0 ? ` (${h2h.draws} draws)` : ""}.`,
  ];
  const card: ReportImageCard = { title: `${a.player} vs ${b.player}`, context: `${context} · Last ${requested} matches each`, takeaway: headline, columns: [a.player, b.player], rows, notes: [...new Set(notes)] };
  const text = [card.context, card.title, headline, ...rows.map(r => `${r.label}: ${r.values.join(" vs ")}`), ...card.notes,
    "Descriptive statistics, not a win prediction. Format, opponent adjustment & source freshness unverified."].join("\n");
  return { card, text, caption: `${context}\n${card.title}\n${headline}\nDescriptive form, not a win prediction.`.slice(0, 1024) };
}

export function playerImageReports(stats: PlayerStatsResult): readonly ImageReport[] {
  const rejected = stats.assessment?.validity.status === "rejected";
  if (rejected) return [{ text: "Research evidence rejected; statistics unavailable.", caption: "Research evidence rejected; statistics unavailable." }];
  const s = calculateMatchSummary(stats.matches);
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(stats.matches.length / pageSize));
  const notes = [`Average ${s.availableAverageCount}/${stats.requestedCount}; 180s ${s.availableOneEightiesCount}/${stats.requestedCount}; checkout ${s.availableCheckoutCount}/${stats.requestedCount}.`,
    `Weighted checkout: ${s.checkoutHits}/${s.checkoutAttempts} hits/attempts.`,
    ...(s.matchCount < stats.requestedCount || s.availableAverageCount < stats.requestedCount || s.availableOneEightiesCount < stats.requestedCount || s.availableCheckoutCount < stats.requestedCount ? ["Warning: incomplete history or metric coverage."] : []),
    ...(s.unclassifiedResults > 0 ? [`Warning: ${s.unclassifiedResults} results could not be classified as win/loss/draw.`] : []),
    ...qualityNotes(stats.assessment),
    ...(stats.evidence?.observedAt === undefined ? [] : [`Collected: ${stats.evidence.observedAt}`])];
  return Array.from({ length: pages }, (_, page): ImageReport => {
    const matches = stats.matches.slice(page * pageSize, (page + 1) * pageSize);
    const pageLabel = pages > 1 ? ` · ${page + 1}/${pages}` : "";
    const card: ReportImageCard = { title: stats.playerName, context: `${stats.sourceLabel} · Last ${stats.requestedCount} matches${pageLabel}`,
      takeaway: `${number(s.average)} average · ${s.wins}W–${s.losses}L${s.draws > 0 ? `–${s.draws}D` : ""}`,
      columns: ["Last matches"], rows: [
        { label: "Best average", values: [number(s.bestAverage)] },
        { label: "180s total", values: [number(s.totalOneEighties, 0)] },
        { label: "Checkout", values: [percentage(s.checkoutPercentage)] },
      ], notes, matchTable: matches.map(m => ({ date: m.date, opponent: m.opponent, result: m.result, score: m.score, average: number(m.average), oneEighties: number(m.oneEighties, 0), checkout: percentage(m.checkoutPercentage), event: m.tournament, round: m.round })) };
    // Each fallback page preserves its row context and proof URLs without losing later pages.
    const text = [card.context, card.title, card.takeaway, ...card.rows.map(r => `${r.label}: ${r.values.join(" vs ")}`),
      ...card.matchTable?.map((m, index) => `${page * pageSize + index + 1}. ${m.date} · ${m.opponent} · ${m.result} ${m.score}\nAvg ${m.average} · 180s ${m.oneEighties} · Checkout ${m.checkout}\n${m.event}${m.round === null ? "" : ` · ${m.round}`}`) ?? [], ...card.notes,
      "Descriptive statistics, not a win prediction. Format, opponent adjustment & source freshness unverified.",
      `Source: ${stats.sourceUrl}`, ...new Set([...stats.evidenceUrls.slice(page * pageSize, (page + 1) * pageSize), ...matches.flatMap(m => m.provenance === undefined ? [] : [m.provenance.sourceUrl])])].join("\n");
    return { card, text, caption: `${stats.playerName} · Last ${stats.requestedCount}${pages > 1 ? ` · Page ${page + 1}/${pages}` : " matches"}\n${stats.sourceUrl}`.slice(0, 1024) };
  });
}

export function limitImageReports(reports: readonly ImageReport[], imageLimit: number = MAX_REPORT_IMAGES): readonly ImageReport[] {
  if (!Number.isSafeInteger(imageLimit) || imageLimit < 0 || imageLimit > MAX_REPORT_IMAGES) throw new Error("Image limit must be between zero and MAX_REPORT_IMAGES.");
  const result: ImageReport[] = reports.slice(0, imageLimit);
  let text = "";
  for (const report of reports.slice(imageLimit)) {
    if (text.length > 0 && text.length + report.text.length + 2 > 3800) {
      result.push({ text, caption: "Additional matchups · text" }); text = "";
    }
    text += `${text === "" ? "" : "\n\n"}${report.text}`;
  }
  if (text !== "") result.push({ text, caption: "Additional matchups · text" });
  return result;
}

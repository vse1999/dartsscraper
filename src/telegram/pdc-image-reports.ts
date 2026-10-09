import type { PdcUpcomingReport } from "../pdc/service.js";
import { normalizePlayerName } from "../player/resolver.js";
import { analyzeMatchup } from "../services/matchup-analysis.js";
import { createModusPlayerKeyboard } from "./modus-player-callback.js";
import { limitImageReports, matchupImageReport } from "./image-report-model.js";
import type { ImageReport } from "./report-image.js";

export function pdcImageReports(report: PdcUpcomingReport): readonly ImageReport[] {
  const histories = new Map(report.players.flatMap(player => player.stats === null ? [] : [[normalizePlayerName(player.requestedName), player.stats] as const]));
  const incomplete = report.players.some(p => p.stats === null || p.failureCode !== null);
  const rows = report.fixtures.map(f => matchupImageReport(analyzeMatchup(f, histories.get(normalizePlayerName(f.playerOne)), histories.get(normalizePlayerName(f.playerTwo)), 10),
    `PDC · ${report.date} · ${f.startTime === null ? f.session ?? "Time TBC" : new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit" }).format(new Date(f.startTime))} · ${f.tournamentName}`, incomplete));
  return limitImageReports(rows);
}

export function pdcPlayerKeyboard(report: PdcUpcomingReport): ReturnType<typeof createModusPlayerKeyboard> {
  return createModusPlayerKeyboard(report.players.map(p => p.requestedName), 10);
}

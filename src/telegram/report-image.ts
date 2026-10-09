import { resolve } from "node:path";
import type { QualityAssessment } from "../research/quality.js";

export interface ReportImageRow {
  readonly label: string;
  readonly values: readonly string[];
}
export interface ReportMatchRow {
  readonly date: string;
  readonly opponent: string;
  readonly event: string;
  readonly round: string | null;
  readonly result: string;
  readonly score: string;
  readonly average: string;
  readonly oneEighties: string;
  readonly checkout: string;
}
export interface ReportImageCard {
  readonly title: string;
  readonly context: string;
  readonly takeaway: string;
  readonly columns: readonly string[];
  readonly rows: readonly ReportImageRow[];
  readonly notes: readonly string[];
  readonly matches?: readonly { readonly label: string; readonly statistics: string; readonly context?: string }[];
  readonly matchTable?: readonly ReportMatchRow[];
}
export interface ImageReport {
  /** Complete accessible text fallback; also suitable for legacy transports. */
  readonly text: string;
  readonly caption: string;
  readonly card?: ReportImageCard;
}
export const MAX_REPORT_IMAGES = 25;
export const MAX_REPORT_IMAGE_BYTES = 1_000_000;

export function reportImagesEnabled(environment: { readonly REPORT_IMAGES_ENABLED?: string }): boolean {
  const flag = environment.REPORT_IMAGES_ENABLED;
  if (flag === undefined || flag === "true") return true;
  if (flag === "false") return false;
  throw new Error("REPORT_IMAGES_ENABLED must be true or false.");
}

export function qualityNotes(assessment: QualityAssessment | undefined): readonly string[] {
  if (assessment?.validity.status === "rejected") return ["Evidence rejected; statistics unavailable."];
  const notes: string[] = [];
  if (assessment?.dimensions.observationAge === "stale") notes.push("Warning: collection is stale.");
  if (assessment?.dimensions.observationAge === "unknown") notes.push("Collection time unknown.");
  if (assessment?.dimensions.identity !== "canonical") notes.push("Player identity not independently verified.");
  if (assessment?.dimensions.ordering === "inconsistent") notes.push("Warning: source match order is inconsistent.");
  if (assessment?.dimensions.ordering === "date-ties") notes.push("Chronological trend limited by date ties.");
  return notes;
}

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** Conservative character wrapping avoids font-dependent clipping; all input remains text, never markup. */
function wrap(value: string, columns: number): readonly string[] {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  if (characters.length > 512) throw new Error("Report image text exceeds the bounded layout limit.");
  const lines: string[] = [];
  while (characters.length > columns) {
    let end = characters.slice(0, columns + 1).lastIndexOf(" ");
    if (end < columns / 2) end = columns;
    lines.push(characters.splice(0, end).join(""));
    if (characters[0] === " ") characters.shift();
  }
  if (characters.length > 0) lines.push(characters.join(""));
  return lines;
}

function wrapPersonalText(value: string, size: number, width: number): readonly string[] {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  if (characters.length > 512) throw new Error("Report image text exceeds the bounded layout limit.");
  const glyphWidth = (character: string): number => {
    if (/[WMwm]/u.test(character)) return size;
    if (/[ilIjtfr]/u.test(character)) return size * 0.45;
    if (/[\s.,:;|'!]/u.test(character)) return size * 0.35;
    if (/[A-Z]/u.test(character)) return size * 0.8;
    if (/[a-z0-9]/u.test(character)) return size * 0.65;
    return size;
  };
  const lines: string[] = [];
  while (characters.length > 0) {
    let end = 0; let used = 0; let lastSpace = -1;
    while (end < characters.length) {
      const character = characters[end] ?? "";
      if (end > 0 && used + glyphWidth(character) > width) break;
      used += glyphWidth(character); if (character === " ") lastSpace = end; end += 1;
    }
    if (end < characters.length && lastSpace > 0) end = lastSpace;
    lines.push(characters.splice(0, Math.max(1, end)).join(""));
    if (characters[0] === " ") characters.shift();
  }
  return lines;
}

export function renderReportSvg(card: ReportImageCard): string {
  if (card.columns.length < 1 || card.columns.length > 2 || card.rows.length > 8 || card.notes.length > 16 || (card.matches?.length ?? 0) > 5 || (card.matchTable?.length ?? 0) > 10) {
    throw new Error("Report image exceeds the bounded card layout.");
  }
  if (card.matchTable !== undefined) return renderPlayerSvg(card);
  const parts: string[] = [];
  let y = 48;
  const text = (value: string, size: number = 26, color: string = "#edf4fa", x: number = 36, width: number = 828): void => {
    const lines = wrap(value, Math.max(1, Math.floor(width / (size * 0.7))));
    for (const line of lines) { parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${xml(line)}</text>`); y += size * 1.4; }
  };
  text(card.context, 24, "#b4c5d5"); y += 12;
  text(card.title, 36); y += 14;
  text(card.takeaway, 29, "#89dac0"); y += 22;
  const start = y;
  const valuesX = card.columns.length === 1 ? [460] : [350, 620];
  let headersEnd = y;
  card.columns.forEach((name: string, index: number): void => {
    y = start; text(name, 24, "#b4c5d5", valuesX[index] ?? 460, card.columns.length === 1 ? 390 : 240); headersEnd = Math.max(headersEnd, y);
  });
  y = headersEnd + 10;
  for (const row of card.rows) {
    if (row.values.length !== card.columns.length) throw new Error("Report image metric columns do not match.");
    const rowStart = y;
    text(row.label, 26, "#b4c5d5", 36, 280);
    let rowEnd = y;
    row.values.forEach((value: string, index: number): void => { y = rowStart; text(value, 28, "#edf4fa", valuesX[index] ?? 460, card.columns.length === 1 ? 390 : 240); rowEnd = Math.max(rowEnd, y); });
    y = rowEnd + 14;
  }
  for (const match of card.matches ?? []) {
    y += 14; text(match.label, 24); text(match.statistics, 24, "#b4c5d5");
    if (match.context !== undefined) text(match.context, 21, "#b4c5d5");
  }
  y += 20;
  for (const note of card.notes) text(note, 23, note.startsWith("Warning:") ? "#ffd188" : "#b4c5d5");
  y += 16; text("Descriptive statistics, not a win prediction.", 23, "#b4c5d5");
  text("Format, opponent adjustment & source freshness unverified.", 23, "#b4c5d5");
  if (y > 2400) throw new Error("Report image exceeds the readable page height.");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${Math.ceil(y + 22)}"><rect width="900" height="100%" fill="#182735"/><g font-family="Noto Sans">${parts.join("")}</g></svg>`;
}

/** One complete ten-match page: aligned numeric columns, a compact summary, and quiet context. */
function renderPlayerSvg(card: ReportImageCard): string {
  const parts: string[] = [];
  let y = 42;
  const line = (value: string, x: number, baseline: number, size: number, color: string = "#edf4fa", anchor: "start" | "end" = "start"): void => {
    parts.push(`<text x="${x}" y="${baseline}" font-size="${size}" text-anchor="${anchor}" fill="${color}">${xml(value)}</text>`);
  };
  const block = (value: string, x: number, baseline: number, size: number, width: number, color: string = "#edf4fa"): number => {
    const lines = wrapPersonalText(value, size, width);
    lines.forEach((value: string, index: number): void => line(value, x, baseline + index * size * 1.35, size, color));
    return baseline + lines.length * size * 1.35;
  };
  y = block(card.context, 32, y, 22, 836, "#b4c5d5");
  y = block(card.title, 32, y + 6, 36, 836);
  y = block(card.takeaway, 32, y + 8, 28, 836, "#89dac0");
  const summaryStart = y + 10;
  let summaryEnd = summaryStart;
  card.rows.forEach((row: ReportImageRow, index: number): void => {
    if (row.values.length !== 1 || index >= 3) throw new Error("Personal summary requires three single-value metrics.");
    const x = 32 + index * 286;
    const labelEnd = block(row.label, x, summaryStart, 21, 260, "#b4c5d5");
    summaryEnd = Math.max(summaryEnd, block(row.values[0] ?? "Unavailable", x, labelEnd + 4, 29, 260));
  });
  y = summaryEnd + 26;
  parts.push(`<path d="M32 ${y - 10}H868" stroke="#3a4e60"/>`);
  line("Date", 32, y + 15, 21, "#b4c5d5");
  line("Opponent / round", 146, y + 15, 21, "#b4c5d5");
  line("Result", 506, y + 15, 21, "#b4c5d5", "end");
  line("Avg", 646, y + 15, 21, "#b4c5d5", "end");
  line("180s", 736, y + 15, 21, "#b4c5d5", "end");
  line("CO", 868, y + 15, 21, "#b4c5d5", "end");
  y += 52;
  const events = [...new Set((card.matchTable ?? []).map(row => row.event))];
  const eventKeys = new Map(events.map((event: string, index: number) => [event, String.fromCharCode(65 + index)]));
  for (const [index, row] of (card.matchTable ?? []).entries()) {
    const top = y;
    // The year remains visible; dates are split over two aligned lines instead of squeezed.
    const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(row.date);
    line(date === null ? row.date : `${date[3]}/${date[2]}`, 32, top, 22);
    if (date !== null) line(`${date[1]} · ${eventKeys.get(row.event) ?? ""}`, 32, top + 25, 17, "#b4c5d5");
    const opponentEnd = block(row.opponent, 146, top, 24, 285);
    const roundEnd = row.round === null ? opponentEnd : block(row.round, 146, opponentEnd + 1, 20, 285, "#b4c5d5");
    const result = row.result.toLocaleLowerCase("en-US");
    const marker = ["won", "win", "w"].includes(result) ? "W" : ["lost", "loss", "l"].includes(result) ? "L" : ["draw", "drawn", "d"].includes(result) ? "D" : "?";
    const score = row.score.replace(/\s*V\s*/giu, "–");
    const color = marker === "W" ? "#89dac0" : marker === "L" ? "#ffb8af" : "#edf4fa";
    const resultEnd = block(`${marker} ${score}`, 445, top, 21, 76, color);
    line(row.average === "Unavailable" ? "—" : row.average, 646, top, 25, "#edf4fa", "end");
    line(row.oneEighties === "Unavailable" ? "—" : row.oneEighties, 736, top, 25, "#edf4fa", "end");
    line(row.checkout === "Unavailable" ? "—" : row.checkout, 868, top, 25, "#edf4fa", "end");
    y = Math.max(top + 50, roundEnd, resultEnd) + 16;
    if (index < (card.matchTable?.length ?? 0) - 1) parts.push(`<path d="M32 ${y - 24}H868" stroke="#2b4050"/>`);
  }
  y += 16;
  y = block("Avg: 3-dart average · CO: checkout % · —: unavailable", 32, y, 20, 836, "#b4c5d5");
  for (const event of events) y = block(`${eventKeys.get(event) ?? ""} · ${event}`, 32, y, 20, 836, "#b4c5d5");
  for (const note of card.notes) y = block(note, 32, y + 2, 20, 836, note.startsWith("Warning:") ? "#ffd188" : "#b4c5d5");
  y = block("Descriptive statistics, not a win prediction.", 32, y + 12, 20, 836, "#b4c5d5");
  y = block("Format, opponent adjustment & source freshness unverified.", 32, y, 20, 836, "#b4c5d5");
  if (y > 2400) throw new Error("Personal report exceeds the readable page height; use text instead.");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${Math.ceil(y + 18)}"><rect width="900" height="100%" fill="#182735"/><g font-family="Noto Sans">${parts.join("")}</g></svg>`;
}

export async function renderReportImage(card: ReportImageCard, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const svg = renderReportSvg(card);
  const { renderAsync } = await import("@resvg/resvg-js");
  signal?.throwIfAborted();
  // napi-rs consumes a signal's native binding. Give each render a fresh child signal;
  // reusing the report's signal directly causes subsequent pages to fail.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const image = await renderAsync(svg, { font: { loadSystemFonts: false, fontFiles: [resolve(process.cwd(), "public/fonts/noto-sans.ttf")], defaultFontFamily: "Noto Sans" }, logLevel: "off" }, controller.signal);
    signal?.throwIfAborted();
    const png = image.asPng();
    if (png.byteLength > MAX_REPORT_IMAGE_BYTES) throw new Error("Report image exceeds the upload budget; use text instead.");
    return png;
  } finally { signal?.removeEventListener("abort", abort); }
}

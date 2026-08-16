import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import {
  MODUS_MATCH_DETAILS_URL,
  MODUS_RESULTS_URL,
  ModusMatchReferenceSchema,
  type ModusMatchReference,
  type ModusResultGroup,
  type ModusSeriesDescriptor,
  type ModusWeekDescriptor,
} from "./history-schemas.js";

export interface ParsedModusResultsPage {
  readonly series: readonly Omit<ModusSeriesDescriptor, "weeks">[];
  readonly weeks: readonly ModusWeekDescriptor[];
  readonly selectedSeriesId: string;
  readonly selectedWeekId: string;
  readonly selectedGroup: ModusResultGroup;
  readonly matches: readonly ModusMatchReference[];
}

export function buildModusResultsUrl(seriesId: string, weekId: string, group: ModusResultGroup): string {
  requireNumericId(seriesId, "seriesId");
  requireNumericId(weekId, "weekId");
  const url = new URL(MODUS_RESULTS_URL);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("week_id", weekId);
  url.searchParams.set("group", group);
  return url.toString();
}

export function buildModusMatchDetailsUrl(matchId: string): string {
  requireNumericId(matchId, "matchId");
  const url = new URL(MODUS_MATCH_DETAILS_URL);
  url.searchParams.set("match_id", matchId);
  return url.toString();
}

export function parseModusResultsPage(html: string, sourceUrl = MODUS_RESULTS_URL): ParsedModusResultsPage {
  if (html.trim() === "") throw new Error("The official MODUS results page was empty.");
  const source = validateResultsUrl(sourceUrl);
  const $ = cheerio.load(html);
  const series = parseOptions($, "#seriesSelect", "series");
  const weeks = parseOptions($, "#weekSelect", "week");
  const selectedSeriesId = selectedOptionId($, "#seriesSelect", "series");
  const selectedWeekId = selectedOptionId($, "#weekSelect", "week");
  const selectedSeries = series.find((item) => item.id === selectedSeriesId);
  const selectedWeek = weeks.find((item) => item.id === selectedWeekId);
  if (selectedSeries === undefined || selectedWeek === undefined) {
    throw new Error("The selected MODUS series or week was not present in its option list.");
  }
  const selectedGroup = parseSelectedGroup($);
  const matches = parseFixtureCards(
    $,
    source,
    selectedSeries,
    selectedWeek,
    selectedGroup,
  );
  return {
    series,
    weeks,
    selectedSeriesId,
    selectedWeekId,
    selectedGroup,
    matches,
  };
}

function parseOptions(
  $: cheerio.CheerioAPI,
  selector: string,
  label: string,
): Array<{ id: string; name: string; order: number }> {
  const options = $(selector).find("option");
  if (options.length === 0) throw new Error(`No official MODUS ${label} options were found.`);
  return options.map((order, element) => {
    const id = normalizeText($(element).attr("value") ?? "");
    const name = normalizeText($(element).text());
    requireNumericId(id, `${label} id`);
    if (name === "") throw new Error(`An official MODUS ${label} option had no name.`);
    return { id, name, order };
  }).get();
}

function selectedOptionId($: cheerio.CheerioAPI, selector: string, label: string): string {
  const selected = $(selector).find("option[selected]");
  if (selected.length !== 1) {
    throw new Error(`Expected one selected official MODUS ${label}, found ${selected.length}.`);
  }
  const id = normalizeText(selected.attr("value") ?? "");
  requireNumericId(id, `selected ${label} id`);
  return id;
}

function parseSelectedGroup($: cheerio.CheerioAPI): ModusResultGroup {
  const name = normalizeText($(".group-tabs button.active").first().text());
  if (name === "Group A" || name === "Group B" || name === "Group C" || name === "Final") return name;
  throw new Error(`The official MODUS results page has an invalid selected group ${JSON.stringify(name)}.`);
}

function parseFixtureCards(
  $: cheerio.CheerioAPI,
  sourceUrl: URL,
  series: Omit<ModusSeriesDescriptor, "weeks">,
  week: ModusWeekDescriptor,
  group: ModusResultGroup,
): ModusMatchReference[] {
  const matches: ModusMatchReference[] = [];
  $(".fixture-card").each((cardIndex, card) => {
    const matchId = matchIdFromCard($, card, sourceUrl);
    if (matchId === undefined) return;
    const names = $(card).find(".player-row").map((_rowIndex, row) => {
      const clone = $(row).clone();
      clone.find(".score").remove();
      return normalizeText(clone.text());
    }).get();
    if (names.length !== 2 || names.some((name) => name === "")) {
      throw new Error(`Official MODUS match ${matchId} did not contain exactly two player names.`);
    }
    const label = normalizeText($(card).find(".match-label").text());
    const matchNumberText = /\bMatch\s+(\d+)\b/iu.exec(label)?.[1];
    // Historical final cards use labels such as "Semi Final" rather than a
    // number. Their stable page order is the only official ordinal available.
    const matchNumber = matchNumberText === undefined ? cardIndex + 1 : Number(matchNumberText);
    const parsed = ModusMatchReferenceSchema.safeParse({
      matchId,
      seriesId: series.id,
      seriesName: series.name,
      seriesOrder: series.order,
      weekId: week.id,
      weekName: week.name,
      weekOrder: week.order,
      group,
      matchNumber,
      homeName: names[0],
      awayName: names[1],
    });
    if (!parsed.success) throw new Error(`Official MODUS match ${matchId} failed validation.`);
    matches.push(parsed.data);
  });
  return matches;
}

function matchIdFromCard($: cheerio.CheerioAPI, card: Element, sourceUrl: URL): string | undefined {
  const onclick = $(card).attr("onclick") ?? "";
  const path = /location\.href\s*=\s*["']([^"']*match-db-stats\.php\?[^"']+)["']/iu.exec(onclick)?.[1];
  if (path === undefined) return undefined;
  const detailsUrl = new URL(path.replaceAll("&amp;", "&"), sourceUrl);
  const allowed = new URL(MODUS_MATCH_DETAILS_URL);
  if (detailsUrl.protocol !== allowed.protocol || detailsUrl.host !== allowed.host || detailsUrl.pathname !== allowed.pathname) {
    throw new Error("An official MODUS fixture card pointed outside the allowed match-details endpoint.");
  }
  const matchId = detailsUrl.searchParams.get("match_id") ?? "";
  requireNumericId(matchId, "fixture-card match_id");
  return matchId;
}

function validateResultsUrl(value: string): URL {
  const parsed = new URL(value);
  const allowed = new URL(MODUS_RESULTS_URL);
  if (parsed.protocol !== allowed.protocol || parsed.host !== allowed.host || parsed.pathname !== allowed.pathname) {
    throw new Error("Only the official MODUS results endpoint can be parsed.");
  }
  return parsed;
}

function requireNumericId(value: string, label: string): void {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must contain only digits.`);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

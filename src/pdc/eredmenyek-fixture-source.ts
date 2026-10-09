import * as cheerio from "cheerio";

import { IsoDateSchema, resolveResearchDate } from "../agent/date.js";
import { noopLogger, type Logger } from "../logger.js";
import { modusNameBaseKey } from "../modus/identity.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import type { PdcFixtureNameResolver } from "./darts-nerd-fixture-source.js";
import { OfficialPdcScheduleUnavailableError } from "./official-api-fixture-source.js";
import { PdcFixtureSchema, type PdcFixture, type PdcFixtureSource } from "./schemas.js";

const ORIGIN = "https://m.eredmenyek.com";
const MAX_FIXTURES = 128;

interface ListedFixture {
  readonly tournamentName: string;
  readonly playerOne: string;
  readonly playerTwo: string;
  readonly url: string;
}

export interface EredmenyekPdcFixtureSourceOptions {
  readonly officialSource: PdcFixtureSource;
  readonly resolver?: PdcFixtureNameResolver;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/** Provider pairings for a dated, officially verified event whose draw API is empty. */
export class EredmenyekPdcFixtureSource implements PdcFixtureSource {
  public readonly name = "official PDC calendar with Eredmenyek pairing fallback";
  private readonly options: EredmenyekPdcFixtureSourceOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  public constructor(options: EredmenyekPdcFixtureSourceOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? noopLogger;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Eredmenyek timeoutMs must be positive and finite.");
  }

  public async getFixtures(date: string, signal?: AbortSignal): Promise<readonly PdcFixture[]> {
    const validatedDate = IsoDateSchema.parse(date);
    throwIfAborted(signal);
    try {
      return await this.options.officialSource.getFixtures(validatedDate, signal);
    } catch (error: unknown) {
      throwIfAborted(signal);
      // A provider competition label alone cannot establish official PDC membership.
      if (!(error instanceof OfficialPdcScheduleUnavailableError) || error.date !== validatedDate || error.tournamentNames.length === 0) throw error;
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("Eredmenyek fixture fallback timed out.")), this.timeoutMs);
      try {
        const fixtures = await this.discover(validatedDate, error.tournamentNames, controller.signal);
        if (error.tournamentNames.some((event) => !fixtures.some((fixture) => fixture.tournamentName === event))) throw new Error("Eredmenyek did not cover every missing official event.");
        this.logger.info("Eredmenyek supplied dated PDC pairings for an official event.", { date: validatedDate, fixtureCount: fixtures.length });
        return [...error.availableFixtures, ...fixtures];
      } catch (fallbackError: unknown) {
        throwIfAborted(signal);
        this.logger.warn("Eredmenyek PDC pairing fallback unavailable.", { date: validatedDate, errorType: fallbackError instanceof Error ? fallbackError.name : "UnknownError", reason: fallbackError instanceof Error ? fallbackError.message : "Unknown failure" });
        throw error;
      } finally {
        clearTimeout(timeout);
        controller.abort(new Error("Eredmenyek fallback finished."));
        signal?.removeEventListener("abort", abort);
      }
    }
  }

  private async discover(date: string, events: readonly string[], signal: AbortSignal): Promise<readonly PdcFixture[]> {
    const today = resolveResearchDate("today", { now: this.options.now?.() ?? new Date(), timeZone: "Europe/Budapest" }).date;
    const offset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (Math.abs(offset) > 7) throw new Error("Eredmenyek lightweight schedule supports only seven days either side of today.");
    const listUrl = `${ORIGIN}/darts/?d=${offset}&s=1`;
    const listed = parseEredmenyekPdcSchedule(await this.read(listUrl, signal), events);
    if (listed.length > MAX_FIXTURES) throw new Error("Eredmenyek fixture safety limit exceeded.");
    const fixtures: PdcFixture[] = [];
    // Bounded batches avoid launching one request per match simultaneously.
    for (let index = 0; index < listed.length; index += 4) {
      const batch = await Promise.all(listed.slice(index, index + 4).map(async (row): Promise<PdcFixture | null> => {
        const detail = parseEredmenyekPdcDetail(await this.read(row.url, signal), row);
        if (detail.date !== date) return null;
        return PdcFixtureSchema.parse({
          id: `eredmenyek:${new URL(row.url).pathname.split("/")[2]}`, tournamentName: row.tournamentName,
          date, startTime: null, session: `${detail.time} (Eredmenyek display time)`, round: null,
          playerOne: await this.resolve(detail.playerOne, signal), playerTwo: await this.resolve(detail.playerTwo, signal),
          sourceUrl: row.url, evidenceUrls: ["https://www.pdc.tv/matches", listUrl, row.url],
        });
      }));
      fixtures.push(...batch.filter((row): row is PdcFixture => row !== null));
    }
    return fixtures;
  }

  private async resolve(name: string, signal: AbortSignal): Promise<string> {
    if (this.options.resolver === undefined) return name;
    try { return await this.options.resolver.resolve(name, signal); }
    catch (error: unknown) {
      throwIfAborted(signal);
      this.logger.warn("Eredmenyek player directory resolution unavailable; retaining source-backed name.", { errorType: error instanceof Error ? error.name : "UnknownError" });
      return name;
    }
  }

  private async read(url: string, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const response = await waitWithSignal(this.fetchImpl(url, { signal, redirect: "error", headers: { Accept: "text/html", "User-Agent": "DartsResearchAgent/0.8" } }), signal);
    if (!response.ok) throw new Error(`Eredmenyek fixture request returned HTTP ${response.status}.`);
    const html = await waitWithSignal(response.text(), signal);
    if (html.length > 1_000_000 || html.trim() === "") throw new Error("Eredmenyek fixture response was empty or oversized.");
    return html;
  }
}

export function parseEredmenyekPdcSchedule(html: string, officialEvents: readonly string[]): readonly ListedFixture[] {
  const $ = cheerio.load(html);
  if ($("#score-data").length !== 1) throw new Error("Eredmenyek schedule markup is unavailable.");
  const fixtures: ListedFixture[] = [];
  const seen = new Set<string>();
  let event: string | undefined;
  let label = "";
  for (const node of $("#score-data").contents().toArray()) {
    if (node.type === "tag" && node.name === "h4") {
      const matches = officialEvents.filter((candidate) => sameEvent($(node).text().replace(/^[^:]+:\s*/u, ""), candidate));
      if (matches.length > 1) throw new Error("Eredmenyek competition maps ambiguously to official PDC events.");
      event = matches[0]; label = "";
    } else if (node.type === "text") label += node.data;
    else if (node.type === "tag" && node.name === "a" && event !== undefined) {
      const names = text(label).split(" - ");
      const playerOne = stripCountry(names[0] ?? "");
      const playerTwo = stripCountry(names[1] ?? "");
      if (names.length !== 2 || !namedPlayer(playerOne) || !namedPlayer(playerTwo)) throw new Error("Eredmenyek PDC row lacks two concrete players.");
      const url = matchUrl($(node).attr("href") ?? "");
      if (seen.has(url)) throw new Error("Eredmenyek repeated a match row.");
      seen.add(url);
      fixtures.push({ tournamentName: event, playerOne, playerTwo, url });
      label = "";
    } else if (node.type === "tag" && node.name === "br") label = "";
  }
  return fixtures;
}

export function parseEredmenyekPdcDetail(html: string, row: Pick<ListedFixture, "playerOne" | "playerTwo">): {
  readonly date: string; readonly time: string; readonly playerOne: string; readonly playerTwo: string;
} {
  const $ = cheerio.load(html);
  const players = $("#main h3 a").toArray();
  const one = players[0]; const two = players[1];
  if (players.length !== 2 || one === undefined || two === undefined || text($(one).text()) !== row.playerOne || text($(two).text()) !== row.playerTwo) throw new Error("Eredmenyek match detail disagrees with scheduled participants.");
  const dates = $("#main > .detail").toArray().map((node) => text($(node).text())).filter((value) => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/u.test(value));
  if (dates.length !== 1) throw new Error("Eredmenyek match detail lacks an explicit unambiguous date and time.");
  const parts = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})$/u.exec(dates[0] ?? "");
  if (parts === null || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(parts[4] ?? "")) throw new Error("Eredmenyek match detail has an invalid time.");
  return {
    date: IsoDateSchema.parse(`${parts[3]}-${parts[2]}-${parts[1]}`), time: parts[4] ?? "",
    playerOne: profileName(row.playerOne, $(one).attr("href") ?? ""),
    playerTwo: profileName(row.playerTwo, $(two).attr("href") ?? ""),
  };
}

function sameEvent(provider: string, official: string): boolean {
  const left = modusNameBaseKey(provider); const right = modusNameBaseKey(official);
  if (/\b(?:qualifier|qualifiers|qualification)\b/u.test(left) !== /\b(?:qualifier|qualifiers|qualification)\b/u.test(right)) return false;
  const providerTour = /^european tour (\d+)$/u.exec(left)?.[1];
  const officialTour = /\bet\s*(\d+)\b/u.exec(right)?.[1];
  const officialTitle = right.replace(/^\d{4} /u, "").replace(/^pdc /u, "").replace(/^et\s*\d+ /u, "");
  return (providerTour !== undefined && officialTour === providerTour) || left === officialTitle;
}

function profileName(label: string, href: string): string {
  // The provider supplies surname-first full-name slugs; use only a slug whose
  // surname AND given-name prefix agree with the displayed abbreviated label.
  let url: URL;
  try { url = new URL(href); } catch { return label; }
  if (url.origin !== "https://www.eredmenyek.com") return label;
  const slug = /^\/csapat\/([a-z0-9-]+)\/[A-Za-z0-9]+\/$/u.exec(url.pathname)?.[1];
  const abbreviation = /^(.*) ([\p{L}]+)\.$/u.exec(label);
  if (slug === undefined || abbreviation === null) return label;
  const surname = abbreviation[1] ?? "";
  const prefix = modusNameBaseKey(surname).replace(/ /gu, "-");
  if (!slug.startsWith(`${prefix}-`)) return label;
  const given = slug.slice(prefix.length + 1).replace(/-/gu, " ");
  if (!given.startsWith(modusNameBaseKey(abbreviation[2] ?? "")) || given === "") return label;
  return `${given.replace(/\b\p{L}/gu, (letter: string): string => letter.toLocaleUpperCase("en-US"))} ${surname}`;
}

function matchUrl(href: string): string {
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || url.username !== "" || url.password !== "" || !/^\/merkozes\/[A-Za-z0-9]{8}\/$/u.test(url.pathname) || !["", "?s=1"].includes(url.search) || url.hash !== "") throw new Error("Eredmenyek supplied an untrusted match URL.");
  url.search = "";
  return url.toString();
}
function stripCountry(value: string): string { return text(value).replace(/\s+\([A-Za-z]{2,3}\)$/u, ""); }
function namedPlayer(value: string): boolean { return value !== "" && value !== "?" && !/^(?:winner|loser|tba|tbc|bye|unknown|to be confirmed)\b/iu.test(value); }
function text(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); }

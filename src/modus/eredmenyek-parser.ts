import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import { dateInTimeZone, IsoDateSchema } from "../agent/date.js";
import { normalizePlayerName } from "../player/resolver.js";
import { modusNameParts, parseModusAbbreviatedName } from "./identity.js";

const DEFAULT_ORIGIN = "https://m.eredmenyek.com";
const MODUS_EVENT_NAME = /^MODUS\s+Super\s+Series$/iu;
const MATCH_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const MATCH_DETAIL_PATH = /^\/merkozes\/([A-Za-z0-9]{8})\/$/u;

export interface ListedModusFixture {
  readonly matchId: string;
  readonly matchUrl: string;
  readonly scheduledTime: string;
}

export interface ParsedModusDetail {
  readonly playerOne: string;
  readonly playerTwo: string;
  readonly date: string;
  readonly time: string;
  readonly startTime: string;
}

export class EredmenyekModusScheduleDateMismatchError extends Error {
  public readonly actualDate: string;
  public readonly requestedDate: string;

  public constructor(requestedDate: string, actualDate: string) {
    super(`Eredmenyek MODUS detail date ${actualDate} does not match requested schedule date ${requestedDate}.`);
    this.name = new.target.name;
    this.actualDate = actualDate;
    this.requestedDate = requestedDate;
  }
}

export function parseEredmenyekModusSchedule(
  html: string,
  dateOffset: number,
  origin: string = DEFAULT_ORIGIN,
): readonly ListedModusFixture[] {
  if (!Number.isSafeInteger(dateOffset) || Math.abs(dateOffset) > 7) throw new Error("Eredmenyek MODUS date offset must be within seven days.");
  const safeOrigin = validatedOrigin(origin);
  const $ = cheerio.load(html);
  const scoreData = $("#score-data");
  if (scoreData.length !== 1) throw new Error("Eredmenyek MODUS schedule markup is unavailable.");

  const fixtures: ListedModusFixture[] = [];
  const seen = new Set<string>();
  let inModusEvent = false;
  let scheduledTime = "";
  for (const node of scoreData.contents().toArray()) {
    if (node.type === "tag" && node.name === "h4") {
      inModusEvent = isModusEvent($(node).text());
      scheduledTime = "";
      continue;
    }
    if (!inModusEvent) continue;
    if (node.type === "tag" && node.name === "span") {
      scheduledTime = normalizedText($(node).text());
      continue;
    }
    if (node.type === "tag" && node.name === "br") {
      scheduledTime = "";
      continue;
    }
    if (node.type !== "tag" || node.name !== "a" || !hasClass(node, "sched")) continue;
    if (!MATCH_TIME.test(scheduledTime)) throw new Error("Eredmenyek MODUS schedule row lacks an explicit local start time.");
    const match = parseMatchUrl($(node).attr("href") ?? "", safeOrigin, dateOffset);
    if (seen.has(match.matchId)) throw new Error("Eredmenyek MODUS repeated a match row.");
    seen.add(match.matchId);
    fixtures.push({ ...match, scheduledTime });
    scheduledTime = "";
  }
  return fixtures;
}

export function parseEredmenyekModusDetail(
  html: string,
  row: ListedModusFixture,
  requestedDate: string,
  timeZone: string = "Europe/Budapest",
): ParsedModusDetail {
  const date = IsoDateSchema.parse(requestedDate);
  const $ = cheerio.load(html);
  const players = $("#main h3 a").toArray();
  if (players.length !== 2) throw new Error("Eredmenyek MODUS match detail must contain exactly two player profiles.");
  const first = players[0];
  const second = players[1];
  if (first === undefined || second === undefined) throw new Error("Eredmenyek MODUS match detail is missing a player profile.");
  const playerOneLabel = stripCountry(normalizedText($(first).text()));
  const playerTwoLabel = stripCountry(normalizedText($(second).text()));
  if (!isNamedPlayer(playerOneLabel) || !isNamedPlayer(playerTwoLabel) || normalizePlayerName(playerOneLabel) === normalizePlayerName(playerTwoLabel)) {
    throw new Error("Eredmenyek MODUS match detail does not identify two different players.");
  }

  const dates = $("#main > .detail").toArray()
    .map((element: Element): string => normalizedText($(element).text()))
    .filter((value: string): boolean => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/u.test(value));
  if (dates.length !== 1) throw new Error("Eredmenyek MODUS detail lacks an explicit unambiguous date and time.");
  const parsedDate = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})$/u.exec(dates[0] ?? "");
  if (parsedDate === null) throw new Error("Eredmenyek MODUS detail has an invalid local date and time.");
  const detailDate = IsoDateSchema.parse(`${parsedDate[3]}-${parsedDate[2]}-${parsedDate[1]}`);
  const time = parsedDate[4] ?? "";
  if (detailDate !== date) throw new EredmenyekModusScheduleDateMismatchError(date, detailDate);
  if (time !== row.scheduledTime) throw new Error("Eredmenyek MODUS detail disagrees with the listed start time.");
  const startTime = localDateTimeToIso(detailDate, time, timeZone);
  if (dateInTimeZone(startTime, timeZone) !== date) throw new Error("Eredmenyek MODUS start time resolves to a different local date.");

  return {
    playerOne: profileName(playerOneLabel, $(first).attr("href") ?? "") ?? playerOneLabel,
    playerTwo: profileName(playerTwoLabel, $(second).attr("href") ?? "") ?? playerTwoLabel,
    date: detailDate,
    time,
    startTime,
  };
}

function parseMatchUrl(href: string, origin: string, dateOffset: number): Pick<ListedModusFixture, "matchId" | "matchUrl"> {
  let url: URL;
  try {
    url = new URL(href, `${origin}/`);
  } catch {
    throw new Error("Eredmenyek MODUS supplied an invalid match URL.");
  }
  const match = MATCH_DETAIL_PATH.exec(url.pathname);
  const allowedQuery = [...url.searchParams.entries()].every(([key, value]): boolean =>
    (key === "s" && value === "1") || (key === "d" && value === String(dateOffset)));
  if (url.protocol !== "https:" || url.origin !== origin || url.username !== "" || url.password !== ""
    || url.hash !== "" || match?.[1] === undefined || url.searchParams.getAll("s").length !== 1
    || url.searchParams.getAll("d").length !== 1 || !allowedQuery) {
    throw new Error("Eredmenyek MODUS supplied an untrusted match URL.");
  }
  return { matchId: match[1], matchUrl: url.toString() };
}

function profileName(label: string, href: string): string | undefined {
  const abbreviation = parseModusAbbreviatedName(label);
  if (abbreviation === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.origin !== "https://www.eredmenyek.com" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  const slug = /^\/csapat\/([a-z0-9-]+)\/[A-Za-z0-9]+\/$/u.exec(url.pathname)?.[1];
  if (slug === undefined) return undefined;
  const slugParts = modusNameParts(slug.replace(/-/gu, " "));
  const surnameParts = abbreviation.surnameParts;
  if (slugParts.length <= surnameParts.length) return undefined;
  if (slugParts.slice(0, surnameParts.length).join(" ") !== surnameParts.join(" ")) return undefined;
  const givenParts = slugParts.slice(surnameParts.length);
  if (givenParts.length < abbreviation.initials.length
    || !abbreviation.initials.every((initial: string, index: number): boolean => (givenParts[index] ?? "").startsWith(initial))) return undefined;
  const labelParts = label.split(/\s+/u);
  while (labelParts.length > 0 && /^[\p{L}]\.$/u.test(labelParts.at(-1) ?? "")) labelParts.pop();
  const surname = labelParts.join(" ").trim();
  if (surname === "") return undefined;
  const given = givenParts.map(capitalizeNamePart).join(" ");
  return `${given} ${surname}`;
}

function localDateTimeToIso(date: string, time: string, timeZone: string): string {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(IsoDateSchema.parse(date));
  const timeParts = /^(\d{2}):(\d{2})$/u.exec(time);
  if (dateParts === null || timeParts === null || !MATCH_TIME.test(time)) throw new Error("Eredmenyek MODUS supplied an invalid local date-time.");
  const year = Number(dateParts[1]);
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(localAsUtc);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new Error("Eredmenyek MODUS supplied an invalid calendar date.");
  }

  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = localDateTimeParts(new Date(candidate), timeZone);
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute);
    const correction = localAsUtc - renderedAsUtc;
    if (correction === 0) break;
    candidate += correction;
  }
  if (!sameLocalDateTime(localDateTimeParts(new Date(candidate), timeZone), { year, month, day, hour, minute })) {
    throw new Error("Eredmenyek MODUS local start time does not exist in the configured timezone.");
  }
  for (const delta of [-60 * 60_000, 60 * 60_000]) {
    if (sameLocalDateTime(localDateTimeParts(new Date(candidate + delta), timeZone), { year, month, day, hour, minute })) {
      throw new Error("Eredmenyek MODUS local start time is ambiguous in the configured timezone.");
    }
  }
  return new Date(candidate).toISOString();
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function localDateTimeParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  const result = { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
  if (!Object.values(result).every(Number.isSafeInteger)) throw new Error("Could not resolve Eredmenyek MODUS local time.");
  return result;
}

function sameLocalDateTime(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

function validatedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Eredmenyek origin must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Eredmenyek origin must be a plain HTTPS origin.");
  }
  return url.origin;
}

function isModusEvent(value: string): boolean {
  const eventName = normalizedText(value).replace(/^[^:]+:\s*/u, "");
  return MODUS_EVENT_NAME.test(eventName);
}

function hasClass(element: Element, className: string): boolean {
  return (element.attribs.class ?? "").split(/\s+/u).includes(className);
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function stripCountry(value: string): string {
  return normalizedText(value).replace(/\s+\([A-Za-z]{2,3}\)$/u, "").trim();
}

function isNamedPlayer(value: string): boolean {
  return value !== "" && value !== "?" && !/^(?:winner|runner[- ]?up|semi[- ]?final|tba|tbc|bye|unknown|to be confirmed)\b/iu.test(value);
}

function capitalizeNamePart(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0)?.toLocaleUpperCase("en-US") ?? ""}${value.slice(1)}`;
}

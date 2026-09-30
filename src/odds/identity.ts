import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type {
  OddsMatch,
  OddsMatchIdentityEvidence,
  OddsParticipantIdentityEvidence,
} from "./contracts.js";

const SOURCE_ORIGIN = "https://www.eredmenyek.com";
const DETAIL_PATH_PATTERN = /^\/merkozes\/darts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/$/u;
const PROFILE_PATH_PATTERN = /^\/jatekos\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)\/$/u;
const MAX_HTML_BYTES = 2_500_000;

export interface EredmenyekIdentityInput {
  readonly html: string;
  readonly detailUrl: string;
  readonly match: Pick<OddsMatch, "eventId" | "player1" | "player2">;
  readonly date: string;
  readonly profileUrls?: readonly string[];
  readonly verifiedProfiles?: readonly EredmenyekPlayerProfile[];
}

export class EredmenyekIdentityError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EredmenyekIdentityError";
  }
}

export interface EredmenyekPlayerProfile {
  readonly sourcePlayerId: string;
  readonly fullName: string;
  readonly profileUrl: string;
}

/**
 * Extracts slot-ordered profile IDs and full names from one exact match
 * detail. The detail heading and participant-link labels are authoritative;
 * URL slug order is deliberately ignored because Eredmenyek can reverse it.
 */
export function parseEredmenyekMatchIdentity(input: unknown): OddsMatchIdentityEvidence {
  const parsed = validateInput(input);
  const detailUrl = validateDetailUrl(parsed.detailUrl, parsed.match.eventId);
  const $ = cheerio.load(parsed.html);
  if ($("h1").length !== 1) throw new EredmenyekIdentityError(`Eredmenyek detail ${parsed.match.eventId} has an ambiguous heading.`);
  const title = normalizeText($("h1").first().text());
  const titleParts = parseTitle(title, parsed.date);
  let profiles = collectProfiles($);
  if (profiles.length === 0 && parsed.profileUrls !== undefined) {
    const verifiedProfiles = parsed.verifiedProfiles ?? [];
    profiles = parsed.profileUrls.map((profileUrl: string): ProfileLink => {
      const profile = parseProfileUrl(profileUrl);
      const verified = profile === undefined ? undefined : verifiedProfiles.find((candidate): boolean => candidate.sourcePlayerId === profile.sourcePlayerId);
      if (profile === undefined || verified === undefined) throw new EredmenyekIdentityError(`Eredmenyek detail ${parsed.match.eventId} has an unverified player profile URL.`);
      return { ...profile, displayedName: verified.fullName };
    });
  }
  if (profiles.length !== 2) {
    throw new EredmenyekIdentityError(`Eredmenyek detail ${parsed.match.eventId} did not expose exactly two distinct player profile links.`);
  }
  if (parsed.verifiedProfiles !== undefined) profiles = verifyCollectedProfiles(profiles, parsed.verifiedProfiles, parsed.match.eventId);
  const homeProfile = profiles.find((profile: ProfileLink): boolean => matchesDisplayedName(titleParts.home, profile.displayedName) && matchesDisplayedName(titleParts.home, parsed.match.player1));
  const awayProfile = profiles.find((profile: ProfileLink): boolean => matchesDisplayedName(titleParts.away, profile.displayedName) && matchesDisplayedName(titleParts.away, parsed.match.player2));
  const home = participantEvidence(homeProfile, titleParts.home, parsed.match.player1, detailUrl);
  const away = participantEvidence(awayProfile, titleParts.away, parsed.match.player2, detailUrl);
  if (home.sourcePlayerId === away.sourcePlayerId) {
    throw new EredmenyekIdentityError(`Eredmenyek detail ${parsed.match.eventId} reused one source profile ID for both slots.`);
  }
  return { eventId: parsed.match.eventId, date: parsed.date, home, away };
}

/** Extracts both opaque player IDs from a validated detail URL without using slug order as participant order. */
export function profileUrlsFromDetailUrl(detailUrl: string, eventId: string): readonly string[] {
  const validated = validateDetailUrl(detailUrl, eventId);
  const url = new URL(validated);
  const segments = url.pathname.split("/").filter((segment: string): boolean => segment !== "");
  const participantSegments = segments.slice(2);
  if (participantSegments.length !== 2) throw new EredmenyekIdentityError("Eredmenyek detail URL does not contain two participant segments.");
  const profiles = participantSegments.map((segment: string): string => {
    const match = /^(.+)-([A-Za-z0-9]{8})$/u.exec(segment);
    const slug = match?.[1];
    const sourcePlayerId = match?.[2];
    if (slug === undefined || sourcePlayerId === undefined || slug === "") throw new EredmenyekIdentityError("Eredmenyek detail URL participant ID is malformed.");
    return `${SOURCE_ORIGIN}/jatekos/${slug}/${sourcePlayerId}/`;
  });
  return profiles;
}

/** Verifies a public profile heading and its canonical source link. */
export function parseEredmenyekPlayerProfile(input: unknown): EredmenyekPlayerProfile {
  if (!isRecord(input) || typeof input.html !== "string" || typeof input.profileUrl !== "string") {
    throw new EredmenyekIdentityError("Eredmenyek player profile input is incomplete.");
  }
  if (new TextEncoder().encode(input.html).byteLength > MAX_HTML_BYTES) throw new EredmenyekIdentityError("Eredmenyek player profile HTML exceeds the size limit.");
  const profile = parseProfileUrl(input.profileUrl);
  if (profile === undefined) throw new EredmenyekIdentityError("Eredmenyek player profile URL is outside the fixed player allowlist.");
  const $ = cheerio.load(input.html);
  if ($("h1").length !== 1 || $(".heading__name").length !== 1) throw new EredmenyekIdentityError(`Eredmenyek player profile ${profile.sourcePlayerId} has ambiguous name headings.`);
  const fullName = normalizeText($(".heading__name").text());
  const headingName = parseProfileHeading(normalizeText($("h1").text()));
  if (fullName === "" || headingName === "" || normalizeName(fullName) !== normalizeName(headingName)) throw new EredmenyekIdentityError(`Eredmenyek player profile ${profile.sourcePlayerId} has conflicting full-name headings.`);
  const canonicalNodes = $("link[rel='canonical'][href]");
  if (canonicalNodes.length !== 1) throw new EredmenyekIdentityError(`Eredmenyek player profile ${profile.sourcePlayerId} has ambiguous canonical metadata.`);
  const canonicalHref = canonicalNodes.attr("href");
  const canonical = canonicalHref === undefined ? undefined : parseProfileUrl(canonicalHref);
  if (canonical === undefined || canonical.sourcePlayerId !== profile.sourcePlayerId || canonical.profileUrl !== profile.profileUrl) throw new EredmenyekIdentityError(`Eredmenyek player profile ${profile.sourcePlayerId} canonical metadata does not match the verified profile URL.`);
  return { sourcePlayerId: profile.sourcePlayerId, fullName, profileUrl: profile.profileUrl };
}

interface ParsedInput {
  readonly html: string;
  readonly detailUrl: string;
  readonly match: Pick<OddsMatch, "eventId" | "player1" | "player2">;
  readonly date: string;
  readonly profileUrls?: readonly string[];
  readonly verifiedProfiles?: readonly EredmenyekPlayerProfile[];
}

interface ParsedTitle {
  readonly home: string;
  readonly away: string;
}

interface ProfileLink {
  readonly sourcePlayerId: string;
  readonly profileUrl: string;
  readonly displayedName: string;
}

function validateInput(input: unknown): ParsedInput {
  if (!isRecord(input)) throw new EredmenyekIdentityError("Eredmenyek identity input must be an object.");
  const html = input.html;
  const detailUrl = input.detailUrl;
  const date = input.date;
  const match = input.match;
  const profileUrls = input.profileUrls;
  const verifiedProfiles = input.verifiedProfiles;
  if (typeof html !== "string" || html.trim() === "") throw new EredmenyekIdentityError("Eredmenyek identity HTML is empty.");
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new EredmenyekIdentityError("Eredmenyek match detail HTML exceeds the size limit.");
  if (typeof detailUrl !== "string" || detailUrl.trim() === "") throw new EredmenyekIdentityError("Eredmenyek identity detail URL is missing.");
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new EredmenyekIdentityError("Eredmenyek identity date must be YYYY-MM-DD.");
  if (!isRecord(match) || typeof match.eventId !== "string" || typeof match.player1 !== "string" || typeof match.player2 !== "string") {
    throw new EredmenyekIdentityError("Eredmenyek identity match context is incomplete.");
  }
  if (match.eventId.trim() === "" || match.player1.trim() === "" || match.player2.trim() === "") throw new EredmenyekIdentityError("Eredmenyek identity match context contains an empty value.");
  if (profileUrls !== undefined && (!Array.isArray(profileUrls) || profileUrls.some((value: unknown): boolean => typeof value !== "string"))) throw new EredmenyekIdentityError("Eredmenyek identity profile URL list is invalid.");
  if (verifiedProfiles !== undefined && (!Array.isArray(verifiedProfiles) || verifiedProfiles.some((value: unknown): boolean => !isRecord(value) || typeof value.sourcePlayerId !== "string" || typeof value.fullName !== "string" || typeof value.profileUrl !== "string"))) throw new EredmenyekIdentityError("Eredmenyek verified profile list is invalid.");
  return {
    html,
    detailUrl,
    date,
    match: { eventId: match.eventId, player1: match.player1, player2: match.player2 },
    ...(profileUrls === undefined ? {} : { profileUrls: profileUrls as readonly string[] }),
    ...(verifiedProfiles === undefined ? {} : { verifiedProfiles: verifiedProfiles as readonly EredmenyekPlayerProfile[] }),
  };
}

function validateDetailUrl(raw: string, eventId: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    throw new EredmenyekIdentityError("Eredmenyek match detail URL is invalid.", error);
  }
  if (url.protocol !== "https:" || url.origin !== SOURCE_ORIGIN || url.username !== "" || url.password !== "" || url.port !== "" || !DETAIL_PATH_PATTERN.test(url.pathname) || url.hash !== "" || url.searchParams.getAll("mid").length !== 1 || url.searchParams.get("mid") !== eventId || [...url.searchParams.keys()].some((key) => key !== "mid")) {
    throw new EredmenyekIdentityError("Eredmenyek match detail URL is outside the fixed darts detail allowlist.");
  }
  return url.toString();
}

function parseTitle(title: string, expectedDate: string): ParsedTitle {
  const match = /^(.+?)\s+v\s+(.+?)\s+\((\d{2})\/(\d{2})\/(\d{4})\)$/u.exec(title);
  if (match === null) throw new EredmenyekIdentityError("Eredmenyek match detail heading is missing the full participant names and date.");
  const day = match[3];
  const month = match[4];
  const year = match[5];
  if (day === undefined || month === undefined || year === undefined) throw new EredmenyekIdentityError("Eredmenyek match detail heading date is incomplete.");
  const date = `${year}-${month}-${day}`;
  if (!isCalendarDate(date) || date !== expectedDate) throw new EredmenyekIdentityError(`Eredmenyek match detail date ${date} does not match expected odds date ${expectedDate}.`);
  const home = normalizeText(match[1] ?? "");
  const away = normalizeText(match[2] ?? "");
  if (home === "" || away === "" || normalizeName(home) === normalizeName(away)) throw new EredmenyekIdentityError("Eredmenyek match detail heading contains ambiguous participant names.");
  return { home, away };
}

function collectProfiles($: cheerio.CheerioAPI): readonly ProfileLink[] {
  const result = new Map<string, ProfileLink>();
  $("main a[href*='/jatekos/']").each((_index: number, element: Element): void => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const profile = parseProfileUrl(href);
    if (profile === undefined) return;
    const displayedName = normalizeText($(element).text());
    const existing = result.get(profile.sourcePlayerId);
    if (existing === undefined) {
      result.set(profile.sourcePlayerId, { ...profile, displayedName });
    } else if (existing.displayedName === "" && displayedName !== "") {
      result.set(profile.sourcePlayerId, { ...profile, displayedName });
    } else if (existing.displayedName !== "" && displayedName !== "" && !matchesDisplayedName(existing.displayedName, displayedName) && !matchesDisplayedName(displayedName, existing.displayedName)) {
      throw new EredmenyekIdentityError(`Eredmenyek detail has conflicting labels for source profile ${profile.sourcePlayerId}.`);
    }
  });
  return [...result.values()];
}

function verifyCollectedProfiles(
  profiles: readonly ProfileLink[],
  verifiedProfiles: readonly EredmenyekPlayerProfile[],
  eventId: string,
): readonly ProfileLink[] {
  const verifiedById = new Map<string, EredmenyekPlayerProfile>();
  for (const verified of verifiedProfiles) {
    const existing = verifiedById.get(verified.sourcePlayerId);
    if (existing !== undefined && (existing.profileUrl !== verified.profileUrl || normalizeName(existing.fullName) !== normalizeName(verified.fullName))) {
      throw new EredmenyekIdentityError(`Eredmenyek detail ${eventId} has conflicting verified profile records.`);
    }
    verifiedById.set(verified.sourcePlayerId, verified);
  }
  return profiles.map((profile: ProfileLink): ProfileLink => {
    const verified = verifiedById.get(profile.sourcePlayerId);
    if (verified === undefined || verified.profileUrl !== profile.profileUrl || !matchesDisplayedName(verified.fullName, profile.displayedName)) {
      throw new EredmenyekIdentityError(`Eredmenyek detail ${eventId} profile link does not match its verified profile page.`);
    }
    return { ...profile, displayedName: verified.fullName };
  });
}

function parseProfileUrl(raw: string): ProfileLink | undefined {
  let url: URL;
  try {
    url = new URL(raw, SOURCE_ORIGIN);
  } catch (error: unknown) {
    void error;
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== SOURCE_ORIGIN || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return undefined;
  const match = PROFILE_PATH_PATTERN.exec(url.pathname);
  const sourcePlayerId = match?.[1];
  if (sourcePlayerId === undefined || sourcePlayerId === "") return undefined;
  return { sourcePlayerId, profileUrl: url.toString(), displayedName: "" };
}

function participantEvidence(profile: ProfileLink | undefined, fullName: string, displayedName: string, detailUrl: string): OddsParticipantIdentityEvidence {
  if (profile === undefined) throw new EredmenyekIdentityError(`Eredmenyek detail ${detailUrl} is missing a participant profile link.`);
  if (profile.displayedName === "" || !matchesDisplayedName(fullName, profile.displayedName) || !matchesDisplayedName(fullName, displayedName)) throw new EredmenyekIdentityError(`Eredmenyek detail participant '${fullName}' does not match its profile-link label.`);
  if (!matchesDisplayedName(fullName, displayedName)) throw new EredmenyekIdentityError(`Eredmenyek detail participant '${fullName}' does not match displayed odds participant '${displayedName}'.`);
  return { sourcePlayerId: profile.sourcePlayerId, fullName, profileUrl: profile.profileUrl };
}

export function matchesDisplayedName(fullName: string, displayedName: string): boolean {
  if (normalizeName(fullName) === normalizeName(displayedName)) return true;
  const shortParts = normalizeName(displayedName).split(" ").filter((part: string): boolean => part !== "");
  const fullParts = normalizeName(fullName).split(" ").filter((part: string): boolean => part !== "");
  if (shortParts.length < 2 || fullParts.length < 2) return false;
  const initialPart = shortParts.at(-1);
  if (initialPart === undefined || initialPart.length !== 1) return false;
  const surname = shortParts.slice(0, -1).join(" ");
  if (surname === "") return false;
  const fullInitial = fullParts[0]?.[0] ?? "";
  const fullSurname = fullParts.slice(1).join(" ");
  if (fullInitial === initialPart && fullSurname === surname) return true;
  const trailingFullInitial = fullParts.at(-1)?.[0] ?? "";
  const leadingFullSurname = fullParts.slice(0, -1).join(" ");
  return trailingFullInitial === initialPart && leadingFullSurname === surname;
}

function parseProfileHeading(value: string): string {
  const match = /^Darts:\s*(.+?)\s+eredmények(?:,|\s|$)/iu.exec(value);
  return normalizeText(match?.[1] ?? "");
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizeText(value: string): string { return value.replace(/\s+/gu, " ").trim(); }

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

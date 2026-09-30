/**
 * Conservative MODUS name matching shared by fixture and history sources.
 *
 * A name is an identity only when its ordered full-name form matches, or when
 * an abbreviation can be resolved to exactly one full name. We deliberately
 * do not use a sorted token set: `John Smith` and `Smith John` are not
 * interchangeable people without source evidence.
 */

export interface ModusAbbreviatedName {
  readonly surnameParts: readonly string[];
  readonly initials: readonly string[];
}

export function modusNameKey(value: string): string {
  const base = modusNameBaseKey(value);
  const qualifiers = modusCountryQualifiers(value);
  return base === "" || qualifiers.length === 0 ? base : `${base} [${qualifiers.join(",")}]`;
}

/** Normalized name without a source-provided country qualifier. */
export function modusNameBaseKey(value: string): string {
  return comparableNameParts(withoutCountryQualifiers(value)).join(" ");
}

/** Country qualifiers are identity evidence and therefore remain distinct. */
export function modusCountryQualifiers(value: string): readonly string[] {
  const qualifiers = new Set<string>();
  for (const match of value.matchAll(/\(([A-Z]{2,3})\)/gu)) {
    const qualifier = match[1];
    if (qualifier !== undefined) qualifiers.add(qualifier);
  }
  return [...qualifiers].sort();
}

export function modusNameParts(value: string): readonly string[] {
  return comparableNameParts(value);
}

export function parseModusAbbreviatedName(value: string): ModusAbbreviatedName | undefined {
  const tokens = withoutCountryQualifiers(value).trim().split(/\s+/u).filter((token: string): boolean => token !== "");
  const initialTokens: string[] = [];
  while (tokens.length > 0) {
    const token = tokens.at(-1) ?? "";
    if (!/^[\p{L}]\.$/u.test(token)) break;
    tokens.pop();
    const initial = comparableNameParts(token)[0];
    if (initial !== undefined) initialTokens.unshift(initial);
  }
  if (tokens.length === 0 || initialTokens.length === 0) return undefined;
  const surnameParts = comparableNameParts(tokens.join(" "));
  if (surnameParts.length === 0) return undefined;
  return { surnameParts, initials: initialTokens };
}

/** Match a provider abbreviation to one already-known full name. */
export function modusAbbreviationMatches(abbreviated: string, fullName: string): boolean {
  if (!countryQualifiersCompatible(abbreviated, fullName)) return false;
  const parsed = parseModusAbbreviatedName(abbreviated);
  if (parsed === undefined) return false;
  const fullParts = comparableNameParts(fullName);
  const comparableFullParts = fullParts.at(-1) === "jnr" ? fullParts.slice(0, -1) : fullParts;
  if (comparableFullParts.length <= parsed.surnameParts.length) return false;
  const surnameStart = comparableFullParts.length - parsed.surnameParts.length;
  if (comparableFullParts.slice(surnameStart).join(" ") !== parsed.surnameParts.join(" ")) return false;
  const givenParts = comparableFullParts.slice(0, surnameStart);
  return parsed.initials.every((initial: string, index: number): boolean => {
    const given = givenParts[index];
    return given !== undefined && given.startsWith(initial);
  });
}

/** Match two names only when their ordered normalized forms are equal. */
export function modusNamesEquivalent(left: string, right: string): boolean {
  const leftKey = modusNameKey(left);
  const rightKey = modusNameKey(right);
  if (leftKey === "" || rightKey === "") return false;
  return leftKey === rightKey;
}

function comparableNameParts(value: string): string[] {
  return value
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\([A-Z]{2,3}\)/gu, " ")
    .replace(/[’'´‘`]/gu, " ")
    .toLocaleLowerCase("en-US")
    .replace(/\bjr\.?$/iu, "jnr")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part: string): boolean => part !== "");
}

function withoutCountryQualifiers(value: string): string {
  return value.replace(/\s*\([A-Z]{2,3}\)/gu, " ");
}

function countryQualifiersCompatible(left: string, right: string): boolean {
  const leftQualifiers = modusCountryQualifiers(left);
  const rightQualifiers = modusCountryQualifiers(right);
  return leftQualifiers.length === 0
    || (rightQualifiers.length > 0 && leftQualifiers.join(",") === rightQualifiers.join(","));
}

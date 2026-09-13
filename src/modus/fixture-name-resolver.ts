import type { DartsOrakelClient } from "../dartsorakel/client.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { normalizePlayerName } from "../player/resolver.js";
import type { PlayerStatsResponse } from "../schemas/player.js";

export class FixtureNameResolver {
  private readonly client: Pick<DartsOrakelClient, "getPlayerStats">;
  private directoryPromise: Promise<PlayerStatsResponse> | undefined;
  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) { this.client = client; }
  public async resolve(name: string): Promise<string> {
    const response = await this.directory();
    const canonicalName = canonicalizeFixtureName(name);
    const normalized = normalizePlayerName(canonicalName);
    const exact = response.data.filter((row) => normalizePlayerName(row.player_name) === normalized);
    if (exact.length === 1) return exact[0]?.player_name ?? name;
    const abbreviated = parseAbbreviatedName(canonicalName);
    if (abbreviated === undefined) throw new PlayerNotFoundError(name);
    const candidates = response.data.filter((row) => {
      const parts = comparableNameParts(row.player_name);
      const candidateSurnameParts = parts.at(-1) === "jnr" ? parts.slice(0, -1) : parts;
      if (candidateSurnameParts.length < abbreviated.surnameParts.length) return false;
      const surnameStart = candidateSurnameParts.length - abbreviated.surnameParts.length;
      const candidateSurname = candidateSurnameParts.slice(surnameStart);
      if (candidateSurname.join("") !== abbreviated.surnameParts.join("")) return false;
      const givenNameParts = candidateSurnameParts.slice(0, surnameStart);
      return abbreviated.initials.every((initial, index) => givenNameParts[index]?.startsWith(initial) === true);
    });
    if (candidates.length === 0) throw new PlayerNotFoundError(name);
    if (candidates.length > 1) throw new PlayerAmbiguousError(name, candidates.map((candidate) => candidate.player_name));
    return candidates[0]?.player_name ?? name;
  }

  private directory(): Promise<PlayerStatsResponse> {
    if (this.directoryPromise !== undefined) return this.directoryPromise;
    const request = this.client.getPlayerStats().catch((error: unknown) => {
      if (this.directoryPromise === request) this.directoryPromise = undefined;
      throw error;
    });
    this.directoryPromise = request;
    return request;
  }
}

function comparableNameParts(value: string): string[] {
  return normalizePlayerName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part !== "");
}

export function canonicalizeFixtureName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const commaName = /^([^,]+),\s*(.+)$/.exec(trimmed);
  return commaName === null ? trimmed : `${commaName[2] ?? ""} ${commaName[1] ?? ""}`.trim();
}

interface AbbreviatedName {
  readonly surnameParts: readonly string[];
  readonly initials: readonly string[];
}

function parseAbbreviatedName(value: string): AbbreviatedName | undefined {
  const tokens = value.trim().split(/\s+/u).filter((token) => token !== "");
  const initialTokens: string[] = [];
  while (tokens.length > 0) {
    const token = tokens.at(-1) ?? "";
    if (!/^[\p{L}]\.$/u.test(token)) break;
    tokens.pop();
    initialTokens.unshift(normalizePlayerName(token).replace(/[^\p{L}]/gu, ""));
  }
  if (tokens.length === 0 || initialTokens.length === 0) return undefined;
  const surnameParts = comparableNameParts(tokens.join(" "));
  const initials = initialTokens.map((initial) => comparableNameParts(initial)[0] ?? "");
  if (surnameParts.length === 0 || initials.some((initial) => initial === "")) return undefined;
  return { surnameParts, initials };
}

import type { DartsOrakelClient } from "../dartsorakel/client.js";
import { playerIdentityFromStatsRow } from "../player/resolver.js";
import type { PlayerIdentity } from "../schemas/player.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { DirectoryLoader } from "../player/directory-loader.js";
import type { PlayerStatsResponse } from "../schemas/player.js";
import { modusAbbreviationMatches, modusCountryQualifiers, modusNameBaseKey, modusNameKey, parseModusAbbreviatedName } from "./identity.js";

type FixtureDirectoryClient = Pick<DartsOrakelClient, "getPlayerStats">
  & Partial<Pick<DartsOrakelClient, "refreshPlayerStats">>;

export interface FixtureNameResolution {
  readonly canonicalName: string;
  readonly sourceId: string;
}

export class FixtureNameResolver {
  private readonly directory: DirectoryLoader<PlayerStatsResponse>;
  public constructor(client: FixtureDirectoryClient) {
    this.directory = new DirectoryLoader<PlayerStatsResponse>(
      (forceRefresh: boolean, signal?: AbortSignal): Promise<PlayerStatsResponse> => {
        if (forceRefresh && client.refreshPlayerStats !== undefined) return client.refreshPlayerStats(signal);
        return client.getPlayerStats(signal);
      },
    );
  }
  public async resolve(name: string, signal?: AbortSignal): Promise<string> {
    return (await this.resolveWithIdentity(name, signal)).canonicalName;
  }

  public async resolveWithIdentity(name: string, signal?: AbortSignal): Promise<FixtureNameResolution> {
    const response = await this.directory.get(signal);
    try {
      return resolveFromDirectory(name, response);
    } catch (error: unknown) {
      if (!(error instanceof PlayerNotFoundError)) throw error;
      const refreshed = await this.directory.refreshAfterMiss(signal);
      return resolveFromDirectory(name, refreshed);
    }
  }

  /** Provider-only short given names: exact surname, >=3-character prefix,
   * unique non-conflicting directory ID. General searches stay strict. */
  public async resolveProviderName(name: string, signal?: AbortSignal): Promise<string> {
    const response = await this.directory.get(signal);
    try { return resolveFromDirectory(name, response, true).canonicalName; }
    catch (error: unknown) {
      if (!(error instanceof PlayerNotFoundError)) throw error;
      return resolveFromDirectory(name, await this.directory.refreshAfterMiss(signal), true).canonicalName;
    }
  }

  /** Use the same strict directory resolution for fixture names and history identity. */
  public async resolvePlayerIdentity(name: string, signal?: AbortSignal): Promise<PlayerIdentity> {
    const verified = await this.resolveWithIdentity(name, signal);
    const response = await this.directory.get(signal);
    const row = response.data.find((candidate: PlayerStatsResponse["data"][number]): boolean =>
      String(candidate.player_key) === verified.sourceId && candidate.player_name === verified.canonicalName);
    if (row === undefined) throw new Error("Verified fixture identity disappeared from the directory; retry bounded resolution.");
    const url = new URL(row.player_profile_url);
    if (url.origin !== "https://dartsorakel.com" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new Error("Verified fixture identity contains an untrusted profile URL.");
    }
    return playerIdentityFromStatsRow(row);
  }
}

function resolveFromDirectory(name: string, response: PlayerStatsResponse, allowGivenNamePrefix: boolean = false): FixtureNameResolution {
    const canonicalName = canonicalizeFixtureName(name);
    if (modusNameKey(canonicalName) === "") throw new PlayerNotFoundError(name);
    const conflictingSourceIds = conflictingSourceIdsInDirectory(response);
    const abbreviated = parseModusAbbreviatedName(canonicalName);
    const requestQualifiers = modusCountryQualifiers(canonicalName);
    const candidates = abbreviated === undefined
      ? response.data.filter((row) => {
        if (conflictingSourceIds.has(row.player_key)) return false;
        if (requestQualifiers.length > 0) return modusNameKey(row.player_name) === modusNameKey(canonicalName);
        return modusNameBaseKey(row.player_name) === modusNameBaseKey(canonicalName);
      })
      : response.data.filter((row) => !conflictingSourceIds.has(row.player_key) && modusAbbreviationMatches(canonicalName, row.player_name));
    const parts = modusNameBaseKey(canonicalName).split(" ");
    const given = parts[0] ?? "";
    const prefixCandidates = candidates.length === 0 && allowGivenNamePrefix && abbreviated === undefined && requestQualifiers.length === 0 && parts.length >= 2 && /^[\p{L}]{3,}$/u.test(given)
      ? response.data.filter((row): boolean => {
        if (conflictingSourceIds.has(row.player_key)) return false;
        const candidate = modusNameBaseKey(row.player_name).split(" ");
        return candidate.length === parts.length && (candidate[0]?.startsWith(given) ?? false) && candidate.slice(1).join(" ") === parts.slice(1).join(" ");
      }) : candidates;
    const uniqueCandidates = uniqueRowsBySourceId(prefixCandidates);
    if (uniqueCandidates.length === 0) throw new PlayerNotFoundError(name);
    if (uniqueCandidates.length > 1) throw new PlayerAmbiguousError(name, uniqueCandidates.map((candidate) => candidate.player_name));
    const resolved = uniqueCandidates[0];
    if (resolved === undefined) throw new PlayerNotFoundError(name);
    return { canonicalName: resolved.player_name, sourceId: String(resolved.player_key) };
}

export function canonicalizeFixtureName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const commaName = /^([^,]+),\s*(.+)$/.exec(trimmed);
  return commaName === null ? trimmed : `${commaName[2] ?? ""} ${commaName[1] ?? ""}`.trim();
}

function uniqueRowsBySourceId(
  rows: readonly PlayerStatsResponse["data"][number][],
): readonly PlayerStatsResponse["data"][number][] {
  const byId = new Map<number, PlayerStatsResponse["data"][number][]>();
  for (const row of rows) byId.set(row.player_key, [...(byId.get(row.player_key) ?? []), row]);
  const resolved: PlayerStatsResponse["data"][number][] = [];
  for (const candidates of byId.values()) {
    const names = new Set(candidates.map((candidate) => modusNameKey(candidate.player_name)));
    // A source id claiming two different names is corrupt identity evidence;
    // quarantine it rather than selecting by response order.
    if (names.size !== 1) continue;
    const first = candidates[0];
    if (first !== undefined) resolved.push(first);
  }
  return resolved;
}

function conflictingSourceIdsInDirectory(response: PlayerStatsResponse): ReadonlySet<number> {
  const namesById = new Map<number, Set<string>>();
  for (const row of response.data) {
    const names = namesById.get(row.player_key) ?? new Set<string>();
    names.add(modusNameKey(row.player_name));
    namesById.set(row.player_key, names);
  }
  return new Set([...namesById.entries()]
    .filter(([, names]: readonly [number, Set<string>]): boolean => names.size > 1)
    .map(([playerKey]: readonly [number, Set<string>]): number => playerKey));
}

import type { DartsOrakelClient } from "../dartsorakel/client.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import type { PlayerStatsResponse } from "../schemas/player.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import { modusAbbreviationMatches, modusNameKey, parseModusAbbreviatedName } from "./identity.js";

export interface FixtureNameResolution {
  readonly canonicalName: string;
  readonly sourceId: string;
}

export class FixtureNameResolver {
  private readonly client: Pick<DartsOrakelClient, "getPlayerStats">;
  private directoryPromise: Promise<PlayerStatsResponse> | undefined;
  private readonly signalDirectoryPromises = new WeakMap<AbortSignal, Promise<PlayerStatsResponse>>();
  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) { this.client = client; }
  public async resolve(name: string, signal?: AbortSignal): Promise<string> {
    return (await this.resolveWithIdentity(name, signal)).canonicalName;
  }

  public async resolveWithIdentity(name: string, signal?: AbortSignal): Promise<FixtureNameResolution> {
    const response = await this.directory(signal);
    throwIfAborted(signal);
    const canonicalName = canonicalizeFixtureName(name);
    if (modusNameKey(canonicalName) === "") throw new PlayerNotFoundError(name);
    const conflictingSourceIds = conflictingSourceIdsInDirectory(response);
    const abbreviated = parseModusAbbreviatedName(canonicalName);
    const candidates = abbreviated === undefined
      ? response.data.filter((row) => !conflictingSourceIds.has(row.player_key) && modusNameKey(row.player_name) === modusNameKey(canonicalName))
      : response.data.filter((row) => !conflictingSourceIds.has(row.player_key) && modusAbbreviationMatches(canonicalName, row.player_name));
    const uniqueCandidates = uniqueRowsBySourceId(candidates);
    if (uniqueCandidates.length === 0) throw new PlayerNotFoundError(name);
    if (uniqueCandidates.length > 1) throw new PlayerAmbiguousError(name, uniqueCandidates.map((candidate) => candidate.player_name));
    const resolved = uniqueCandidates[0];
    if (resolved === undefined) throw new PlayerNotFoundError(name);
    return { canonicalName: resolved.player_name, sourceId: String(resolved.player_key) };
  }

  private directory(signal?: AbortSignal): Promise<PlayerStatsResponse> {
    if (signal !== undefined) {
      throwIfAborted(signal);
      // A signal-bound load belongs to that caller. Never put its promise in
      // the shared cache: aborting one report must not cancel/poison another.
      if (this.directoryPromise !== undefined) return waitWithSignal(this.directoryPromise, signal);
      const existingSignalRequest = this.signalDirectoryPromises.get(signal);
      if (existingSignalRequest !== undefined) return waitWithSignal(existingSignalRequest, signal);
      const request = this.client.getPlayerStats(signal)
        .then((response: PlayerStatsResponse): PlayerStatsResponse => {
          if (this.signalDirectoryPromises.get(signal) === request) this.signalDirectoryPromises.delete(signal);
          if (!signal.aborted && this.directoryPromise === undefined) this.directoryPromise = Promise.resolve(response);
          return response;
        })
        .catch((error: unknown): never => {
          if (this.signalDirectoryPromises.get(signal) === request) this.signalDirectoryPromises.delete(signal);
          throw error;
        });
      this.signalDirectoryPromises.set(signal, request);
      return waitWithSignal(request, signal);
    }
    if (this.directoryPromise !== undefined) return this.directoryPromise;
    const request = this.client.getPlayerStats().catch((error: unknown) => {
      if (this.directoryPromise === request) this.directoryPromise = undefined;
      throw error;
    });
    this.directoryPromise = request;
    return request;
  }
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

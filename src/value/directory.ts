import { DartsOrakelClient } from "../dartsorakel/client.js";
import { DirectoryLoader } from "../player/directory-loader.js";
import { playerIdentityFromStatsRow } from "../player/resolver.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import type { PlayerIdentity, PlayerStatsRow } from "../schemas/player.js";
import type { ValuePlayerDirectory } from "./contracts.js";
import { abbreviatedNameParts, nameParts, normalizeForMatch, uniqueById, waitForSignal, type ValueResolution } from "./helpers.js";

export type Resolution = ValueResolution;

export class DartsOrakelPlayerDirectory implements ValuePlayerDirectory {
  private readonly directoryLoader: DirectoryLoader<readonly PlayerIdentity[]>;

  public constructor(
    client: Pick<DartsOrakelClient, "getPlayerStats"> & Partial<Pick<DartsOrakelClient, "refreshPlayerStats">>,
  ) {
    this.directoryLoader = new DirectoryLoader<readonly PlayerIdentity[]>(
      async (forceRefresh: boolean, signal?: AbortSignal): Promise<readonly PlayerIdentity[]> => {
        const response = forceRefresh && client.refreshPlayerStats !== undefined
          ? await client.refreshPlayerStats(signal)
          : signal === undefined
            ? await client.getPlayerStats()
            : await client.getPlayerStats(signal);
        return playersFromStatsRows(response.data);
      },
    );
  }

  public async getPlayers(signal?: AbortSignal): Promise<readonly PlayerIdentity[]> {
    // Value reports share the directory acquisition; a report deadline stops
    // only that report from waiting and does not cancel or discard the cache fill.
    const pending = this.directoryLoader.get();
    return signal === undefined ? pending : waitForSignal(pending, signal);
  }

  public async refreshAfterMiss(signal?: AbortSignal): Promise<readonly PlayerIdentity[]> {
    return this.directoryLoader.refreshAfterMiss(signal);
  }
}

function playersFromStatsRows(
  rows: readonly PlayerStatsRow[],
): readonly PlayerIdentity[] {
  const byId = new Map<number, PlayerIdentity>();
  const conflictingIds = new Set<number>();
  for (const row of rows) {
    const player = playerIdentityFromStatsRow(row);
    const existing = byId.get(player.id);
    if (conflictingIds.has(player.id)) continue;
    if (existing === undefined) {
      byId.set(player.id, player);
    } else if (normalizeForMatch(existing.name) !== normalizeForMatch(player.name)) {
      byId.delete(player.id);
      conflictingIds.add(player.id);
    }
  }
  return [...byId.values()];
}

export function resolveFromDirectory(requestedName: string, players: readonly PlayerIdentity[]): Resolution {
  const exact = uniqueById(players.filter((player: PlayerIdentity): boolean => normalizeForMatch(player.name) === normalizeForMatch(requestedName)));
  if (exact.length === 1) return { status: "available", identity: exact[0] ?? null, error: null };
  if (exact.length > 1) return { status: "unresolved", identity: null, error: new PlayerAmbiguousError(requestedName, exact.map((player) => player.name)).message };
  const requestedParts = abbreviatedNameParts(requestedName);
  if (requestedParts === null) return { status: "unresolved", identity: null, error: new PlayerNotFoundError(requestedName).message };
  const surnameMatches = uniqueById(players.filter((player: PlayerIdentity): boolean => {
    const parts = nameParts(player.name);
    return parts !== null && parts.surname === requestedParts.surname && parts.initial === requestedParts.initial;
  }));
  if (surnameMatches.length === 1) return { status: "available", identity: surnameMatches[0] ?? null, error: null };
  if (surnameMatches.length > 1) return { status: "unresolved", identity: null, error: new PlayerAmbiguousError(requestedName, surnameMatches.map((player) => player.name)).message };
  return { status: "unresolved", identity: null, error: new PlayerNotFoundError(requestedName).message };
}

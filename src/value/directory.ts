import { DartsOrakelClient } from "../dartsorakel/client.js";
import { playerIdentityFromStatsRow } from "../player/resolver.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import type { PlayerIdentity } from "../schemas/player.js";
import type { ValuePlayerDirectory } from "./contracts.js";
import { abbreviatedNameParts, nameParts, normalizeForMatch, uniqueById, waitForSignal, type ValueResolution } from "./helpers.js";

export type Resolution = ValueResolution;

export class DartsOrakelPlayerDirectory implements ValuePlayerDirectory {
  private readonly client: Pick<DartsOrakelClient, "getPlayerStats">;
  private playersPromise: Promise<readonly PlayerIdentity[]> | undefined;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) {
    this.client = client;
  }

  public async getPlayers(signal?: AbortSignal): Promise<readonly PlayerIdentity[]> {
    if (this.playersPromise === undefined) {
      // Keep the shared directory fetch independent from one report's deadline.
      this.playersPromise = this.loadPlayers().catch((error: unknown) => {
        this.playersPromise = undefined;
        throw error;
      });
    }
    if (signal === undefined) return this.playersPromise;
    return await waitForSignal(this.playersPromise, signal);
  }

  private async loadPlayers(signal?: AbortSignal): Promise<readonly PlayerIdentity[]> {
    const response = signal === undefined ? await this.client.getPlayerStats() : await this.client.getPlayerStats(signal);
    const players = response.data.map((row): PlayerIdentity => playerIdentityFromStatsRow(row));
    const byId = new Map<number, PlayerIdentity>();
    const conflictingIds = new Set<number>();
    for (const player of players) {
      if (conflictingIds.has(player.id)) continue;
      const existing = byId.get(player.id);
      if (existing === undefined) {
        byId.set(player.id, player);
      } else if (normalizeForMatch(existing.name) !== normalizeForMatch(player.name)) {
        byId.delete(player.id);
        conflictingIds.add(player.id);
      }
    }
    return [...byId.values()];
  }
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

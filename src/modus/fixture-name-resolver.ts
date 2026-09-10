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
    const abbreviated = /^(.+?)\s+([\p{L}])\.$/u.exec(canonicalName.trim());
    if (abbreviated === null) throw new PlayerNotFoundError(name);
    const surname = normalizePlayerName(abbreviated[1] ?? "");
    const initial = normalizePlayerName(abbreviated[2] ?? "");
    const candidates = response.data.filter((row) => {
      const parts = normalizePlayerName(row.player_name).split(" ");
      return (parts[0] ?? "").startsWith(initial) && parts.slice(1).join(" ") === surname;
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

export function canonicalizeFixtureName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const commaName = /^([^,]+),\s*(.+)$/.exec(trimmed);
  return commaName === null ? trimmed : `${commaName[2] ?? ""} ${commaName[1] ?? ""}`.trim();
}

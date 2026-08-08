import { DartsOrakelStructureChangedError, PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { DartsOrakelPlayerProfilePattern } from "../dartsorakel/selectors.js";
import type { DartsOrakelClient } from "../dartsorakel/client.js";
import {
  PlayerIdentitySchema,
  type PlayerIdentity,
  type PlayerStatsRow,
} from "../schemas/player.js";

export class PlayerResolver {
  private readonly client: Pick<DartsOrakelClient, "getPlayerStats">;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) {
    this.client = client;
  }

  public async resolvePlayer(name: string): Promise<PlayerIdentity> {
    const normalizedRequestedName = normalizePlayerName(name);
    if (normalizedRequestedName === "") {
      throw new PlayerNotFoundError(name);
    }

    const response = await this.client.getPlayerStats();
    const candidates = response.data.filter(
      (row) => normalizePlayerName(row.player_name) === normalizedRequestedName,
    );
    if (candidates.length === 0) {
      throw new PlayerNotFoundError(name);
    }
    if (candidates.length > 1) {
      throw new PlayerAmbiguousError(name, candidates.map((candidate) => candidate.player_name));
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new PlayerNotFoundError(name);
    }
    return playerIdentityFromStatsRow(candidate);
  }
}

export function normalizePlayerName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function playerIdentityFromStatsRow(row: PlayerStatsRow): PlayerIdentity {
  let profileUrl: URL;
  try {
    profileUrl = new URL(row.player_profile_url);
  } catch (error: unknown) {
    throw new DartsOrakelStructureChangedError(
      "DartsOrakel returned an invalid player profile URL.",
      error,
    );
  }
  const match = DartsOrakelPlayerProfilePattern.exec(profileUrl.pathname);
  if (match === null) {
    throw new DartsOrakelStructureChangedError(
      `DartsOrakel player profile URL has an unexpected shape: ${profileUrl.pathname}.`,
    );
  }
  const idText = match[1];
  const slug = match[2];
  if (idText === undefined || slug === undefined || Number(idText) !== row.player_key) {
    throw new DartsOrakelStructureChangedError("DartsOrakel player profile ID does not match player_key.");
  }

  const parsed = PlayerIdentitySchema.safeParse({ id: row.player_key, name: row.player_name, slug });
  if (!parsed.success) {
    throw new DartsOrakelStructureChangedError("DartsOrakel player identity failed validation.");
  }
  return parsed.data;
}

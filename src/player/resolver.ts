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
  private directoryPromise: Promise<ReadonlyMap<string, readonly PlayerIdentity[]>> | undefined;

  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) {
    this.client = client;
  }

  public async resolvePlayer(name: string): Promise<PlayerIdentity> {
    const normalizedRequestedName = normalizePlayerName(name);
    if (normalizedRequestedName === "") {
      throw new PlayerNotFoundError(name);
    }

    const directory = await this.directory();
    const candidates = directory.get(normalizedRequestedName) ?? [];
    if (candidates.length === 0) {
      throw new PlayerNotFoundError(name);
    }
    if (candidates.length > 1) {
      throw new PlayerAmbiguousError(name, candidates.map((candidate) => candidate.name));
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new PlayerNotFoundError(name);
    }
    return candidate;
  }

  public async findMention(text: string): Promise<PlayerIdentity | undefined> {
    return (await this.findMentions(text))[0];
  }

  public async findMentions(text: string): Promise<readonly PlayerIdentity[]> {
    const searchableText = searchable(text);
    if (searchableText === "") return [];
    const directory = await this.directory();
    const matches: PlayerIdentity[] = [];
    for (const candidates of directory.values()) {
      if (candidates.length !== 1) continue;
      const player = candidates[0];
      if (player !== undefined && ` ${searchableText} `.includes(` ${searchable(player.name)} `)) matches.push(player);
    }
    matches.sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));
    return matches;
  }

  public async preload(): Promise<void> {
    await this.directory();
  }

  private directory(): Promise<ReadonlyMap<string, readonly PlayerIdentity[]>> {
    if (this.directoryPromise !== undefined) return this.directoryPromise;
    const request = this.client.getPlayerStats().then((response) => {
      const directory = new Map<string, PlayerIdentity[]>();
      for (const row of response.data) {
        const player = playerIdentityFromStatsRow(row);
        const key = normalizePlayerName(player.name);
        directory.set(key, [...(directory.get(key) ?? []), player]);
      }
      return directory as ReadonlyMap<string, readonly PlayerIdentity[]>;
    }).catch((error: unknown) => {
      if (this.directoryPromise === request) this.directoryPromise = undefined;
      throw error;
    });
    this.directoryPromise = request;
    return request;
  }
}

export function normalizePlayerName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function searchable(value: string): string {
  return normalizePlayerName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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

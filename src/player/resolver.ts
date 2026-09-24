import { DartsOrakelStructureChangedError, PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { DartsOrakelPlayerProfilePattern } from "../dartsorakel/selectors.js";
import type { DartsOrakelClient } from "../dartsorakel/client.js";
import {
  PlayerIdentitySchema,
  type PlayerIdentity,
  type PlayerStatsRow,
} from "../schemas/player.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";

const MIN_FUZZY_INPUT_LENGTH = 5;
const MAX_FUZZY_DISTANCE = 2;
const MIN_FUZZY_SCORE = 0.86;
const MIN_FUZZY_MARGIN = 0.08;
const MAX_SUGGESTIONS = 3;

export class PlayerResolver {
  private readonly client: Pick<DartsOrakelClient, "getPlayerStats">;
  private directoryPromise: Promise<ReadonlyMap<string, readonly PlayerIdentity[]>> | undefined;
  private readonly signalDirectoryPromises = new WeakMap<AbortSignal, Promise<ReadonlyMap<string, readonly PlayerIdentity[]>>>();

  public constructor(client: Pick<DartsOrakelClient, "getPlayerStats">) {
    this.client = client;
  }

  public async resolvePlayer(name: string, signal?: AbortSignal): Promise<PlayerIdentity> {
    const normalizedRequestedName = normalizePlayerName(name);
    if (normalizedRequestedName === "") {
      throw new PlayerNotFoundError(name);
    }

    const directory = await this.directory(signal);
    throwIfAborted(signal);
    const candidates = directory.get(normalizedRequestedName) ?? [];
    if (candidates.length > 1) {
      throw new PlayerAmbiguousError(name, candidates.map((candidate) => candidate.name));
    }
    const exactCandidate = candidates[0];
    if (exactCandidate !== undefined) return exactCandidate;

    const uniquePlayers = uniqueDirectoryPlayers(directory);
    const queryTokens = searchable(name).split(" ").filter((token: string): boolean => token !== "");
    const partialCandidates = uniquePlayers.filter((candidate: PlayerIdentity): boolean => {
      return containsTokenPhrase(searchable(candidate.name).split(" "), queryTokens);
    });
    if (partialCandidates.length > 1) {
      throw new PlayerAmbiguousError(name, partialCandidates.map((candidate) => candidate.name));
    }
    const partialCandidate = partialCandidates[0];
    if (partialCandidate !== undefined) return partialCandidate;

    const fuzzyCandidates = rankFuzzyCandidates(name, uniquePlayers);
    const first = fuzzyCandidates[0];
    if (first !== undefined && first.score >= MIN_FUZZY_SCORE && first.distance <= MAX_FUZZY_DISTANCE) {
      const second = fuzzyCandidates[1];
      if (second !== undefined && first.score - second.score < MIN_FUZZY_MARGIN) {
        throw new PlayerAmbiguousError(name, fuzzyCandidates.slice(0, MAX_SUGGESTIONS).map((candidate) => candidate.player.name));
      }
      return first.player;
    }

    throw new PlayerNotFoundError(name, suggestionNames(fuzzyCandidates));
  }

  public async findMention(text: string, signal?: AbortSignal): Promise<PlayerIdentity | undefined> {
    return (await this.findMentions(text, signal))[0];
  }

  public async findMentions(text: string, signal?: AbortSignal): Promise<readonly PlayerIdentity[]> {
    const searchableText = searchable(text);
    if (searchableText === "") return [];
    const directory = await this.directory(signal);
    throwIfAborted(signal);
    const matches: PlayerIdentity[] = [];
    for (const candidates of directory.values()) {
      if (candidates.length !== 1) continue;
      const player = candidates[0];
      if (player !== undefined && ` ${searchableText} `.includes(` ${searchable(player.name)} `)) matches.push(player);
    }
    matches.sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name));
    return matches;
  }

  public async preload(signal?: AbortSignal): Promise<void> {
    await this.directory(signal);
  }

  private directory(signal?: AbortSignal): Promise<ReadonlyMap<string, readonly PlayerIdentity[]>> {
    if (signal !== undefined) {
      throwIfAborted(signal);
      const sharedRequest = this.directoryPromise;
      if (sharedRequest !== undefined) return waitWithSignal(sharedRequest, signal);
      const signalRequest = this.signalDirectoryPromises.get(signal);
      if (signalRequest !== undefined) return waitWithSignal(signalRequest, signal);
      const request = this.loadDirectory(signal).then((directory) => {
        // A completed signal-bound request is valid cache data, but an aborted
        // request must never become the shared single-flight promise.
        if (this.directoryPromise === undefined && signal.aborted !== true) {
          this.directoryPromise = Promise.resolve(directory);
        }
        return directory;
      }).catch((error: unknown) => {
        if (this.signalDirectoryPromises.get(signal) === request) {
          this.signalDirectoryPromises.delete(signal);
        }
        throw error;
      });
      this.signalDirectoryPromises.set(signal, request);
      return request;
    }
    if (this.directoryPromise !== undefined) return this.directoryPromise;
    const request = this.loadDirectory().catch((error: unknown) => {
      if (this.directoryPromise === request) this.directoryPromise = undefined;
      throw error;
    });
    this.directoryPromise = request;
    return request;
  }

  private async loadDirectory(signal?: AbortSignal): Promise<ReadonlyMap<string, readonly PlayerIdentity[]>> {
    throwIfAborted(signal);
    const response = signal === undefined
      ? await this.client.getPlayerStats()
      : await this.client.getPlayerStats(signal);
    throwIfAborted(signal);
    const directory = new Map<string, PlayerIdentity[]>();
    for (const row of response.data) {
      const player = playerIdentityFromStatsRow(row);
      const key = normalizePlayerName(player.name);
      directory.set(key, [...(directory.get(key) ?? []), player]);
    }
    return directory as ReadonlyMap<string, readonly PlayerIdentity[]>;
  }
}

export function normalizePlayerName(name: string): string {
  return name
    .replace(/['\u00b4\u2018\u2019\u02bc]+/gu, " ")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bjr\.?$/iu, "jnr")
    .toLocaleLowerCase("en-US");
}

function searchable(value: string): string {
  return normalizePlayerName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface FuzzyCandidate {
  readonly player: PlayerIdentity;
  readonly distance: number;
  readonly score: number;
}

function uniqueDirectoryPlayers(
  directory: ReadonlyMap<string, readonly PlayerIdentity[]>,
): readonly PlayerIdentity[] {
  const players = new Map<number, PlayerIdentity>();
  for (const candidates of directory.values()) {
    for (const player of candidates) players.set(player.id, player);
  }
  return [...players.values()];
}

function rankFuzzyCandidates(
  requestedName: string,
  players: readonly PlayerIdentity[],
): readonly FuzzyCandidate[] {
  const query = searchable(requestedName);
  if (query.length < MIN_FUZZY_INPUT_LENGTH) return [];
  return players
    .map((player: PlayerIdentity): FuzzyCandidate => {
      const queryTokens = query.split(" ");
      const candidateTokens = searchable(player.name).split(" ");
      const representations = [searchable(player.name), ...tokenWindows(candidateTokens, queryTokens.length)];
      const distance = Math.min(...representations.map((representation: string): number => levenshteinDistance(query, representation)));
      const score = 1 - distance / Math.max(query.length, searchable(player.name).length);
      return { player, distance, score };
    })
    .sort((left: FuzzyCandidate, right: FuzzyCandidate): number => {
      return right.score - left.score || left.distance - right.distance || left.player.name.localeCompare(right.player.name);
    });
}

function suggestionNames(candidates: readonly FuzzyCandidate[]): readonly string[] {
  return candidates
    .filter((candidate: FuzzyCandidate): boolean => candidate.score >= 0.45)
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate: FuzzyCandidate): string => candidate.player.name);
}

function tokenWindows(tokens: readonly string[], length: number): readonly string[] {
  if (length <= 0 || length > tokens.length) return [];
  const windows: string[] = [];
  for (let start = 0; start <= tokens.length - length; start += 1) {
    windows.push(tokens.slice(start, start + length).join(" "));
  }
  return windows;
}

function containsTokenPhrase(candidateTokens: readonly string[], queryTokens: readonly string[]): boolean {
  if (queryTokens.length === 0 || queryTokens.length > candidateTokens.length) return false;
  for (let start = 0; start <= candidateTokens.length - queryTokens.length; start += 1) {
    if (queryTokens.every((token: string, index: number): boolean => candidateTokens[start + index] === token)) return true;
  }
  return false;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index: number): number => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
      );
    }
    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index] ?? Number.POSITIVE_INFINITY;
    }
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
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

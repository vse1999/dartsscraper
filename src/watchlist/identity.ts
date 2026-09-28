import { WatchlistQuoteSchema, type WatchlistPlayer, type WatchlistQuote } from "./contracts.js";

export interface CanonicalMatchIdentity {
  readonly competitionOccurrenceId: string;
  readonly eventId: string;
  readonly round: string | undefined;
  readonly playerIds: readonly [string, string];
  readonly selectedPlayerId: string;
  readonly key: string;
}

export interface IdentityValidation {
  readonly valid: boolean;
  readonly identity: CanonicalMatchIdentity | null;
  readonly reason: "invalid_quote" | "ambiguous_player_pair" | "selected_player_not_in_event" | null;
}

/** Name normalization is for diagnostics only; stable provider IDs are identity. */
export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeStableId(id: string): string {
  // Provider IDs are opaque. Case-folding could merge two distinct IDs.
  return id.trim();
}

export function selectedPlayerIsMember(players: readonly WatchlistPlayer[], selectedPlayerId: string): boolean {
  const selected = normalizeStableId(selectedPlayerId);
  return players.some((player) => normalizeStableId(player.id) === selected);
}

function identityKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function validateWatchlistIdentity(quote: WatchlistQuote): IdentityValidation {
  const first = quote.players[0];
  const second = quote.players[1];
  const firstId = normalizeStableId(first.id);
  const secondId = normalizeStableId(second.id);
  const selectedId = normalizeStableId(quote.selectedPlayerId);

  if (firstId.length === 0 || secondId.length === 0 || firstId === secondId) {
    return { valid: false, identity: null, reason: "ambiguous_player_pair" };
  }
  if (!selectedPlayerIsMember(quote.players, selectedId)) {
    return { valid: false, identity: null, reason: "selected_player_not_in_event" };
  }

  const playerIds: readonly [string, string] = firstId < secondId
    ? [firstId, secondId]
    : [secondId, firstId];
  const round = quote.round?.trim();
  const identity: CanonicalMatchIdentity = {
    competitionOccurrenceId: quote.competitionOccurrenceId.trim(),
    eventId: quote.eventId.trim(),
    round,
    playerIds,
    selectedPlayerId: selectedId,
    key: [
      quote.competitionOccurrenceId.trim(),
      quote.eventId.trim(),
      playerIds[0],
      playerIds[1],
    ].map(identityKeyPart).join("|"),
  };
  return { valid: true, identity, reason: null };
}

/**
 * Parse and canonicalize an untrusted quote without guessing missing identity
 * fields. Consumers should treat a failed result as quarantined input.
 */
export function parseAndCanonicalizeIdentity(input: unknown): IdentityValidation {
  const parsed = WatchlistQuoteSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, identity: null, reason: "invalid_quote" };
  }
  return validateWatchlistIdentity(parsed.data);
}

export function sameCanonicalMatchup(left: CanonicalMatchIdentity, right: CanonicalMatchIdentity): boolean {
  return left.key === right.key;
}

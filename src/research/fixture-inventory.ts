import { createHash } from "node:crypto";

import { IsoDateSchema } from "../agent/date.js";
import { ReportDeadlineExceededError } from "../daily/report-budget.js";
import { PlayerAmbiguousError, PlayerNotFoundError } from "../errors.js";
import { normalizePlayerName } from "../player/resolver.js";
import { PlayerIdentitySchema, type PlayerIdentity } from "../schemas/player.js";
import { throwIfAborted, waitWithSignal } from "../services/cancellation.js";
import {
  ModusFixtureSchema,
  type ModusFixture,
} from "../modus/schemas.js";
import {
  PdcFixtureSchema,
  type PdcFixture,
} from "../pdc/schemas.js";

export const MAX_FIXTURE_INVENTORY_FIXTURES = 1_000;
export const MAX_FIXTURE_INVENTORY_PARTICIPANTS = 100;

export type FixtureInventorySource = "pdc" | "modus";
export type FixtureSide = "one" | "two";
export type FixtureReferenceReason =
  | "ambiguous"
  | "deadline"
  | "excluded-limit"
  | "fixture-date-mismatch"
  | "identity-conflict"
  | "placeholder"
  | "source-unavailable"
  | "unresolved";

export interface FixtureInventoryOccurrence {
  readonly inventoryIndex: number;
  readonly occurrenceId: string;
  readonly fixtureId: string;
  readonly date: string;
  readonly startTime: string | null;
  readonly playerOne: string;
  readonly playerTwo: string;
  readonly sourceUrls: readonly string[];
  readonly fixture: PdcFixture | ModusFixture;
}

interface FixtureParticipantReferenceBase {
  readonly id: string;
  readonly inventoryIndex: number;
  readonly fixtureId: string;
  readonly occurrenceId: string;
  readonly side: FixtureSide;
  readonly requestedName: string;
  readonly startTime: string | null;
}

export type FixtureParticipantReference = FixtureParticipantReferenceBase & (
  | { readonly status: "pending"; readonly participantId: null; readonly reason: null }
  | { readonly status: "resolved"; readonly participantId: number; readonly reason: null }
  | { readonly status: "unresolved"; readonly participantId: null; readonly reason: FixtureReferenceReason }
  | { readonly status: "excluded-limit"; readonly participantId: null; readonly reason: "excluded-limit" }
);

export interface FixtureInventoryDraft {
  readonly version: 1;
  readonly id: string;
  readonly source: FixtureInventorySource;
  readonly playerNamespace: "dartsorakel";
  readonly date: string;
  readonly fixtures: readonly FixtureInventoryOccurrence[];
  readonly references: readonly FixtureParticipantReference[];
}

export interface FixtureInventoryParticipant {
  readonly player: PlayerIdentity;
  readonly inventoryIndex: number;
  readonly startTime: string | null;
  readonly aliases: readonly string[];
  readonly referenceIds: readonly string[];
  readonly fixtureOccurrences: readonly string[];
}

export type ResolvedFixtureParticipantReference = Exclude<FixtureParticipantReference, { readonly status: "pending" }>;

export interface FixtureResearchInventory {
  readonly version: 1;
  readonly id: string;
  readonly source: FixtureInventorySource;
  readonly playerNamespace: "dartsorakel";
  readonly date: string;
  readonly fixtures: readonly FixtureInventoryOccurrence[];
  readonly participants: readonly FixtureInventoryParticipant[];
  readonly references: readonly ResolvedFixtureParticipantReference[];
}

export type FixtureParticipantResolver = (
  requestedName: string,
  signal?: AbortSignal,
) => Promise<PlayerIdentity>;

/**
 * Validate and retain source fixture occurrences without deriving identity from names.
 * Source order and duplicate fixture pairs are intentional occurrence evidence.
 */
export function buildFixtureInventory(
  source: "pdc",
  date: string,
  fixtures: readonly PdcFixture[],
): FixtureInventoryDraft;
export function buildFixtureInventory(
  source: "modus",
  date: string,
  fixtures: readonly ModusFixture[],
): FixtureInventoryDraft;
export function buildFixtureInventory(
  source: FixtureInventorySource,
  date: string,
  fixtures: readonly (PdcFixture | ModusFixture)[],
): FixtureInventoryDraft;
export function buildFixtureInventory(
  source: FixtureInventorySource,
  date: string,
  fixtures: readonly (PdcFixture | ModusFixture)[],
): FixtureInventoryDraft {
  const validatedDate = IsoDateSchema.parse(date);
  const validatedFixtures = source === "pdc"
    ? PdcFixtureSchema.array().max(MAX_FIXTURE_INVENTORY_FIXTURES, `At most ${MAX_FIXTURE_INVENTORY_FIXTURES} fixtures may be inventoried.`).parse(fixtures)
    : ModusFixtureSchema.array().max(MAX_FIXTURE_INVENTORY_FIXTURES, `At most ${MAX_FIXTURE_INVENTORY_FIXTURES} fixtures may be inventoried.`).parse(fixtures);

  for (const fixture of validatedFixtures) validateFixtureBounds(fixture);

  const id = createHash("sha256")
    .update(JSON.stringify({ version: 1, source, date: validatedDate, fixtures: validatedFixtures }))
    .digest("hex");
  const occurrences: FixtureInventoryOccurrence[] = [];
  const references: FixtureParticipantReference[] = [];

  for (const [inventoryIndex, fixture] of validatedFixtures.entries()) {
    const sourceUrls = getFixtureSourceUrls(fixture);
    const fixtureId = fixture.id;
    const occurrenceId = createHash("sha256")
      .update(JSON.stringify({ source, date: validatedDate, inventoryId: id, inventoryIndex, fixtureId }))
      .digest("hex");
    occurrences.push({
      inventoryIndex,
      occurrenceId,
      fixtureId,
      date: fixture.date,
      startTime: fixture.startTime,
      playerOne: fixture.playerOne,
      playerTwo: fixture.playerTwo,
      sourceUrls,
      fixture,
    });

    for (const [side, requestedName] of [["one", fixture.playerOne], ["two", fixture.playerTwo]] as const) {
      const base: FixtureParticipantReferenceBase = {
        id: createHash("sha256").update(`${id}\u0000${inventoryIndex}\u0000${side}`).digest("hex"),
        inventoryIndex,
        fixtureId,
        occurrenceId,
        side,
        requestedName,
        startTime: fixture.startTime,
      };
      if (fixture.date !== validatedDate) {
        references.push({ ...base, status: "unresolved", participantId: null, reason: "fixture-date-mismatch" });
      } else if (isPlaceholderName(requestedName)) {
        references.push({ ...base, status: "unresolved", participantId: null, reason: "placeholder" });
      } else {
        references.push({ ...base, status: "pending", participantId: null, reason: null });
      }
    }
  }

  return {
    version: 1,
    id,
    source,
    playerNamespace: "dartsorakel",
    date: validatedDate,
    fixtures: occurrences,
    references,
  };
}

/** Resolve fixture labels through an injected trusted resolver; caller cancellation is never swallowed. */
export async function resolveFixtureInventory(
  inventory: FixtureInventoryDraft,
  resolver: FixtureParticipantResolver,
  signal?: AbortSignal,
): Promise<FixtureResearchInventory> {
  const resolutions = new Map<string, Resolution>();
  let deadlineExceeded = false;

  if (signal?.aborted === true) {
    if (isResearchDeadline(signal.reason)) deadlineExceeded = true;
    else throwIfAborted(signal);
  }

  for (const reference of inventory.references) {
    if (reference.status !== "pending") continue;
    if (deadlineExceeded) break;
    if (signal?.aborted === true) {
      if (isResearchDeadline(signal.reason)) {
        deadlineExceeded = true;
        break;
      }
      throwIfAborted(signal);
    }
    const nameKey = normalizePlayerName(reference.requestedName);
    if (resolutions.has(nameKey)) continue;

    try {
      const result: unknown = await waitWithSignal(resolver(reference.requestedName, signal), signal);
      throwIfAborted(signal);
      const parsed = PlayerIdentitySchema.safeParse(result);
      if (!parsed.success) {
        resolutions.set(nameKey, { status: "unresolved", reason: "identity-conflict" });
      } else {
        resolutions.set(nameKey, { status: "resolved", player: parsed.data });
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        if (isResearchDeadline(signal.reason)) {
          deadlineExceeded = true;
          break;
        }
        throwIfAborted(signal);
      }
      if (isResearchDeadline(error)) {
        deadlineExceeded = true;
        break;
      }
      if (error instanceof PlayerAmbiguousError) {
        resolutions.set(nameKey, { status: "unresolved", reason: "ambiguous" });
      } else if (error instanceof PlayerNotFoundError) {
        resolutions.set(nameKey, { status: "unresolved", reason: "unresolved" });
      } else {
        resolutions.set(nameKey, { status: "unresolved", reason: "source-unavailable" });
      }
    }
  }

  const conflictingIds = findConflictingIdentityIds(resolutions);
  const samePlayerSides = new Set<string>();
  const occurrencePlayers = new Map<string, { readonly id: number; readonly referenceId: string }>();
  for (const reference of inventory.references) {
    if (reference.status !== "pending") continue;
    const resolution = resolutions.get(normalizePlayerName(reference.requestedName));
    if (resolution?.status !== "resolved") continue;
    const other = occurrencePlayers.get(reference.occurrenceId);
    if (other !== undefined && other.id === resolution.player.id) {
      samePlayerSides.add(other.referenceId); samePlayerSides.add(reference.id);
    } else occurrencePlayers.set(reference.occurrenceId, { id: resolution.player.id, referenceId: reference.id });
  }
  const participantBuilders = new Map<number, ParticipantBuilder>();
  const finalReferences: ResolvedFixtureParticipantReference[] = [];

  for (const reference of inventory.references) {
    if (reference.status === "unresolved") {
      finalReferences.push(reference);
      continue;
    }
    if (reference.status !== "pending") {
      throw new Error("Fixture inventory contains an unexpected pre-resolved reference.");
    }
    if (samePlayerSides.has(reference.id)) {
      finalReferences.push({ ...reference, status: "unresolved", participantId: null, reason: "identity-conflict" });
      continue;
    }
    const resolution = resolutions.get(normalizePlayerName(reference.requestedName));
    if (resolution === undefined) {
      finalReferences.push({ ...reference, status: "unresolved", participantId: null, reason: deadlineExceeded ? "deadline" : "unresolved" });
      continue;
    }
    if (resolution.status === "unresolved") {
      finalReferences.push({ ...reference, status: "unresolved", participantId: null, reason: resolution.reason });
      continue;
    }
    const player = resolution.player;
    if (conflictingIds.has(player.id)) {
      finalReferences.push({ ...reference, status: "unresolved", participantId: null, reason: "identity-conflict" });
      continue;
    }

    let builder = participantBuilders.get(player.id);
    if (builder === undefined && participantBuilders.size >= MAX_FIXTURE_INVENTORY_PARTICIPANTS) {
      finalReferences.push({ ...reference, status: "excluded-limit", participantId: null, reason: "excluded-limit" });
      continue;
    }
    if (builder === undefined) {
      builder = {
        player,
        inventoryIndex: participantBuilders.size,
        startTime: reference.startTime,
        aliases: [],
        aliasKeys: new Set<string>(),
        referenceIds: [],
        fixtureOccurrences: [],
        fixtureOccurrenceKeys: new Set<string>(),
      };
      participantBuilders.set(player.id, builder);
    }
    const aliasKey = normalizePlayerName(reference.requestedName);
    if (!builder.aliasKeys.has(aliasKey)) {
      builder.aliasKeys.add(aliasKey);
      builder.aliases.push(reference.requestedName);
    }
    builder.referenceIds.push(reference.id);
    if (!builder.fixtureOccurrenceKeys.has(reference.occurrenceId)) {
      builder.fixtureOccurrenceKeys.add(reference.occurrenceId);
      builder.fixtureOccurrences.push(reference.occurrenceId);
    }
    if (reference.startTime !== null && (builder.startTime === null || Date.parse(reference.startTime) < Date.parse(builder.startTime))) {
      builder.startTime = reference.startTime;
    }
    finalReferences.push({ ...reference, status: "resolved", participantId: player.id, reason: null });
  }

  return {
    version: inventory.version,
    id: inventory.id,
    source: inventory.source,
    playerNamespace: inventory.playerNamespace,
    date: inventory.date,
    fixtures: inventory.fixtures,
    participants: [...participantBuilders.values()].map((builder: ParticipantBuilder): FixtureInventoryParticipant => ({
      player: builder.player,
      inventoryIndex: builder.inventoryIndex,
      startTime: builder.startTime,
      aliases: builder.aliases,
      referenceIds: builder.referenceIds,
      fixtureOccurrences: builder.fixtureOccurrences,
    })),
    references: finalReferences,
  };
}

/** Convert unresolved draft references into an explicit terminal inventory outcome after a deadline. */
export function finalizeFixtureInventoryUnresolved(
  inventory: FixtureInventoryDraft,
  reason: "deadline" | "unresolved" = "unresolved",
): FixtureResearchInventory {
  return {
    version: inventory.version,
    id: inventory.id,
    source: inventory.source,
    playerNamespace: inventory.playerNamespace,
    date: inventory.date,
    fixtures: inventory.fixtures,
    participants: [],
    references: inventory.references.map((reference): ResolvedFixtureParticipantReference => (
      reference.status === "pending"
        ? { ...reference, status: "unresolved", participantId: null, reason }
        : reference
    )),
  };
}

type Resolution =
  | { readonly status: "resolved"; readonly player: PlayerIdentity }
  | { readonly status: "unresolved"; readonly reason: "ambiguous" | "identity-conflict" | "source-unavailable" | "unresolved" };

interface ParticipantBuilder {
  readonly player: PlayerIdentity;
  readonly inventoryIndex: number;
  startTime: string | null;
  readonly aliases: string[];
  readonly aliasKeys: Set<string>;
  readonly referenceIds: string[];
  readonly fixtureOccurrences: string[];
  readonly fixtureOccurrenceKeys: Set<string>;
}

function findConflictingIdentityIds(resolutions: ReadonlyMap<string, Resolution>): ReadonlySet<number> {
  const identitiesById = new Map<number, { readonly name: string; readonly slug: string }>();
  const conflicts = new Set<number>();
  for (const resolution of resolutions.values()) {
    if (resolution.status !== "resolved") continue;
    const current = { name: normalizePlayerName(resolution.player.name), slug: resolution.player.slug };
    const previous = identitiesById.get(resolution.player.id);
    if (previous === undefined) identitiesById.set(resolution.player.id, current);
    else if (previous.name !== current.name || previous.slug !== current.slug) conflicts.add(resolution.player.id);
  }
  return conflicts;
}

function validateFixtureBounds(fixture: PdcFixture | ModusFixture): void {
  if (fixture.playerOne.length > 120 || fixture.playerTwo.length > 120) {
    throw new Error("Fixture participant names must not exceed 120 characters.");
  }
  const values = [fixture.id];
  if ("tournamentName" in fixture) {
    values.push(fixture.tournamentName);
    if (fixture.session !== null) values.push(fixture.session);
    if (fixture.round !== null) values.push(fixture.round);
  } else {
    values.push(fixture.event);
  }
  if (values.some((value: string): boolean => value.length > 256)) {
    throw new Error("Fixture IDs and event labels must not exceed 256 characters.");
  }
  const sourceUrls = getFixtureSourceUrls(fixture);
  if (sourceUrls.length > 12 || sourceUrls.some((url: string): boolean => url.length > 2_048 || !isSafeSourceUrl(url))) {
    throw new Error("Fixture source URLs must be safe HTTPS URLs no longer than 2048 characters; at most 12 are allowed.");
  }
  if (JSON.stringify(fixture).length > 8_192) {
    throw new Error("A fixture record must not exceed 8192 serialized characters.");
  }
}

function getFixtureSourceUrls(fixture: PdcFixture | ModusFixture): readonly string[] {
  if ("sourceUrl" in fixture) return [fixture.sourceUrl, ...(fixture.evidenceUrls ?? [])];
  return [fixture.source];
}

function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname !== ""
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function isResearchDeadline(value: unknown): value is ReportDeadlineExceededError {
  return value instanceof ReportDeadlineExceededError && value.phase === "research";
}

function isPlaceholderName(value: string): boolean {
  const trimmed = value.normalize("NFKC").trim();
  return /^(?:tbd|tbc|to be decided|to be confirmed|unknown(?: player)?|winner(?:\s+of)?(?:\s+(?:match\s+)?[a-z0-9/-]+)?|loser(?:\s+of)?(?:\s+(?:match\s+)?[a-z0-9/-]+)?|player\s+[a-z0-9]+|qualifier(?:\s+\d+)?|bye|walkover|not announced|n\/?a|[?\-–—]+)$/iu.test(trimmed);
}
